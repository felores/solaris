/**
 * Voice tool-dispatch seam (U8, R5, KTD8).
 *
 * Pure tool layer for the voice bridge. Owns the `VOICE_TOOLS`
 * declarations, the loopback-HTTP `callTool` (read-only) and
 * `runTool` (stateful) bodies, and the mutable session state
 * (`workingDocId`, `contractWikisRead`). `voice.ts` keeps the Gemini
 * session, the audio relay, and the prompt assembly — its tool-call
 * loop delegates to a session object built here.
 *
 * The loopback-HTTP design is deliberate: it reuses the guard/consent
 * stack the existing spending routes already enforce. Do not replace
 * these `fetch` calls with direct function calls; the seam exists to
 * make this layer testable, not to collapse the integration boundary.
 *
 * `fetchFn` defaults to the global `fetch`; tests pass a fake. The
 * session token comes from `getSessionToken()` so a single token
 * rotation is observed across all calls in the same conversation.
 * `send` is the browser action side-channel (open_note, show_document,
 * open_research, open_saved_note) — also injected for full unit
 * control. Returning the session's `run` (not the whole state) means
 * a misbehaving caller cannot poke at workingDocId or the wiki set
 * directly.
 */

import type { FunctionDeclaration } from "@google/genai";
import { Type } from "@google/genai";

export type VoiceArgs = Record<string, unknown>;
export type VoiceResult = Record<string, unknown>;

export interface VoiceToolContext {
  base: string;
  fetchFn?: typeof fetch;
  getSessionToken: () => string;
  send: (obj: object) => void;
}

export interface VoiceToolSession {
  run(name: string, args: VoiceArgs): Promise<VoiceResult>;
  setSelectedContext(context: unknown): void;
}

type SelectionSource = "reader" | "research";
interface SelectedSlot {
  source: SelectionSource;
  text: string;
  noteId?: string;
  noteTitle?: string;
  entryId?: string;
  mode?: string;
  title?: string;
  query?: string;
  url?: string;
  truncated?: boolean;
  originalWordCount?: number;
  originalCharCount?: number;
}

interface SelectedContextState {
  current: SelectedSlot | null;
}

/** Cap tool text sent back to the voice model: articles/transcripts run 20k+
 *  chars — too much to inject and narrate by voice. */
function cap(s: string, n = 6000): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s;
}

const SELECTED_WORDS = 300;
const SELECTED_CHARS = 3000;
const emptySelectedContext = (): SelectedContextState => ({
  current: null,
});
const clean = (s: unknown): string | undefined =>
  typeof s === "string" && s.trim() ? s.replace(/\s+/g, " ").trim() : undefined;
const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const count = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;

function normalizeSlot(raw: unknown): SelectedSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const source = r.source === "reader" || r.source === "research" ? r.source : null;
  const text = clean(r.text);
  if (!source || !text) return null;
  return {
    source,
    text,
    noteId: clean(r.noteId),
    noteTitle: clean(r.noteTitle),
    entryId: clean(r.entryId),
    mode: clean(r.mode),
    title: clean(r.title),
    query: clean(r.query),
    url: clean(r.url),
    truncated: r.truncated === true,
    originalWordCount: count(r.originalWordCount),
    originalCharCount: count(r.originalCharCount),
  };
}

function capSelectedSlot(slot: SelectedSlot, wordLeft: number, charLeft: number): SelectedSlot | null {
  if (wordLeft <= 0 || charLeft <= 0) return null;
  const originalWordCount = slot.originalWordCount ?? words(slot.text).length;
  const originalCharCount = slot.originalCharCount ?? slot.text.length;
  let text = words(slot.text).slice(0, wordLeft).join(" ");
  if (text.length > charLeft) text = text.slice(0, charLeft).trim();
  if (!text) return null;
  const truncated = slot.truncated === true || text !== slot.text;
  return truncated
    ? { ...slot, text, truncated: true, originalWordCount, originalCharCount }
    : { ...slot, text };
}

function capSelectedContext(state: SelectedContextState): SelectedContextState {
  return {
    current: state.current ? capSelectedSlot(state.current, SELECTED_WORDS, SELECTED_CHARS) : null,
  };
}

function stripFrontmatter(md: string): string {
  return md.startsWith("---") ? md.replace(/^---\n[\s\S]*?\n---\n?/, "") : md;
}

interface ResearchHist {
  id: string;
  mode: string;
  query: string;
  answer?: { content: string } | null;
}

