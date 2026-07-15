/**
 * Excerpt/snippet heuristics (U3, KTD6). Pure functions over note content,
 * used by /api/related to show a preview of each KNN neighbor.
 *
 * Priority: YAML frontmatter description/summary/excerpt (long, not a title
 * echo) wins; otherwise the body is read paragraph by paragraph, skipping
 * short paragraphs and H1 title echoes, joined up to ~280 chars. Markdown
 * is stripped (links, emphasis, headings), speaker timestamps, email
 * headers, dividers, and bare URLs are dropped, and the result is clipped
 * with a trailing ellipsis.
 *
 * `excerptFor` is the only function that touches the filesystem. The file
 * read is wrapped in try/catch -> "" so a missing/unreadable note degrades
 * to an empty preview instead of throwing (the read route was already
 * guarded by the path-confinement seam; this matches its "best-effort
 * preview" contract).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Rich preview of a note. Reads `id` from `vaultRoot`, applies the
 * markdown-cleaning heuristics, and returns a string clipped to ~280
 * characters. Returns "" if the file is unreadable.
 */
export function excerptFor(
  vaultRoot: string,
  id: string,
  title: string,
): string {
  let raw: string;
  try {
    raw = readFileSync(resolve(vaultRoot, id), "utf-8");
  } catch {
    return "";
  }
  const nt = norm(title);
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const fmLine = fm.match(
    /^\s*(?:description|summary|excerpt):\s*(.+?)\s*$/im,
  )?.[1];
  if (fmLine) {
    const v = fmLine.replace(/^["']|["']$/g, "").trim();
    if (v.length >= 25) {
      const nv = norm(v);
      if (nv && nv !== nt && !nv.startsWith(nt)) return clip(v, 280);
    }
  }
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
  let out = "";
  for (const para of body.split(/\n\s*\n/)) {
    const clean = stripSnippet(para);
    if (clean.length < 25) continue;
    const nc = norm(clean);
    if (!nc || nc === nt || nc.startsWith(nt)) continue;
    out = out ? `${out} ${clean}` : clean;
    if (out.length >= 280) break;
  }
  return clip(out, 280);
}

/** Lowercase + strip everything outside [a-z0-9]; used to compare titles to
 *  paragraphs without caring about case, punctuation, or whitespace. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Drop noise a body paragraph might carry (speaker timestamps, dividers,
 * email headers / forwarded-message markers, bare URLs), strip the
 * surrounding markdown (inline links, leading heading, emphasis, code
 * ticks, blockquote markers), and join the kept lines into a single
 * whitespace-normalized string. Zero-width and BOM chars are removed too.
 */
export function stripSnippet(para: string): string {
  const EMAIL = /^(de|fecha|asunto|para|subject|from|to|date|cc|bcc)\b/i;
  const FWD = /mensaje reenviado|forwarded (message|conversation)/i;
  const kept = para
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (/^\d{1,2}:\d{2}\s*[-–]/.test(l)) return false; // MM:SS - Speaker
      if (/^[-=*_~]{4,}$/.test(l)) return false; // divider lines
      if (EMAIL.test(l) || FWD.test(l)) return false; // email headers / fwd markers
      if (/^<?https?:\/\/\S+>?$/i.test(l)) return false; // bare URL
      return true;
    });
  return kept
    .join(" ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/^#+\s*/, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "") // zero-width / BOM (email tracking)
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trim a string to at most `n` characters, trimming trailing whitespace
 *  before appending "…" so the ellipsis never sits on a stray space. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}
