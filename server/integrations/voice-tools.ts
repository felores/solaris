/**
 * Voice tool-dispatch seam (U8, R5, KTD8).
 *
 * Pure tool layer for the voice bridge. Owns the `VOICE_TOOLS`
 * declarations, the loopback-HTTP `callTool` (read-only) and
 * `runTool` (stateful) bodies, and the mutable session state
 * (`activeWorkingDocId`). `voice.ts` keeps the Gemini
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
 * a misbehaving caller cannot poke at activeWorkingDocId directly.
 */

import type { FunctionDeclaration, Type } from "@google/genai";
import { toolsForSurface } from "./registry.js";

export type VoiceArgs = Record<string, unknown>;
export type VoiceResult = Record<string, unknown>;

export interface VoiceToolContext {
  base: string;
  fetchFn?: typeof fetch;
  getSessionToken: () => string;
  send: (obj: object) => void;
  /** Voice-session id used to scope delegation jobs (one job per session). */
  sessionId?: string;
}

export interface VoiceToolSession {
  run(name: string, args: VoiceArgs): Promise<VoiceResult>;
  setBrowserContext(context: unknown): void;
  setSelectedContext(context: unknown): void;
  close(): void;
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

interface BrowserViewState {
  readerNoteId: string | null;
  researchPanelOpen: boolean;
  visibleResearchId: string | null;
  pinnedResearchId: string | null;
  recentResearch: ResearchHist | null;
}

/** Cap tool text sent back to the voice model: articles can run 20k+
 *  chars — too much to inject and narrate by voice. */
function cap(s: string, n = 6000): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s;
}

const SELECTED_WORDS = 300;
const SELECTED_CHARS = 3000;
const DOC_ID_RE = /^[a-z0-9-]+$/;
const emptySelectedContext = (): SelectedContextState => ({
  current: null,
});
const clean = (s: unknown): string | undefined =>
  typeof s === "string" && s.trim() ? s.replace(/\s+/g, " ").trim() : undefined;
const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const count = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : undefined;
const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim());

function normalizeSlot(raw: unknown): SelectedSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const source =
    r.source === "reader" || r.source === "research" ? r.source : null;
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