interface VoiceWikiSummary {
  id: string;
  label: string;
  path: string;
  enabled: boolean;
  rawDestination: string | null;
  contractFiles: string[];
}

interface NotePreviewResult {
  path?: string;
  title?: string;
  truncated?: boolean;
  preview?: string;
  error?: string;
  [key: string]: unknown;
}

// ---- tool declarations (mirror the vault HTTP endpoints) ----

export const VOICE_TOOLS: FunctionDeclaration[] = [
  {
    name: "current_view",
    description:
      "What the user is looking at RIGHT NOW: the note open in the reader, their recent research, and selectedContext.current from the one highlighted reader/research passage. Call this FIRST whenever they refer to what's on screen or selected text: 'this note', 'what I'm reading', 'this', 'the research I just did', 'esto', 'lo seleccionado'. Then use the open note's path or selectedContext source label with the other tools to answer specifics.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "search_vault",
    description:
      "DISCOVER which of the user's notes exist on a topic — returns note titles + paths, not the content. Use for 'do I have anything on X', 'which of my notes talk about Y', 'list my notes on Z'. To actually ANSWER a question from the content, use search_passages instead.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Topic or concept to find." },
      },
      required: ["query"],
    },
  },
  {
    name: "search_passages",
    description:
      "ANSWER a question from the user's notes: returns the exact matching paragraphs (each with its note + line number), not whole notes. This is the DEFAULT tool for any 'what does it say about X' / 'what did I write on Y' question. Pass 'note' (a path from an earlier result) to look only inside that one note or book; omit it to search the whole vault.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Specific question or topic.",
        },
        note: {
          type: Type.STRING,
          description:
            "Optional relative path of the note to restrict the search to.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_passage",
    description:
      "Expand context around a passage you ALREADY found (via search_passages or grep_note): reads a line range of that note. Use for 'read me more', 'what's around that', 'go on'. Give 'note' (its path) and 'line' (from the earlier result).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        note: { type: Type.STRING, description: "Relative path of the note." },
        line: {
          type: Type.INTEGER,
          description: "Approximate line to expand.",
        },
        count: {
          type: Type.INTEGER,
          description: "How many lines to read (default 60).",
        },
      },
      required: ["note", "line"],
    },
  },
  {
    name: "grep_note",
    description:
      "Find EXACT literal occurrences of a word, name, number, or quote inside ONE note you already have the path for — returns every line it appears on. Use for a precise string, not meaning (for meaning/paraphrase use search_passages). Give 'note' (its path) and 'query' (the exact text).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        note: { type: Type.STRING, description: "Relative path of the note." },
        query: {
          type: Type.STRING,
          description: "Exact literal text to find.",
        },
        ignore_case: {
          type: Type.BOOLEAN,
          description: "Case-insensitive (default false).",
        },
      },
      required: ["note", "query"],
    },
  },
  {
    name: "browse_folder",
    description:
      "See how the vault is organized: the subfolders (with note counts) and notes directly inside a folder. Omit 'path' for the top level, or give a folder path to look inside it and navigate down. Use for 'what folders do I have', 'how is my vault organized', '¿qué hay en la carpeta saas?', 'las notas dentro de X', or to FIND WHERE a kind of note lives (meetings usually sit in a 'reuniones' subfolder, etc.). This covers the WHOLE vault, including folders the semantic search does not index.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description:
            "Folder path to look inside (e.g. 'saas' or 'saas/climatia'). Omit for the top level.",
        },
      },
    },
  },
  {
    name: "find_notes",
    description:
      "Keyword full-text search across the ENTIRE vault (note titles + full content), returning matches anywhere — INCLUDING folders the semantic tools miss (saas/, edtech/, apps/, …). Use FIRST when the user asks for keyword, exact, literal, or filename search. Also use whenever search_vault / search_passages come up empty. Pass 'path' to scope results to a folder (e.g. 'felo/wiki'). Returns titles + paths + a snippet.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Words, name, or filename to find.",
        },
        path: {
          type: Type.STRING,
          description:
            "Optional folder prefix to scope results (e.g. 'felo/wiki' or 'saas/climatia'). Omit to search the whole vault.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "open_note",
    description:
      "Open a note in the reader so it appears on the user's screen, and get a preview of what's in it. Give 'note' (a path from a previous result, or one the user named). Use when they ask to open / show / pull up a note: 'open X', 'show me that note', 'abre X', 'muéstrame esa nota'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        note: {
          type: Type.STRING,
          description: "Relative path of the note to open.",
        },
      },
      required: ["note"],
    },
  },
  {
    name: "open_last_note",
    description:
      "Reopen the most recently viewed note in the reader (even if nothing is open now) and get a preview of it — the voice equivalent of the reader's history button. Use for 'open the last note', 'reopen what I was reading', 'abre la última nota'. No arguments.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "open_last_research",
    description:
      "Reopen the most recent research result in the research panel and get its question + answer. Use for 'open the last research', 'show my last search', 'abre la última investigación'. No arguments.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_wikis",
    description:
      "List the enabled Admin-configured wikis, their vault-relative paths, raw folders, and contract files. Use before saving a working document into a wiki or raw folder. If only one wiki is returned, use it by default; if multiple are returned, choose from user context or ask.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "read_wiki_contract",
    description:
      "Read the selected wiki's contract files (AGENTS.md, CLAUDE.md, index.md, README.md when present). Use before creating a structured wiki note so the note follows that wiki's node types, folders, wikilinks, sources, and connection conventions.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        wikiId: {
          type: Type.STRING,
          description: "Wiki id or path from list_wikis.",
        },
      },
      required: ["wikiId"],
    },
  },
  {
    name: "write_document",
    description:
      "Create or update THE working document shown in the research panel. There is ONE working document per conversation; call this again to edit it — always pass the COMPLETE new markdown (previous body plus your changes), never a fragment, because it REPLACES the document in place (it is not a chat log). Use it to synthesize notes/results, draft, find relations or gaps, and iterate turn by turn as the user asks for edits. The user can then save it as a vault note.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Document title." },
        markdown: {
          type: Type.STRING,
          description: "The complete document body in markdown.",
        },
      },
      required: ["title", "markdown"],
    },
  },
  {
    name: "save_working_document",
    description:
      "Promote the current working document out of temporary history into the vault. Use kind='wiki_note' for a structured note inside the selected wiki, after read_wiki_contract and any needed write_document revision. Use kind='raw_copy' to save the document as a raw source copy in the selected wiki's raw folder. On success it rescans and opens the saved note, and removes the temporary document from history.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        kind: {
          type: Type.STRING,
          description: "Either 'wiki_note' or 'raw_copy'. Defaults to wiki_note.",
        },
        wikiId: {
          type: Type.STRING,
          description:
            "Wiki id or path from list_wikis. Optional only when exactly one wiki is enabled.",
        },
        path: {
          type: Type.STRING,
          description:
            "Optional vault-relative .md path for wiki_note, chosen from the wiki contract. Must stay under the selected wiki.",
        },
        title: {
          type: Type.STRING,
          description: "Optional title override for the saved note.",
        },
      },
    },
  },
  {
    name: "edit_vault_note",
    description:
      "Edit an EXISTING vault note in place — replace its full content. Give 'note' (the vault-relative .md path from a previous result) and 'markdown' (the COMPLETE new body, not a fragment). Use when the user asks to revise, add to, or fix a note that is already in the vault: 'edita X', 'add sources to that note', 'arregla eso', 'actualiza la nota'. Always pass the full markdown including the unchanged parts. On success it rescans and reopens the note.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        note: {
          type: Type.STRING,
          description: "Vault-relative .md path of the note to edit.",
        },
        markdown: {
          type: Type.STRING,
          description: "The complete new markdown body for the note.",
        },
      },
      required: ["note", "markdown"],
    },
  },
  {
    name: "web_research",
    description:
      "Search the WEB (not their vault) and return a synthesized answer with sources, via Exa deep research. Use when they ask about the wider world, current facts, or anything NOT in their own notes — 'look it up', 'search the web for X', 'investiga X en la web', 'qué dice internet sobre…'. Spends the user's Exa credit and needs Web mode enabled. The result also opens in their research panel.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "What to research on the web.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch the FULL text of a specific web page — OR the TRANSCRIPT of a YouTube video — by its URL, via Exa. Use when they give you a link or ask to read/summarize a page or video: 'read this article', 'what does this page say', 'summarize this YouTube video', 'transcribe este video', 'lee este enlace'. Give the exact http(s) URL. Spends Exa credit and needs Web mode. The result also opens in their research panel.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description:
            "The exact http(s) URL to fetch (a web page or a YouTube video).",
        },
      },
      required: ["url"],
    },
  },
];

