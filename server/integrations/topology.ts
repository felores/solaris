/**
 * Topology/gaps primitive (U5, KTD6): phantoms, orphans, and sparse clusters
 * computed from the in-memory graph, shared by the Web-mode suggestion
 * endpoint and the agent's read context (R15). Suggested queries are
 * template-based, no LLM; context comes from graph-local signals (linker
 * titles) instead of per-suggestion qmd lookups, which would cost one
 * 5-9s vsearch spawn each at Web-mode activation.
 */

export interface TopoNode {
  id: string;
  title: string;
  pillar?: string;
  words?: number;
  in: number;
  out: number;
  phantom?: boolean;
}

export interface TopoLink {
  source: string;
  target: string;
}

export interface GapSuggestion {
  kind: "phantom" | "orphan" | "cluster";
  title: string;
  query: string;
  reason: string;
  /** Graph node this gap anchors to (null for cluster suggestions). */
  nodeId: string | null;
}

export interface GapStats {
  phantoms: number;
  orphans: number;
  sparsePillars: string[];
}

/** Path-like titles (broken relative links, tooling artifacts) are not concept gaps. */
function conceptLike(title: string): boolean {
  return (
    !!title &&
    !title.includes("/") &&
    !title.includes("\\") &&
    !title.startsWith(".")
  );
}

/**
 * Note-scoped research questions (F019): 3-5 template questions derived
 * from ONE note — its unresolved phantom links first (explicit gaps in
 * this note), then title-based templates. Local and free; no LLM.
 * Short notes (< 200 words) get 3; richer notes up to 5.
 */
export function noteQuestions(
  nodes: TopoNode[],
  links: TopoLink[],
  noteId: string,
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const note = byId.get(noteId);
  if (!note || note.phantom) return [];
  const target = (note.words ?? 0) < 200 ? 3 : 5;
  const questions: string[] = [];
  for (const l of links) {
    if (questions.length >= target) break;
    if (l.source !== noteId) continue;
    const t = byId.get(l.target);
    if (t?.phantom && conceptLike(t.title))
      questions.push(`${t.title} overview key concepts`);
  }
  const topic = note.title.replace(/[-_]+/g, " ").trim(); // slug titles -> readable queries
  // Varied phrasings with the topic embedded, never a repeated title prefix.
  const fillers = [
    `What are the latest developments in ${topic}?`,
    `Strongest criticisms and common pitfalls of ${topic}`,
    `Practical case studies applying ${topic}`,
    `Best tools and frameworks for ${topic}`,
    `Key people and seminal writing on ${topic}`,
  ];
  for (const f of fillers) {
    if (questions.length >= target) break;
    questions.push(f);
  }
  return questions;
}

export function computeGaps(
  nodes: TopoNode[],
  links: TopoLink[],
  cap = 5,
): { suggestions: GapSuggestion[]; stats: GapStats } {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Phantoms ranked by inbound demand, with their linkers as context.
  const linkersOf = new Map<string, string[]>();
  for (const l of links) {
    const t = byId.get(l.target);
    if (!t?.phantom) continue;
    const s = byId.get(l.source);
    if (!s) continue;
    (
      linkersOf.get(l.target) ?? linkersOf.set(l.target, []).get(l.target)!
    ).push(s.title);
  }
  const phantoms = nodes
    .filter((n) => n.phantom && conceptLike(n.title))
    .sort((a, b) => b.in - a.in);

  // Orphans: no links either way; longest first (most content, least woven in).
  const orphans = nodes
    .filter((n) => !n.phantom && n.in + n.out === 0 && conceptLike(n.title))
    .sort((a, b) => (b.words ?? 0) - (a.words ?? 0));

  // Sparse clusters: pillars (>=3 notes) whose average degree is below 1.
  const pillarStats = new Map<string, { count: number; degree: number }>();
  for (const n of nodes) {
    if (n.phantom || !n.pillar) continue;
    const s = pillarStats.get(n.pillar) ?? { count: 0, degree: 0 };
    s.count++;
    s.degree += n.in + n.out;
    pillarStats.set(n.pillar, s);
  }
  const sparsePillars = [...pillarStats.entries()]
    .filter(
      ([p, s]) => s.count >= 3 && s.degree / s.count < 1 && conceptLike(p),
    )
    .sort((a, b) => a[1].degree / a[1].count - b[1].degree / b[1].count)
    .map(([p]) => p);

  const suggestions: GapSuggestion[] = [];
  const linkerNote = (id: string) => {
    const names = (linkersOf.get(id) ?? []).slice(0, 3).join(", ");
    return names ? ` (linked from ${names})` : "";
  };
  for (const p of phantoms.slice(0, 3)) {
    suggestions.push({
      kind: "phantom",
      title: p.title,
      query: `${p.title} overview key concepts`,
      reason: `Linked from ${p.in} note${p.in === 1 ? "" : "s"} but never written${linkerNote(p.id)}`,
      nodeId: p.id,
    });
  }
  for (const o of orphans) {
    if (suggestions.length >= cap - 1) break;
    suggestions.push({
      kind: "orphan",
      title: o.title,
      query: `${o.title} related topics and context`,
      reason: `No links in or out — ${o.words ?? 0} words with no connections yet`,
      nodeId: o.id,
    });
  }
  if (suggestions.length < cap && sparsePillars.length) {
    const p = sparsePillars[0];
    suggestions.push({
      kind: "cluster",
      title: p,
      query: `${p} fundamentals and key ideas`,
      reason: `The "${p}" group is sparsely connected`,
      nodeId: null,
    });
  }
  // Fill any remaining room with more phantoms.
  for (const p of phantoms.slice(3)) {
    if (suggestions.length >= cap) break;
    suggestions.push({
      kind: "phantom",
      title: p.title,
      query: `${p.title} overview key concepts`,
      reason: `Linked from ${p.in} note${p.in === 1 ? "" : "s"} but never written${linkerNote(p.id)}`,
      nodeId: p.id,
    });
  }

  return {
    suggestions: suggestions.slice(0, cap),
    stats: {
      phantoms: nodes.filter((n) => n.phantom).length,
      orphans: nodes.filter((n) => !n.phantom && n.in + n.out === 0).length,
      sparsePillars,
    },
  };
}
