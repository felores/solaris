import type { GNode } from "./types";

// A node's searchable text: title, group (pillar/tag), and its #tags.
export function filterFields(
  n: GNode,
  groupOf: (n: GNode) => string,
): string[] {
  return [n.title || "", groupOf(n) || "", ...(n.tags || [])].map((s) =>
    s.toLowerCase(),
  );
}

// needle's chars appear in order within hay (loose fuzzy match).
export function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++)
    if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

// Compile a pattern to a node predicate: wildcards (*, ?) glob-match a field
// end to end (macro* = starts with macro); plain text is substring-or-fuzzy.
// groupOf is the closure-side "group of n" resolver (depends on group mode).
export function compileMatcher(
  pattern: string,
  groupOf: (n: GNode) => string,
): (n: GNode) => boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return () => false;
  if (/[*?]/.test(p)) {
    const re = new RegExp(
      "^" +
        p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
    );
    return (n) => filterFields(n, groupOf).some((f) => re.test(f));
  }
  return (n) => {
    const fs = filterFields(n, groupOf);
    return (
      fs.some((f) => f.includes(p)) || (p.length >= 3 && subsequence(p, fs[0]))
    );
  };
}
