/**
 * MCP bridge integration tests (U8): a real Sinapso app listening on an
 * ephemeral loopback port, the bridge proxying registry tools to it.
 * Covers AE4 (guarded, path-confined writes), AE6 (edit opt-in), R17
 * (surface-scoped token rejected outside the mcp surface — release-blocking),
 * token-rotation recovery, gate parity for spending tools, and the
 * cross-surface result-shape parity check.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../app";
import { createMcpBridge, mcpEntries, zodShape } from "./mcp-bridge";
import { entryFor, mcpRouteAllowed } from "./registry";
import { createVoiceToolSession } from "./voice-tools";
import { updateConfig } from "./config";
import { readChangeLog } from "./write";

const ROOT = mkdtempSync(join(tmpdir(), "sinapso-mcp-bridge-"));
const VAULT = join(ROOT, "vault");
const DATA = join(ROOT, "data");
mkdirSync(join(VAULT, "notes"), { recursive: true });
mkdirSync(DATA, { recursive: true });
writeFileSync(join(VAULT, "notes", "alpha.md"), "# Alpha\n\nalpha body text\n");
const graphPath = join(DATA, "graph.json");
writeFileSync(
  graphPath,
  JSON.stringify({
    meta: { vaultName: "t", vaultPath: VAULT, notes: 1, excludes: [] },
    nodes: [{ id: "notes/alpha.md", title: "Alpha", phantom: false }],
    links: [],
  }),
);
const configPath = join(DATA, "config.json");

function listen(): Promise<{ server: Server; base: string }> {
  const { app } = createApp(graphPath, undefined, { configPath });
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      const port = typeof a === "object" && a ? a.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

let server: Server;
let base: string;

beforeAll(async () => {
  ({ server, base } = await listen());
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(ROOT, { recursive: true, force: true });
});

describe("mcp entries and schemas", () => {
  it("excludes the edit tool by default and includes it with the opt-in (AE6)", () => {
    expect(mcpEntries(false).map((e) => e.name)).not.toContain(
      "edit_vault_note",
    );
    expect(mcpEntries(true).map((e) => e.name)).toContain("edit_vault_note");
  });

  it("converts registry params to zod shapes with required/optional split", () => {
    const shape = zodShape(entryFor("create_note")!.params);
    expect(shape.content.isOptional()).toBe(false);
    expect(shape.title.isOptional()).toBe(true);
    expect(shape.path.isOptional()).toBe(true);
  });
});

describe("bridge proxying (AE4)", () => {
  it("creates a journaled vault note through the guarded route", async () => {
    const bridge = createMcpBridge({ base });
    const before = readChangeLog(DATA).length;
    const r = await bridge.call(entryFor("create_note")!, {
      title: "From MCP",
      content: "# From MCP\n\nbody\n",
    });
    expect(r.ok).toBe(true);
    const id = (r.body as { id: string }).id;
    expect(id).toMatch(/\.md$/);
    expect(readFileSync(join(VAULT, id), "utf-8")).toContain("From MCP");
    const log = readChangeLog(DATA);
    expect(log.length).toBe(before + 1);
    expect(log.at(-1)).toMatchObject({ action: "create", path: id });
  });

  it("rejects traversal paths through the same write guard", async () => {
    const bridge = createMcpBridge({ base });
    const r = await bridge.call(entryFor("create_note")!, {
      path: "../outside.md",
      content: "escape",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).toMatch(/outside|invalid|path/i);
  });

  it("edit over MCP is rejected by default and works with the opt-in (AE6)", async () => {
    const bridge = createMcpBridge({ base });
    const edit = entryFor("edit_vault_note")!;
    const denied = await bridge.call(edit, {
      note: "notes/alpha.md",
      markdown: "# Alpha\n\nedited\n",
    });
    expect(denied.status).toBe(403); // server-side guard, not just bridge filtering
    updateConfig({ mcpEditEnabled: true }, configPath);
    const allowed = await bridge.call(edit, {
      note: "notes/alpha.md",
      markdown: "# Alpha\n\nedited via mcp\n",
    });
    expect(allowed.ok).toBe(true);
    expect(readFileSync(join(VAULT, "notes", "alpha.md"), "utf-8")).toContain(
      "edited via mcp",
    );
    updateConfig({ mcpEditEnabled: false }, configPath);
  });

  it("spending tools get the same gate error as the browser", async () => {
    const bridge = createMcpBridge({ base });
    const viaBridge = await bridge.call(entryFor("web_research")!, {
      query: "anything",
    });
    const token = (await request(`${base}`).get("/api/session")).body
      .token as string;
    const viaBrowser = await request(`${base}`)
      .post("/api/research")
      .set("x-sinapso-token", token)
      .send({ query: "anything" });
    expect(viaBridge.status).toBe(viaBrowser.status);
    expect(viaBridge.body).toEqual(viaBrowser.body);
  });
});

describe("surface-scoped token (R17, release-blocking)", () => {
  it("rejects the MCP token on routes outside the mcp surface", async () => {
    const mcpToken = (await request(`${base}`).get("/api/session?surface=mcp"))
      .body.token as string;
    // delegate is voice-only; config is browser-only
    for (const [method, path, body] of [
      ["post", "/api/delegate", { sessionId: "s", task: "t" }],
      ["post", "/api/integrations/config", { consents: { web: true } }],
    ] as const) {
      const res = await request(`${base}`)
        [method](path)
        .set("x-sinapso-token", mcpToken)
        .send(body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("the browser token still reaches every guarded route", async () => {
    const token = (await request(`${base}`).get("/api/session")).body
      .token as string;
    const res = await request(`${base}`)
      .post("/api/integrations/config")
      .set("x-sinapso-token", token)
      .send({});
    expect(res.status).toBe(200);
  });

  it("mcpRouteAllowed reflects the registry's surface + opt-in state", () => {
    expect(mcpRouteAllowed("POST", "/api/notes", false)).toBe(true);
    expect(mcpRouteAllowed("PUT", "/api/notes", false)).toBe(false); // edit gated
    expect(mcpRouteAllowed("PUT", "/api/notes", true)).toBe(true);
    expect(mcpRouteAllowed("POST", "/api/delegate", true)).toBe(false); // voice-only
    expect(mcpRouteAllowed("POST", "/api/wiki-ingest/propose", false)).toBe(
      true,
    );
    expect(mcpRouteAllowed("POST", "/api/wiki-ingest/apply", false)).toBe(true);
  });
});

describe("token rotation recovery (restart)", () => {
  it("re-fetches the token once on 403 and replays the call", async () => {
    // Faked fetch models a server restart: the first issued token goes
    // stale (403), the re-fetched one succeeds.
    let issued = 0;
    let calls = 0;
    const tokensSeen: string[] = [];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/session")) {
        issued += 1;
        return new Response(JSON.stringify({ token: `tok-${issued}` }), {
          status: 200,
        });
      }
      calls += 1;
      const tok = (init!.headers as Record<string, string>)["x-sinapso-token"];
      tokensSeen.push(tok);
      if (tok === "tok-1")
        return new Response(JSON.stringify({ error: "invalid" }), {
          status: 403,
        });
      return new Response(JSON.stringify({ ok: true, id: "n.md" }), {
        status: 200,
      });
    }) as typeof fetch;
    const bridge = createMcpBridge({ base: "http://127.0.0.1:9", fetchFn });
    const r = await bridge.call(entryFor("create_note")!, { content: "x" });
    expect(r.ok).toBe(true);
    expect(issued).toBe(2); // lazy fetch + one re-fetch on 403
    expect(calls).toBe(2); // original call + one replay
    expect(tokensSeen).toEqual(["tok-1", "tok-2"]);
  });
});

describe("cross-surface parity (HTTP = voice = MCP)", () => {
  it("browse_folder returns the same result shape on all three surfaces", async () => {
    const bridge = createMcpBridge({ base });
    const viaMcp = await bridge.call(entryFor("browse_folder")!, {
      path: "notes",
    });
    const viaHttp = await request(`${base}`).get("/api/tree?path=notes");
    const session = createVoiceToolSession({
      base,
      getSessionToken: () => "unused",
      send: () => {},
    });
    const viaVoice = await session.run("browse_folder", { path: "notes" });
    expect(viaMcp.ok).toBe(true);
    expect(viaMcp.body).toEqual(viaHttp.body);
    expect(viaVoice).toEqual(viaHttp.body);
  });
});

describe("startup probe", () => {
  it("fails with a clear error when Sinapso is down", async () => {
    const bridge = createMcpBridge({ base: "http://127.0.0.1:1" });
    await expect(bridge.probe()).rejects.toThrow();
  });

  it("reports the edit opt-in state when up", async () => {
    const bridge = createMcpBridge({ base });
    expect(await bridge.probe()).toEqual({ editEnabled: false });
  });
});
