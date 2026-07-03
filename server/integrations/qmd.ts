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

export type QmdSetupState = "idle" | "indexing" | "ready" | "error";

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
