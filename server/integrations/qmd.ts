/**
 * qmd bridge (U3): semantic related-notes and search over the vault via the
 * qmd CLI. Uses `qmd vsearch --format json` (vector similarity, no LLM
 * rerank) to meet the 1-2s latency target; never `qmd query` (tens of
 * seconds) or `qmd search` (keyword-only).
 *
 * qmd CLI contract (verified against qmd --help, 2026-07):
 *   - `collection list` / `collection show <name>` are human text; parsed
 *     with regexes. `collection add <path>` is positional and defaults to
 *     the cwd, so the vault path is ALWAYS passed explicitly.
 *   - vsearch hits carry `file: "qmd://<collection>/<rel-path>.md"`.
 *   - vsearch prints progress noise around the JSON; parse defensively.
 *   - Coverage counts equal, parent AND child collection roots: a vault at
 *     ~/FeloVault is covered by collections rooted at its subfolders.
 */

import { relative, resolve, sep } from "node:path";
import type { RunResult, Runner } from "./detect.js";

const SEARCH_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 3_600_000; // update + embed can run for minutes on big vaults

export interface QmdCollection {
  name: string;
  path: string;
}

export interface QmdHit {
  file: string;
  score?: number;
  title?: string;
  snippet?: string;
  /** 1-based line where the passage/chunk starts, when qmd reports it. */
  line?: number;
}

export interface NodeResult {
  id: string;
  title: string;
  score: number;
  snippet: string;
}

