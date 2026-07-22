import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { REGISTRY, entryFor, operationTier, toolsForSurface } from "./registry";
import { createVoiceToolSession, VOICE_TOOLS } from "./voice-tools";
import { realtimeVoiceTools } from "./voice";

describe("registry → voice derivation (characterization, U4)", () => {
  it("derives the research curation capabilities from the registry", () => {
    const tools = new Map(VOICE_TOOLS.map((tool) => [tool.name, tool]));
    expect(tools.get("save_research_to_inbox")).toMatchObject({
      parameters: { properties: { researchId: expect.any(Object) } },
    });
    expect(tools.get("propose_wiki_ingest")).toMatchObject({
      parameters: {
        properties: {
          researchId: expect.any(Object),
          sourceNote: expect.any(Object),
          wikiId: expect.any(Object),
        },
      },
    });
    expect(tools.get("apply_wiki_ingest")).toMatchObject({
      parameters: {
        required: ["wikiId", "operations"],
        properties: {
          operations: {
            type: "ARRAY",
            items: { type: "OBJECT", required: ["type", "path"] },
          },
        },
      },
    });
  });

  it("realtime conversion still lowercases every type", () => {
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) {
        o.forEach(walk);
        return;
      }
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (k === "type" && typeof v === "string")
          expect(v).toBe(v.toLowerCase());
        else walk(v);
      }
    };
    const tools = realtimeVoiceTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      VOICE_TOOLS.map((tool) => tool.name),
    );
    walk(tools);
  });
});

describe("registry surfaces and routes", () => {
  it("keeps browser actions voice-only while exposing the active view everywhere", () => {
    const voiceOnly = ["open_resource", "open_last_note", "open_last_research"];
    const mcpNames = toolsForSurface("mcp").map((e) => e.name);
    for (const name of voiceOnly) {
      expect(entryFor(name)?.surfaces).toEqual(["voice"]);
      expect(mcpNames).not.toContain(name);
    }
    expect(entryFor("current_view")?.surfaces).toEqual(["voice", "mcp", "cli"]);
    expect(entryFor("current_view")?.route).toMatchObject({
      method: "GET",
      path: "/api/current-view",
      tokenRequired: true,
    });
    expect(entryFor("open_note")?.surfaces).toEqual(["voice", "mcp", "cli"]);
    expect(entryFor("open_note")?.route).toMatchObject({
      method: "POST",
      path: "/api/current-view/open-note",
      tokenRequired: true,
    });
  });

  it("exposes search + write tools on mcp with route bindings", () => {
    const mcp = toolsForSurface("mcp");
    const names = mcp.map((e) => e.name);
    for (const expected of [
      "search_vault",
      "current_view",
      "read_note",
      "browse_folder",
      "list_wikis",
      "read_wiki_contract",
      "read_working_document",
      "save_research_to_inbox",
      "propose_wiki_ingest",
      "apply_wiki_ingest",
      "create_note",
      "edit_vault_note",
      "archive_vault_note",
      "web_research",
    ])
      expect(names).toContain(expected);
    for (const e of mcp) expect(e.route, e.name).toBeDefined();
  });

  it("consolidates discovery into one search_vault tool on voice/mcp/cli", () => {
    // search_notes and search_passages are gone everywhere.
    expect(entryFor("search_notes")).toBeUndefined();
    expect(entryFor("search_passages")).toBeUndefined();
    const sv = entryFor("search_vault");
    expect(sv?.surfaces).toEqual(["voice", "mcp", "cli"]);
    expect(sv?.route?.path).toBe("/api/search-vault");
    const props = (sv?.params.properties ?? {}) as Record<string, unknown>;
    expect(props).toHaveProperty("queries");
    expect(props).toHaveProperty("mode");
    expect(props).toHaveProperty("path");
    const mode = props.mode as { enum?: string[] };
    expect(mode.enum).toEqual(["auto", "semantic", "exact", "path"]);
    // read_passage is retired; read_note replaces it on every surface.
    expect(entryFor("read_passage")).toBeUndefined();
    expect(entryFor("read_note")?.surfaces).toEqual(["voice", "mcp", "cli"]);
    expect(entryFor("browse_folder")?.surfaces).toEqual([
      "voice",
      "mcp",
      "cli",
    ]);
  });

  it("documents Discover/Verify guidance and rank-vs-score in the three discovery tool descriptions", () => {
    const sv = entryFor("search_vault")?.description ?? "";
    const rn = entryFor("read_note")?.description ?? "";
    const bf = entryFor("browse_folder")?.description ?? "";
    // Modes + multi-query + rank/score guidance in search_vault.
    expect(sv).toContain("'auto'");
    expect(sv).toContain("'semantic'");
    expect(sv).toContain("'exact'");
    expect(sv).toContain("'path'");
    expect(sv).toContain("newline-separated variants");
    expect(sv).toContain("RECOMMENDED reading order");
    expect(sv).toContain("NOT comparable across modes");
    // search_vault: when NOT to use + empty-results discipline.
    expect(sv).toContain("when the note or path is unknown");
    expect(sv).toContain("In 'auto', keyword is the fallback");
    expect(sv).toContain("use read_note");
    expect(sv).toContain("use browse_folder");
    expect(sv).toContain("EMPTY RESULTS ARE A SIGNAL");
    expect(sv).toContain("never repeat the exact same");
    // read_note: both modes + when NOT to use.
    expect(rn).toContain("ANCHORED");
    expect(rn).toContain("RANGE/PAGINATION");
    expect(rn).toContain("'line'");
    expect(rn).toContain("'before'");
    expect(rn).toContain("'after'");
    expect(rn).toContain("'from'");
    expect(rn).toContain("'count'");
    expect(rn).toContain("use search_vault");
    expect(rn).toContain("use browse_folder");
    expect(rn).toContain("never pass an invented path");
    // browse_folder: subfolder count vs direct notes distinction.
    expect(bf).toContain("DIRECTLY");
    expect(bf).toContain("up to 40");
    expect(bf).toContain("noteCount");
    expect(bf).toContain("recursive");
    expect(bf).toContain("drill");
    expect(bf).toContain("TOP-DOWN");
    expect(bf).toContain("use search_vault");
    expect(bf).toContain("use read_note");
  });

  it("keeps create_note off the voice surface (voice uses working documents)", () => {
    expect(entryFor("create_note")?.surfaces).not.toContain("voice");
    expect(VOICE_TOOLS.map((t) => t.name)).not.toContain("create_note");
  });

  it("gates in-place editing behind the MCP opt-in flag", () => {
    expect(entryFor("edit_vault_note")?.mcpEditOptIn).toBe(true);
    const others = REGISTRY.filter(
      (e) => e.mcpEditOptIn && e.name !== "edit_vault_note",
    );
    expect(others).toEqual([]);
  });

  it("registers the four LLM operations with their tiers (R8)", () => {
    expect(operationTier("note_questions")).toBe("worker");
    expect(operationTier("commit_message")).toBe("worker");
    expect(operationTier("contextual_rewrite")).toBe("worker");
    expect(operationTier("wiki_ingest_synthesis")).toBe("thinker");
  });

  it("ships the tool-usage flows fixture documenting the three declared flows", () => {
    const fixturePath = new URL(
      "./__fixtures__/tool-usage-flows.md",
      import.meta.url,
    );
    expect(existsSync(fixturePath)).toBe(true);
    const md = readFileSync(fixturePath, "utf-8");
    expect(md).toContain("Discover → Verify → Act");
    expect(md).toContain("Flow 1");
    expect(md).toContain("Flow 2");
    expect(md).toContain("Flow 3");
    expect(md).toContain("search_vault");
    expect(md).toContain("read_note");
    expect(md).toContain("browse_folder");
    expect(md).toContain("read_wiki_contract");
    expect(md).toContain("propose_wiki_ingest");
    expect(md).toContain("apply_wiki_ingest");
    expect(md).toContain("Never repeat the same");
    expect(md).toContain("without explicit user approval");
    expect(md).toContain("backend guards");
    expect(md).toContain("up to 40");
  });
});

