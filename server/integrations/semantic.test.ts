/**
 * F031 — mutual-KNN semantic edge set.
 *
 * Pure algorithm test (no sqlite): craft doc vectors with known geometry and
 * assert the edge set is thresholded, bounded (<= K*N/2), undirected/deduped,
 * MUTUAL-only (a one-directional nearest neighbor is NOT an edge), restricted
 * to nodeIds, and that known-close-but-unlinked notes are connected.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_K, DEFAULT_THRESHOLD, mutualKnnEdges } from "./semantic.js";

const v = (...n: number[]) => Float32Array.from(n);

describe("mutualKnnEdges (F031)", () => {
  it("connects tight clusters, drops the orphan, excludes non-graph nodes, respects threshold + bound", async () => {
    const docs = new Map<string, Float32Array>([
      // cluster A (mutually cosine > 0.9)
      ["a1", v(1, 0, 0)],
      ["a2", v(0.99, 0.14, 0)],
      ["a3", v(0.98, 0, 0.2)],
      // cluster B (far from A: dot ~0.14 < 0.5)
      ["b1", v(0, 1, 0)],
      ["b2", v(0.14, 0.99, 0)],
      // orphan: near-orthogonal to everyone
      ["o1", v(0, 0, 1)],
      // present in vectors but NOT a graph node -> must be excluded
      ["x1", v(1, 0, 0)],
    ]);
    const nodeIds = new Set(["a1", "a2", "a3", "b1", "b2", "o1"]);
    const edges = await mutualKnnEdges(
      docs,
      nodeIds,
      DEFAULT_K,
      DEFAULT_THRESHOLD,
    );

    const key = (e: { source: string; target: string }) =>
      [e.source, e.target].sort().join("~");
    const set = new Set(edges.map(key));

    // spot-check: known-close pairs connected, cross-cluster pair not
    expect(set.has("a1~a2")).toBe(true);
    expect(set.has("a1~a3")).toBe(true);
    expect(set.has("a2~a3")).toBe(true);
    expect(set.has("b1~b2")).toBe(true);
    expect(set.has("a1~b1")).toBe(false);

    // orphan and excluded node never appear
    expect(edges.some((e) => e.source === "o1" || e.target === "o1")).toBe(
      false,
    );
    expect(edges.some((e) => e.source === "x1" || e.target === "x1")).toBe(
      false,
    );

    // thresholded
    for (const e of edges)
      expect(e.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
    // undirected / deduped (no reversed duplicate)
    expect(set.size).toBe(edges.length);
    // bounded by K*N/2
    expect(edges.length).toBeLessThanOrEqual((DEFAULT_K * nodeIds.size) / 2);
  });

  it("keeps only MUTUAL nearest neighbors (a one-way nearest link is not an edge)", async () => {
    // c's single (K=1) nearest is n1; n1's and n2's nearest is c.
    // => c-n1 mutual (edge); c-n2 one-way (no edge); n1-n2 unrelated.
    const docs = new Map<string, Float32Array>([
      ["c", v(1, 0, 0)],
      ["n1", v(0.95, 0.31, 0)], // cos(c,n1)=0.95
      ["n2", v(0.8, 0, 0.6)], //  cos(c,n2)=0.80, cos(n1,n2)=0.76
    ]);
    const nodeIds = new Set(["c", "n1", "n2"]);
    const edges = await mutualKnnEdges(docs, nodeIds, 1, 0.5);

    expect(edges).toHaveLength(1);
    const only = edges[0];
    expect([only.source, only.target].sort()).toEqual(["c", "n1"]);
  });
});
