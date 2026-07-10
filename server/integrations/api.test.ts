import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { TOKEN_HEADER } from "./security";
import type { RunResult } from "./detect";

const VAULT = mkdtempSync(join(tmpdir(), "solaris-api-test-"));
writeFileSync(join(VAULT, "real.md"), "# Real\n");
const graphPath = join(VAULT, "graph.json");
writeFileSync(
  graphPath,
  JSON.stringify({
    meta: { vaultName: "test", vaultPath: VAULT, notes: 1, excludes: [] },
    nodes: [{ id: "real.md", title: "Real", phantom: false }],
    links: [],
  }),
);
afterAll(() => rmSync(VAULT, { recursive: true, force: true }));

const ok = (stdout: string): RunResult => ({ ok: true, stdout, stderr: "" });
const fail = (): RunResult => ({ ok: false, stdout: "", stderr: "" });

// Mutable fake install state so the refresh scenario can flip it.
let qmdInstalled = false;
const QMD_BIN = "/fake/bin/qmd";

const { app } = createApp(graphPath, undefined, {
  configPath: join(VAULT, "config.json"),
  detectDeps: {
    home: "/home/tester",
    env: { PATH: "/fake/bin", SHELL: "/bin/zsh" },
    fileExists: (p) => qmdInstalled && p === QMD_BIN,
    run: async (cmd) => (cmd === QMD_BIN ? ok("qmd 1.0.0") : fail()),
  },
});

async function sessionToken(): Promise<string> {
  const res = await request(app).get("/api/session");
  expect(res.status).toBe(200);
  return res.body.token;
}

describe("local-origin enforcement (KTD12)", () => {
  it("rejects a foreign Host header on every route", async () => {
    for (const path of [
      "/api/graph",
      "/api/note?id=real.md",
      "/api/integrations",
      "/api/session",
    ]) {
      const res = await request(app).get(path).set("Host", "evil.example.com");
      expect(res.status, path).toBe(403);
    }
  });

  it("rejects a foreign Origin header", async () => {
    const res = await request(app)
      .get("/api/graph")
      .set("Origin", "https://evil.example.com");
    expect(res.status).toBe(403);
  });

  it("allows localhost Origins (vite dev on 5173)", async () => {
    const res = await request(app)
      .get("/api/integrations")
      .set("Origin", "http://localhost:5173");
    expect(res.status).toBe(200);
  });

  it("rejects a mutating request without the session token and accepts it with one", async () => {
    const denied = await request(app)
      .post("/api/integrations/config")
      .send({ consents: { web: true } });
    expect(denied.status).toBe(403);

    const token = await sessionToken();
    const allowed = await request(app)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, token)
      .send({ consents: { web: true } });
    expect(allowed.status).toBe(200);
    expect(allowed.body.consents.web).toBe(true);
  });
});

describe("GET /api/integrations", () => {
  it("reports tool state from detection and config booleans only", async () => {
    const res = await request(app).get("/api/integrations");
    expect(res.status).toBe(200);
    expect(res.body.tools.qmd.installed).toBe(false);
    expect(res.body.tools.exa).toEqual({ configured: false });
  });

  it("never exposes the Exa key in the status payload", async () => {
    const token = await sessionToken();
    const save = await request(app)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, token)
      .send({ exaKey: "exa-super-secret-key" });
    expect(save.status).toBe(200);
    expect(JSON.stringify(save.body)).not.toContain("exa-super-secret-key");

    const res = await request(app).get("/api/integrations");
    expect(JSON.stringify(res.body)).not.toContain("exa-super-secret-key");
    expect(res.body.tools.exa.configured).toBe(true);
  });

  it("serves cached detection until ?refresh=1 re-probes a changed PATH state", async () => {
    qmdInstalled = true; // tool appears after the first probe
    const cached = await request(app).get("/api/integrations");
    expect(cached.body.tools.qmd.installed).toBe(false);

    const fresh = await request(app).get("/api/integrations?refresh=1");
    expect(fresh.body.tools.qmd.installed).toBe(true);
    expect(fresh.body.tools.qmd.version).toBe("qmd 1.0.0");
  });
});

