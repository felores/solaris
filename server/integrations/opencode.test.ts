import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { TOKEN_HEADER } from "./security";
import {
  createOpencodeBridge,
  eventSessionId,
  lockdownConfig,
  restartBackoffMs,
  type OpencodeClientLike,
  type OpencodeEvent,
  type SpawnedProc,
} from "./opencode";

const OC_BIN = "/fake/bin/opencode";

// --- fakes ---

class FakeProc implements SpawnedProc {
  stdoutHandlers: Array<(c: string) => void> = [];
  exitHandlers: Array<(code: number | null) => void> = [];
  killed = false;
  stdout = {
    on: (_ev: "data", fn: (c: string) => void) => {
      this.stdoutHandlers.push(fn);
    },
  };
  on(ev: "exit", fn: (code: number | null) => void) {
    if (ev === "exit") this.exitHandlers.push(fn);
  }
  kill() {
    this.killed = true;
  }
  emitListening(url = "http://127.0.0.1:41234") {
    for (const fn of this.stdoutHandlers)
      fn(`opencode server listening on ${url}\n`);
  }
  emitExit(code: number) {
    for (const fn of this.exitHandlers) fn(code);
  }
}

function fakeSpawner(auto = true) {
  const spawns: Array<{
    cmd: string;
    args: string[];
    opts: Record<string, any>;
    proc: FakeProc;
  }> = [];
  const spawn = (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => {
    const proc = new FakeProc();
    spawns.push({ cmd, args, opts: opts as Record<string, any>, proc });
    if (auto) setTimeout(() => proc.emitListening(), 0);
    return proc;
  };
  return { spawns, spawn };
}

function fakeClient(events: OpencodeEvent[] = []) {
  const calls: Record<string, unknown[]> = {
    create: [],
    promptAsync: [],
    abort: [],
    subscribe: [],
  };
  const made: Array<{ baseUrl: string; password: string }> = [];
  const client: OpencodeClientLike = {
    session: {
      async create(o) {
        calls.create.push(o);
        return { data: { id: "ses_123" } };
      },
      async promptAsync(o) {
        calls.promptAsync.push(o);
        return {};
      },
      async abort(o) {
        calls.abort.push(o);
        return {};
      },
    },
    event: {
      async subscribe() {
        calls.subscribe.push({});
        return {
          stream: (async function* () {
            yield* events;
          })(),
        };
      },
    },
  };
  const makeClient = (baseUrl: string, password: string) => {
    made.push({ baseUrl, password });
    return client;
  };
  return { calls, made, makeClient };
}

// --- pure pieces ---

describe("lockdown profile (KTD3)", () => {
  it("denies every write/egress/spawn capability regardless of permission mode", () => {
    const c = lockdownConfig() as {
      permission: Record<string, string>;
      tools: Record<string, boolean>;
    };
    expect(c.permission.edit).toBe("deny");
    expect(c.permission.bash).toBe("deny");
    expect(c.permission.webfetch).toBe("deny");
    expect(c.permission.external_directory).toBe("deny"); // read scoped to the vault cwd
    for (const tool of [
      "write",
      "edit",
      "patch",
      "bash",
      "webfetch",
      "websearch",
      "task",
      "skill",
    ])
      expect(c.tools[tool], tool).toBe(false);
  });
});

describe("restart backoff", () => {
  it("doubles and caps at 30s", () => {
    expect(restartBackoffMs(0)).toBe(1000);
    expect(restartBackoffMs(1)).toBe(2000);
    expect(restartBackoffMs(4)).toBe(16000);
    expect(restartBackoffMs(10)).toBe(30000);
  });
});

describe("eventSessionId", () => {
  it("finds the session id in nested shapes", () => {
    expect(eventSessionId({ type: "x", properties: { sessionID: "a" } })).toBe(
      "a",
    );
    expect(
      eventSessionId({ type: "x", properties: { info: { sessionID: "b" } } }),
    ).toBe("b");
    expect(
      eventSessionId({ type: "x", properties: { part: { sessionID: "c" } } }),
    ).toBe("c");
    expect(eventSessionId({ type: "x" })).toBeNull();
  });
});

// --- bridge lifecycle ---

describe("opencode bridge", () => {
  const VAULT = "/fake/vault";

  it("spawns locked-down, vault-scoped, password-protected", async () => {
    const { spawns, spawn } = fakeSpawner();
    const { made, makeClient } = fakeClient();
    const bridge = createOpencodeBridge({
      binPath: async () => OC_BIN,
      vaultRoot: () => VAULT,
      extraConfig: () => ({ model: "opencode/some-model" }),
      spawn,
      makeClient,
      backoff: () => 1,
    });
    await bridge.ensureRunning();
    expect(spawns).toHaveLength(1);
    const s = spawns[0];
    expect(s.cmd).toBe(OC_BIN);
    expect(s.args).toContain("serve");
    expect(s.args).toContain("--hostname=127.0.0.1");
    expect(s.opts.cwd).toBe(VAULT); // vault-scoped: serve has no dir flag
    const env = s.opts.env as Record<string, string>;
    expect(env.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.permission.edit).toBe("deny");
    expect(cfg.model).toBe("opencode/some-model");
    // client got the parsed url and the same generated password
    expect(made[0].baseUrl).toBe("http://127.0.0.1:41234");
    expect(made[0].password).toBe(env.OPENCODE_SERVER_PASSWORD);
    expect(bridge.running()).toBe(true);
  });

  it("restarts after a crash with backoff", async () => {
    const { spawns, spawn } = fakeSpawner();
    const { makeClient } = fakeClient();
    const bridge = createOpencodeBridge({
      binPath: async () => OC_BIN,
      vaultRoot: () => VAULT,
      extraConfig: () => ({}),
      spawn,
      makeClient,
      backoff: () => 1, // ms, keeps the test fast; real curve tested above
    });
    await bridge.ensureRunning();
    expect(bridge.running()).toBe(true);
    spawns[0].proc.emitExit(1); // crash
    expect(bridge.running()).toBe(false);
    await bridge.ensureRunning(); // respawns after the (tiny) backoff
    expect(spawns).toHaveLength(2);
    expect(bridge.running()).toBe(true);
  });

  it("reports missing / not-connected / ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "solaris-oc-auth-"));
    const authPath = join(dir, "auth.json");
    const mk = (bin: string | null) =>
      createOpencodeBridge({
        binPath: async () => bin,
        vaultRoot: () => VAULT,
        extraConfig: () => ({}),
        spawn: fakeSpawner().spawn,
        makeClient: fakeClient().makeClient,
        authJsonPath: authPath,
        backoff: () => 1,
      });
    expect(await mk(null).state()).toBe("missing");
    expect(await mk(OC_BIN).state()).toBe("not-connected");
    writeFileSync(authPath, JSON.stringify({ opencode: { type: "oauth" } }));
    expect(await mk(OC_BIN).state()).toBe("ready");
    rmSync(dir, { recursive: true, force: true });
  });
});

