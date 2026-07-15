import type { GNode, GLink } from "./types";

const endId = (e: string | GNode, byId: Map<string, GNode>): string =>
  typeof e === "object" ? e.id : byId.get(e)!.id;

// Label-propagation clustering over the mutual-KNN semantic edge set.
// Deterministic: seeds = each node's own id, fixed node order, lexicographic
// tie-break — stable across runs with no randomness. Cluster names come from
// the most common tag of the cluster's members, with pillar as fallback,
// "cluster" as last resort; duplicates get a numeric suffix. Returns an
// id->clusterName map; nodes with no semantic edges are absent (matches the
// current behavior of `clusterNameOfId` in boot()).
export function computeSemanticClusters(
  nodes: GNode[],
  semanticLinks: GLink[],
): Map<string, string> {
  const result = new Map<string, string>();
  if (!semanticLinks.length) return result;
  const byId = new Map<string, GNode>();
  for (const n of nodes) byId.set(n.id, n);
  const adj = new Map<string, Array<[string, number]>>();
  const link = (a: string, b: string, w: number) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push([b, w]);
  };
  for (const l of semanticLinks) {
    const a = endId(l.source, byId);
    const b = endId(l.target, byId);
    link(a, b, l.weight);
    link(b, a, l.weight);
  }
  const ids = [...adj.keys()].sort();
  const label = new Map<string, string>();
  for (const id of ids) label.set(id, id);
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (const id of ids) {
      const counts = new Map<string, number>();
      for (const [nb, w] of adj.get(id)!) {
        const lab = label.get(nb)!;
        counts.set(lab, (counts.get(lab) ?? 0) + w);
      }
      let best = label.get(id)!;
      let bestW = -1;
      for (const [lab, w] of counts) {
        if (w > bestW || (w === bestW && lab < best)) {
          best = lab;
          bestW = w;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Group members by label and name each cluster deterministically.
  const members = new Map<string, string[]>();
  for (const [id, lab] of label) {
    (members.get(lab) ?? members.set(lab, []).get(lab)!).push(id);
  }
  const ordered = [...members.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
  );
  const used = new Map<string, number>();
  const nameOfLabel = new Map<string, string>();
  for (const [lab, ids] of ordered) {
    const tally = new Map<string, number>();
    for (const id of ids)
      for (const t of byId.get(id)?.tags ?? [])
        tally.set(t, (tally.get(t) ?? 0) + 1);
    let name: string;
    if (tally.size) {
      name =
        "#" +
        [...tally.entries()].sort(
          (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
        )[0][0];
    } else {
      const pc = new Map<string, number>();
      for (const id of ids) {
        const p = byId.get(id)?.pillar;
        if (p) pc.set(p, (pc.get(p) ?? 0) + 1);
      }
      name = pc.size
        ? [...pc.entries()].sort(
            (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
          )[0][0]
        : "cluster";
    }
    const k = (used.get(name) ?? 0) + 1;
    used.set(name, k);
    nameOfLabel.set(lab, k > 1 ? `${name} ${k}` : name);
  }
  for (const [id, lab] of label) result.set(id, nameOfLabel.get(lab)!);
  return result;
}
