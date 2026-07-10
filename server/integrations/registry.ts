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
  /** Mutating/spending route: callers must send x-solaris-token. */
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
  /** MCP exposure additionally requires the config edit opt-in (R15/AE6). */
  mcpEditOptIn?: boolean;
}

export const REGISTRY: RegistryEntry[] = [
  {
    name: "current_view",
    description:
      "What the user is looking at RIGHT NOW: the note open in the reader, their recent research, and selectedContext.current from the one highlighted reader/research passage. Call this FIRST whenever they refer to what's on screen or selected text: 'this note', 'what I'm reading', 'this', 'the research I just did', 'esto', 'lo seleccionado'. Then use the open note's path or selectedContext source label with the other tools to answer specifics.",
    params: {
      "type": "object",
      "properties": {}
    },
    surfaces: ["voice"],
  },
  {
    name: "search_notes",
    description:
      "DISCOVER which of the user's notes exist on a topic — returns note titles + paths + a snippet, not the content. Meaning-based search first, with automatic keyword fallback that covers the WHOLE vault (every folder). Pass 'path' to scope results to a folder (e.g. 'felo/wiki'). To actually ANSWER a question from note content, use search_passages instead.",
    params: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Topic, concept, keywords, or filename to find.",
        },
        path: {
          type: "string",
          description:
            "Optional folder prefix to scope results (e.g. 'felo/wiki' or 'saas/climatia'). Omit to search the whole vault.",
        },
      },
      required: ["query"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "GET",
      path: "/api/search",
      query: { query: "q" },
    },
  },
  {
    name: "search_passages",
    description:
      "ANSWER a question from the user's notes: returns the matching passages (each with path, title, snippet, and line), not whole notes. This is the DEFAULT tool for any 'what does it say about X' / 'what did I write on Y' question. Pass 'note' (a path from an earlier result) to look only inside that one note or book; omit it to search the whole vault. Set exact=true together with 'note' to find literal occurrences of a precise word, name, number, or quote instead of meaning matches. Falls back to keyword search automatically when semantic search is unavailable.",
    params: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Specific question, topic, or (with exact=true) the literal text to find.",
        },
        note: {
          type: "string",
          description: "Optional relative path of the note to restrict the search to.",
        },
        exact: {
          type: "boolean",
          description:
            "Match the query literally instead of by meaning (requires 'note'). Default false.",
        },
      },
      required: ["query"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "GET",
      path: "/api/passages",
      query: { query: "q", note: "note" },
    },
  },
  {
    name: "read_passage",
    description:
      "Expand context around a location you ALREADY know: reads a line range of one note and returns it as a snippet. Use for 'read me more', 'what's around that', 'go on'. Give 'note' (its path) and 'line' (from an earlier search_passages result).",
    params: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "Relative path of the note.",
        },
        line: {
          type: "integer",
          description: "Approximate line to expand.",
        },
        count: {
          type: "integer",
          description: "How many lines to read (default 60).",
        },
      },
      required: ["note", "line"],
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      method: "GET",
      path: "/api/note-lines",
      query: { note: "id", line: "from", count: "count" },
    },
  },
  {
    name: "browse_folder",
    description:
      "See how the vault is organized: the subfolders (with note counts) and notes directly inside a folder. Omit 'path' for the top level, or give a folder path to look inside it and navigate down. Use for 'what folders do I have', 'how is my vault organized', '¿qué hay en la carpeta saas?', 'las notas dentro de X', or to FIND WHERE a kind of note lives (meetings usually sit in a 'reuniones' subfolder, etc.). This covers the WHOLE vault, including folders the semantic search does not index.",
    params: {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Folder path to look inside (e.g. 'saas' or 'saas/climatia'). Omit for the top level."
        }
      }
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      "method": "GET",
      "path": "/api/tree",
      "query": {
        "path": "path"
      }
    },
  },
  {
    name: "open_note",
    description:
      "Open a vault note in the reader and get a preview. Give 'note' as a vault-relative .md path from a previous result or current_view. Do NOT use this for http(s) URLs; use open_resource or fetch_url for links.",
    params: {
      "type": "object",
      "properties": {
        "note": {
          "type": "string",
          "description": "Relative path of the note to open."
        }
      },
      "required": [
        "note"
      ]
    },
    surfaces: ["voice"],
  },
  {
    name: "open_resource",
    description:
      "Open whatever the user points at: an http(s) URL opens as a temporary web article in research, a research-history id reopens that stored research entry, and a vault-relative .md path opens the note reader. Use this for 'open that link/result/resource' when the domain may be ambiguous.",
    params: {
      "type": "object",
      "properties": {
        "target": {
          "type": "string",
          "description": "URL, research-history id, or vault-relative .md note path."
        }
      },
      "required": [
        "target"
      ]
    },
    surfaces: ["voice"],
  },
  {
    name: "open_last_note",
    description:
      "Reopen the most recently viewed note in the reader (even if nothing is open now) and get a preview of it — the voice equivalent of the reader's history button. Use for 'open the last note', 'reopen what I was reading', 'abre la última nota'. No arguments.",
    params: {
      "type": "object",
      "properties": {}
    },
    surfaces: ["voice"],
  },
  {
    name: "open_last_research",
    description:
      "Reopen the most recent research result in the research panel and get its question + answer. Use for 'open the last research', 'show my last search', 'abre la última investigación'. No arguments.",
    params: {
      "type": "object",
      "properties": {}
    },
    surfaces: ["voice"],
  },
  {
    name: "list_wikis",
    description:
      "List the enabled Admin-configured wikis, their vault-relative paths, raw folders, and contract files. Use before saving a working document into a wiki or raw folder. If only one wiki is returned, use it by default; if multiple are returned, choose from user context or ask.",
    params: {
      "type": "object",
      "properties": {}
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      "method": "GET",
      "path": "/api/wikis"
    },
  },
  {
    name: "read_wiki_contract",
    description:
      "Read the selected wiki's contract files (AGENTS.md, CLAUDE.md, index.md, README.md when present). Use before creating a structured wiki note so the note follows that wiki's node types, folders, wikilinks, sources, and connection conventions.",
    params: {
      "type": "object",
      "properties": {
        "wikiId": {
          "type": "string",
          "description": "Wiki id or path from list_wikis."
        }
      },
      "required": [
        "wikiId"
      ]
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      "method": "GET",
      "path": "/api/wiki-contracts",
      "query": {
        "wikiId": "wikiId"
      }
    },
  },
  {
    name: "write_document",
    description:
      "Create or update a temporary working document shown in the research panel. Use operation='create' for a separate new artifact, draft, alternate version, or second document. Use operation='update' with documentId when revising a known document. If operation is omitted, the current active document is updated; if none exists, a new one is created. Always pass the COMPLETE new markdown, never a fragment, because it REPLACES that document in place. The user can then save it as a vault note.",
    params: {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "description": "Document title."
        },
        "operation": {
          "type": "string",
          "description": "Optional: 'create' for a separate new document, or 'update' to revise an existing document."
        },
        "documentId": {
          "type": "string",
          "description": "Optional id of the temporary document to update."
        },
        "markdown": {
          "type": "string",
          "description": "The complete document body in markdown."
        }
      },
      "required": [
        "title",
        "markdown"
      ]
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      "method": "POST",
      "path": "/api/document",
      "tokenRequired": true,
      "body": {
        "documentId": "id",
        "title": "title",
        "markdown": "content"
      }
    },
  },
  {
    name: "save_working_document",
    description:
      "Promote the current working document out of temporary history into the vault. Use kind='wiki_note' for a structured note inside the selected wiki, after read_wiki_contract and any needed write_document revision. Use kind='raw_copy' to save the document as a raw source copy in the selected wiki's raw folder. On success it rescans and opens the saved note, and removes the temporary document from history.",
    params: {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "description": "Either 'wiki_note' or 'raw_copy'. Defaults to wiki_note."
        },
        "wikiId": {
          "type": "string",
          "description": "Wiki id or path from list_wikis. Optional only when exactly one wiki is enabled."
        },
        "path": {
          "type": "string",
          "description": "Optional vault-relative .md path for wiki_note, chosen from the wiki contract. Must stay under the selected wiki."
        },
        "title": {
          "type": "string",
          "description": "Optional title override for the saved note."
        },
        "documentId": {
          "type": "string",
          "description": "Optional id of the temporary document to save. Defaults to the active document."
        }
      }
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      "method": "POST",
      "path": "/api/document/{documentId}/promote",
      "tokenRequired": true,
      "body": {
        "kind": "kind",
        "wikiId": "wikiId",
        "path": "path",
        "title": "title"
      }
    },
  },
  {
    name: "edit_vault_note",
    description:
      "Edit an EXISTING vault note in place — replace its full content. Give 'note' (the vault-relative .md path from a previous result) and 'markdown' (the COMPLETE new body, not a fragment). Use when the user asks to revise, add to, or fix a note that is already in the vault: 'edita X', 'add sources to that note', 'arregla eso', 'actualiza la nota'. Always pass the full markdown including the unchanged parts. On success it rescans and reopens the note.",
    params: {
      "type": "object",
      "properties": {
        "note": {
          "type": "string",
          "description": "Vault-relative .md path of the note to edit."
        },
        "markdown": {
          "type": "string",
          "description": "The complete new markdown body for the note."
        }
      },
      "required": [
        "note",
        "markdown"
      ]
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      "method": "PUT",
      "path": "/api/notes",
      "tokenRequired": true,
      "body": {
        "note": "id",
        "markdown": "content"
      }
    },
    mcpEditOptIn: true,
  },
  {
    name: "archive_vault_note",
    description:
      "Archive a saved vault note by moving it to the Admin-configured archive folder. Use for delete/remove/trash/archive requests: this is NOT a hard delete. Give 'note' (the vault-relative .md path from current_view or a previous result). If the user says 'this note', call current_view first.",
    params: {
      "type": "object",
      "properties": {
        "note": {
          "type": "string",
          "description": "Vault-relative .md path of the note to archive."
        }
      },
      "required": [
        "note"
      ]
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      "method": "POST",
      "path": "/api/archive",
      "tokenRequired": true,
      "body": {
        "note": "id"
      }
    },
  },
  {
    name: "web_research",
    description:
      "Search the WEB (not their vault) and return a synthesized answer with sources, via Exa deep research. Use when they ask about the wider world, current facts, or anything NOT in their own notes — 'look it up', 'search the web for X', 'investiga X en la web', 'qué dice internet sobre…'. Spends the user's Exa credit and needs Web mode enabled. The result also opens in their research panel.",
    params: {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "What to research on the web."
        }
      },
      "required": [
        "query"
      ]
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      "method": "POST",
      "path": "/api/research",
      "tokenRequired": true,
      "body": {
        "query": "query"
      }
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch the FULL text of a specific web page by its URL, via Exa. Use when they give you a link or ask to read/summarize a page: 'read this article', 'what does this page say', 'lee este enlace'. Give the exact http(s) URL. Spends Exa credit and needs Web mode. The result also opens in their research panel.",
    params: {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "The exact http(s) URL to fetch."
        }
      },
      "required": [
        "url"
      ]
    },
    surfaces: ["voice", "mcp", "cli"],
    route: {
      "method": "POST",
      "path": "/api/article",
      "tokenRequired": true,
      "body": {
        "url": "url"
      }
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
        title: { type: "string", description: "Note title (used to derive the filename)." },
        path: { type: "string", description: "Optional vault-relative .md path." },
        content: { type: "string", description: "The complete note body in markdown." },
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
      body: { title: "title", path: "path", content: "content", destination: "destination" },
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
