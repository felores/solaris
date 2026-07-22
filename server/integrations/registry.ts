/**
 * Operation/tool registry (R7, KTD1): the single declaration catalog for
 * every LLM operation and voice tool — name, description, provider-neutral
 * JSON-schema params (lowercase types), tier for LLM-calling operations,
 * surfaces, and route binding. It is a catalog plus route bindings, NOT a
 * new execution layer: routes keep their guards, voice keeps loopback-HTTP
 * dispatch (the documented testability boundary), and derived declarations
 * (Gemini FunctionDeclarations, OpenAI/xAI realtime schemas, MCP tools,
 * CLI) are generated from these entries instead of duplicated.
 *
 * Surface scoping (R11, R15, R17): browser-bound tools (current_view,
 * open_*) are voice-only; write tools ride voice+mcp+cli through the
 * sanctioned write path; in-place editing over MCP additionally needs the
 * config opt-in (mcpEditOptIn). The server-side token guard checks a
 * surface-scoped token against these declarations, so scoping is enforced
 * on the server, not only inside a bridge.
 */

import type { LlmTier } from "./llm.js";

export type Surface = "voice" | "http" | "mcp" | "cli";

export interface RouteBinding {
  method: "GET" | "POST" | "PUT";
  /** Route path; "{param}" segments are filled from same-named args. */
  path: string;
  /** Mutating/spending route: callers must send x-sinapso-token. */
  tokenRequired?: boolean;
  /** GET bindings: tool arg name → query parameter name. */
  query?: Record<string, string>;
  /** POST/PUT bindings: tool arg name → JSON body field name. */
  body?: Record<string, string>;
}

export interface RegistryEntry {
  name: string;
  description: string;
  /** Provider-neutral JSON-schema params (lowercase types). */
  params: Record<string, unknown>;
  surfaces: Surface[];
  /** LLM-calling operations declare their tier here (R8). */
  tier?: LlmTier;
  route?: RouteBinding;
  /** Additional routes selected by this tool's bridge compatibility logic. */
  mcpRoutes?: RouteBinding[];
  /** MCP exposure additionally requires the config edit opt-in (R15/AE6). */
  mcpEditOptIn?: boolean;
}