// ---- session factory ----

export function createVoiceToolSession(
  ctx: VoiceToolContext,
): VoiceToolSession {
  const fetchFn: typeof fetch = ctx.fetchFn ?? globalThis.fetch.bind(globalThis);
  const { base, getSessionToken, send } = ctx;

  // Mutable session state — one per conversation.
  let workingDocId: string | null = null;
  const contractWikisRead = new Set<string>();
  let selectedContext = emptySelectedContext();

  function setSelectedContext(context: unknown): void {
    if (!context || typeof context !== "object") return;
    const raw = context as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(raw, "current")) return;
    selectedContext = capSelectedContext({ current: normalizeSlot(raw.current) });
  }

  // ---- shared context helpers (reused by current_view + the open_* tools) ----

  async function notePreview(
    path: string,
    words = 250,
  ): Promise<NotePreviewResult> {
    try {
      const u = new URL(`${base}/api/note`);
      u.searchParams.set("id", path);
      const r = await fetchFn(u);
      if (!r.ok) return { error: `note not found: ${path}` };
      const { markdown } = (await r.json()) as { markdown?: string };
      const body = stripFrontmatter(markdown ?? "").trim();
      const tokens = body.split(/\s+/).filter(Boolean);
      const h1 = body.match(/^#\s+(.+)$/m);
      return {
        path,
        title: (h1?.[1] ?? path.split("/").pop() ?? path).replace(/\.md$/i, ""),
        truncated: tokens.length > words,
        preview: tokens.slice(0, words).join(" "),
      };
    } catch {
      return { error: `could not read ${path}` };
    }
  }

  async function researchEntries(): Promise<ResearchHist[]> {
    try {
      const d = (await (
        await fetchFn(`${base}/api/research/history`)
      ).json()) as { entries?: ResearchHist[] };
      return d.entries ?? [];
    } catch {
      return [];
    }
  }

  async function wikiSummaries(): Promise<VoiceWikiSummary[]> {
    try {
      const d = (await (
        await fetchFn(`${base}/api/wikis`)
      ).json()) as { wikis?: VoiceWikiSummary[] };
      return d.wikis ?? [];
    } catch {
      return [];
    }
  }

  async function lastReaderNoteId(): Promise<string | null> {
    try {
      const d = (await (
        await fetchFn(`${base}/api/reader-history`)
      ).json()) as { entries?: Array<{ id: string }> };
      return d.entries?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  // Query tool dispatch: reuse loopback endpoints so guards/history stay shared.
  async function callTool(
    name: string,
    args: VoiceArgs,
  ): Promise<VoiceResult> {
    try {
      if (name === "search_vault") {
        send({ type: "status", key: "voice.status.searchingVault", query: String(args.query ?? "") });
        const u = new URL(`${base}/api/semantic-search`);
        u.searchParams.set("q", String(args.query ?? ""));
        const d = (await (await fetchFn(u)).json()) as { results?: unknown[] };
        return {
          results: (d.results ?? []).slice(0, 5).map((r) => {
            const x = r as Record<string, unknown>;
            return { title: x.title, snippet: x.snippet, path: x.id };
          }),
        };
      }
      if (name === "search_passages") {
        send({ type: "status", key: "voice.status.searchingPassages", query: String(args.query ?? "") });
        const u = new URL(`${base}/api/passages`);
        u.searchParams.set("q", String(args.query ?? ""));
        if (args.note) u.searchParams.set("note", String(args.note));
        const d = (await (await fetchFn(u)).json()) as { results?: unknown[] };
        return {
          results: (d.results ?? []).slice(0, 5).map((r) => {
            const x = r as Record<string, unknown>;
            return {
              title: x.title,
              snippet: x.snippet,
              file: x.file,
              line: x.line,
            };
          }),
        };
      }
      if (name === "read_passage") {
        send({ type: "status", key: "voice.status.readingPassage", note: String(args.note ?? "") });
        const line = Number(args.line ?? 1);
        const u = new URL(`${base}/api/note-lines`);
        u.searchParams.set("id", String(args.note ?? ""));
        u.searchParams.set("from", String(Math.max(1, line - 5)));
        u.searchParams.set("count", String(Number(args.count ?? 60)));
        const d = (await (await fetchFn(u)).json()) as Record<string, unknown>;
        return { note: args.note, from: d.from, to: d.to, text: d.text };
      }
      if (name === "grep_note") {
        send({ type: "status", key: "voice.status.searchingNote", note: String(args.note ?? ""), query: String(args.query ?? "") });
        const u = new URL(`${base}/api/note-grep`);
        u.searchParams.set("id", String(args.note ?? ""));
        u.searchParams.set("q", String(args.query ?? ""));
        if (args.ignore_case) u.searchParams.set("ignore_case", "1");
        const d = (await (await fetchFn(u)).json()) as { matches?: unknown[] };
        return {
          matches: (d.matches ?? []).slice(0, 8).map((m) => {
            const x = m as Record<string, unknown>;
            return { line: x.line, snippet: x.snippet ?? x.text };
          }),
        };
      }
      if (name === "browse_folder") {
        send({ type: "status", key: "voice.status.browsingFolder", path: String(args.path ?? "/") });
        const u = new URL(`${base}/api/tree`);
        if (args.path) u.searchParams.set("path", String(args.path));
        return (await (await fetchFn(u)).json()) as Record<string, unknown>;
      }
      if (name === "find_notes") {
        const query = String(args.query ?? "");
        send({ type: "status", key: "voice.status.findingNotes", query });
        const prefix =
          typeof args.path === "string"
            ? args.path.trim().replace(/\/+$/, "")
            : "";
        const writeHistory = !prefix;
        const u = new URL(`${base}/api/search`);
        u.searchParams.set("q", query);
        if (writeHistory) {
          u.searchParams.set("history", "1");
          u.searchParams.set("displayQuery", query);
        }
        const d = (await (await fetchFn(
          u,
          writeHistory ? { headers: { "x-solaris-token": getSessionToken() } } : undefined,
        )).json()) as { results?: unknown[]; historyId?: string } | unknown[];
        const hits = Array.isArray(d) ? d : (d.results ?? []);
        const historyId = Array.isArray(d) ? undefined : d.historyId;
        if (historyId) send({ type: "action", action: "open_research", id: historyId });
        return {
          historyId,
          results: (hits ?? [])
            .filter((h) => {
              if (!prefix) return true;
              const x = h as Record<string, unknown>;
              return String(x.id ?? "").startsWith(prefix + "/");
            })
            .slice(0, 8)
            .map((h) => {
              const x = h as Record<string, unknown>;
              return { title: x.title, snippet: x.snippet, path: x.id };
            }),
        };
      }
      if (name === "list_wikis") {
        send({ type: "status", key: "voice.status.listingWikis" });
        return {
          wikis: (await wikiSummaries()).filter((w) => w.enabled),
        };
      }
      if (name === "read_wiki_contract") {
        const u = new URL(`${base}/api/wiki-contracts`);
        if (args.wikiId) u.searchParams.set("wikiId", String(args.wikiId));
        return (await (await fetchFn(u)).json()) as Record<string, unknown>;
      }
      return { error: `unknown tool ${name}` };
    } catch (e) {
      return {
        error: `tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // Stateful tool dispatch: view/open + write/save/edit + web.
  async function runTool(
    name: string,
    args: VoiceArgs,
  ): Promise<VoiceResult> {
    if (name === "current_view") {
      send({ type: "status", key: "voice.status.currentView" });
      const noteId = await lastReaderNoteId();
      return {
        openNote: noteId ? await notePreview(noteId) : null,
        recentResearch: (await researchEntries())
          .slice(0, 6)
          .map((e) => ({ mode: e.mode, query: e.query })),
        selectedContext,
      };
    }
    if (name === "open_note") {
      const path = String(args.note ?? "");
      send({ type: "status", key: "voice.status.openingNote", note: path });
      const preview = await notePreview(path);
      if (!preview.error)
        send({ type: "action", action: "open_note", note: path });
      return preview;
    }
    if (name === "open_last_note") {
      send({ type: "status", key: "voice.status.openingLastNote" });
      const path = await lastReaderNoteId();
      if (!path) return { error: "no notes have been opened yet" };
      send({ type: "action", action: "open_note", note: path });
      return await notePreview(path);
    }
    if (name === "open_last_research") {
      send({ type: "status", key: "voice.status.openingLastResearch" });
      const entry = (await researchEntries())[0];
      if (!entry) return { error: "no research yet" };
      send({ type: "action", action: "open_research", id: entry.id });
      return {
        mode: entry.mode,
        query: entry.query,
        answer: entry.answer?.content ?? null,
      };
    }
    if (name === "read_wiki_contract") {
      send({ type: "status", key: "voice.status.readingWiki", wiki: String(args.wikiId ?? "") });
      const result = await callTool(name, args);
      const wiki = result.wiki as Record<string, unknown> | undefined;
      for (const value of [args.wikiId, wiki?.id, wiki?.path]) {
        if (typeof value === "string" && value) contractWikisRead.add(value);
      }
      return result;
    }
    if (name === "write_document") {
      const title = String(args.title ?? "").trim() || "Untitled";
      send({ type: "status", key: "voice.status.writingDocument", title });
      const content = String(args.markdown ?? "");
      if (!workingDocId) {
        const slug =
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 32) || "doc";
        workingDocId = `doc-${Date.now().toString(36)}-${slug}`;
      }
      const r = await fetchFn(`${base}/api/document`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-solaris-token": getSessionToken(),
        },
        body: JSON.stringify({ id: workingDocId, title, content }),
      });
      if (!r.ok) return { error: "could not save the document" };
      send({
        type: "action",
        action: "show_document",
        id: workingDocId,
        title,
        content,
      });
      return { ok: true, id: workingDocId, chars: content.length };
    }
    if (name === "save_working_document") {
      send({ type: "status", key: "voice.status.savingDocument" });
      if (!workingDocId) return { error: "no working document to save" };
      if (
        args.kind !== "raw_copy" &&
        typeof args.wikiId === "string" &&
        args.wikiId &&
        !contractWikisRead.has(args.wikiId)
      ) {
        return {
          error: "read_wiki_contract before saving a structured wiki note",
        };
      }
      const r = await fetchFn(
        `${base}/api/document/${encodeURIComponent(workingDocId)}/promote`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-solaris-token": getSessionToken(),
          },
          body: JSON.stringify({
            kind: args.kind === "raw_copy" ? "raw_copy" : "wiki_note",
            wikiId: args.wikiId,
            path: args.path,
            title: args.title,
          }),
        },
      );
      const d = (await r.json().catch(() => ({}))) as {
        id?: string;
        ids?: string[];
        error?: string;
        removedHistory?: boolean;
      };
      if (!r.ok || !d.id) return { error: d.error ?? "could not save document" };
      workingDocId = null;
      send({ type: "action", action: "open_saved_note", note: d.id });
      return {
        ok: true,
        path: d.id,
        ids: d.ids,
        removedTemporaryDocument: d.removedHistory === true,
      };
    }
    if (name === "edit_vault_note") {
      const note = String(args.note ?? "").trim();
      send({ type: "status", key: "voice.status.editingNote", note });
      const markdown = String(args.markdown ?? "");
      if (!note) return { error: "note path required" };
      if (!markdown.trim()) return { error: "content required" };
      const r = await fetchFn(`${base}/api/notes`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-solaris-token": getSessionToken(),
        },
        body: JSON.stringify({ id: note, content: markdown }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!r.ok || !d.id) return { error: d.error ?? "could not edit note" };
      send({ type: "action", action: "open_saved_note", note: d.id });
      return { ok: true, path: d.id };
    }
    // Web tools (Exa): spend-bearing, so the guarded routes need the session
    // token — they cannot go through the token-less callTool path. fetch_url
    // covers both articles and YouTube transcripts (same /api/article endpoint).
    if (name === "web_research" || name === "fetch_url") {
      const isFetch = name === "fetch_url";
      let payload: Record<string, unknown>;
      if (isFetch) {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url))
          return { error: "a valid http(s) URL is required" };
        send({ type: "status", key: "voice.status.fetchingUrl", url });
        payload = { url };
      } else {
        const query = String(args.query ?? "").trim();
        if (!query) return { error: "empty query" };
        send({ type: "status", key: "voice.status.searchingWeb", query });
        payload = { query, deep: true };
      }
      const r = await fetchFn(
        `${base}${isFetch ? "/api/article" : "/api/research"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-solaris-token": getSessionToken(),
          },
          body: JSON.stringify(payload),
        },
      );
      const d = (await r.json().catch(() => ({}))) as {
        message?: string;
        historyId?: string;
        answer?: { content?: string } | null;
        results?: Array<{ title?: string; url?: string }>;
        title?: string;
        content?: string;
      };
      if (!r.ok) return { error: d.message ?? "web request failed" };
      if (d.historyId)
        send({ type: "action", action: "open_research", id: d.historyId });
      return isFetch
        ? { title: d.title, text: cap(d.content ?? "") }
        : {
            answer: cap(d.answer?.content ?? ""),
            sources: (d.results ?? [])
              .slice(0, 6)
              .map((x) => ({ title: x.title, url: x.url })),
          };
    }
    return callTool(name, args);
  }

  return {
    run: (name, args) => runTool(name, args),
    setSelectedContext,
  };
}