function capSelectedSlot(
  slot: SelectedSlot,
  wordLeft: number,
  charLeft: number,
): SelectedSlot | null {
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
    current: state.current
      ? capSelectedSlot(state.current, SELECTED_WORDS, SELECTED_CHARS)
      : null,
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
  results?: unknown[];
  article?: { title: string; url: string; content?: string };
  document?: { title: string; content?: string };
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

// ---- tool declarations: derived from the registry (R7, KTD1) ----

/** Provider-neutral lowercase JSON-schema type → Gemini Type enum value. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(schema)) {
    out[key] =
      key === "type" && typeof val === "string"
        ? (val.toUpperCase() as Type)
        : geminiSchema(val);
  }
  return out;
}

export const VOICE_TOOLS: FunctionDeclaration[] = toolsForSurface("voice").map(
  (e) => ({
    name: e.name,
    description: e.description,
    parameters: geminiSchema(e.params) as FunctionDeclaration["parameters"],
  }),
);

// ---- session factory ----

export function createVoiceToolSession(
  ctx: VoiceToolContext,
): VoiceToolSession {
  const fetchFn: typeof fetch =
    ctx.fetchFn ?? globalThis.fetch.bind(globalThis);
  const { base, getSessionToken, send } = ctx;
  const sessionId =
    ctx.sessionId ??
    `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Mutable session state - one per conversation.
  let activeWorkingDocId: string | null = null;
  const knownDocumentIds = new Set<string>();
  const documentRevisions = new Map<string, string>();
  let selectedContext = emptySelectedContext();
  let browserView: BrowserViewState | null = null;
  const displayAcks = new Map<
    string,
    {
      resolve: (ack: Record<string, unknown>) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let recentResearch: Record<string, unknown> | null = null;
  const DISPLAY_ACK_TIMEOUT_MS = 5_000;

  function setBrowserContext(context: unknown): void {
    if (!context || typeof context !== "object") return;
    const raw = context as Record<string, unknown>;
    if (Object.hasOwn(raw, "current")) {
      selectedContext = capSelectedContext({
        current: normalizeSlot(raw.current),
      });
    }
    const view = raw.view;
    if (view && typeof view === "object") {
      const v = view as Record<string, unknown>;
      browserView = {
        readerNoteId: clean(v.readerNoteId) ?? null,
        researchPanelOpen: v.researchPanelOpen === true,
        visibleResearchId: clean(v.visibleResearchId) ?? null,
        pinnedResearchId: clean(v.pinnedResearchId) ?? null,
        recentResearch:
          v.recentResearch && typeof v.recentResearch === "object"
            ? (v.recentResearch as ResearchHist)
            : null,
      };
      if (browserView.recentResearch)
        recentResearch = researchSummary(browserView.recentResearch);
    }
    const ack = raw.displayAcknowledgment;
    if (ack && typeof ack === "object") {
      const requestId = clean((ack as Record<string, unknown>).requestId);
      const pending = requestId ? displayAcks.get(requestId) : undefined;
      if (requestId && pending) {
        clearTimeout(pending.timer);
        displayAcks.delete(requestId);
        pending.resolve(ack as Record<string, unknown>);
      }
    }
  }

  async function requestResearchDisplay(
    action: "open_research" | "show_document",
    id: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    send({ type: "action", action, id, requestId, ...extra });
    if (!browserView) return { decision: "display-unavailable" };
    return new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => {
        displayAcks.delete(requestId);
        resolve({ decision: "display-timeout" });
      }, DISPLAY_ACK_TIMEOUT_MS);
      displayAcks.set(requestId, { resolve, timer });
    });
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
      const entries = d.entries ?? [];
      recentResearch = entries[0] ? researchSummary(entries[0]) : null;
      return entries;
    } catch {
      return [];
    }
  }

  async function readWorkingDocument(id: string): Promise<VoiceResult> {
    if (!DOC_ID_RE.test(id)) return { error: "invalid documentId" };
    const r = await fetchFn(`${base}/api/document/${encodeURIComponent(id)}`);
    const d = (await r.json().catch(() => ({}))) as VoiceResult;
    if (!r.ok) return { error: String(d.error ?? "document not found") };
    if (typeof d.revision === "string") documentRevisions.set(id, d.revision);
    knownDocumentIds.add(id);
    activeWorkingDocId = id;
    return d;
  }

  function webResults(
    entry: ResearchHist,
  ): Array<{ title?: unknown; url?: unknown }> {
    return Array.isArray(entry.results)
      ? entry.results.filter(
          (r): r is { title?: unknown; url?: unknown } =>
            !!r && typeof r === "object",
        )
      : [];
  }

  function researchSummary(entry: ResearchHist): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: entry.id,
      mode: entry.mode,
      query: entry.query,
      mutable: entry.mode === "document",
    };
    if (entry.mode === "web") {
      base.results = webResults(entry)
        .slice(0, 4)
        .map((r) => ({ title: clean(r.title), url: clean(r.url) }))
        .filter((r) => r.title || r.url);
    }
    if (entry.article) {
      base.article = { title: entry.article.title, url: entry.article.url };
    }
    if (entry.document) {
      base.document = {
        title: entry.document.title,
        content: cap(entry.document.content ?? "", 3000),
      };
    }
    return base;
  }

  async function wikiSummaries(): Promise<VoiceWikiSummary[]> {
    try {
      const d = (await (await fetchFn(`${base}/api/wikis`)).json()) as {
        wikis?: VoiceWikiSummary[];
      };
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

  async function openNotePath(path: string): Promise<VoiceResult> {
    if (isHttpUrl(path))
      return { error: "target is a web URL; use open_resource or fetch_url" };
    send({ type: "status", key: "voice.status.openingNote", note: path });
    const preview = await notePreview(path);
    if (!preview.error)
      send({ type: "action", action: "open_note", note: path });
    return preview;
  }

  async function fetchUrl(url: string): Promise<VoiceResult> {
    if (!isHttpUrl(url)) return { error: "a valid http(s) URL is required" };
    send({ type: "status", key: "voice.status.fetchingUrl", url });
    const r = await fetchFn(`${base}/api/article`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sinapso-token": getSessionToken(),
      },
      body: JSON.stringify({ url }),
    });
    const d = (await r.json().catch(() => ({}))) as {
      message?: string;
      historyId?: string;
      title?: string;
      content?: string;
    };
    if (!r.ok) return { error: d.message ?? "web request failed" };
    if (d.historyId)
      send({ type: "action", action: "open_research", id: d.historyId });
    return { title: d.title, text: cap(d.content ?? "") };
  }

  async function openResearchId(id: string): Promise<VoiceResult | null> {
    const entry = (await researchEntries()).find((e) => e.id === id);
    if (!entry) return null;
    send({ type: "action", action: "open_research", id: entry.id });
    return researchSummary(entry);
  }

  const titleFrom = (p: string): string =>
    (p.split("/").pop() ?? p).replace(/\.md$/i, "");

  /** Keyword full-text across the vault (MiniSearch route). Unscoped queries
   *  join research history and open the research panel, like before (R9). */
  async function fulltextNotes(
    query: string,
    prefix: string,
  ): Promise<{ historyId?: string; results: unknown[] }> {
    const writeHistory = !prefix;
    const u = new URL(`${base}/api/search`);
    u.searchParams.set("q", query);
    if (writeHistory) {
      u.searchParams.set("history", "1");
      u.searchParams.set("displayQuery", query);
    }
    const d = (await (
      await fetchFn(
        u,
        writeHistory
          ? { headers: { "x-sinapso-token": getSessionToken() } }
          : undefined,
      )
    ).json()) as { results?: unknown[]; historyId?: string } | unknown[];
    const hits = Array.isArray(d) ? d : (d.results ?? []);
    const historyId = Array.isArray(d) ? undefined : d.historyId;
    if (historyId)
      send({ type: "action", action: "open_research", id: historyId });
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
          return { path: x.id, title: x.title, snippet: x.snippet };
        }),
    };
  }

  /** Literal occurrences inside one note, normalized to {path,title,snippet,line}. */
  async function grepNote(
    note: string,
    query: string,
    ignoreCase: boolean,
  ): Promise<VoiceResult> {
    const u = new URL(`${base}/api/note-grep`);
    u.searchParams.set("id", note);
    u.searchParams.set("q", query);
    if (ignoreCase) u.searchParams.set("ignore_case", "1");
    const d = (await (await fetchFn(u)).json()) as { matches?: unknown[] };
    return {
      source: "exact",
      results: (d.matches ?? []).slice(0, 8).map((m) => {
        const x = m as Record<string, unknown>;
        return {
          path: note,
          title: titleFrom(note),
          snippet: x.snippet ?? x.text,
          line: x.line,
        };
      }),
    };
  }

  // Query tool dispatch: reuse loopback endpoints so guards/history stay shared.
  async function callTool(name: string, args: VoiceArgs): Promise<VoiceResult> {
    try {
      if (name === "search_notes") {
        const query = String(args.query ?? "");
        const prefix =
          typeof args.path === "string"
            ? args.path.trim().replace(/\/+$/, "")
            : "";
        send({ type: "status", key: "voice.status.searchingVault", query });
        // Meaning-based first; keyword full-text covers the rest of the vault
        // (and any semantic-unavailable state) inside this same call (R9).
        const u = new URL(`${base}/api/semantic-search`);
        u.searchParams.set("q", query);
        try {
          const r = await fetchFn(u);
          const d = (await r.json()) as { state?: string; results?: unknown[] };
          const hits = r.ok && d.state === "ready" ? (d.results ?? []) : [];
          const scoped = hits.filter((h) => {
            if (!prefix) return true;
            return String((h as Record<string, unknown>).id ?? "").startsWith(
              prefix + "/",
            );
          });
          if (scoped.length) {
            return {
              source: "semantic",
              results: scoped.slice(0, 8).map((h) => {
                const x = h as Record<string, unknown>;
                return { path: x.id, title: x.title, snippet: x.snippet };
              }),
            };
          }
        } catch {
          /* semantic layer down: the keyword fallback below still answers */
        }
        return { source: "fulltext", ...(await fulltextNotes(query, prefix)) };
      }
      if (name === "search_passages") {
        const query = String(args.query ?? "");
        const note =
          typeof args.note === "string" && args.note ? args.note : undefined;
        send({ type: "status", key: "voice.status.searchingPassages", query });
        if (args.exact === true) {
          if (!note)
            return {
              error:
                "exact search needs 'note' (a path from an earlier result)",
            };
          return grepNote(note, query, args.ignore_case === true);
        }
        const u = new URL(`${base}/api/passages`);
        u.searchParams.set("q", query);
        if (note) u.searchParams.set("note", note);
        try {
          const r = await fetchFn(u);
          const d = (await r.json()) as { state?: string; results?: unknown[] };
          const hits = r.ok && d.state === "ready" ? (d.results ?? []) : [];
          if (hits.length) {
            return {
              source: "semantic",
              results: hits.slice(0, 8).map((h) => {
                const x = h as Record<string, unknown>;
                return {
                  path: x.file,
                  title: x.title,
                  snippet: x.snippet,
                  line: x.line,
                };
              }),
            };
          }
        } catch {
          /* fall through to the keyword path below */
        }
        // Semantic unavailable or empty: literal search inside the note, or
        // keyword full-text across the vault — one call, no re-prompting.
        if (note) return grepNote(note, query, true);
        return { source: "fulltext", ...(await fulltextNotes(query, "")) };
      }
      if (name === "read_passage") {
        send({
          type: "status",
          key: "voice.status.readingPassage",
          note: String(args.note ?? ""),
        });
        const line = Number(args.line ?? 1);
        const u = new URL(`${base}/api/note-lines`);
        u.searchParams.set("id", String(args.note ?? ""));
        u.searchParams.set("from", String(Math.max(1, line - 5)));
        u.searchParams.set("count", String(Number(args.count ?? 60)));
        const d = (await (await fetchFn(u)).json()) as Record<string, unknown>;
        return { path: args.note, line: d.from, to: d.to, snippet: d.text };
      }
      if (name === "browse_folder") {
        send({
          type: "status",
          key: "voice.status.browsingFolder",
          path: String(args.path ?? "/"),
        });
        const u = new URL(`${base}/api/tree`);
        if (args.path) u.searchParams.set("path", String(args.path));
        return (await (await fetchFn(u)).json()) as Record<string, unknown>;
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
  async function runTool(name: string, args: VoiceArgs): Promise<VoiceResult> {
    if (name === "current_view") {
      send({ type: "status", key: "voice.status.currentView" });
      if (!browserView)
        return { viewStateKnown: false, selectedContext, recentResearch };
      const needsResearch =
        browserView.researchPanelOpen || browserView.pinnedResearchId !== null;
      const entries = needsResearch ? await researchEntries() : [];
      const resolveResearch = (id: string | null) => {
        const entry = id
          ? entries.find((candidate) => candidate.id === id)
          : undefined;
        return entry ? researchSummary(entry) : null;
      };
      return {
        viewStateKnown: true,
        openNote: browserView.readerNoteId
          ? await notePreview(browserView.readerNoteId)
          : null,
        recentResearch,
        research: {
          panelOpen: browserView.researchPanelOpen,
          visible: browserView.researchPanelOpen
            ? resolveResearch(browserView.visibleResearchId)
            : null,
          pinned: resolveResearch(browserView.pinnedResearchId),
        },
        selectedContext,
      };
    }
    if (name === "open_note") {
      const path = String(args.note ?? "");
      return openNotePath(path);
    }
    if (name === "open_resource") {
      const target = String(args.target ?? "").trim();
      if (!target) return { error: "target required" };
      if (isHttpUrl(target)) return fetchUrl(target);
      const research = await openResearchId(target);
      if (research) return research;
      if (target.toLowerCase().endsWith(".md")) return openNotePath(target);
      return { error: "unknown resource; use search tools first" };
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
      const display = await requestResearchDisplay("open_research", entry.id);
      return {
        ...researchSummary(entry),
        display,
      };
    }
    if (name === "read_wiki_contract") {
      send({
        type: "status",
        key: "voice.status.readingWiki",
        wiki: String(args.wikiId ?? ""),
      });
      return callTool(name, args);
    }
    if (name === "read_working_document") {
      const documentId = clean(args.documentId);
      if (!documentId) return { error: "documentId required" };
      return readWorkingDocument(documentId);
    }
    if (name === "write_document") {
      const title = String(args.title ?? "").trim() || "Untitled";
      send({ type: "status", key: "voice.status.writingDocument", title });
      const content = String(args.markdown ?? "");
      const requestedId = clean(args.documentId);
      const operation = args.operation;
      if (operation !== "create" && operation !== "update") {
        return { error: "operation must be create or update" };
      }
      if (operation === "create" && requestedId) {
        return { error: "documentId is not allowed when creating a document" };
      }
      if (operation === "update" && !requestedId) {
        return { error: "documentId required to update a document" };
      }
      const revision = clean(args.revision);
      if (operation === "update" && !revision) {
        return { error: "revision required to update a document" };
      }
      if (
        operation === "update" &&
        requestedId &&
        documentRevisions.get(requestedId) !== revision
      ) {
        return { error: "read_working_document required before update" };
      }
      const r = await fetchFn(`${base}/api/document`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sinapso-token": getSessionToken(),
        },
        body: JSON.stringify({
          id: requestedId,
          title,
          content,
          revision,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        id?: string;
        revision?: string;
        error?: string;
      };
      if (!r.ok || !d.id || !d.revision) {
        return { error: d.error ?? "could not save the document" };
      }
      knownDocumentIds.add(d.id);
      documentRevisions.set(d.id, d.revision);
      activeWorkingDocId = d.id;
      const display = await requestResearchDisplay("show_document", d.id, {
        title,
        content,
        revision: d.revision,
      });
      return {
        ok: true,
        id: d.id,
        revision: d.revision,
        chars: content.length,
        display,
      };
    }
    if (name === "save_research_to_inbox") {
      send({ type: "status", key: "voice.status.savingDocument" });
      const researchId = clean(args.researchId) ?? activeWorkingDocId;
      if (!researchId) return { error: "no research to save" };
      const r = await fetchFn(
        `${base}/api/research/history/${encodeURIComponent(researchId)}/save-inbox`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sinapso-token": getSessionToken(),
          },
          body: JSON.stringify({}),
        },
      );
      const d = (await r.json().catch(() => ({}))) as {
        id?: string;
        ids?: string[];
        error?: string;
        removedHistory?: boolean;
      };
      if (!r.ok || !d.id)
        return { error: d.error ?? "could not save document" };
      knownDocumentIds.delete(researchId);
      if (activeWorkingDocId === researchId) activeWorkingDocId = null;
      send({ type: "action", action: "open_saved_note", note: d.id });
      return {
        ok: true,
        path: d.id,
        ids: d.ids,
        removedTemporaryDocument: d.removedHistory === true,
      };
    }
    if (name === "propose_wiki_ingest" || name === "apply_wiki_ingest") {
      const researchId =
        clean(args.researchId) ??
        (name === "propose_wiki_ingest" ? activeWorkingDocId : undefined);
      if (
        name === "propose_wiki_ingest" &&
        !researchId &&
        !clean(args.sourceNote)
      )
        return { error: "researchId or Inbox sourceNote required" };
      if (name === "apply_wiki_ingest" && !Array.isArray(args.operations))
        return { error: "proposal operations required" };
      const r = await fetchFn(
        `${base}/api/wiki-ingest/${name === "propose_wiki_ingest" ? "propose" : "apply"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sinapso-token": getSessionToken(),
          },
          body: JSON.stringify({
            wikiId: clean(args.wikiId),
            researchId,
            sourceNote: clean(args.sourceNote),
            ...(name === "apply_wiki_ingest"
              ? { operations: args.operations }
              : {}),
          }),
        },
      );
      const d = (await r.json().catch(() => ({}))) as VoiceResult & {
        ids?: string[];
        id?: string;
        error?: string;
      };
      if (!r.ok) return { error: d.error ?? "wiki ingest failed" };
      if (name === "propose_wiki_ingest") return { ok: true, ...d };
      const path = d.ids?.[0] ?? d.id;
      if (researchId) {
        knownDocumentIds.delete(researchId);
        if (activeWorkingDocId === researchId) activeWorkingDocId = null;
      }
      if (path) send({ type: "action", action: "open_saved_note", note: path });
      return { ok: true, ...d, path };
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
          "x-sinapso-token": getSessionToken(),
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
    if (name === "archive_vault_note") {
      const note = String(args.note ?? "").trim();
      if (!note) return { error: "note path required" };
      const r = await fetchFn(`${base}/api/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sinapso-token": getSessionToken(),
        },
        body: JSON.stringify({ id: note }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!r.ok || !d.id) return { error: d.error ?? "could not archive note" };
      send({ type: "action", action: "archived_note", note: d.id });
      return { ok: true, path: d.id };
    }
    if (name === "delegate_to_thinker") {
      const task = String(args.task ?? "").trim();
      if (!task) return { error: "task required" };
      send({ type: "status", key: "voice.status.delegating", task });
      const strings = (v: unknown): string[] =>
        Array.isArray(v)
          ? v.filter((x): x is string => typeof x === "string")
          : [];
      const r = await fetchFn(`${base}/api/delegate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sinapso-token": getSessionToken(),
        },
        body: JSON.stringify({
          sessionId,
          task,
          notes: strings(args.notes),
          researchIds: strings(args.researchIds),
          title: typeof args.title === "string" ? args.title : undefined,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        job?: { id: string; documentId: string };
        error?: string;
      };
      if (!r.ok || !d.job)
        return { error: d.error ?? "could not start the delegation" };
      // The job writes into this document; adopt it as the session's working
      // document so later curation and revisions target it (R13).
      knownDocumentIds.add(d.job.documentId);
      activeWorkingDocId = d.job.documentId;
      return {
        started: true,
        jobId: d.job.id,
        documentId: d.job.documentId,
        note: "The reasoner is working in the background. Announce the handoff aloud and keep conversing; the result will arrive in the working document.",
      };
    }
    // Web tools (Exa): spend-bearing, so the guarded routes need the session
    // token; they cannot go through the token-less callTool path.
    if (name === "fetch_url") return fetchUrl(String(args.url ?? "").trim());
    if (name === "web_research") {
      const query = String(args.query ?? "").trim();
      if (!query) return { error: "empty query" };
      send({ type: "status", key: "voice.status.searchingWeb", query });
      const r = await fetchFn(`${base}/api/research`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sinapso-token": getSessionToken(),
        },
        body: JSON.stringify({ query, deep: true }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        message?: string;
        historyId?: string;
        answer?: { content?: string } | null;
        results?: Array<{ title?: string; url?: string }>;
      };
      if (!r.ok) return { error: d.message ?? "web request failed" };
      if (d.historyId)
        send({ type: "action", action: "open_research", id: d.historyId });
      return {
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
    setBrowserContext,
    setSelectedContext: setBrowserContext,
    close() {
      for (const pending of displayAcks.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ decision: "display-unavailable" });
      }
      displayAcks.clear();
    },
  };
}