export const REGISTRY: RegistryEntry[] = [
  {
    name: "current_view",
    description:
      "What the active Sinapso window shows RIGHT NOW, published by the frontend rather than inferred from server history: whether view state is known, the reader note, research panel open state, visible and pinned research ids, plus a bounded summary of visible Research. Voice also receives selectedContext.current; MCP/CLI intentionally do not. Call this FIRST whenever the user refers to what's on screen. If viewStateKnown is false, say the app has no active view rather than guessing.",
    params: {
      type: "object",
      properties: {},
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "GET",
      path: "/api/current-view",
      tokenRequired: true,
    },
  },
  {
    name: "search_vault",
    description:
      "DISCOVER step when the note or path is unknown. Search the user's OWN vault notes and return normalized, bounded, RANKED results — one tool for every discovery need. Pass 'queries' (newline-separated variants of the same intent, e.g. 'renewable energy\\nsolar panels') to widen recall in a single call, and 'path' to scope to a folder. Modes: 'auto' (default) is a HYBRID — it runs BOTH meaning/semantic and keyword full-text, then fuses them with Reciprocal Rank Fusion (RRF) so the two engines' scores are never compared directly; 'semantic' meaning only; 'exact' literal occurrences everywhere with path, line, context, and matched terms; 'path' matches note paths/basenames/titles. Use this for BOTH 'which notes exist on X' (auto/path) and 'what do my notes say about Y' (auto/exact). In 'auto', keyword is the fallback when semantic search is unavailable. Each result carries a stable 1-based 'rank' (the RECOMMENDED reading order — follow it top-down), a 'score', a 'scoreKind' (rrf/semantic/keyword/exact/path), and 'sources' (engines that found it, in auto mode). IMPORTANT: raw 'score' values are NOT comparable across modes or scoreKinds — always order by 'rank' and read 'snippet'/'line' context to judge relevance, never by comparing scores from different engines. Do NOT use search_vault to read a note you already have a path for (use read_note) or to list folders (use browse_folder). EMPTY RESULTS ARE A SIGNAL, NOT AN ANSWER: if 'auto' returns nothing, retry with mode 'exact' for a precise term/quote/id, mode 'path' if the query looks like a file/route/title, drop or rephrase a variant, widen or narrow the 'path' scope — never repeat the exact same (queries, mode, path) call unchanged.",
    params: {
      type: "object",
      properties: {
        queries: {
          type: "string",
          description:
            "One query, or several variants of the same intent separated by newlines (e.g. 'renewable energy\\nsolar panels'). More variants = wider recall in one call.",
        },
        mode: {
          type: "string",
          enum: ["auto", "semantic", "exact", "path"],
          description:
            "auto = hybrid RRF over semantic+keyword (default). semantic = meaning only. exact = literal occurrences (path, line, context, terms). path = match note paths/basenames/titles.",
        },
        path: {
          type: "string",
          description:
            "Optional folder prefix to scope results (e.g. 'felo/wiki' or 'saas/climatia'). Omit to search the whole vault.",
        },
        note: {
          type: "string",
          description:
            "Optional relative path of one note to restrict the search to (exact mode).",
        },
        limit: {
          type: "integer",
          description: "Max results to return (default 8, max 20).",
        },
      },
      required: ["queries"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "GET",
      path: "/api/search-vault",
      query: {
        queries: "queries",
        mode: "mode",
        path: "path",
        note: "note",
        limit: "limit",
      },
    },
  },
  {
    name: "read_note",
    description:
      "VERIFY step: read a slice of ONE vault note by path and return it with line metadata {from, to, total}. Use this whenever you are about to cite, quote, summarize, link, or edit a note — confirm the snippet is real and read the surrounding context before you act on it. Two modes, line wins when both are given. (1) ANCHORED — give 'note' plus 'line' (1-based, from a search_vault result) to expand context AROUND that line: 'before' lines before it AND 'after' lines after it (default 5 each). Use for 'read me more around that', 'what's before/after this', 'go on', 'sigue'. (2) RANGE/PAGINATION — give 'note' plus 'from' (1-based start line, default 1) and 'count' (lines to read, default 60) to read an initial chunk or page forward/back. Never returns more than 400 lines; give a larger 'count' or a new 'from' to read more. The note must be an existing .md file inside the vault. Do NOT use read_note to discover notes (use search_vault) or navigate folders (use browse_folder); never pass an invented path — get the path from a previous result or current_view first.",
    params: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "Vault-relative .md path of the note to read.",
        },
        line: {
          type: "integer",
          description:
            "1-based line to center context on (anchored mode). Takes precedence over from/count when present.",
        },
        before: {
          type: "integer",
          description:
            "Lines to include BEFORE the anchor (anchored mode, default 5).",
        },
        after: {
          type: "integer",
          description:
            "Lines to include AFTER the anchor (anchored mode, default 5).",
        },
        from: {
          type: "integer",
          description:
            "1-based start line (range mode, default 1). Ignored when 'line' is given.",
        },
        count: {
          type: "integer",
          description:
            "Lines to read (range mode, default 60, capped at 400). Ignored when 'line' is given.",
        },
      },
      required: ["note"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "GET",
      path: "/api/note-lines",
      query: {
        note: "id",
        line: "line",
        before: "before",
        after: "after",
        from: "from",
        count: "count",
      },
    },
  },
  {
    name: "browse_folder",
    description:
      "DISCOVER step when scope is unknown: see how the vault is organized. Returns the subfolders (each with a note 'count') and up to 40 notes DIRECTLY inside a folder; 'noteCount' is the total number of direct notes before that cap. Omit 'path' for the top level, or give a folder path to drill INTO it. Use for 'what folders do I have', 'how is my vault organized', '¿qué hay en la carpeta saas?', 'las notas dentro de X', or to FIND WHERE a kind of note lives (meetings usually sit in a 'reuniones' subfolder, etc.). This covers the WHOLE vault, including folders the semantic search does not index. IMPORTANT: a subfolder's 'count' is the TOTAL number of notes anywhere under that subfolder tree (recursive, nested subfolders included). To see inside a subfolder, call browse_folder again with that subfolder's path. Navigate TOP-DOWN from the root when you don't know the layout. Do NOT use browse_folder to search note contents (use search_vault) or to read one note (use read_note).",
    params: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Folder path to look inside (e.g. 'saas' or 'saas/climatia'). Omit for the top level.",
        },
      },
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "GET",
      path: "/api/tree",
      query: {
        path: "path",
      },
    },
  },
  {
    name: "open_note",
    description:
      "Open a known vault note in the active Sinapso reader. Give 'note' as a vault-relative .md path from a previous result or current_view. Voice opens it immediately; MCP/CLI queue it for the active desktop window. Do NOT use this for http(s) URLs; use open_resource or fetch_url for links.",
    params: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "Relative path of the note to open.",
        },
      },
      required: ["note"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "POST",
      path: "/api/current-view/open-note",
      tokenRequired: true,
      body: { note: "note" },
    },
  },
  {
    name: "open_resource",
    description:
      "Open whatever the user points at: an http(s) URL opens as a temporary web article in research, a research-history id reopens that stored research entry, and a vault-relative .md path opens the note reader. Use this for 'open that link/result/resource' when the domain may be ambiguous.",
    params: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "URL, research-history id, or vault-relative .md note path.",
        },
      },
      required: ["target"],
    },
    surfaces: ["voice"],
  },
  {
    name: "open_last_note",
    description:
      "Reopen the most recently viewed note in the reader (even if nothing is open now) and get a preview of it — the voice equivalent of the reader's history button. Use for 'open the last note', 'reopen what I was reading', 'abre la última nota'. No arguments.",
    params: {
      type: "object",
      properties: {},
    },
    surfaces: ["voice"],
  },
  {
    name: "open_last_research",
    description:
      "Reopen the most recent research result in the research panel and get its question + answer. Use for 'open the last research', 'show my last search', 'abre la última investigación'. No arguments.",
    params: {
      type: "object",
      properties: {},
    },
    surfaces: ["voice"],
  },
  {
    name: "list_wikis",
    description:
      "List the enabled Admin-configured wikis, their vault-relative paths, raw folders, and contract files. Use before saving a working document into a wiki or raw folder. If only one wiki is returned, use it by default; if multiple are returned, choose from user context or ask.",
    params: {
      type: "object",
      properties: {},
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "GET",
      path: "/api/wikis",
    },
  },
  {
    name: "read_wiki_contract",
    description:
      "Read the selected wiki's contract files (AGENTS.md, CLAUDE.md, index.md, README.md when present). Use before creating a structured wiki note so the note follows that wiki's node types, folders, wikilinks, sources, and connection conventions.",
    params: {
      type: "object",
      properties: {
        wikiId: {
          type: "string",
          description: "Wiki id or path from list_wikis.",
        },
      },
      required: ["wikiId"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "GET",
      path: "/api/wiki-contracts",
      query: {
        wikiId: "wikiId",
      },
    },
  },
  {
    name: "write_document",
    description:
      "Create or update a durable Markdown note in the configured Inbox. New work is vault-backed: use operation='create' with a required title plus the COMPLETE markdown to create a new note (the server picks the path under the Inbox and returns { path, baseHash }); for an update, FIRST call read_working_document on the same note to get its current baseHash, then send operation='update' with { note, baseHash, markdown } — the compare-and-swap rejects a stale hash. Legacy mode=document entries (an existing documentId from prior sessions) remain editable with { documentId, revision }; unknown legacy ids are rejected. Never invent a documentId for create.",
    params: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Document title (required for create).",
        },
        operation: {
          type: "string",
          description:
            "Required: either 'create' or 'update'. Create writes a new Inbox note; update replaces an existing note or legacy document.",
          enum: ["create", "update"],
        },
        note: {
          type: "string",
          description:
            "Vault-relative .md path of the note to update (vault-backed update).",
        },
        baseHash: {
          type: "string",
          description:
            "SHA-256 base hash returned by read_working_document for the note's current content. Required for a vault-backed update (compare-and-swap).",
        },
        documentId: {
          type: "string",
          description:
            "Existing legacy mode=document id. Accepted ONLY when it already resolves to a persisted legacy entry; rejected for create or unknown ids.",
        },
        revision: {
          type: "string",
          description:
            "Revision returned by read_working_document for a legacy entry. Required for a legacy update.",
        },
        markdown: {
          type: "string",
          description: "The complete document body in markdown.",
        },
      },
      required: ["operation", "markdown"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "POST",
      path: "/api/agent/notes",
      tokenRequired: true,
      body: {
        title: "title",
        note: "id",
        markdown: "content",
        baseHash: "baseHash",
      },
    },
    mcpRoutes: [
      { method: "PUT", path: "/api/agent/notes", tokenRequired: true },
      { method: "POST", path: "/api/document", tokenRequired: true },
    ],
  },
  {
    name: "read_working_document",
    description:
      "Read the complete markdown and current revision/hash of a working document before replacing it. Vault-backed work uses { note } and returns { note, markdown, baseHash, title }; legacy mode=document entries use { documentId } and return { id, title, content, revision }. The returned baseHash/revision is required for the next update's compare-and-swap.",
    params: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description:
            "Vault-relative .md path of the note to read (vault-backed work).",
        },
        documentId: {
          type: "string",
          description:
            "Existing legacy mode=document id (legacy compatibility only).",
        },
      },
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "GET",
      path: "/api/note",
      query: {
        note: "id",
      },
    },
    mcpRoutes: [{ method: "GET", path: "/api/document/{documentId}" }],
  },
  {
    name: "save_research_to_inbox",
    description:
      "Save one persisted web, article, or temporary working-document research entry to the configured Inbox. The history entry is removed only after the guarded write succeeds.",
    params: {
      type: "object",
      properties: {
        researchId: {
          type: "string",
          description:
            "Persisted research id. Voice defaults to the active web research, fetched article, or working document.",
        },
      },
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "POST",
      path: "/api/research/history/{researchId}/save-inbox",
      tokenRequired: true,
    },
  },
  {
    name: "propose_wiki_ingest",
    description:
      "Build a wiki-ingest preview from a persisted research entry or an existing Inbox note. The server reads the selected wiki contract and plans the exact canonical RAW source path. This preview writes nothing; the caller must present it and obtain explicit user approval before calling apply_wiki_ingest.",
    params: {
      type: "object",
      properties: {
        researchId: {
          type: "string",
          description:
            "Persisted web, article, or working-document research id.",
        },
        sourceNote: {
          type: "string",
          description:
            "Existing Inbox note path to move first to the selected wiki's exact canonical RAW path.",
        },
        wikiId: {
          type: "string",
          description: "Target enabled wiki id or path.",
        },
      },
    },
    surfaces: ["voice", "mcp", "cli"],
    tier: "thinker",
    route: {
      method: "POST",
      path: "/api/wiki-ingest/propose",
      tokenRequired: true,
    },
  },
  {
    name: "apply_wiki_ingest",
    description:
      "Apply a previously shown wiki-ingest proposal only after explicit user approval. The caller is responsible for obtaining that approval; the server validates the token, wiki, source state, and operations but cannot prove human approval. RAW source storage or an Inbox-note move runs first at its exact canonical path, then derived create/edit operations.",
    params: {
      type: "object",
      properties: {
        wikiId: {
          type: "string",
          description: "Target enabled wiki id or path.",
        },
        operations: {
          type: "array",
          description:
            "Operations returned by propose_wiki_ingest without modification.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["create", "edit", "move"] },
              path: { type: "string" },
              content: { type: "string" },
              title: { type: "string" },
              raw: { type: "boolean" },
              sourceNote: { type: "string" },
            },
            required: ["type", "path"],
          },
        },
        researchId: {
          type: "string",
          description: "Research id returned by propose_wiki_ingest.",
        },
        sourceNote: {
          type: "string",
          description: "Inbox note path returned by propose_wiki_ingest.",
        },
      },
      required: ["wikiId", "operations"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "POST",
      path: "/api/wiki-ingest/apply",
      tokenRequired: true,
    },
  },
  {
    name: "edit_vault_note",
    description:
      "Edit an EXISTING vault note in place — replace its full content. Give 'note' (the vault-relative .md path from a previous result) and 'markdown' (the COMPLETE new body, not a fragment). Use when the user asks to revise, add to, or fix a note that is already in the vault: 'edita X', 'add sources to that note', 'arregla eso', 'actualiza la nota'. Always pass the full markdown including the unchanged parts. On success it rescans and reopens the note.",
    params: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "Vault-relative .md path of the note to edit.",
        },
        markdown: {
          type: "string",
          description: "The complete new markdown body for the note.",
        },
      },
      required: ["note", "markdown"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "PUT",
      path: "/api/notes",
      tokenRequired: true,
      body: {
        note: "id",
        markdown: "content",
      },
    },
    mcpEditOptIn: true,
  },
  {
    name: "archive_vault_note",
    description:
      "Archive a saved vault note by moving it to the Admin-configured archive folder. Use for delete/remove/trash/archive requests: this is NOT a hard delete. Give 'note' (the vault-relative .md path from current_view or a previous result). If the user says 'this note', call current_view first.",
    params: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "Vault-relative .md path of the note to archive.",
        },
      },
      required: ["note"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "POST",
      path: "/api/archive",
      tokenRequired: true,
      body: {
        note: "id",
      },
    },
  },
  {
    name: "web_research",
    description:
      "Search the WEB (not their vault) and return a synthesized answer with sources, via Exa deep research. Use when they ask about the wider world, current facts, or anything NOT in their own notes — 'look it up', 'search the web for X', 'investiga X en la web', 'qué dice internet sobre…'. Spends the user's Exa credit and needs Web mode enabled. The result also opens in their research panel.",
    params: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to research on the web.",
        },
      },
      required: ["query"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "POST",
      path: "/api/research",
      tokenRequired: true,
      body: {
        query: "query",
      },
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch the FULL text of a specific web page by its URL, via Exa. Use when they give you a link or ask to read/summarize a page: 'read this article', 'what does this page say', 'lee este enlace'. Give the exact http(s) URL. Spends Exa credit and needs Web mode. The result also opens in their research panel.",
    params: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The exact http(s) URL to fetch.",
        },
      },
      required: ["url"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "POST",
      path: "/api/article",
      tokenRequired: true,
      body: {
        url: "url",
      },
    },
  },
  // ---- LLM operations (the static tier map, R8). Not tools: they are the
  // server-side operations that call a model, registered so tier assignment
  // has one declaration source. Routes execute them with their gates.
  {
    name: "note_questions",
    description:
      "Generate research questions for one vault note (falls back to templates without an LLM).",
    params: {
      type: "object",
      properties: {
        id: { type: "string", description: "Vault-relative note path." },
      },
      required: ["id"],
    },
    surfaces: ["http"],
    tier: "worker",
    route: { method: "GET", path: "/api/note-questions", query: { id: "id" } },
  },
  {
    name: "commit_message",
    description:
      "Generate the Git commit subject for vault sync (falls back to a counted summary without an LLM).",
    params: { type: "object", properties: {} },
    surfaces: ["http"],
    tier: "worker",
    route: { method: "POST", path: "/api/git/commit", tokenRequired: true },
  },
  {
    name: "contextual_rewrite",
    description:
      "Rewrite a web-research query using the selected reader/research context before it reaches Exa.",
    params: {
      type: "object",
      properties: {
        query: { type: "string", description: "The user's research query." },
      },
      required: ["query"],
    },
    surfaces: ["http"],
    tier: "worker",
    route: { method: "POST", path: "/api/research", tokenRequired: true },
  },
  {
    name: "selection_assist",
    description:
      "Run a free-form instruction over the reader's selected note text (with positional note context); the reply is previewed before it can replace or follow the selection.",
    params: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "What to do with the selection.",
        },
        selection: { type: "string", description: "The selected note text." },
      },
      required: ["instruction", "selection"],
    },
    surfaces: ["http"],
    tier: "thinker",
    route: {
      method: "POST",
      path: "/api/selection-assist",
      tokenRequired: true,
    },
  },
  {
    name: "wiki_ingest_synthesis",
    description:
      "Synthesize wiki create/edit proposals from a converted source document against the wiki contract.",
    params: {
      type: "object",
      properties: {
        source: { type: "string", description: "File path or URL to ingest." },
        wikiId: { type: "string", description: "Target wiki id." },
      },
      required: ["source"],
    },
    surfaces: ["http"],
    tier: "thinker",
    route: {
      method: "POST",
      path: "/api/wiki-ingest/propose",
      tokenRequired: true,
    },
  },
  // ---- MCP/CLI-only tools: vault note creation through the sanctioned
  // write path (R15). Voice creates notes via working documents instead.
  {
    name: "create_note",
    description:
      "Create a new vault note (never overwrites). Give 'content' (markdown) plus 'title' or a vault-relative .md 'path'. Without a path the note lands in the configured destination folder (inbox by default). The write is path-confined and journaled.",
    params: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Note title (used to derive the filename).",
        },
        path: {
          type: "string",
          description: "Optional vault-relative .md path.",
        },
        content: {
          type: "string",
          description: "The complete note body in markdown.",
        },
        destination: {
          type: "string",
          description: "Optional vault-relative destination folder override.",
        },
      },
      required: ["content"],
    },
    surfaces: ["mcp", "cli"],
    route: {
      method: "POST",
      path: "/api/notes",
      tokenRequired: true,
      body: {
        title: "title",
        path: "path",
        content: "content",
        destination: "destination",
      },
    },
  },
];