describe("token-required dispatch (mutating routes send the header)", () => {
  // Canned args per tool so each mutating voice tool actually reaches its
  // bound route through the session dispatch.
  const ARGS: Record<string, Record<string, unknown>> = {
    write_document: { operation: "create", title: "T", markdown: "body" },
    save_research_to_inbox: { researchId: "doc-x" },
    propose_wiki_ingest: { researchId: "doc-x", wikiId: "w" },
    apply_wiki_ingest: { wikiId: "w", operations: [] },
    edit_vault_note: { note: "a.md", markdown: "new" },
    archive_vault_note: { note: "a.md" },
    web_research: { query: "q" },
    fetch_url: { url: "https://example.com" },
  };

  it("every voice entry with a token-required route sends x-sinapso-token", async () => {
    const tokenTools = toolsForSurface("voice").filter(
      // current_view is served directly from the voice session; its route is
      // for MCP/CLI to read the frontend-published snapshot.
      (e) =>
        e.route?.tokenRequired &&
        e.name !== "current_view" &&
        e.name !== "open_note",
    );
    expect(tokenTools.length).toBeGreaterThanOrEqual(6);
    for (const entry of tokenTools) {
      const seen: Array<{ url: string; token: string | undefined }> = [];
      const fetchFn = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (init?.method && init.method !== "GET")
          seen.push({ url, token: headers["x-sinapso-token"] });
        if (url.includes("/api/research/history"))
          return new Response(
            JSON.stringify({
              entries: [
                { id: "doc-x", mode: "document", document: { title: "T" } },
              ],
            }),
            { status: 200 },
          );
        return new Response(
          JSON.stringify({ ok: true, id: "x", revision: "rev-1" }),
          { status: 200 },
        );
      }) as typeof fetch;
      const session = createVoiceToolSession({
        base: "http://127.0.0.1:9",
        fetchFn,
        getSessionToken: () => "tok-123",
        send: () => {},
      });
      expect(
        ARGS[entry.name],
        `canned args missing for ${entry.name}`,
      ).toBeDefined();
      await session.run(entry.name, ARGS[entry.name]);
      expect(seen.length, entry.name).toBeGreaterThan(0);
      for (const req of seen) expect(req.token, req.url).toBe("tok-123");
    }
  });

  it("unknown tool names keep the existing error shape", async () => {
    const session = createVoiceToolSession({
      base: "http://127.0.0.1:9",
      fetchFn: (async () => new Response("{}")) as typeof fetch,
      getSessionToken: () => "t",
      send: () => {},
    });
    expect(await session.run("nope", {})).toEqual({
      error: "unknown tool nope",
    });
  });
});