// --- routes ---

const VAULT = mkdtempSync(join(tmpdir(), "solaris-agent-test-"));
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
const authPath = join(VAULT, "auth.json");
writeFileSync(authPath, JSON.stringify({ opencode: { type: "oauth" } }));

const events: OpencodeEvent[] = [
  {
    type: "message.part.updated",
    properties: { part: { sessionID: "ses_123", text: "hi" } },
  },
  {
    type: "message.part.updated",
    properties: { part: { sessionID: "other", text: "nope" } },
  },
  {
    type: "session.status",
    properties: { sessionID: "ses_123", status: { type: "idle" } },
  },
];
const oc = fakeClient(events);
const spawner = fakeSpawner();

const { app } = createApp(graphPath, undefined, {
  configPath: join(VAULT, "config.json"),
  detectDeps: {
    home: "/h",
    env: { PATH: "/fake/bin" },
    fileExists: (p) => p === OC_BIN,
    run: async (cmd) => ({ ok: cmd === OC_BIN, stdout: "1.17.13", stderr: "" }),
  },
  opencode: {
    spawn: spawner.spawn,
    makeClient: oc.makeClient,
    authJsonPath: authPath,
    backoff: () => 1,
  },
});
const token = async () => (await request(app).get("/api/session")).body.token;

describe("agent routes", () => {
  it("status reports ready without leaking any password", async () => {
    const res = await request(app).get("/api/agent/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("ready");
    expect(res.body.running).toBe(false);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("password");
  });

  it("rejects session and message without recorded Agent consent, calling OpenCode zero times (R18)", async () => {
    const t = await token();
    const s = await request(app)
      .post("/api/agent/session")
      .set(TOKEN_HEADER, t)
      .send({});
    expect(s.status).toBe(403);
    expect(s.body.error).toBe("agent-consent-required");
    const m = await request(app)
      .post("/api/agent/message")
      .set(TOKEN_HEADER, t)
      .send({ sessionId: "x", text: "hi" });
    expect(m.status).toBe(403);
    expect(spawner.spawns).toHaveLength(0);
    expect(oc.calls.create).toHaveLength(0);
  });

  it("creates a session and prompts once consent is recorded", async () => {
    const t = await token();
    await request(app)
      .post("/api/integrations/config")
      .set(TOKEN_HEADER, t)
      .send({ consents: { agent: true } });
    const s = await request(app)
      .post("/api/agent/session")
      .set(TOKEN_HEADER, t)
      .send({});
    expect(s.status).toBe(200);
    expect(s.body.id).toBe("ses_123");
    expect(spawner.spawns).toHaveLength(1);
    const env = spawner.spawns[0].opts.env as Record<string, string>;
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission.bash).toBe(
      "deny",
    );
    // context seed (R15) rides along as an instructions file
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).instructions?.[0]).toContain(
      "agent-context.md",
    );
    expect(JSON.stringify(s.body)).not.toContain(env.OPENCODE_SERVER_PASSWORD);

    const m = await request(app)
      .post("/api/agent/message")
      .set(TOKEN_HEADER, t)
      .send({ sessionId: "ses_123", text: "hello agent" });
    expect(m.status).toBe(200);
    expect(oc.calls.promptAsync).toHaveLength(1);
  });

  it("streams only the requested session's events over SSE", async () => {
    const t = await token();
    const res = await request(app).get(
      `/api/agent/stream?session=ses_123&token=${t}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"sessionID":"ses_123"');
    expect(res.text).not.toContain('"sessionID":"other"');
  });

  it("rejects the stream without a valid token", async () => {
    const res = await request(app).get(
      "/api/agent/stream?session=ses_123&token=wrong",
    );
    expect(res.status).toBe(403);
  });

  it("cancel aborts the in-flight session turn", async () => {
    const t = await token();
    const res = await request(app)
      .post("/api/agent/cancel")
      .set(TOKEN_HEADER, t)
      .send({ sessionId: "ses_123" });
    expect(res.status).toBe(200);
    expect(oc.calls.abort).toHaveLength(1);
    expect((oc.calls.abort[0] as { path: { id: string } }).path.id).toBe(
      "ses_123",
    );
  });
});
