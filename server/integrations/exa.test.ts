import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { TOKEN_HEADER } from "./security";
import { createExaAdapter, type ExaClientLike } from "./exa";

const KEY = "exa-super-secret-key";

const CANNED = {
  requestId: "r1",
  results: [
    {
      id: "1",
      title: "Zettelkasten Method",
      url: "https://example.com/zk",
      publishedDate: "2026-01-01",
      author: "Niklas",
      score: 0.92,
      highlights: ["A note-taking method", "linked atomic notes"],
    },
    {
      id: "2",
      title: null,
      url: "https://example.com/untitled",
      text: "body text here",
    },
    { id: "3", title: "No URL", score: 1 },
  ],
};

function fakeExa(behavior: (calls: number) => unknown) {
  const state = {
    calls: 0,
    keys: [] as string[],
    requests: [] as Array<Record<string, unknown>>,
  };
  const makeClient = (key: string): ExaClientLike => ({
    async search(_query, options) {
      state.keys.push(key);
      state.calls++;
      state.requests.push(options);
      const r = behavior(state.calls);
      if (r instanceof Error) throw r;
      return r;
    },
  });
  return { state, makeClient };
}

const CANNED_DEEP = {
  ...CANNED,
  output: {
    content: "Synthesized research answer about zettelkasten.",
    grounding: [
      {
        field: "answer",
        confidence: "high",
        citations: [
          { url: "https://example.com/zk", title: "Zettelkasten Method" },
          { url: "https://example.com/other", title: "Other Source" },
        ],
      },
      {
        field: "answer",
        confidence: "medium",
        // duplicate url must be deduped
        citations: [
          { url: "https://example.com/zk", title: "Zettelkasten Method" },
        ],
      },
    ],
  },
};

const exaError = (statusCode: number) =>
  Object.assign(new Error(`http ${statusCode}`), { statusCode });

describe("exa adapter", () => {
  it("maps a canned Exa response to the UI shape", async () => {
    const { makeClient } = fakeExa(() => CANNED);
    const research = createExaAdapter({ makeClient, retryDelays: [1] });
    const { results: out, answer } = await research(KEY, "zettelkasten");
    expect(answer).toBeNull(); // fast mode: no synthesis
    expect(out).toHaveLength(2); // result without url dropped
    expect(out[0]).toEqual({
      title: "Zettelkasten Method",
      url: "https://example.com/zk",
      snippet: "A note-taking method … linked atomic notes",
      publishedDate: "2026-01-01",
      author: "Niklas",
      score: 0.92,
    });
    expect(out[1].title).toBe("https://example.com/untitled"); // url fallback
    expect(out[1].snippet).toBe("body text here"); // text fallback
  });

  it("retries transient failures with backoff, then succeeds", async () => {
    const { state, makeClient } = fakeExa((n) =>
      n < 3 ? exaError(503) : CANNED,
    );
    const research = createExaAdapter({ makeClient, retryDelays: [1, 1] });
    const out = await research(KEY, "q");
    expect(out.results).toHaveLength(2);
    expect(state.calls).toBe(3);
  });

  it("surfaces a clean error after retries are exhausted", async () => {
    const { state, makeClient } = fakeExa(() => exaError(429));
    const research = createExaAdapter({ makeClient, retryDelays: [1, 1] });
    await expect(research(KEY, "q")).rejects.toThrow("http 429");
    expect(state.calls).toBe(3);
  });

  it("deep mode requests synthesis and maps the answer with deduped citations (F020)", async () => {
    const { state, makeClient } = fakeExa(() => CANNED_DEEP);
    const research = createExaAdapter({ makeClient, retryDelays: [1] });
    const { results, answer } = await research(KEY, "zettelkasten", {
      deep: true,
    });
    expect(state.requests[0].type).toBe("deep");
    expect(state.requests[0].outputSchema).toEqual({ type: "text" });
    expect(results).toHaveLength(2); // sources still mapped
    expect(answer?.content).toContain("Synthesized research answer");
    expect(answer?.citations).toEqual([
      { url: "https://example.com/zk", title: "Zettelkasten Method" },
      { url: "https://example.com/other", title: "Other Source" },
    ]);
  });

  it("deep response without output degrades to answer: null", async () => {
    const { makeClient } = fakeExa(() => CANNED);
    const research = createExaAdapter({ makeClient, retryDelays: [1] });
    const { answer } = await research(KEY, "q", { deep: true });
    expect(answer).toBeNull();
  });

  it("does not retry non-transient failures (bad key)", async () => {
    const { state, makeClient } = fakeExa(() => exaError(401));
    const research = createExaAdapter({ makeClient, retryDelays: [1, 1] });
    await expect(research(KEY, "q")).rejects.toThrow("http 401");
    expect(state.calls).toBe(1);
  });
});

describe("POST /api/research", () => {
  const VAULT = mkdtempSync(join(tmpdir(), "solaris-exa-test-"));
  afterAll(() => rmSync(VAULT, { recursive: true, force: true }));
  const graphPath = join(VAULT, "graph.json");
  writeFileSync(
    graphPath,
    JSON.stringify({
      meta: { vaultName: "t", vaultPath: VAULT, notes: 0, excludes: [] },
      nodes: [],
      links: [],
    }),
  );

  const { state, makeClient } = fakeExa(() => CANNED);
  const { app } = createApp(graphPath, undefined, {
    configPath: join(VAULT, "config.json"),
    detectDeps: {
      fileExists: () => false,
      run: async () => ({ ok: false, stdout: "", stderr: "" }),
      home: "/h",
      env: {},
    },
    exa: { makeClient, retryDelays: [1] },
  });
  const token = async () => (await request(app).get("/api/session")).body.token;
  const setConfig = async (patch: object) =>
    request(app)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, await token())
      .send(patch);

  it("rejects without the session token", async () => {
    expect(
      (await request(app).post("/api/research").send({ query: "q" })).status,
    ).toBe(403);
  });

  it("rejects without stored Web consent and makes no outbound call (AE8)", async () => {
    const res = await request(app)
      .post("/api/research")
      .set(TOKEN_HEADER, await token())
      .send({ query: "q" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("web-consent-required");
    expect(state.calls).toBe(0);
  });

  it("rejects with an actionable message when no key is configured (AE5)", async () => {
    await setConfig({ consents: { web: true } });
    const res = await request(app)
      .post("/api/research")
      .set(TOKEN_HEADER, await token())
      .send({ query: "q" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Tools");
    expect(state.calls).toBe(0);
  });

  it("returns mapped results and never echoes the key", async () => {
    await setConfig({ exaKey: KEY });
    const res = await request(app)
      .post("/api/research")
      .set(TOKEN_HEADER, await token())
      .send({ query: "zettelkasten" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(state.keys[0]).toBe(KEY); // adapter received the stored key
  });

  it("rejects an empty query before any call", async () => {
    const before = state.calls;
    const res = await request(app)
      .post("/api/research")
      .set(TOKEN_HEADER, await token())
      .send({});
    expect(res.status).toBe(400);
    expect(state.calls).toBe(before);
  });
});
