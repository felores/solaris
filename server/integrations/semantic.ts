/**
 * Semantic edge set (F031, plan §1): doc-level mutual-KNN over the qmd vectors
 * (F030), restricted to graph.json node ids, written to data/semantic.json.
 *
 * Anti-hairball rule (do NOT relax): MUTUAL-KNN only (A in topK(B) AND B in
 * topK(A)), cosine >= threshold, K capped small. This keeps the extra edge
 * count bounded (<= K*N/2) and the map legible.
 *
 * The build is a cooperative O(n^2) cosine pass (n = graph∩vector docs, ~2.6k
 * today) that yields to the event loop periodically so the server stays
 * responsive; the result is cached by graph fingerprint. Exact, self-contained,
 * no per-query sqlite (sqlite-vec KNN is exact/linear and too slow per node at
 * this scale). ponytail: full rebuild keyed by fingerprint, not per-note
 * incremental — revisit only if the build stops fitting in one interaction.
 */

export interface SemanticEdge {
  source: string;
  target: string;
  score: number;
}

export const DEFAULT_K = 8;
export const DEFAULT_THRESHOLD = 0.5;

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const u = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) u[i] = v[i] / n;
  return u;
}

/**
 * Compute the undirected mutual-KNN edge set over docVectors, keeping only
 * endpoints present in nodeIds. Async: yields to the event loop every few
 * hundred nodes so a full-vault build does not freeze other requests.
 */
export async function mutualKnnEdges(
  docVectors: Map<string, Float32Array>,
  nodeIds: Set<string>,
  k: number = DEFAULT_K,
  threshold: number = DEFAULT_THRESHOLD,
): Promise<SemanticEdge[]> {
  const ids: string[] = [];
  const vecs: Float32Array[] = [];
  for (const [id, v] of docVectors) {
    if (nodeIds.has(id)) {
      ids.push(id);
      vecs.push(normalize(v));
    }
  }
  const n = ids.length;
  if (n < 2) return [];
  const dim = vecs[0].length;

  // Directed top-K neighbor -> score, per node.
  const topK: Array<Map<number, number>> = new Array(n);
  for (let i = 0; i < n; i++) {
    const vi = vecs[i];
    const cand: Array<[number, number]> = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const vj = vecs[j];
      let s = 0;
      for (let d = 0; d < dim; d++) s += vi[d] * vj[d];
      if (s >= threshold) cand.push([j, s]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    const m = new Map<number, number>();
    for (let t = 0; t < Math.min(k, cand.length); t++)
      m.set(cand[t][0], cand[t][1]);
    topK[i] = m;
    if ((i & 255) === 0) await new Promise<void>((r) => setImmediate(r));
  }

  // Keep only mutual pairs; undirected, dedup by i<j; symmetric score = mean.
  const edges: SemanticEdge[] = [];
  for (let i = 0; i < n; i++) {
    for (const [j, sij] of topK[i]) {
      if (i >= j) continue;
      const sji = topK[j].get(i);
      if (sji === undefined) continue; // not mutual
      edges.push({ source: ids[i], target: ids[j], score: (sij + sji) / 2 });
    }
  }
  return edges;
}
