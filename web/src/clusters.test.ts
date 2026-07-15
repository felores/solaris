import { describe, it, expect } from "vitest";
import { computeSemanticClusters } from "./clusters";
import type { GNode, GLink } from "./types";

const node = (id: string, over: Partial<GNode> = {}): GNode => ({
  id,
  title: id,
  pillar: "",
  words: 0,
  in: 0,
  out: 0,
  ...over,
});

const link = (source: string, target: string, weight = 1): GLink => ({
  source,
  target,
  weight,
  __sem: true,
});

describe("computeSemanticClusters", () => {
  it("returns an empty map when semanticLinks is empty", () => {
    const nodes = [node("a"), node("b")];
    expect(computeSemanticClusters(nodes, [])).toEqual(new Map());
  });

  it("two disconnected cliques get two distinct clusters", () => {
    const nodes = [
      node("a1", { tags: ["#alpha"] }),
      node("a2", { tags: ["#alpha"] }),
      node("b1", { tags: ["#beta"] }),
      node("b2", { tags: ["#beta"] }),
    ];
    const links = [
      link("a1", "a2"),
      link("a2", "a1"),
      link("b1", "b2"),
      link("b2", "b1"),
    ];
    const map = computeSemanticClusters(nodes, links);
    expect(map.size).toBe(4);
    expect(map.get("a1")).toBe(map.get("a2"));
    expect(map.get("b1")).toBe(map.get("b2"));
    expect(map.get("a1")).not.toBe(map.get("b1"));
  });

  it("clusters are deterministic across two runs of the same input", () => {
    const nodes = [
      node("a", { tags: ["#a"] }),
      node("b", { tags: ["#b"] }),
      node("c", { tags: ["#c"] }),
    ];
    const links = [
      link("a", "b"),
      link("b", "a"),
      link("b", "c"),
      link("c", "b"),
    ];
    const m1 = computeSemanticClusters(nodes, links);
    const m2 = computeSemanticClusters(nodes, links);
    expect([...m1.entries()]).toEqual([...m2.entries()]);
  });

  it("a node with no semantic edges is absent from the result (current behavior)", () => {
    const nodes = [node("solo"), node("a"), node("b")];
    const links = [link("a", "b"), link("b", "a")];
    const map = computeSemanticClusters(nodes, links);
    expect(map.has("solo")).toBe(false);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(true);
  });

  it("nodes array can be empty (no crash, empty map)", () => {
    expect(computeSemanticClusters([], [])).toEqual(new Map());
  });

  it("names a cluster by its most common tag (deterministic tie-break)", () => {
    const nodes = [
      node("a", { tags: ["#zeta"] }),
      node("b", { tags: ["#zeta"] }),
      node("c", { tags: ["#zeta"] }),
    ];
    const links = [
      link("a", "b"),
      link("b", "a"),
      link("b", "c"),
      link("c", "b"),
    ];
    const map = computeSemanticClusters(nodes, links);
    // current code prepends '#' to the tag value
    expect(map.get("a")).toBe("##zeta");
    expect(map.get("b")).toBe("##zeta");
    expect(map.get("c")).toBe("##zeta");
  });

  it("falls back to pillar when no tags exist on the cluster", () => {
    const nodes = [
      node("a", { pillar: "Biology" }),
      node("b", { pillar: "Biology" }),
    ];
    const links = [link("a", "b"), link("b", "a")];
    const map = computeSemanticClusters(nodes, links);
    expect(map.get("a")).toBe("Biology");
    expect(map.get("b")).toBe("Biology");
  });

  it("falls back to 'cluster' when neither tags nor pillar exist", () => {
    const nodes = [node("a"), node("b")];
    const links = [link("a", "b"), link("b", "a")];
    const map = computeSemanticClusters(nodes, links);
    expect(map.get("a")).toBe("cluster");
    expect(map.get("b")).toBe("cluster");
  });

  it("dedupes duplicate cluster names with a numeric suffix on the second use", () => {
    const nodes = [
      node("a1", { tags: ["#x"] }),
      node("a2", { tags: ["#x"] }),
      node("b1", { tags: ["#x"] }),
      node("b2", { tags: ["#x"] }),
    ];
    const links = [
      link("a1", "a2"),
      link("a2", "a1"),
      link("b1", "b2"),
      link("b2", "b1"),
    ];
    const map = computeSemanticClusters(nodes, links);
    const names = new Set([map.get("a1"), map.get("b1")]);
    // tag '#x' becomes '##x'; dedupe produces '##x' and '##x 2'
    expect(names.size).toBe(2);
  });

  it("accepts GLink objects whose source/target are GNode (3d-force-graph shape)", () => {
    const a = node("a", { tags: ["#g"] });
    const b = node("b", { tags: ["#g"] });
    const links: GLink[] = [
      { source: a, target: b, weight: 1, __sem: true },
      { source: b, target: a, weight: 1, __sem: true },
    ];
    const map = computeSemanticClusters([a, b], links);
    // current code prepends '#' to the tag value, so a '#g' tag becomes '##g'
    expect(map.get("a")).toBe("##g");
    expect(map.get("b")).toBe("##g");
  });

  it("asymmetric link set still propagates a single label to the connected component", () => {
    const nodes = [node("a", { tags: ["#one"] }), node("b"), node("c")];
    const links = [link("a", "b"), link("b", "c")];
    const map = computeSemanticClusters(nodes, links);
    expect(map.size).toBe(3);
    expect(map.get("a")).toBe(map.get("b"));
    expect(map.get("b")).toBe(map.get("c"));
  });

  it("is stable when nodes are passed in a different array order (label propagation is order-independent)", () => {
    const a = node("a", { tags: ["#x"] });
    const b = node("b", { tags: ["#x"] });
    const c = node("c", { tags: ["#x"] });
    const links = [
      link("a", "b"),
      link("b", "a"),
      link("b", "c"),
      link("c", "b"),
    ];
    const m1 = computeSemanticClusters([a, b, c], links);
    const m2 = computeSemanticClusters([c, a, b], links);
    const m3 = computeSemanticClusters([b, c, a], links);
    // membership is what matters; size + per-node labels
    expect(m1.size).toBe(m2.size);
    expect(m1.size).toBe(m3.size);
    for (const id of ["a", "b", "c"]) {
      expect(m1.get(id)).toBe(m2.get(id));
      expect(m1.get(id)).toBe(m3.get(id));
    }
  });
});