describe("GET /api/note-questions", () => {
  it("falls back to templates without an OpenRouter key", async () => {
    const res = await request(app).get("/api/note-questions?id=real.md");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("templates");
    expect(Array.isArray(res.body.questions)).toBe(true);
  });

  it("returns LLM questions via OpenRouter when key + model are set", async () => {
    const fetched: string[] = [];
    const { app: app2 } = createApp(graphPath, undefined, {
      configPath: join(VAULT, "llm-config.json"),
      openrouter: {
        fetch: (async (url: string) => {
          fetched.push(url);
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '["what is X?", "why Y?"]' } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as never,
      },
    });
    const t = (await request(app2).get("/api/session")).body.token;
    await request(app2)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, t)
      .send({
        openrouterKey: "or-secret",
        defaultModel: "deepseek/deepseek-v4-flash",
      });
    const res = await request(app2).get("/api/note-questions?id=real.md");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("llm");
    expect(res.body.questions).toEqual(["what is X?", "why Y?"]);
    expect(fetched[0]).toContain("/chat/completions");
    expect(JSON.stringify(res.body)).not.toContain("or-secret"); // key never echoed
  });

  it("uses the LLM with the default model when a key is set but no model", async () => {
    const bodies: string[] = [];
    const { app: app2 } = createApp(graphPath, undefined, {
      configPath: join(VAULT, "llm-nomodel-config.json"),
      openrouter: {
        fetch: (async (_url: string, init: RequestInit) => {
          bodies.push(String(init.body));
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '["q1?", "q2?"]' } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as never,
      },
    });
    const t = (await request(app2).get("/api/session")).body.token;
    await request(app2)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, t)
      .send({ openrouterKey: "or-secret" }); // key only, no defaultModel
    const res = await request(app2).get("/api/note-questions?id=real.md");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("llm");
    expect(bodies[0]).toContain("deepseek/deepseek-v4-flash"); // fell back to default
  });
});

describe("DeepSeek key status and test route (U1)", () => {
  it("exposes deepseek.configured boolean only, never key material", async () => {
    const { app: app2 } = createApp(graphPath, undefined, {
      configPath: join(VAULT, "deepseek-config.json"),
    });
    const t = (await request(app2).get("/api/session")).body.token;
    await request(app2)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, t)
      .send({ deepseekKey: "ds-super-secret", thinkerProvider: "deepseek" });
    const res = await request(app2).get("/api/integrations");
    expect(res.status).toBe(200);
    expect(res.body.tools.deepseek).toEqual({ configured: true });
    expect(res.body.llm.thinkerProvider).toBe("deepseek");
    expect(JSON.stringify(res.body)).not.toContain("ds-super-secret");
  });

  it("reports configured:false without a key", async () => {
    const { app: app2 } = createApp(graphPath, undefined, {
      configPath: join(VAULT, "deepseek-nokey-config.json"),
    });
    const res = await request(app2).get("/api/integrations/test/deepseek");
    expect(res.body).toEqual({ configured: false });
  });

  it("returns ok / unreachable per the faked models-list fetch", async () => {
    let status = 200;
    const { app: app2 } = createApp(graphPath, undefined, {
      configPath: join(VAULT, "deepseek-test-config.json"),
      deepseek: {
        fetch: (async () => new Response("{}", { status })) as never,
      },
    });
    const t = (await request(app2).get("/api/session")).body.token;
    await request(app2)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, t)
      .send({ deepseekKey: "ds-k" });
    let res = await request(app2).get("/api/integrations/test/deepseek");
    expect(res.body).toEqual({ configured: true, ok: true });
    status = 401;
    res = await request(app2).get("/api/integrations/test/deepseek");
    expect(res.body).toEqual({ configured: true, ok: false });
    status = 500;
    res = await request(app2).get("/api/integrations/test/deepseek");
    expect(res.body).toEqual({ configured: true, ok: false, unreachable: true });
  });
});

describe("worker tier resolution (U2)", () => {
  it("note-questions use the worker slot model when configured", async () => {
    const bodies: string[] = [];
    const { app: app2 } = createApp(graphPath, undefined, {
      configPath: join(VAULT, "worker-slot-config.json"),
      openrouter: {
        fetch: (async (_url: string, init: RequestInit) => {
          bodies.push(String(init.body));
          return new Response(
            JSON.stringify({ choices: [{ message: { content: '["q?"]' } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as never,
      },
    });
    const t = (await request(app2).get("/api/session")).body.token;
    await request(app2)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, t)
      .send({
        openrouterKey: "or-secret",
        defaultModel: "legacy/model",
        workerProvider: "openrouter",
        workerModel: "meta/fast-worker",
      });
    const res = await request(app2).get("/api/note-questions?id=real.md");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("llm");
    expect(JSON.parse(bodies[0]).model).toBe("meta/fast-worker");
  });
});
