import { describe, it, expect } from "vitest";
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
      parameters: { required: ["wikiId", "operations"] },
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
    // realtime excludes gemini-live-only tools (the delegate, R11)
    const geminiOnly = toolsForSurface("voice").filter((e) => e.geminiLiveOnly);
    expect(tools.length).toBe(VOICE_TOOLS.length - geminiOnly.length);
    walk(tools);
  });
});

describe("registry surfaces and routes", () => {
  it("scopes browser-bound tools to voice only", () => {
    const voiceOnly = [
      "current_view",
      "open_note",
      "open_resource",
      "open_last_note",
      "open_last_research",
    ];
    const mcpNames = toolsForSurface("mcp").map((e) => e.name);
    for (const name of voiceOnly) {
      expect(entryFor(name)?.surfaces).toEqual(["voice"]);
      expect(mcpNames).not.toContain(name);
    }
  });

  it("exposes search + write tools on mcp with route bindings", () => {
    const mcp = toolsForSurface("mcp");
    const names = mcp.map((e) => e.name);
    for (const expected of [
      "search_notes",
      "search_passages",
      "read_passage",
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
    delegate_to_thinker: { task: "synthesize these notes" },
  };

  it("every voice entry with a token-required route sends x-sinapso-token", async () => {
    const tokenTools = toolsForSurface("voice").filter(
      (e) => e.route?.tokenRequired,
    );
    expect(tokenTools.length).toBeGreaterThanOrEqual(6);
    for (const entry of tokenTools) {
      const seen: Array<{ url: string; token: string | undefined }> = [];
      const fetchFn = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (init?.method && init.method !== "GET")
          seen.push({ url, token: headers["x-sinapso-token"] });
        if (url.includes("/api/delegate"))
          return new Response(
            JSON.stringify({ job: { id: "job-1", documentId: "doc-1" } }),
            { status: 200 },
          );
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