export async function listCollections(
  run: Runner,
  qmd: string,
): Promise<QmdCollection[]> {
  const list = await run(qmd, ["collection", "list"], SEARCH_TIMEOUT_MS);
  if (!list.ok) return [];
  const names = [...list.stdout.matchAll(/^(\S+) \(qmd:\/\//gm)].map(
    (m) => m[1],
  );
  const out: QmdCollection[] = [];
  await Promise.all(
    names.map(async (name) => {
      const show = await run(
        qmd,
        ["collection", "show", name],
        SEARCH_TIMEOUT_MS,
      );
      const m = show.stdout.match(/^\s*Path:\s*(.+)$/m);
      if (show.ok && m) out.push({ name, path: m[1].trim() });
    }),
  );
  return out;
}

/** Collections that index the vault (equal root), a superset (parent) or a subset (child). */
export function coveringCollections(
  cols: QmdCollection[],
  vaultRoot: string,
): QmdCollection[] {
  const vr = resolve(vaultRoot);
  return cols.filter((c) => {
    const cp = resolve(c.path);
    return cp === vr || cp.startsWith(vr + sep) || vr.startsWith(cp + sep);
  });
}

export async function vsearch(
  run: Runner,
  qmd: string,
  query: string,
  limit: number,
): Promise<QmdHit[]> {
  // Type the query as a single "vec:" line: untyped queries trigger qmd's
  // auto-expansion (LLM hyde generation, 30s+ observed); a pre-typed vec line
  // is pure vector similarity (~5s per spawn, dominated by model load).
  const typed = "vec: " + query.replace(/\s+/g, " ").trim();
  const r = await run(
    qmd,
    ["vsearch", typed, "-n", String(limit), "--format", "json"],
    SEARCH_TIMEOUT_MS,
  );
  if (!r.ok) {
    console.warn(
      "qmd vsearch failed:",
      (r.stderr || "unknown error").slice(0, 300),
    );
    return [];
  }
  const start = r.stdout.indexOf("[");
  if (start < 0) {
    console.warn("qmd vsearch: no JSON array in output");
    return [];
  }
  try {
    const arr: unknown = JSON.parse(r.stdout.slice(start));
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (h): h is QmdHit => typeof (h as QmdHit)?.file === "string",
    );
  } catch {
    console.warn("qmd vsearch: malformed JSON output");
    return [];
  }
}

/**
 * Strip qmd's diff-style snippet decoration and squash whitespace.
 * CLI snippets start lines with "@@ -n,n @@"; MCP snippets additionally
 * prefix every line with its line number ("12: text").
 */
function cleanSnippet(s: string | undefined): string {
  if (!s) return "";
  return s
    .split("\n")
    .map((l) => l.replace(/^\s*\d+:\s?/, ""))
    .filter((l) => !l.trimStart().startsWith("@@"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 340);
}

/**
 * Map vsearch hits to graph nodes (R5): resolve each qmd:// file against its
 * collection root, keep only paths inside the vault that exist as non-phantom
 * node ids, honoring the enabled-collections filter (R8). Deduped, ordered.
 */
export function hitsToNodes(
  hits: QmdHit[],
  cols: QmdCollection[],
  vaultRoot: string,
  nodeTitles: Map<string, string>,
  enabled?: Set<string>,
): NodeResult[] {
  const byName = new Map(cols.map((c) => [c.name, resolve(c.path)]));
  const vr = resolve(vaultRoot);
  const out: NodeResult[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const m = h.file.match(/^qmd:\/\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, coll, rel] = m;
    if (enabled && !enabled.has(coll)) continue;
    const base = byName.get(coll);
    if (!base) continue; // hit from a non-covering collection
    const abs = resolve(base, rel);
    if (abs !== vr && !abs.startsWith(vr + sep)) continue;
    const id = relative(vr, abs);
    const title = nodeTitles.get(id);
    if (title === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title,
      score: h.score ?? 0,
      snippet: cleanSnippet(h.snippet),
    });
  }
  return out;
}

export interface PassageResult {
  file: string;
  title: string;
  /** 1-based start line of the passage (0 when qmd did not report one). */
  line: number;
  score: number;
  snippet: string;
}

/**
 * Chunk-level variant of hitsToNodes: keeps EVERY passage (no per-note
 * dedup), does NOT require the note to be a graph node, and preserves the
 * line position — so a caller can answer from within a long note instead of
 * loading the whole file. Still vault-confined (R5) and collection-filtered
 * (R8). Pass `note` (a vault-relative path) to keep only that note's passages.
 */
export function hitsToPassages(
  hits: QmdHit[],
  cols: QmdCollection[],
  vaultRoot: string,
  enabled?: Set<string>,
  note?: string,
): PassageResult[] {
  const byName = new Map(cols.map((c) => [c.name, resolve(c.path)]));
  const vr = resolve(vaultRoot);
  const out: PassageResult[] = [];
  for (const h of hits) {
    const m = h.file.match(/^qmd:\/\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, coll, rel] = m;
    if (enabled && !enabled.has(coll)) continue;
    const base = byName.get(coll);
    if (!base) continue; // hit from a non-covering collection
    const abs = resolve(base, rel);
    if (abs !== vr && !abs.startsWith(vr + sep)) continue;
    const id = relative(vr, abs);
    if (note && id !== note) continue;
    out.push({
      file: id,
      title: h.title ?? id,
      line: typeof h.line === "number" ? h.line : 0,
      score: h.score ?? 0,
      snippet: cleanSnippet(h.snippet),
    });
  }
  return out;
}

export type QmdSetupState = "idle" | "indexing" | "ready" | "error";

/**
 * Minimal node shape `runQmdQuery` reads to build the in-graph title map.
 * Structural subset of `GraphFile["nodes"][number]` so the route can pass
 * `graph.nodes` without an extra adapter.
 */
export interface QmdGraphNodeLike {
  id: string;
  title: string;
  phantom?: boolean;
}

/**
 * Dependencies `runQmdQuery` reads from the surrounding app. Kept injectable
 * (a) so the function can be unit-tested without an Express app, and (b) so
 * the existing `collections()` cache and `qmdSearch()` warm-MCP/CLI-fallback
 * closure in `server/app.ts` stay in place — only their handle is passed in.
 */
export interface QmdQueryDeps {
  /** Resolved qmd binary (null when qmd is not installed). */
  bin: string | null;
  setupState: () => QmdSetupState;
  /** Drop the cached `collection list` (called on ready-state transition). */
  invalidateCollectionsCache: () => void;
  getCollections: (bin: string) => Promise<QmdCollection[]>;
  search: (
    bin: string,
    queryText: string,
    limit: number,
    scopeNames: string[] | undefined,
  ) => Promise<QmdHit[]>;
  vaultRoot: string;
  graphNodes: ReadonlyArray<QmdGraphNodeLike>;
}

export type QmdQueryMode = "nodes" | "passages";

export interface QmdQueryOpts {
  /** Raw `req.query.collections` (string or undefined). */
  collectionsParam: unknown;
  mode: QmdQueryMode;
  /** Final cap on returned items. */
  limit: number;
  /** Passages mode only: scope to one vault-relative note (may be undefined). */
  note?: string;
}

/**
 * The shared body of `/api/semantic-search` and `/api/passages` (U4): one
 * qmd orchestration + result mapping function with a mode switch. Behavior
 * is byte-identical to the prior `semanticQuery` and `passagesQuery`
 * closures in `server/app.ts`; the route handlers stay thin adapters that
 * resolve `bin` via `qmdBin()` and pass it in.
 */
export async function runQmdQuery(
  deps: QmdQueryDeps,
  queryText: string,
  opts: QmdQueryOpts,
): Promise<{ status: number; body: object }> {
  if (!deps.bin) return { status: 503, body: { error: "qmd not installed" } };
  if (deps.setupState() === "indexing")
    return { status: 200, body: { state: "indexing", results: [] } };
  if (deps.setupState() === "ready") deps.invalidateCollectionsCache(); // pick up the new collection once
  const covering = coveringCollections(
    await deps.getCollections(deps.bin),
    deps.vaultRoot,
  );
  if (!covering.length)
    return { status: 200, body: { state: "uncovered", results: [] } };
  const enabled =
    typeof opts.collectionsParam === "string" && opts.collectionsParam
      ? new Set(opts.collectionsParam.split(",").filter(Boolean))
      : undefined;
  // Narrow at the source: only covering (and enabled) collections.
  const scopeNames = covering
    .map((c) => c.name)
    .filter((n) => !enabled || enabled.has(n));
  // passages-with-note over-fetches so one long doc still yields several
  // passages; the final .slice below caps the response.
  const pool =
    opts.mode === "passages" && opts.note
      ? Math.max(opts.limit * 6, 30)
      : opts.limit;
  const hits = await deps.search(deps.bin, queryText, pool, scopeNames);
  let results: unknown;
  if (opts.mode === "nodes") {
    const nodeTitles = new Map(
      deps.graphNodes
        .filter((n) => !n.phantom)
        .map((n) => [n.id, n.title] as const),
    );
    results = hitsToNodes(hits, covering, deps.vaultRoot, nodeTitles, enabled);
  } else {
    results = hitsToPassages(
      hits,
      covering,
      deps.vaultRoot,
      enabled,
      opts.note,
    ).slice(0, opts.limit);
  }
  return { status: 200, body: { state: "ready", results } };
}

/**
 * One-time setup (R6): create a collection for the vault, index it, generate
 * embeddings. Reports ready only after `embed` completes, since vsearch
 * needs vectors. Runs in the background; state is polled via /api/qmd/status.
 */
export function createQmdSetup(run: Runner) {
  let state: QmdSetupState = "idle";
  let error = "";
  return {
    state: () => state,
    error: () => error,
    start(qmd: string, vaultRoot: string) {
      if (state === "indexing") return;
      state = "indexing";
      error = "";
      void (async () => {
        const steps: string[][] = [
          ["collection", "add", vaultRoot],
          ["update"],
          ["embed"],
        ];
        for (const args of steps) {
          let r: RunResult;
          try {
            r = await run(qmd, args, SETUP_TIMEOUT_MS);
          } catch (e) {
            r = { ok: false, stdout: "", stderr: String(e) };
          }
          if (!r.ok) {
            state = "error";
            error = (r.stderr || `qmd ${args.join(" ")} failed`).slice(0, 500);
            console.warn("qmd setup failed:", error);
            return;
          }
        }
        state = "ready";
      })();
    },
  };
}