export function toolsForSurface(surface: Surface): RegistryEntry[] {
  return REGISTRY.filter((e) => e.surfaces.includes(surface));
}

export function entryFor(name: string): RegistryEntry | undefined {
  return REGISTRY.find((e) => e.name === name);
}

/** Tier for a registered LLM operation; worker when unregistered (safe default). */
export function operationTier(name: string): LlmTier {
  return entryFor(name)?.tier ?? "worker";
}

function pathMatches(pattern: string, actual: string): boolean {
  if (!pattern.includes("{")) return pattern === actual;
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.*+?^$()[\]\\|]/g, "\\$&")
        .replace(/\{[^}]+\}/g, "[^/]+") +
      "$",
  );
  return re.test(actual);
}

/**
 * Server-side surface check for MCP-scoped tokens (R17): the route must be
 * the binding of an entry that declares the `mcp` surface, and edit-gated
 * entries additionally need the config opt-in (AE6).
 */
export function mcpRouteAllowed(
  method: string,
  path: string,
  editEnabled: boolean,
): boolean {
  return REGISTRY.some(
    (e) =>
      e.surfaces.includes("mcp") &&
      [e.route, ...(e.mcpRoutes ?? [])].some(
        (route) => route?.method === method && pathMatches(route.path, path),
      ) &&
      (!e.mcpEditOptIn || editEnabled),
  );
}
