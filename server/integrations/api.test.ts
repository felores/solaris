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
});
