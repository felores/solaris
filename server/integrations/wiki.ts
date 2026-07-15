/**
 * Wiki discovery (F044 / U2): find `wiki/` folders in the active vault and
 * detect their contract files. The discovery signal is a directory whose
 * basename is exactly `wiki` (KTD1); AGENTS.md/CLAUDE.md/index.md/README.md
 * only adjust confidence and contract context.
 *
 * Walks the vault with stdlib fs, respecting graph excludes (same lowercase
 * relative-path semantics as scanner/scan.ts). Confinement mirrors write.ts:
 * every candidate resolves under the vault root. rawDestination is inferred from
 * nearby source folders so wiki ingest does not invent wiki/raw unless needed.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { WikiConfig } from "./config.js";

export interface DiscoverDeps {
  /** Optional injectable directory listing (tests). Defaults to fs.readdirSync. */
  readdir?: (p: string) => string[];
  /** Optional injectable stat (tests). Defaults to fs.statSync. */
  stat?: (p: string) => { isDirectory: () => boolean };
}

const CONTRACT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "index.md",
  "README.md",
] as const;

/** Fallback raw landing folder for new discoveries when no source/docs folder exists. */
export const DEFAULT_RAW_DESTINATION = "../raw/";

/**
 * Discover wiki folders under `vaultRoot`, skipping any directory whose
 * vault-relative path matches an exclude entry (case-insensitive, like the
 * scanner). Returns WikiConfig[] with stable ids derived from the
 * vault-relative path so rediscovery merges cleanly with saved state.
 */
export function discoverWikis(
  vaultRoot: string,
  excludes: string[] = [],
  deps: DiscoverDeps = {},
): WikiConfig[] {
  if (!vaultRoot || !existsSync(vaultRoot)) return [];
  const readdir = deps.readdir ?? ((p) => readdirSync(p));
  const stat = deps.stat ?? ((p) => statSync(p));
  const excludeSet = buildExcludeSet(excludes);
  const base = resolve(vaultRoot);
  const realBase = realpathSync(base);
  const found: WikiConfig[] = [];

  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st: { isDirectory: () => boolean };
      try {
        st = stat(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      if (real !== realBase && !real.startsWith(realBase + sep)) continue;
      const rel = relative(base, full).split(sep).join("/");
      if (isExcludedRel(rel, excludeSet)) continue;
      if (entry === "wiki") {
        found.push(buildWiki(rel || "wiki", base));
      }
      visit(full);
    }
  };

  visit(base);
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}

function buildWiki(relPath: string, vaultRoot: string): WikiConfig {
  const contractFiles = CONTRACT_FILES.filter((f) =>
    existsSync(resolve(vaultRoot, relPath, f)),
  );
  const confidence = confidenceFor(contractFiles);
  return {
    id: relPath || "wiki",
    label: relPath || "wiki",
    path: relPath || "wiki",
    enabled: true,
    contractFiles,
    rawDestination: inferRawDestination(resolve(vaultRoot, relPath)),
    discovered: true,
    confidence,
  };
}

function inferRawDestination(wikiDir: string): string {
  for (const rel of [
    "raw/",
    "../raw/",
    "research/",
    "../research/",
    "docs/",
    "../docs/",
  ]) {
    if (existsSync(resolve(wikiDir, rel))) return rel;
  }
  return DEFAULT_RAW_DESTINATION;
}

function confidenceFor(contracts: string[]): "high" | "medium" | "low" {
  if (contracts.includes("AGENTS.md") || contracts.includes("CLAUDE.md"))
    return "high";
  if (contracts.includes("index.md") || contracts.includes("README.md"))
    return "medium";
  return "low";
}

/**
 * Merge discovered candidates with saved manual wikis for one vault path.
 * - Saved wikis whose `path` matches a discovery keep their enabled/label/
 *   rawDestination (user edits survive rediscovery); discovery refreshes
 *   contractFiles/confidence/discovered.
 * - Saved wikis with no matching discovery are kept as manual entries
 *   (discovered: false).
 * - New discoveries default to enabled:true + inferred rawDestination.
 *
 * Keyed by normalized vault-relative `path` (lowercased, forward slashes) so
 * case or separator differences don't fork entries.
 */
export function mergeWikis(
  discovered: WikiConfig[],
  saved: WikiConfig[] = [],
): WikiConfig[] {
  const byPath = new Map<string, WikiConfig>();
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  for (const d of discovered) byPath.set(norm(d.path), d);
  for (const s of saved) {
    const key = norm(s.path);
    const d = byPath.get(key);
    if (d) {
      byPath.set(key, {
        ...d,
        id: s.id,
        label: s.label,
        enabled: s.enabled,
        rawDestination:
          s.rawDestination === "raw/" && d.rawDestination !== "raw/"
            ? d.rawDestination
            : s.rawDestination,
      });
    } else {
      byPath.set(key, { ...s, discovered: false });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Full discovery + merge entrypoint. Returns the merged wiki list for one
 * vault. Used by the /api/wikis route.
 */
export function discoverAndMerge(
  vaultRoot: string,
  excludes: string[],
  saved: WikiConfig[] = [],
  deps: DiscoverDeps = {},
): WikiConfig[] {
  const excludeSet = buildExcludeSet(excludes);
  const discovered = discoverWikis(vaultRoot, excludes, deps);
  return mergeWikis(
    discovered,
    saved.filter(
      (w) =>
        !isExcludedRel(w.path, excludeSet) &&
        isExistingWikiDir(vaultRoot, w.path, deps),
    ),
  );
}

function isExistingWikiDir(
  vaultRoot: string,
  relPath: string,
  deps: DiscoverDeps,
): boolean {
  const stat = deps.stat ?? ((p) => statSync(p));
  try {
    const base = resolve(vaultRoot);
    const realBase = realpathSync(base);
    const full = resolve(base, relPath);
    const real = realpathSync(full);
    if (real !== realBase && !real.startsWith(realBase + sep)) return false;
    return stat(full).isDirectory();
  } catch {
    return false;
  }
}

function buildExcludeSet(excludes: string[]): Set<string> {
  return new Set(excludes.map((e) => normalizeRel(e)).filter(Boolean));
}

function normalizeRel(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function isExcludedRel(rel: string, excludeSet: Set<string>): boolean {
  const clean = normalizeRel(rel);
  for (const exclude of excludeSet) {
    if (clean === exclude || clean.startsWith(`${exclude}/`)) return true;
  }
  return false;
}
