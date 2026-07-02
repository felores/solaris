import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { computeGaps, type TopoNode, type TopoLink } from "./topology";

const node = (
  over: Partial<TopoNode> & { id: string; title: string },
): TopoNode => ({
  in: 0,
  out: 0,
  words: 100,
  pillar: "notes",
  ...over,
});

describe("computeGaps", () => {
  it("surfaces phantoms with their linker context, ranked by inbound demand", () => {
    const nodes = [
      node({ id: "a.md", title: "Note A", out: 2, in: 1 }),
      node({ id: "b.md", title: "Note B", out: 1, in: 1 }),
      node({
        id: "phantom:zettelkasten",
        title: "Zettelkasten",
        in: 2,
        phantom: true,
      }),
      node({ id: "phantom:rare", title: "Rare Topic", in: 1, phantom: true }),
    ];
    const links: TopoLink[] = [
      { source: "a.md", target: "phantom:zettelkasten" },
      { source: "b.md", target: "phantom:zettelkasten" },
      { source: "a.md", target: "phantom:rare" },
    ];
    const { suggestions } = computeGaps(nodes, links);
    const ph = suggestions.filter((s) => s.kind === "phantom");
    expect(ph[0].title).toBe("Zettelkasten");
    expect(ph[0].reason).toContain("2 notes");
    expect(ph[0].reason).toContain("Note A");
    expect(ph[0].query).toContain("Zettelkasten");
    expect(ph[0].nodeId).toBe("phantom:zettelkasten");
  });

  it("detects orphans and reports stats", () => {
    const nodes = [
      node({ id: "lonely.md", title: "Lonely Idea", words: 900 }),
      node({ id: "hub.md", title: "Hub", in: 3, out: 3 }),
    ];
    const { suggestions, stats } = computeGaps(nodes, []);
    const orphan = suggestions.find((s) => s.kind === "orphan");
    expect(orphan?.title).toBe("Lonely Idea");
    expect(orphan?.nodeId).toBe("lonely.md");
    expect(stats.orphans).toBe(1);
  });

  it("yields no false gaps on a well-connected graph", () => {
    const nodes = [
      node({ id: "a.md", title: "A", in: 2, out: 2 }),
      node({ id: "b.md", title: "B", in: 2, out: 2 }),
      node({ id: "c.md", title: "C", in: 2, out: 2 }),
    ];
    const { suggestions, stats } = computeGaps(nodes, []);
    expect(suggestions).toEqual([]);
    expect(stats.phantoms).toBe(0);
    expect(stats.orphans).toBe(0);
    expect(stats.sparsePillars).toEqual([]);
  });

  it("caps suggestions at five", () => {
    const nodes: TopoNode[] = [];
    for (let i = 0; i < 10; i++)
      nodes.push(
        node({
          id: `phantom:p${i}`,
          title: `Topic ${i}`,
          in: 10 - i,
          phantom: true,
        }),
      );
    for (let i = 0; i < 10; i++)
      nodes.push(node({ id: `o${i}.md`, title: `Orphan ${i}` }));
    const { suggestions } = computeGaps(nodes, []);
    expect(suggestions.length).toBe(5);
  });

  it("ignores path-like phantom titles (broken relative links, not concept gaps)", () => {
    const nodes = [
      node({
        id: "phantom:x",
        title: "node_modules/pkg/README",
        in: 5,
        phantom: true,
      }),
      node({ id: "phantom:y", title: ".hidden/thing", in: 4, phantom: true }),
      node({ id: "phantom:z", title: "Real Concept", in: 1, phantom: true }),
    ];
    const { suggestions } = computeGaps(nodes, []);
    expect(suggestions.map((s) => s.title)).toEqual(["Real Concept"]);
  });

  it("flags sparse pillars via the degree heuristic", () => {
    const nodes = [
      node({ id: "a.md", title: "A", pillar: "sparse-area" }),
      node({ id: "b.md", title: "B", pillar: "sparse-area" }),
      node({ id: "c.md", title: "C", pillar: "sparse-area", in: 1 }),
      node({ id: "d.md", title: "D", pillar: "dense", in: 4, out: 4 }),
      node({ id: "e.md", title: "E", pillar: "dense", in: 4, out: 4 }),
      node({ id: "f.md", title: "F", pillar: "dense", in: 4, out: 4 }),
    ];
    const { suggestions, stats } = computeGaps(nodes, []);
    expect(stats.sparsePillars).toEqual(["sparse-area"]);
    expect(
      suggestions.some(
        (s) => s.kind === "cluster" && s.title === "sparse-area",
      ),
    ).toBe(true);
  });
});

describe("GET /api/gaps", () => {
  const VAULT = mkdtempSync(join(tmpdir(), "solaris-topo-test-"));
  afterAll(() => rmSync(VAULT, { recursive: true, force: true }));
  const graphPath = join(VAULT, "graph.json");
  writeFileSync(
    graphPath,
    JSON.stringify({
      meta: { vaultName: "t", vaultPath: VAULT, notes: 2, excludes: [] },
      nodes: [
        { id: "a.md", title: "Note A", pillar: "n", words: 10, in: 0, out: 1 },
        {
          id: "lone.md",
          title: "Loner",
          pillar: "n",
          words: 50,
          in: 0,
          out: 0,
        },
        {
          id: "phantom:missing",
          title: "Missing Concept",
          pillar: "Unwritten",
          words: 0,
          in: 1,
          out: 0,
          phantom: true,
        },
      ],
      links: [{ source: "a.md", target: "phantom:missing", weight: 1 }],
    }),
  );
  const { app } = createApp(graphPath, undefined, {
    configPath: join(VAULT, "config.json"),
    detectDeps: {
      fileExists: () => false,
      run: async () => ({ ok: false, stdout: "", stderr: "" }),
      home: "/h",
      env: {},
    },
  });

  it("returns capped template suggestions from the live graph", async () => {
    const res = await request(app).get("/api/gaps");
    expect(res.status).toBe(200);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    expect(res.body.suggestions.length).toBeLessThanOrEqual(5);
    const kinds = res.body.suggestions.map((s: { kind: string }) => s.kind);
    expect(kinds).toContain("phantom");
    expect(kinds).toContain("orphan");
    expect(res.body.stats.phantoms).toBe(1);
    expect(res.body.stats.orphans).toBe(1);
  });
});
