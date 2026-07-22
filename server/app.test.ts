import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createApp } from "./app";
import { scanVault } from "../scanner/scan";
import { updateConfig } from "./integrations/config";
import {
  createVoiceTraceStore,
  type VoiceTraceStore,
} from "./integrations/voice-trace";

// Throwaway vault with one real note. The graph.json points /api/note's
// vaultRoot here so the path-traversal guard can be exercised end-to-end.
const VAULT = mkdtempSync(join(tmpdir(), "sinapso-test-"));
const NOTE_BODY = "# Real Note\n\nA real markdown note inside the vault.\n";
writeFileSync(join(VAULT, "real.md"), NOTE_BODY);
// 12-line note for anchored-context / pagination tests.
const LINES_NOTE =
  Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
writeFileSync(join(VAULT, "lines.md"), LINES_NOTE);

const graphPath = join(VAULT, "graph.json");
writeFileSync(
  graphPath,
  JSON.stringify({
    meta: { vaultName: "test", vaultPath: VAULT, notes: 1, excludes: [] },
    nodes: [{ id: "real.md", title: "Real Note", phantom: false }],
    links: [],
  }),
);

const { app } = createApp(graphPath);

afterAll(() => rmSync(VAULT, { recursive: true, force: true }));

describe("server: active frontend view", () => {
  it("serves the latest published note or Research view to the scoped MCP token", async () => {
    const browserToken = (await request(app).get("/api/session")).body.token;
    const mcpToken = (await request(app).get("/api/session?surface=mcp")).body
      .token;
    const context = {
      clientId: "desktop-a",
      sequence: 1,
      activate: true,
      view: {
        readerNoteId: "real.md",
        researchPanelOpen: true,
        visibleResearchId: "research-new",
        pinnedResearchId: null,
      },
    };
    await request(app)
      .post("/api/current-view")
      .set("x-sinapso-token", browserToken)
      .send(context)
      .expect(204);
    const shown = await request(app)
      .get("/api/current-view")
      .set("x-sinapso-token", mcpToken)
      .expect(200);
    expect(shown.body).toMatchObject({
      viewStateKnown: true,
      view: {
        readerNoteId: "real.md",
        researchPanelOpen: true,
        visibleResearchId: "research-new",
      },
    });
    expect(shown.body.updatedAt).toEqual(expect.any(String));
  });

  it("does not expose the active view without a session token", async () => {
    await request(app).get("/api/current-view").expect(403);
  });

  it("queues a validated MCP open-note action for the active window", async () => {
    const browserToken = (await request(app).get("/api/session")).body.token;
    const mcpToken = (await request(app).get("/api/session?surface=mcp")).body
      .token;
    await request(app)
      .post("/api/current-view")
      .set("x-sinapso-token", browserToken)
      .send({
        clientId: "desktop-actions",
        sequence: 1,
        activate: true,
        view: { readerNoteId: null, researchPanelOpen: false },
      })
      .expect(204);
    await request(app)
      .post("/api/current-view/open-note")
      .set("x-sinapso-token", mcpToken)
      .send({ note: "real.md" })
      .expect(202);
    await request(app)
      .post("/api/current-view/open-note")
      .set("x-sinapso-token", mcpToken)
      .send({ note: "phantom:missing.md" })
      .expect(404);
    const actions = await request(app)
      .get("/api/current-view/actions?clientId=desktop-actions")
      .set("x-sinapso-token", browserToken)
      .expect(200);
    expect(actions.body.actions).toEqual([
      { type: "open_note", note: "real.md" },
    ]);
  });

  it("keeps the last activated window and ignores out-of-order updates", async () => {
    const browserToken = (await request(app).get("/api/session")).body.token;
    const mcpToken = (await request(app).get("/api/session?surface=mcp")).body
      .token;
    const publish = (
      clientId: string,
      sequence: number,
      note: string,
      activate = true,
    ) =>
      request(app)
        .post("/api/current-view")
        .set("x-sinapso-token", browserToken)
        .send({
          clientId,
          sequence,
          activate,
          view: { readerNoteId: note, researchPanelOpen: false },
        })
        .expect(204);
    await publish("desktop-a", 2, "real.md");
    await publish("desktop-b", 1, "lines.md");
    await publish("desktop-a", 1, "stale.md");
    await publish("desktop-a", 3, "background.md", false);
    const shown = await request(app)
      .get("/api/current-view")
      .set("x-sinapso-token", mcpToken)
      .expect(200);
    expect(shown.body.view.readerNoteId).toBe("lines.md");
    await request(app)
      .post("/api/current-view")
      .set("x-sinapso-token", mcpToken)
      .send({ clientId: "forbidden", sequence: 1, view: {} })
      .expect(403);
  });
});

describe("server: /api/note path-traversal guard", () => {
  it("returns markdown for a valid in-vault note", async () => {
    const res = await request(app).get("/api/note?id=real.md");
    expect(res.status).toBe(200);
    expect(res.body.markdown).toBe(NOTE_BODY);
  });

  it("rejects parent-directory traversal (../../etc/passwd)", async () => {
    const res = await request(app).get("/api/note?id=../../etc/passwd");
    expect(res.status).toBe(400);
  });

  it("rejects URL-encoded traversal", async () => {
    const res = await request(app).get("/api/note?id=..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
  });

  it("rejects a non-.md path", async () => {
    const res = await request(app).get("/api/note?id=readme.txt");
    expect(res.status).toBe(400);
  });

  it("rejects a phantom: id with 404 (not 400)", async () => {
    const res = await request(app).get("/api/note?id=phantom:something");
    expect(res.status).toBe(404);
  });
});

describe("server: /api/note-lines slice + guard", () => {
  it("returns a line-range slice with range metadata", async () => {
    const res = await request(app).get(
      "/api/note-lines?id=real.md&from=1&count=1",
    );
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("# Real Note");
    expect(res.body.from).toBe(1);
    expect(res.body.to).toBe(1);
  });

  it("clamps an over-long count and reports total lines", async () => {
    const res = await request(app).get(
      "/api/note-lines?id=real.md&from=3&count=999",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.text).toContain("A real markdown note");
  });

  it("anchored mode centers context on the line (before AND after)", async () => {
    const res = await request(app).get(
      "/api/note-lines?id=lines.md&line=6&before=2&after=2",
    );
    expect(res.status).toBe(200);
    expect(res.body.from).toBe(4);
    expect(res.body.to).toBe(8);
    expect(res.body.text).toBe("L4\nL5\nL6\nL7\nL8");
  });

  it("anchored mode at line 1 clamps the start to the file head", async () => {
    const res = await request(app).get(
      "/api/note-lines?id=lines.md&line=1&before=5&after=5",
    );
    expect(res.status).toBe(200);
    expect(res.body.from).toBe(1);
    expect(res.body.to).toBe(11);
    expect(res.body.text.startsWith("L1\n")).toBe(true);
  });

  it("anchored mode near end of file clamps the tail", async () => {
    const res = await request(app).get(
      "/api/note-lines?id=lines.md&line=12&before=3&after=3",
    );
    expect(res.status).toBe(200);
    expect(res.body.from).toBe(9);
    expect(res.body.to).toBe(13);
    expect(res.body.text).toContain("L12");
  });

  it("anchored mode caps the window at 400 lines", async () => {
    const res = await request(app).get(
      "/api/note-lines?id=lines.md&line=6&before=500&after=500",
    );
    expect(res.status).toBe(200);
    // window = before+1+after would be 1001, capped at 400; small file so
    // the whole note is returned but never more than 400 lines.
    expect(res.body.to - res.body.from + 1).toBeLessThanOrEqual(400);
    expect(res.body.from).toBe(1);
  });

  it("range mode still works alongside anchored mode (from/count)", async () => {
    const res = await request(app).get(
      "/api/note-lines?id=lines.md&from=3&count=4",
    );
    expect(res.status).toBe(200);
    expect(res.body.from).toBe(3);
    expect(res.body.to).toBe(6);
    expect(res.body.text).toBe("L3\nL4\nL5\nL6");
  });

  it("always returns the full {id, from, to, total, text} shape", async () => {
    const res = await request(app).get("/api/note-lines?id=lines.md&line=2");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "lines.md");
    expect(res.body).toHaveProperty("from");
    expect(res.body).toHaveProperty("to");
    expect(res.body).toHaveProperty("total", 13);
    expect(res.body).toHaveProperty("text");
  });

  it("rejects parent-directory traversal", async () => {
    const res = await request(app).get(
      "/api/note-lines?id=../../etc/passwd&from=1",
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-.md path", async () => {
    const res = await request(app).get("/api/note-lines?id=readme.txt");
    expect(res.status).toBe(400);
  });

  it("rejects a phantom: id with 404", async () => {
    const res = await request(app).get("/api/note-lines?id=phantom:x");
    expect(res.status).toBe(404);
  });
});

describe("server: rescan excludes", () => {
  it("reconciles stale graph files with default archive and images excludes on startup", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sinapso-startup-default-excludes-"),
    );
    try {
      mkdirSync(join(root, "archivo"));
      mkdirSync(join(root, "images"));
      writeFileSync(join(root, "keep.md"), "# Keep\n");
      writeFileSync(join(root, "archivo", "old.md"), "# Archived\n");
      writeFileSync(join(root, "images", "image-note.md"), "# Image note\n");
      const graph = join(root, "graph.json");
      scanVault({ vault: root, out: graph });
      const configPath = join(root, "config.json");
      updateConfig({ archiveDestination: "archivo" }, configPath);

      const created = createApp(graph, undefined, { configPath });
      const ids = (created.meta() as unknown as { notes?: number }).notes;
      const graphData = JSON.parse(readFileSync(graph, "utf-8")) as {
        meta: { excludes: string[] };
        nodes: Array<{ id: string }>;
      };

      expect(ids).toBe(1);
      expect(graphData.meta.excludes).toContain("archivo");
      expect(graphData.meta.excludes).toContain("images");
      expect(graphData.nodes.map((n) => n.id)).toEqual(["keep.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses initialized vault-scoped excludes exactly on rescan", async () => {
    const root = mkdtempSync(join(tmpdir(), "sinapso-rescan-excludes-"));
    try {
      mkdirSync(join(root, "skip"));
      mkdirSync(join(root, "done"));
      mkdirSync(join(root, "media"));
      writeFileSync(join(root, "keep.md"), "# Keep\n");
      writeFileSync(join(root, "skip", "hidden.md"), "# Hidden\n");
      writeFileSync(join(root, "done", "archived.md"), "# Archived\n");
      writeFileSync(join(root, "media", "image-note.md"), "# Image note\n");
      const graph = join(root, "graph.json");
      scanVault({ vault: root, out: graph });
      const configPath = join(root, "config.json");
      updateConfig(
        {
          archiveDestination: "done",
          imagesDestination: "media",
          vaults: {
            [root]: {
              path: root,
              excludes: ["skip"],
              wikis: [],
            },
          },
        },
        configPath,
      );
      const { app } = createApp(graph, undefined, { configPath });

      const res = await request(app).post("/api/rescan");
      const ids = (res.body.graph.nodes as Array<{ id: string }>).map(
        (n) => n.id,
      );

      expect(res.status).toBe(200);
      expect(res.body.graph.meta.excludes).toEqual(["skip"]);
      expect(ids).toContain("keep.md");
      expect(ids).not.toContain("skip/hidden.md");
      expect(ids).toContain("done/archived.md");
      expect(ids).toContain("media/image-note.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("server: /api/note-grep literal scan + guard", () => {
  it("finds every matching line with its 1-based line number", async () => {
    const res = await request(app).get("/api/note-grep?id=real.md&q=markdown");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.matches[0].line).toBe(3);
    expect(res.body.matches[0].text).toContain("markdown");
  });

  it("is case-sensitive by default, case-insensitive with ignore_case=1", async () => {
    const sensitive = await request(app).get(
      "/api/note-grep?id=real.md&q=Real",
    );
    expect(sensitive.body.count).toBe(1); // "# Real Note" only
    const insensitive = await request(app).get(
      "/api/note-grep?id=real.md&q=real&ignore_case=1",
    );
    expect(insensitive.body.count).toBe(2); // "Real" + "real"
  });

  it("returns count 0 for no match", async () => {
    const res = await request(app).get("/api/note-grep?id=real.md&q=zzzznope");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it("rejects parent-directory traversal", async () => {
    const res = await request(app).get(
      "/api/note-grep?id=../../etc/passwd&q=root",
    );
    expect(res.status).toBe(400);
  });

  it("rejects a phantom: id with 404", async () => {
    const res = await request(app).get("/api/note-grep?id=phantom:x&q=a");
    expect(res.status).toBe(404);
  });
});

describe("server: /api/tree folder structure", () => {
  const V = mkdtempSync(join(tmpdir(), "sinapso-tree-"));
  const gp = join(V, "graph.json");
  writeFileSync(
    gp,
    JSON.stringify({
      meta: { vaultName: "t", vaultPath: V, notes: 4, excludes: [] },
      nodes: [
        { id: "root.md", title: "Root", phantom: false },
        { id: "saas/a.md", title: "A", phantom: false },
        { id: "saas/b.md", title: "B", phantom: false },
        { id: "saas/climatia/reuniones/m1.md", title: "M1", phantom: false },
        { id: "phantom:x.md", title: "X", phantom: true },
      ],
      links: [],
    }),
  );
  const { app: treeApp } = createApp(gp);
  afterAll(() => rmSync(V, { recursive: true, force: true }));

  it("root lists top-level folders (with counts) and root notes, excluding phantoms", async () => {
    const res = await request(treeApp).get("/api/tree");
    expect(res.status).toBe(200);
    expect(res.body.subfolders).toContainEqual({ path: "saas", count: 3 });
    expect(res.body.notes).toContainEqual({ id: "root.md", title: "Root" });
    // phantom node is never surfaced as a folder or a note
    expect(JSON.stringify(res.body)).not.toContain("phantom");
  });

  it("drills into a subfolder", async () => {
    const res = await request(treeApp).get("/api/tree?path=saas");
    expect(res.body.subfolders).toContainEqual({
      path: "saas/climatia",
      count: 1,
    });
    expect(res.body.noteCount).toBe(2);
    expect(res.body.notes.map((n: { id: string }) => n.id)).toEqual(
      expect.arrayContaining(["saas/a.md", "saas/b.md"]),
    );
  });

  it("caps direct note listings at 40 while preserving the full direct count", async () => {
    const crowded = mkdtempSync(join(tmpdir(), "sinapso-tree-crowded-"));
    const crowdedGraph = join(crowded, "graph.json");
    writeFileSync(
      crowdedGraph,
      JSON.stringify({
        meta: {
          vaultName: "crowded",
          vaultPath: crowded,
          notes: 41,
          excludes: [],
        },
        nodes: Array.from({ length: 41 }, (_, n) => ({
          id: `crowded-${n}.md`,
          title: `Crowded ${n}`,
          phantom: false,
        })),
        links: [],
      }),
    );
    const { app: crowdedApp } = createApp(crowdedGraph);
    try {
      const res = await request(crowdedApp).get("/api/tree");
      expect(res.body.noteCount).toBe(41);
      expect(res.body.notes).toHaveLength(40);
    } finally {
      rmSync(crowded, { recursive: true, force: true });
    }
  });
});

describe("server: /api/search-vault consolidated discovery", () => {
  const V = mkdtempSync(join(tmpdir(), "sinapso-sv-"));
  mkdirSync(join(V, "saas", "climatia"), { recursive: true });
  writeFileSync(
    join(V, "root.md"),
    "# Root Note\n\nA markdown note about solar panels and renewable energy.\n",
  );
  writeFileSync(
    join(V, "saas", "climatia", "plan.md"),
    "# Climatia Plan\n\nThe exact phrase. Find it.\nMore (solar panels) content.\n",
  );
  const gp = join(V, "graph.json");
  writeFileSync(
    gp,
    JSON.stringify({
      meta: { vaultName: "t", vaultPath: V, notes: 2, excludes: [] },
      nodes: [
        { id: "root.md", title: "Root Note", phantom: false },
        {
          id: "saas/climatia/plan.md",
          title: "Climatia Plan",
          phantom: false,
        },
        { id: "phantom:gone.md", title: "Gone", phantom: true },
      ],
      links: [],
    }),
  );
  const { app: svApp } = createApp(gp);
  afterAll(() => rmSync(V, { recursive: true, force: true }));

  it("path mode matches basenames/titles and is vault-confined", async () => {
    const res = await request(svApp).get(
      "/api/search-vault?queries=plan&mode=path",
    );
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("path");
    expect(res.body.results.map((r: { path: string }) => r.path)).toEqual([
      "saas/climatia/plan.md",
    ]);
    // Ranked: stable 1-based rank + scoreKind=path; path emits no score.
    expect(res.body.results[0].rank).toBe(1);
    expect(res.body.results[0].scoreKind).toBe("path");
    expect(res.body.results[0].score).toBeUndefined();
  });

  it("path mode scopes to a folder prefix", async () => {
    const res = await request(svApp).get(
      "/api/search-vault?queries=root&mode=path&path=saas",
    );
    expect(res.body.results).toEqual([]);
    const res2 = await request(svApp).get(
      "/api/search-vault?queries=root&mode=path",
    );
    expect(res2.body.results.map((r: { path: string }) => r.path)).toEqual([
      "root.md",
    ]);
    expect(res2.body.results[0].rank).toBe(1);
    expect(res2.body.results[0].scoreKind).toBe("path");
  });

  it("exact mode returns literal matches with line + terms across the vault", async () => {
    const res = await request(svApp).get(
      "/api/search-vault?queries=solar%20panels&mode=exact",
    );
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("exact");
    const paths = res.body.results.map((r: { path: string }) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining(["root.md", "saas/climatia/plan.md"]),
    );
    for (const r of res.body.results) {
      expect(typeof r.line).toBe("number");
      expect(r.terms).toContain("solar panels");
      // Ranked: every exact hit has a stable rank + scoreKind; no raw score.
      expect(typeof r.rank).toBe("number");
      expect(r.scoreKind).toBe("exact");
      expect(r.score).toBeUndefined();
    }
    // Ranks are dense 1..N.
    const ranks = res.body.results
      .map((r: { rank?: number }) => r.rank)
      .sort((a: number, b: number) => a - b);
    expect(ranks).toEqual(
      Array.from({ length: ranks.length }, (_, i) => i + 1),
    );
  });

  it("exact mode honors note scope", async () => {
    const res = await request(svApp).get(
      "/api/search-vault?queries=exact%20phrase&mode=exact&note=root.md",
    );
    expect(res.body.results).toEqual([]);
    const res2 = await request(svApp).get(
      "/api/search-vault?queries=exact%20phrase&mode=exact&note=saas/climatia/plan.md",
    );
    expect(res2.body.results.length).toBe(1);
    expect(res2.body.results[0].path).toBe("saas/climatia/plan.md");
  });

  it("exact mode treats regex metacharacters literally (no ReDoS)", async () => {
    // An unmatched '(' would throw in a regex engine; as a literal substring
    // it matches the parenthesized text in the note.
    const res = await request(svApp).get(
      "/api/search-vault?queries=(solar&mode=exact",
    );
    expect(res.body.results.map((r: { path: string }) => r.path)).toContain(
      "saas/climatia/plan.md",
    );
  });

  it("auto/keyword mode never touch paths outside the vault", async () => {
    // A traversal id in a note scope stays confined (404 from the path guard
    // would only apply to note reads; here the index only has vault nodes).
    const res = await request(svApp).get(
      "/api/search-vault?queries=../../etc/passwd&mode=auto",
    );
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it("auto is hybrid RRF: without qmd it degrades to keyword with RRF scoring", async () => {
    // qmd is not installed in this test env, so semantic contributes nothing
    // and auto runs keyword-only. The response must still be RRF-tagged
    // (scoreKind=rrf, stable rank) with source reflecting the single engine.
    const res = await request(svApp).get(
      "/api/search-vault?queries=renewable%20energy&mode=auto",
    );
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("auto");
    // Single contributing engine → keyword (not "hybrid").
    expect(res.body.source).toBe("keyword");
    expect(res.body.results.length).toBeGreaterThan(0);
    for (const r of res.body.results) {
      expect(r.scoreKind).toBe("rrf");
      expect(typeof r.score).toBe("number");
      expect(typeof r.rank).toBe("number");
      expect(r.sources).toEqual(["keyword"]);
    }
    // Ranks are dense 1..N and scores are monotonically non-increasing.
    const ranks = res.body.results.map(
      (r: { rank: number }) => r.rank,
    ) as number[];
    expect(ranks).toEqual(
      Array.from({ length: ranks.length }, (_, i) => i + 1),
    );
    const scores = res.body.results.map(
      (r: { score: number }) => r.score,
    ) as number[];
    for (let i = 1; i < scores.length; i++)
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
  });

  it("empty queries return an empty bounded shape", async () => {
    const res = await request(svApp).get("/api/search-vault");
    expect(res.body).toEqual({ mode: "auto", source: "keyword", results: [] });
  });
});

function switchFixture(pickVault?: () => Promise<string | null>) {
  const root = mkdtempSync(join(tmpdir(), "sinapso-switch-"));
  const data = join(root, "data");
  const vaultA = join(root, "vault-a");
  const vaultB = join(root, "vault-b");
  mkdirSync(data);
  mkdirSync(vaultA);
  mkdirSync(vaultB);
  writeFileSync(join(vaultA, "a.md"), "# A\n");
  writeFileSync(join(vaultB, "b.md"), "# B\n");
  const graph = join(data, "graph.json");
  scanVault({ vault: vaultA, out: graph });
  const server = createApp(graph, undefined, {
    configPath: join(root, "config.json"),
    pickVault,
  });
  return { root, vaultA, vaultB, server };
}

async function sessionToken(app: ReturnType<typeof createApp>["app"]) {
  return (await request(app).get("/api/session")).body.token as string;
}

describe("server: /api/vault switch", () => {
  it("rejects switching without a session token", async () => {
    const f = switchFixture();
    try {
      const res = await request(f.server.app)
        .post("/api/vault")
        .send({ path: f.vaultB });
      expect(res.status).toBe(403);
      expect(f.server.meta().vaultPath).toBe(f.vaultA);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects missing paths and files", async () => {
    const f = switchFixture();
    try {
      const token = await sessionToken(f.server.app);
      const missing = await request(f.server.app)
        .post("/api/vault")
        .set("x-sinapso-token", token)
        .send({ path: join(f.root, "missing") });
      expect(missing.status).toBe(404);

      const file = await request(f.server.app)
        .post("/api/vault")
        .set("x-sinapso-token", token)
        .send({ path: join(f.vaultA, "a.md") });
      expect(file.status).toBe(400);
      expect(f.server.meta().vaultPath).toBe(f.vaultA);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rescans a valid directory and updates the active graph", async () => {
    const f = switchFixture();
    try {
      const token = await sessionToken(f.server.app);
      const res = await request(f.server.app)
        .post("/api/vault")
        .set("x-sinapso-token", token)
        .send({ path: f.vaultB });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.graph.meta.vaultPath).toBe(f.vaultB);
      expect(res.body.graph.nodes.map((n: { id: string }) => n.id)).toEqual([
        "b.md",
      ]);
      expect(f.server.meta().vaultPath).toBe(f.vaultB);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("reports browse unavailable without an Electron picker", async () => {
    const f = switchFixture();
    try {
      const token = await sessionToken(f.server.app);
      const res = await request(f.server.app)
        .post("/api/vault")
        .set("x-sinapso-token", token)
        .send({ browse: true });
      expect(res.status).toBe(501);
      expect(f.server.meta().vaultPath).toBe(f.vaultA);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("leaves the current vault unchanged when browse is cancelled", async () => {
    const f = switchFixture(async () => null);
    try {
      const token = await sessionToken(f.server.app);
      const res = await request(f.server.app)
        .post("/api/vault")
        .set("x-sinapso-token", token)
        .send({ browse: true });
      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(true);
      expect(f.server.meta().vaultPath).toBe(f.vaultA);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("server: git note versions", () => {
  function git(args: string[], cwd: string): void {
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
  }

  function gitFixture() {
    const root = mkdtempSync(join(tmpdir(), "sinapso-git-"));
    const vault = join(root, "vault");
    const data = join(root, "data");
    mkdirSync(vault);
    mkdirSync(data);
    writeFileSync(join(vault, "real.md"), "# v1\n");
    git(["init"], vault);
    git(["config", "user.name", "t"], vault);
    git(["config", "user.email", "t@t"], vault);
    git(["add", "real.md"], vault);
    git(["commit", "-m", "first"], vault);
    writeFileSync(join(vault, "real.md"), "# v2\n");
    git(["add", "real.md"], vault);
    git(["commit", "-m", "second"], vault);
    writeFileSync(join(vault, "sibling.md"), "# sibling\n");
    git(["add", "sibling.md"], vault);
    git(["commit", "-m", "sibling commit"], vault);
    const graphPath = join(data, "graph.json");
    writeFileSync(
      graphPath,
      JSON.stringify({
        meta: { vaultName: "test", vaultPath: vault, notes: 1, excludes: [] },
        nodes: [{ id: "real.md", title: "Real", phantom: false }],
        links: [],
      }),
    );
    return { root, vault, graphPath };
  }

  function gitApp(f: { root: string; graphPath: string }) {
    return createApp(f.graphPath, undefined, {
      configPath: join(f.root, "config.json"),
    });
  }

  function gitSyncFixture() {
    const root = mkdtempSync(join(tmpdir(), "sinapso-git-sync-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const vault = join(root, "vault");
    const data = join(root, "data");
    mkdirSync(seed);
    mkdirSync(data);
    git(["init", "--bare", remote], root);
    git(["init", "-b", "main"], seed);
    git(["config", "user.name", "t"], seed);
    git(["config", "user.email", "t@t"], seed);
    writeFileSync(join(seed, "real.md"), "# base\n");
    git(["add", "real.md"], seed);
    git(["commit", "-m", "base"], seed);
    git(["remote", "add", "origin", remote], seed);
    git(["push", "-u", "origin", "main"], seed);
    git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], root);
    git(["clone", remote, vault], root);
    const graphPath = join(data, "graph.json");
    writeFileSync(
      graphPath,
      JSON.stringify({
        meta: { vaultName: "test", vaultPath: vault, notes: 1, excludes: [] },
        nodes: [{ id: "real.md", title: "Real", phantom: false }],
        links: [],
      }),
    );
    return { root, seed, vault, graphPath };
  }

  it("returns available:false when vault has no git", async () => {
    const root = mkdtempSync(join(tmpdir(), "sinapso-nogit-"));
    try {
      writeFileSync(join(root, "real.md"), "# x\n");
      const graphPath = join(root, "graph.json");
      writeFileSync(
        graphPath,
        JSON.stringify({
          meta: { vaultName: "t", vaultPath: root, notes: 1, excludes: [] },
          nodes: [{ id: "real.md", title: "R", phantom: false }],
          links: [],
        }),
      );
      const { app } = createApp(graphPath);
      const res = await request(app).get("/api/note-versions?id=real.md");
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(res.body.versions).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns bounded history for a git-tracked note", async () => {
    const f = gitFixture();
    try {
      const { app } = gitApp(f);
      const res = await request(app).get("/api/note-versions?id=real.md");
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.versioned).toBe(true);
      expect(res.body.dirty).toBe(false);
      expect(res.body.versions.length).toBe(2);
      expect(res.body.versions[0].subject).toBe("second");
      expect(res.body.versions[0]).toHaveProperty("commit");
      expect(res.body.versions[0]).toHaveProperty("committedAt");
      expect(res.body.versions[0]).toHaveProperty("author");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects traversal ids on version endpoints", async () => {
    const f = gitFixture();
    try {
      const { app } = gitApp(f);
      const res = await request(app).get(
        "/api/note-versions?id=../../etc/passwd",
      );
      expect(res.status).toBe(400);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("reads old version content without changing the working copy", async () => {
    const f = gitFixture();
    try {
      const { app } = gitApp(f);
      const hist = await request(app).get("/api/note-versions?id=real.md");
      const oldCommit = hist.body.versions[1].commit;
      const res = await request(app).get(
        `/api/note-version?id=real.md&commit=${oldCommit}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.markdown).toBe("# v1\n");
      expect(readFileSync(join(f.vault, "real.md"), "utf-8")).toBe("# v2\n");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("restores old content only for the target note, no git state change", async () => {
    const f = gitFixture();
    try {
      const { app } = gitApp(f);
      const token = (await request(app).get("/api/session")).body.token;
      const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: f.vault,
      })
        .toString()
        .trim();
      const hist = await request(app).get("/api/note-versions?id=real.md");
      const oldCommit = hist.body.versions[1].commit;

      const res = await request(app)
        .post("/api/note-version/restore")
        .set("x-sinapso-token", token)
        .send({ id: "real.md", commit: oldCommit });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      expect(readFileSync(join(f.vault, "real.md"), "utf-8")).toBe("# v1\n");
      // Sibling untouched
      expect(readFileSync(join(f.vault, "sibling.md"), "utf-8")).toBe(
        "# sibling\n",
      );
      // Git HEAD unchanged
      const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: f.vault,
      })
        .toString()
        .trim();
      expect(headAfter).toBe(headBefore);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("forbids restore without a session token", async () => {
    const f = gitFixture();
    try {
      const { app } = gitApp(f);
      const res = await request(app)
        .post("/api/note-version/restore")
        .send({ id: "real.md", commit: "deadbeef" });
      expect(res.status).toBe(403);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("checkpoints only the selected note", async () => {
    const f = gitFixture();
    try {
      writeFileSync(join(f.vault, "real.md"), "# checkpoint\n");
      writeFileSync(join(f.vault, "sibling.md"), "# staged sibling\n");
      git(["add", "sibling.md"], f.vault);
      const { app } = gitApp(f);
      const token = (await request(app).get("/api/session")).body.token;

      const res = await request(app)
        .post("/api/note-version/checkpoint")
        .set("x-sinapso-token", token)
        .send({ id: "real.md" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.checkpointed).toBe(true);
      expect(res.body.versioned).toBe(true);
      expect(
        execFileSync(
          "git",
          ["show", "--name-only", "--pretty=format:", "HEAD"],
          {
            cwd: f.vault,
          },
        )
          .toString()
          .trim(),
      ).toBe("real.md");
      expect(
        execFileSync("git", ["diff", "--cached", "--name-only"], {
          cwd: f.vault,
        })
          .toString()
          .trim(),
      ).toBe("sibling.md");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("does not create duplicate checkpoints for clean notes", async () => {
    const f = gitFixture();
    try {
      const { app } = gitApp(f);
      const token = (await request(app).get("/api/session")).body.token;
      const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: f.vault,
      })
        .toString()
        .trim();

      const res = await request(app)
        .post("/api/note-version/checkpoint")
        .set("x-sinapso-token", token)
        .send({ id: "real.md" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          ok: true,
          checkpointed: false,
          versioned: true,
        }),
      );
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.vault })
          .toString()
          .trim(),
      ).toBe(headBefore);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("returns vault git status", async () => {
    const f = gitFixture();
    try {
      writeFileSync(join(f.vault, "real.md"), "# changed\n");
      const { app } = gitApp(f);
      const res = await request(app).get("/api/git/status");
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.clean).toBe(false);
      expect(res.body.files).toContainEqual(
        expect.objectContaining({ path: "real.md", status: " M" }),
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("returns available:false for vault git status outside a repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "sinapso-git-status-nogit-"));
    try {
      writeFileSync(join(root, "real.md"), "# x\n");
      const graphPath = join(root, "graph.json");
      writeFileSync(
        graphPath,
        JSON.stringify({
          meta: { vaultName: "t", vaultPath: root, notes: 1, excludes: [] },
          nodes: [{ id: "real.md", title: "R", phantom: false }],
          links: [],
        }),
      );
      const { app } = createApp(graphPath);
      const res = await request(app).get("/api/git/status");
      expect(res.status).toBe(200);
      let gitPresent = true;
      try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
      } catch {
        gitPresent = false;
      }
      expect(res.body).toEqual(
        gitPresent
          ? { available: false, gitInstalled: true, reason: "not_a_repo" }
          : { available: false, gitInstalled: false, reason: "git_missing" },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("guards the git init route", async () => {
    const root = mkdtempSync(join(tmpdir(), "sinapso-git-init-guard-"));
    try {
      writeFileSync(join(root, "real.md"), "# x\n");
      const graphPath = join(root, "graph.json");
      writeFileSync(
        graphPath,
        JSON.stringify({
          meta: { vaultName: "t", vaultPath: root, notes: 1, excludes: [] },
          nodes: [{ id: "real.md", title: "R", phantom: false }],
          links: [],
        }),
      );
      const { app } = createApp(graphPath);
      const res = await request(app).post("/api/git/init").send({});
      expect(res.status).toBe(403);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("initializes local versioning for a vault outside a repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "sinapso-git-init-"));
    try {
      writeFileSync(join(root, "real.md"), "# x\n");
      const graphPath = join(root, "graph.json");
      writeFileSync(
        graphPath,
        JSON.stringify({
          meta: { vaultName: "t", vaultPath: root, notes: 1, excludes: [] },
          nodes: [{ id: "real.md", title: "R", phantom: false }],
          links: [],
        }),
      );
      const { app } = createApp(graphPath);
      const token = (await request(app).get("/api/session")).body.token;

      const res = await request(app)
        .post("/api/git/init")
        .set("x-sinapso-token", token)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(
        execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: root })
          .toString()
          .trim(),
      ).toBe("Initial vault snapshot");

      const status = await request(app).get("/api/git/status");
      expect(status.body.available).toBe(true);

      const again = await request(app)
        .post("/api/git/init")
        .set("x-sinapso-token", token)
        .send({});
      expect(again.status).toBe(400);
      expect(again.body.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commits vault changes through a guarded route", async () => {
    const f = gitFixture();
    try {
      writeFileSync(join(f.vault, "real.md"), "# v3\n");
      const { app } = gitApp(f);
      const token = (await request(app).get("/api/session")).body.token;

      const res = await request(app)
        .post("/api/git/commit")
        .set("x-sinapso-token", token)
        .send({ message: "third" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(
        execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: f.vault })
          .toString()
          .trim(),
      ).toBe("third");
      const status = await request(app).get("/api/git/status");
      expect(status.body.clean).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("guards git commit and sync routes", async () => {
    const f = gitFixture();
    try {
      const { app } = gitApp(f);
      const commit = await request(app)
        .post("/api/git/commit")
        .send({ message: "no token" });
      const sync = await request(app).post("/api/git/sync").send({});
      expect(commit.status).toBe(403);
      expect(sync.status).toBe(403);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("generates commit messages and rejects sync without upstream", async () => {
    const f = gitFixture();
    try {
      writeFileSync(join(f.vault, "real.md"), "# generated\n");
      const { app } = gitApp(f);
      const token = (await request(app).get("/api/session")).body.token;
      const commit = await request(app)
        .post("/api/git/commit")
        .set("x-sinapso-token", token)
        .send({});
      const sync = await request(app)
        .post("/api/git/sync")
        .set("x-sinapso-token", token)
        .send({});

      expect(commit.status).toBe(200);
      expect(
        execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: f.vault })
          .toString()
          .trim(),
      ).toBe("Update vault (1 modified)");
      expect(sync.status).toBe(400);
      expect(sync.body).toEqual({ ok: false, error: "No upstream branch." });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("sync route fast-forwards through the guarded endpoint", async () => {
    const f = gitSyncFixture();
    try {
      writeFileSync(join(f.seed, "real.md"), "# remote\n");
      git(["add", "real.md"], f.seed);
      git(["commit", "-m", "remote"], f.seed);
      git(["push"], f.seed);
      const { app } = gitApp(f);
      const token = (await request(app).get("/api/session")).body.token;

      const res = await request(app)
        .post("/api/git/sync")
        .set("x-sinapso-token", token)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(readFileSync(join(f.vault, "real.md"), "utf-8")).toBe(
        "# remote\n",
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("POST /api/selection-assist (plan 018 U7)", () => {
  it("rejects a request without the session token", async () => {
    const res = await request(app)
      .post("/api/selection-assist")
      .send({ instruction: "shorten", selection: "text" });
    expect(res.status).toBe(403);
  });

  it("400s when no LLM tier is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-assist-nokey-"));
    try {
      const { app: app2 } = createApp(graphPath, undefined, {
        configPath: join(dir, "config.json"),
      });
      const token = (await request(app2).get("/api/session")).body.token;
      const res = await request(app2)
        .post("/api/selection-assist")
        .set("x-sinapso-token", token)
        .send({ instruction: "shorten", selection: "some text" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("no LLM configured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("400s when instruction or selection is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-assist-badreq-"));
    try {
      const { app: app2 } = createApp(graphPath, undefined, {
        configPath: join(dir, "config.json"),
      });
      const token = (await request(app2).get("/api/session")).body.token;
      const res = await request(app2)
        .post("/api/selection-assist")
        .set("x-sinapso-token", token)
        .send({ instruction: "  ", selection: "" });
      expect(res.status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the positional envelope to the thinker and returns its text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-assist-ok-"));
    try {
      const bodies: string[] = [];
      const configPath = join(dir, "config.json");
      updateConfig(
        {
          openrouterKey: "or-k",
          thinkerProvider: "openrouter",
          thinkerModel: "meta/thinker-model",
        },
        configPath,
      );
      const { app: app2 } = createApp(graphPath, undefined, {
        configPath,
        openrouter: {
          fetch: (async (_url: string, init?: RequestInit) => {
            bodies.push(String(init?.body ?? ""));
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: "a tighter line" } }],
              }),
              { status: 200 },
            );
          }) as never,
        },
      });
      const token = (await request(app2).get("/api/session")).body.token;
      const res = await request(app2)
        .post("/api/selection-assist")
        .set("x-sinapso-token", token)
        .send({
          instruction: "make this tighter",
          selection: "a long rambling line",
          surrounding: "before\na long rambling line\nafter",
          noteId: "folder/note.md",
          noteTitle: "Note",
        });
      expect(res.status).toBe(200);
      expect(res.body.text).toBe("a tighter line");
      expect(bodies[0]).toContain("meta/thinker-model");
      expect(bodies[0]).toContain("make this tighter");
      expect(bodies[0]).toContain("a long rambling line");
      expect(bodies[0]).toContain("folder/note.md");
      expect(bodies[0]).toContain("Surrounding lines");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats web selections as immutable evidence and preserves their URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-assist-evidence-"));
    try {
      let body = "";
      const configPath = join(dir, "config.json");
      updateConfig({ openrouterKey: "or-k" }, configPath);
      const { app: app2 } = createApp(graphPath, undefined, {
        configPath,
        openrouter: {
          fetch: (async (_url: string, init?: RequestInit) => {
            body = String(init?.body ?? "");
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: "grounded answer" } }],
              }),
              { status: 200 },
            );
          }) as never,
        },
      });
      const token = (await request(app2).get("/api/session")).body.token;
      const res = await request(app2)
        .post("/api/selection-assist")
        .set("x-sinapso-token", token)
        .send({
          instruction: "What does this establish?",
          selection: "The measured result was 42.",
          sourceMode: "web",
          sourceId: "research-1",
          sourceTitle: "Study",
          sourceUrl: "https://example.com/study",
        });

      expect(res.status).toBe(200);
      expect(res.body.text).toBe("grounded answer");
      expect(body).toContain("immutable research evidence");
      expect(body).toContain("Do not propose replacement or insertion edits");
      expect(body).toContain("https://example.com/study");
      expect(body).not.toContain("ready to be placed into the note");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("502s when the LLM call fails, without leaking details", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-assist-fail-"));
    try {
      const configPath = join(dir, "config.json");
      updateConfig({ openrouterKey: "or-k" }, configPath);
      const { app: app2 } = createApp(graphPath, undefined, {
        configPath,
        openrouter: {
          fetch: (async () =>
            new Response("upstream broke", { status: 500 })) as never,
        },
      });
      const token = (await request(app2).get("/api/session")).body.token;
      const res = await request(app2)
        .post("/api/selection-assist")
        .set("x-sinapso-token", token)
        .send({ instruction: "x", selection: "y" });
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("selection assist failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server: working document compare-and-swap boundary", () => {
  // Plan 020 U7: /api/document no longer accepts first-party creates, so
  // these tests seed a legacy mode=document entry on disk to exercise the
  // revision-CAS update path that the route still serves. New vault-backed
  // create/update is covered by the /api/agent/notes tests below.
  function seedLegacyDocument(
    id: string,
    body: { title?: string; content?: string; revision?: string },
  ): void {
    const researchDir = join(VAULT, "research");
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(
      join(researchDir, `${id}.json`),
      JSON.stringify({
        id,
        ts: new Date().toISOString(),
        mode: "document",
        query: body.title ?? "Legacy",
        document: {
          title: body.title ?? "Legacy",
          content: body.content ?? "",
          ...(body.revision ? { revision: body.revision } : {}),
        },
      }),
    );
  }

  it("rejects first-party create on /api/document (plan 020 U7)", async () => {
    const token = await sessionToken(app);
    const created = await request(app)
      .post("/api/document")
      .set("x-sinapso-token", token)
      .send({ title: "Draft", content: "one" });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe("document-create-removed");
  });

  it("legacy update: reads, updates, and rejects a stale revision without mutation", async () => {
    seedLegacyDocument("doc-cas", {
      title: "Draft",
      content: "one",
      revision: "rev-1",
    });
    const token = await sessionToken(app);
    const read = await request(app).get("/api/document/doc-cas");
    expect(read.body).toEqual({
      id: "doc-cas",
      title: "Draft",
      content: "one",
      revision: "rev-1",
    });

    const updated = await request(app)
      .post("/api/document")
      .set("x-sinapso-token", token)
      .send({
        id: "doc-cas",
        revision: "rev-1",
        title: "Draft",
        content: "two",
      });
    expect(updated.status).toBe(200);
    expect(updated.body.revision).not.toBe("rev-1");

    const stale = await request(app)
      .post("/api/document")
      .set("x-sinapso-token", token)
      .send({
        id: "doc-cas",
        revision: "rev-1",
        title: "Draft",
        content: "lost update",
      });
    expect(stale.status).toBe(409);
    const after = await request(app).get("/api/document/doc-cas");
    expect(after.body.content).toBe("two");
  });

  it("rejects missing updates and immutable evidence ids", async () => {
    const token = await sessionToken(app);
    const missing = await request(app)
      .post("/api/document")
      .set("x-sinapso-token", token)
      .send({ id: "doc-missing", revision: "rev", content: "x" });
    expect(missing.status).toBe(404);

    const researchDir = join(VAULT, "research");
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(
      join(researchDir, "evidence-id.json"),
      JSON.stringify({
        id: "evidence-id",
        ts: new Date().toISOString(),
        mode: "web",
        query: "source",
      }),
    );
    const collision = await request(app)
      .post("/api/document")
      .set("x-sinapso-token", token)
      .send({ id: "evidence-id", revision: "rev", content: "overwrite" });
    expect(collision.status).toBe(409);
    expect((await request(app).get("/api/document/evidence-id")).status).toBe(
      404,
    );
    expect(
      JSON.parse(readFileSync(join(researchDir, "evidence-id.json"), "utf-8"))
        .mode,
    ).toBe("web");
  });

  it("accepts one revisionless update for a legacy working document", async () => {
    seedLegacyDocument("doc-legacy", {
      title: "Legacy",
      content: "old",
    });
    const firstRead = await request(app).get("/api/document/doc-legacy");
    expect(firstRead.body.revision).toEqual(expect.any(String));
    const secondRead = await request(app).get("/api/document/doc-legacy");
    expect(secondRead.body.revision).toBe(firstRead.body.revision);
    const token = await sessionToken(app);
    const updated = await request(app)
      .post("/api/document")
      .set("x-sinapso-token", token)
      .send({
        id: "doc-legacy",
        revision: firstRead.body.revision,
        title: "Legacy",
        content: "new",
      });

    expect(updated.status).toBe(200);
    expect(updated.body.revision).toEqual(expect.any(String));
    const read = await request(app).get("/api/document/doc-legacy");
    expect(read.body).toMatchObject({
      id: "doc-legacy",
      content: "new",
      revision: updated.body.revision,
    });
  });
  it("saves a seeded legacy working document to Inbox through research curation", async () => {
    seedLegacyDocument("doc-promote", {
      title: "Promoted",
      content: "# Saved body",
    });
    const token = await sessionToken(app);
    const promoted = await request(app)
      .post("/api/research/history/doc-promote/save-inbox")
      .set("x-sinapso-token", token)
      .send({});

    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({
      id: "inbox/promoted.md",
      removedHistory: true,
    });
    expect(promoted.body.graphUpdated).toBe(true);
    const promotedGraph = await request(app).get("/api/graph");
    expect(
      promotedGraph.body.nodes.map((node: { id: string }) => node.id),
    ).toContain("inbox/promoted.md");
    expect(readFileSync(join(VAULT, "inbox/promoted.md"), "utf-8")).toContain(
      "# Saved body",
    );
    expect((await request(app).get("/api/document/doc-promote")).status).toBe(
      404,
    );
  });
});

describe("server: plan 020 U5 agent-actor note routes (/api/agent/notes)", () => {
  it("POST journals actor:agent and returns { ok, id, baseHash }", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-agent-notes-"));
    try {
      const vault = join(dir, "vault");
      const data = join(dir, "data");
      mkdirSync(vault, { recursive: true });
      mkdirSync(data, { recursive: true });
      const gp = join(data, "graph.json");
      writeFileSync(
        gp,
        JSON.stringify({
          meta: { vaultName: "t", vaultPath: vault, notes: 0, excludes: [] },
          nodes: [],
          links: [],
        }),
      );
      const cfgPath = join(data, "config.json");
      updateConfig({}, cfgPath);
      const { app: app2 } = createApp(gp, undefined, { configPath: cfgPath });
      const token = (await request(app2).get("/api/session")).body.token;
      const created = await request(app2)
        .post("/api/agent/notes")
        .set("x-sinapso-token", token)
        .send({ title: "From Agent", content: "# body\n" });
      expect(created.status).toBe(200);
      expect(created.body.id).toBe("inbox/from-agent.md");
      expect(created.body.graphUpdated).toBe(true);
      const agentGraph = await request(app2).get("/api/graph");
      expect(
        agentGraph.body.nodes.map((node: { id: string }) => node.id),
      ).toContain("inbox/from-agent.md");
      expect(typeof created.body.baseHash).toBe("string");
      expect(created.body.baseHash).toHaveLength(64);
      const journalPath = join(data, "changes.jsonl");
      const entry = JSON.parse(
        readFileSync(journalPath, "utf-8").trim(),
      ) as Record<string, unknown>;
      expect(entry.actor).toBe("agent");
      expect(entry.action).toBe("create");
      expect(entry.path).toBe("inbox/from-agent.md");
      // The user-actor route journals actor:user for parity.
      const userCreate = await request(app2)
        .post("/api/notes")
        .set("x-sinapso-token", token)
        .send({ title: "From User", content: "# body\n" });
      expect(userCreate.status).toBe(200);
      expect(userCreate.body.id).toBe("inbox/from-user.md");
      expect(userCreate.body.graphUpdated).toBe(true);
      const userGraph = await request(app2).get("/api/graph");
      expect(
        userGraph.body.nodes.map((node: { id: string }) => node.id),
      ).toContain("inbox/from-user.md");
      expect(typeof userCreate.body.baseHash).toBe("string");
      const userEntry = JSON.parse(
        readFileSync(journalPath, "utf-8").trim().split("\n").pop()!,
      ) as Record<string, unknown>;
      expect(userEntry.actor).toBe("user");
      expect(userEntry.path).toBe("inbox/from-user.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a created note durable when the post-create graph refresh fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-create-refresh-fail-"));
    const vault = join(dir, "vault");
    const data = join(dir, "data");
    const gp = join(data, "graph.json");
    try {
      mkdirSync(vault, { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(
        gp,
        JSON.stringify({
          meta: { vaultName: "t", vaultPath: vault, notes: 0, excludes: [] },
          nodes: [],
          links: [],
        }),
      );
      const cfgPath = join(data, "config.json");
      updateConfig({}, cfgPath);
      const { app: app2 } = createApp(gp, undefined, { configPath: cfgPath });
      const token = (await request(app2).get("/api/session")).body.token;
      rmSync(gp);
      mkdirSync(gp);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const created = await request(app2)
        .post("/api/notes")
        .set("x-sinapso-token", token)
        .send({ title: "Survives Refresh", content: "# Durable\n" });
      log.mockRestore();

      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({
        id: "inbox/survives-refresh.md",
        graphUpdated: false,
        graphRefreshFailed: true,
      });
      expect(
        readFileSync(join(vault, "inbox/survives-refresh.md"), "utf-8"),
      ).toBe("# Durable\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PUT enforces baseHash compare-and-swap and returns the new baseHash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-agent-notes-cas-"));
    try {
      const vault = join(dir, "vault");
      const data = join(dir, "data");
      mkdirSync(join(vault, "inbox"), { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(join(vault, "inbox", "seeded.md"), "# Seeded\nold body\n");
      const gp = join(data, "graph.json");
      writeFileSync(
        gp,
        JSON.stringify({
          meta: { vaultName: "t", vaultPath: vault, notes: 0, excludes: [] },
          nodes: [],
          links: [],
        }),
      );
      const cfgPath = join(data, "config.json");
      updateConfig({}, cfgPath);
      const { app: app2 } = createApp(gp, undefined, { configPath: cfgPath });
      const token = (await request(app2).get("/api/session")).body.token;
      // Read current content + hash through /api/note (which now returns it).
      const read = await request(app2).get("/api/note?id=inbox/seeded.md");
      expect(read.status).toBe(200);
      const baseHash = read.body.baseHash as string;
      // CAS update succeeds with the matching hash.
      const updated = await request(app2)
        .put("/api/agent/notes")
        .set("x-sinapso-token", token)
        .send({
          id: "inbox/seeded.md",
          content: "# Seeded\nnew body\n",
          baseHash,
        });
      expect(updated.status).toBe(200);
      expect(updated.body.id).toBe("inbox/seeded.md");
      expect(typeof updated.body.baseHash).toBe("string");
      expect(updated.body.baseHash).not.toBe(baseHash);
      // Stale hash → 409, content unchanged.
      const stale = await request(app2)
        .put("/api/agent/notes")
        .set("x-sinapso-token", token)
        .send({
          id: "inbox/seeded.md",
          content: "# Seeded\nlost update\n",
          baseHash,
        });
      expect(stale.status).toBe(409);
      expect(
        readFileSync(join(vault, "inbox", "seeded.md"), "utf-8"),
      ).toContain("new body");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns graph data only when a note edit changes structural links", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-edit-graph-"));
    try {
      const vault = join(dir, "vault");
      const data = join(dir, "data");
      mkdirSync(vault, { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(join(vault, "a.md"), "# A\nbody\n");
      writeFileSync(join(vault, "b.md"), "# B\n");
      const gp = join(data, "graph.json");
      scanVault({ vault, out: gp });
      const cfgPath = join(data, "config.json");
      updateConfig({}, cfgPath);
      const { app: app2 } = createApp(gp, undefined, { configPath: cfgPath });
      const token = (await request(app2).get("/api/session")).body.token;

      let read = await request(app2).get("/api/note?id=a.md&nolog=1");
      const prose = await request(app2)
        .put("/api/notes")
        .set("x-sinapso-token", token)
        .send({
          id: "a.md",
          content: "# A\nchanged prose\n",
          baseHash: read.body.baseHash,
        });
      expect(prose.status).toBe(200);
      expect(prose.body.graph).toBeUndefined();

      read = await request(app2).get("/api/note?id=a.md&nolog=1");
      const linked = await request(app2)
        .put("/api/notes")
        .set("x-sinapso-token", token)
        .send({
          id: "a.md",
          content: "# A\nchanged prose [[b]]\n",
          baseHash: read.body.baseHash,
        });
      expect(linked.status).toBe(200);
      expect(linked.body.graph.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "a.md", target: "b.md" }),
        ]),
      );

      read = await request(app2).get("/api/note?id=a.md&nolog=1");
      const aliasOnly = await request(app2)
        .put("/api/notes")
        .set("x-sinapso-token", token)
        .send({
          id: "a.md",
          content: "# A\nchanged prose [[B#section|renamed]]\n",
          baseHash: read.body.baseHash,
        });
      expect(aliasOnly.status).toBe(200);
      expect(aliasOnly.body.graph).toBeUndefined();

      read = await request(app2).get("/api/note?id=a.md&nolog=1");
      const duplicate = await request(app2)
        .put("/api/agent/notes")
        .set("x-sinapso-token", token)
        .send({
          id: "a.md",
          content: "# A\n[[b]] [B](b.md)\n",
          baseHash: read.body.baseHash,
        });
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.graph.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "a.md",
            target: "b.md",
            weight: 2,
          }),
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a structural edit durable when its graph refresh fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-edit-refresh-fail-"));
    const vault = join(dir, "vault");
    const data = join(dir, "data");
    const gp = join(data, "graph.json");
    try {
      mkdirSync(vault, { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(join(vault, "a.md"), "# A\n");
      writeFileSync(join(vault, "b.md"), "# B\n");
      scanVault({ vault, out: gp });
      const cfgPath = join(data, "config.json");
      updateConfig({}, cfgPath);
      const { app: app2 } = createApp(gp, undefined, { configPath: cfgPath });
      const token = (await request(app2).get("/api/session")).body.token;
      const read = await request(app2).get("/api/note?id=a.md&nolog=1");
      rmSync(gp);
      mkdirSync(gp);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const edited = await request(app2)
        .put("/api/notes")
        .set("x-sinapso-token", token)
        .send({
          id: "a.md",
          content: "# A\n[[b]]\n",
          baseHash: read.body.baseHash,
        });
      log.mockRestore();
      expect(edited.status).toBe(200);
      expect(edited.body.graphRefreshFailed).toBe(true);
      expect(typeof edited.body.baseHash).toBe("string");
      expect(readFileSync(join(vault, "a.md"), "utf-8")).toContain("[[b]]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /api/note returns baseHash alongside markdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-note-hash-"));
    try {
      const vault = join(dir, "vault");
      const data = join(dir, "data");
      mkdirSync(vault, { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(join(vault, "real.md"), "# Real\nbody\n");
      const gp = join(data, "graph.json");
      writeFileSync(
        gp,
        JSON.stringify({
          meta: { vaultName: "t", vaultPath: vault, notes: 1, excludes: [] },
          nodes: [{ id: "real.md", title: "Real", phantom: false }],
          links: [],
        }),
      );
      const cfgPath = join(data, "config.json");
      updateConfig({}, cfgPath);
      const { app: app2 } = createApp(gp, undefined, { configPath: cfgPath });
      const r = await request(app2).get("/api/note?id=real.md&nolog=1");
      expect(r.status).toBe(200);
      expect(r.body.id).toBe("real.md");
      expect(r.body.markdown).toBe("# Real\nbody\n");
      expect(typeof r.body.baseHash).toBe("string");
      expect(r.body.baseHash).toHaveLength(64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server: voice trace routes (dev-only opt-in)", () => {
  // The relay-side recording is covered in voice-trace.test.ts; these focus
  // on the HTTP adapter: the dev opt-in gate (404 when off), listing,
  // reading, the clear-all token guard, bad ids, path traversal, and the
  // secret-leak negative (the store redacts before disk, so events the route
  // returns must never contain raw keys). Tests inject `voiceTraceEnabled`
  // explicitly so they do not depend on the SINAPSO_VOICE_TRACE env var.
  let voiceTraceSeq = 0;
  async function freshApp(): Promise<{
    app: ReturnType<typeof createApp>["app"];
    token: string;
    dataDir: string;
    store: VoiceTraceStore;
  }> {
    const dir = mkdtempSync(
      join(tmpdir(), `sinapso-voice-routes-${voiceTraceSeq++}-`),
    );
    const gp = join(dir, "graph.json");
    writeFileSync(
      gp,
      JSON.stringify({
        meta: { vaultName: "t", vaultPath: dir, notes: 0, excludes: [] },
        nodes: [],
        links: [],
      }),
    );
    const a = createApp(gp, undefined, { voiceTraceEnabled: true }).app;
    const token = (await request(a).get("/api/session")).body.token;
    return { app: a, token, dataDir: dir, store: createVoiceTraceStore(dir) };
  }

  it("returns 404 for all trace routes when the dev opt-in is off", async () => {
    // Default: voiceTraceEnabled is undefined and we do NOT set the env var
    // in this test process, so the routes must respond 404 with `enabled:false`
    // and never touch the filesystem.
    const dir = mkdtempSync(join(tmpdir(), "sinapso-voice-off-"));
    const gp = join(dir, "graph.json");
    writeFileSync(
      gp,
      JSON.stringify({
        meta: { vaultName: "t", vaultPath: dir, notes: 0, excludes: [] },
        nodes: [],
        links: [],
      }),
    );
    const a = createApp(gp).app;
    const token = (await request(a).get("/api/session")).body.token;
    const list = await request(a).get("/api/voice/sessions");
    expect(list.status).toBe(404);
    expect(list.body).toEqual({ enabled: false });
    const ev = await request(a).get("/api/voice/sessions/voice-x/events");
    expect(ev.status).toBe(404);
    expect(ev.body).toEqual({ enabled: false });
    // Even an authorized DELETE returns 404 when disabled (route is hidden,
    // not merely empty). The 403 token guard still fires first because the
    // `guarded` middleware runs before the handler.
    const delAuth = await request(a)
      .delete("/api/voice/sessions")
      .set("x-sinapso-token", token);
    expect(delAuth.status).toBe(404);
    expect(delAuth.body).toEqual({ enabled: false });
    // No trace directory was created.
    expect(existsSync(join(dir, "voice-traces"))).toBe(false);
  });

  it("rejects DELETE /api/voice/sessions without the session token", async () => {
    const { app: a } = await freshApp();
    const res = await request(a).delete("/api/voice/sessions");
    expect(res.status).toBe(403);
  });

  it("lists sessions newest first, reads events, and clears with token", async () => {
    const { app: a, token, store: s } = await freshApp();
    const sidA = "voice-route-a";
    const sidB = "voice-route-b";
    s.start(sidA, { provider: "gemini" });
    await new Promise((r) => setTimeout(r, 5));
    s.start(sidB, { provider: "openai" });
    s.append(sidB, { type: "tool_call", name: "x" });

    const list = await request(a).get("/api/voice/sessions");
    expect(list.status).toBe(200);
    expect(
      list.body.sessions.map((sess: { sessionId: string }) => sess.sessionId),
    ).toEqual([sidB, sidA]);

    const ev = await request(a).get(`/api/voice/sessions/${sidB}/events`);
    expect(ev.status).toBe(200);
    expect(ev.body.events.map((e: { type: string }) => e.type)).toEqual([
      "session_started",
      "tool_call",
    ]);

    const cleared = await request(a)
      .delete("/api/voice/sessions")
      .set("x-sinapso-token", token);
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toBe(2);
    const after = await request(a).get("/api/voice/sessions");
    expect(after.body.sessions).toEqual([]);
  });

  it("rejects bad ids and path traversal on /events", async () => {
    const { app: a } = await freshApp();
    const upper = await request(a).get("/api/voice/sessions/UPPER/events");
    expect(upper.status).toBe(400);
    const trav = await request(a).get(
      "/api/voice/sessions/..%2F..%2Fetc%2fpasswd/events",
    );
    expect(trav.status).toBe(400);
    // Well-formed but missing id: readEvents returns null → 400.
    const missing = await request(a).get(
      "/api/voice/sessions/voice-missing/events",
    );
    expect(missing.status).toBe(400);
  });

  it("never leaks secret-bearing keys through the read route", async () => {
    const { app: a, store: s } = await freshApp();
    const sid = "voice-leak";
    s.start(sid, {
      provider: "gemini",
      apiKey: "should-never-leak",
      config: { voiceKey: "secret-value" },
    });
    s.append(sid, {
      type: "tool_result",
      result: { token: "abc", nested: { password: "p" } },
    });
    const ev = await request(a).get(`/api/voice/sessions/${sid}/events`);
    expect(ev.status).toBe(200);
    const text = JSON.stringify(ev.body);
    expect(text).not.toContain("should-never-leak");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain('"abc"');
    expect(text).not.toContain('"p"');
    expect(text).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------
// Plan 020 U1 + U2 focused server coverage.
//
// These tests exercise the new filesystem-backed vault catalog end-to-end
// through the HTTP routes: recursive Inbox listing, Admin hard excludes in
// catalog/search, mutation refresh (a successful write shows up in catalog,
// search, and Inbox immediately, without a rescan), the qmd hit mapper
// returning catalog-only notes (R29), and /api/current-view/open-note
// accepting a catalog-only note (R29a). They construct their own isolated
// vault + config so they don't disturb the shared global fixture.
// ---------------------------------------------------------------------------

function freshCatalogVault(opts?: {
  adminExcludes?: string[];
  writeDestination?: string;
}): {
  app: ReturnType<typeof createApp>["app"];
  vault: string;
  data: string;
  cfgPath: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "sinapso-catalog-app-"));
  const vault = join(root, "vault");
  const data = join(root, "data");
  mkdirSync(vault, { recursive: true });
  mkdirSync(data, { recursive: true });
  // A small vault: an inbox note (in graph), a loose note (on disk, not in
  // graph.nodes — the catalog must still find it), a RAW note (scanner
  // presentation default that stays searchable per R28), and a Private note
  // (Admin hard exclude per AE9).
  mkdirSync(join(vault, "inbox"), { recursive: true });
  mkdirSync(join(vault, "Raw"), { recursive: true });
  mkdirSync(join(vault, "Private"), { recursive: true });
  writeFileSync(join(vault, "inbox", "in-graph.md"), "# In Graph\n");
  writeFileSync(join(vault, "loose.md"), "# Loose\nunique-loose-token\n");
  writeFileSync(join(vault, "Raw", "source.md"), "# Raw\nunique-raw-token\n");
  writeFileSync(join(vault, "Private", "secret.md"), "# Secret\n");
  const graphPath = join(data, "graph.json");
  writeFileSync(
    graphPath,
    JSON.stringify({
      meta: {
        vaultName: "cat",
        vaultPath: vault,
        notes: 1,
        excludes: [],
      },
      nodes: [{ id: "inbox/in-graph.md", title: "In Graph", phantom: false }],
      links: [],
    }),
  );
  const cfgPath = join(data, "config.json");
  updateConfig(
    {
      writeDestination: opts?.writeDestination ?? "inbox",
      ...(opts?.adminExcludes
        ? {
            vaults: {
              [vault]: {
                path: vault,
                excludes: opts.adminExcludes,
                excludesInitialized: true,
                wikis: [],
              },
            },
          }
        : {}),
    },
    cfgPath,
  );
  const { app } = createApp(graphPath, undefined, {
    configPath: cfgPath,
    detectDeps: {
      fileExists: () => false,
      run: async () => ({ ok: false, stdout: "", stderr: "" }),
      home: "/h",
      env: {},
    },
  });
  return {
    app,
    vault,
    data,
    cfgPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("server: plan 020 U1 /api/inbox", () => {
  it("recursively lists .md notes under the configured destination with path/title/modifiedAt/baseHash", async () => {
    const { app, cleanup } = freshCatalogVault();
    try {
      const res = await request(app).get("/api/inbox");
      expect(res.status).toBe(200);
      expect(res.body.destination).toBe("inbox");
      const ids = res.body.entries.map((e: { id: string }) => e.id);
      expect(ids).toEqual(["inbox/in-graph.md"]);
      for (const e of res.body.entries) {
        expect(typeof e.id).toBe("string");
        expect(typeof e.title).toBe("string");
        expect(typeof e.modifiedAt).toBe("string");
        expect(typeof e.baseHash).toBe("string");
      }
    } finally {
      cleanup();
    }
  });

  it("returns [] when the destination is missing", async () => {
    const { app, cleanup } = freshCatalogVault({
      writeDestination: "no-such-folder",
    });
    try {
      const res = await request(app).get("/api/inbox");
      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("server: plan 020 U2 graph-independent catalog/search/open", () => {
  it("catalog-based /api/search finds a note that exists on disk but is not in graph.nodes (R26/R28)", async () => {
    const { app, cleanup } = freshCatalogVault();
    try {
      // loose.md exists on disk but graph.nodes only has inbox/in-graph.md.
      // Pre-U2: search missed it. Post-U2: catalog feeds search, so it hits.
      const res = await request(app).get("/api/search?q=unique-loose-token");
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain("loose.md");
    } finally {
      cleanup();
    }
  });

  it("catalog-based /api/search finds RAW notes the scanner keeps out of the graph (R28)", async () => {
    const { app, cleanup } = freshCatalogVault();
    try {
      const res = await request(app).get("/api/search?q=unique-raw-token");
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain("Raw/source.md");
    } finally {
      cleanup();
    }
  });

  it("catalog-based /api/search-vault path mode returns catalog-only notes (R26)", async () => {
    const { app, cleanup } = freshCatalogVault();
    try {
      const res = await request(app).get(
        "/api/search-vault?queries=source&mode=path",
      );
      expect(res.status).toBe(200);
      const ids = res.body.results.map((r: { path: string }) => r.path);
      expect(ids).toContain("Raw/source.md");
    } finally {
      cleanup();
    }
  });

  it("catalog-based /api/search-vault exact mode finds catalog-only notes (R26)", async () => {
    const { app, cleanup } = freshCatalogVault();
    try {
      const res = await request(app).get(
        "/api/search-vault?queries=unique-raw-token&mode=exact",
      );
      expect(res.status).toBe(200);
      const ids = res.body.results.map((r: { path: string }) => r.path);
      expect(ids).toContain("Raw/source.md");
    } finally {
      cleanup();
    }
  });

  it("Admin-excluded folders disappear from /api/inbox, /api/search, and /api/search-vault (AE9)", async () => {
    const { app, vault, cleanup } = freshCatalogVault({
      adminExcludes: ["Private"],
    });
    try {
      // Drop a searchable token into the Admin-excluded folder.
      writeFileSync(
        join(vault, "Private", "secret.md"),
        "# Secret\nadmin-excluded-token\n",
      );
      // Re-apply config to trigger refreshAfterWrite() on the running app.
      const token = (await request(app).get("/api/session")).body
        .token as string;
      await request(app)
        .post("/api/integrations/config")
        .set("x-sinapso-token", token)
        .send({
          vaults: {
            [vault]: {
              path: vault,
              excludes: ["Private"],
              excludesInitialized: true,
              wikis: [],
            },
          },
        })
        .expect(200);
      // Admin-excluded: not in search, not in search-vault exact, not in inbox.
      const s = await request(app).get("/api/search?q=admin-excluded-token");
      expect((s.body as Array<{ id: string }>).map((r) => r.id)).not.toContain(
        "Private/secret.md",
      );
      const sv = await request(app).get(
        "/api/search-vault?queries=admin-excluded-token&mode=exact",
      );
      expect(
        sv.body.results.map((r: { path: string }) => r.path),
      ).not.toContain("Private/secret.md");
      const inbox = await request(app).get("/api/inbox?destination=Private");
      // Direct /api/inbox respects ?destination but the body always uses the
      // configured one; assert via the route's configured-destination path.
      expect(inbox.body.destination).toBe("inbox");
    } finally {
      cleanup();
    }
  });

  it("a successful POST /api/notes refreshes the catalog and search immediately, without a rescan (R7/R10)", async () => {
    const { app, cleanup } = freshCatalogVault();
    try {
      const token = (await request(app).get("/api/session")).body
        .token as string;
      // Before: no match for a unique token (avoid the existing *-token
      // strings in the fixture, which collide under MiniSearch's tokenizer).
      const before = await request(app).get(
        "/api/search?q=zzz-post-write-zyxw",
      );
      expect(before.status).toBe(200);
      expect((before.body as Array<{ id: string }>).map((r) => r.id)).toEqual(
        [],
      );
      // Create a note via the guarded writer.
      const created = await request(app)
        .post("/api/notes")
        .set("x-sinapso-token", token)
        .send({
          title: "Post Write",
          content: "# Post Write\nzzz-post-write-zyxw\n",
        })
        .expect(200);
      expect(created.body.id).toBe("inbox/post-write.md");
      expect(created.body.graphUpdated).toBe(true);
      const createdGraph = await request(app).get("/api/graph");
      expect(
        createdGraph.body.nodes.map((node: { id: string }) => node.id),
      ).toContain("inbox/post-write.md");
      // After: the note is searchable immediately, no rescan needed.
      const after = await request(app).get("/api/search?q=zzz-post-write-zyxw");
      expect((after.body as Array<{ id: string }>).map((r) => r.id)).toContain(
        "inbox/post-write.md",
      );
      const pathSearch = await request(app).get(
        "/api/search-vault?queries=post-write.md&mode=path",
      );
      expect(
        pathSearch.body.results.map((r: { path: string }) => r.path),
      ).toContain("inbox/post-write.md");
      // And it shows up in /api/inbox.
      const inbox = await request(app).get("/api/inbox");
      expect(inbox.body.entries.map((e: { id: string }) => e.id)).toContain(
        "inbox/post-write.md",
      );
    } finally {
      cleanup();
    }
  });

  it("a successful PUT /api/notes refreshes search so a brand-new token is searchable (R7)", async () => {
    const { app, vault, cleanup } = freshCatalogVault();
    try {
      // Pre-seed a note on disk in the configured Inbox.
      writeFileSync(join(vault, "inbox", "seeded.md"), "# Seeded\nold body\n");
      const token = (await request(app).get("/api/session")).body
        .token as string;
      // Force the catalog to pick it up via a config-save refresh.
      await request(app)
        .post("/api/integrations/config")
        .set("x-sinapso-token", token)
        .send({})
        .expect(200);
      const before = await request(app).get("/api/search?q=zzz-put-edit-zyxw");
      expect((before.body as Array<{ id: string }>).map((r) => r.id)).toEqual(
        [],
      );
      // Edit through the guarded writer.
      await request(app)
        .put("/api/notes")
        .set("x-sinapso-token", token)
        .send({
          id: "inbox/seeded.md",
          content: "# Seeded\nzzz-put-edit-zyxw\n",
        })
        .expect(200);
      const after = await request(app).get("/api/search?q=zzz-put-edit-zyxw");
      expect((after.body as Array<{ id: string }>).map((r) => r.id)).toContain(
        "inbox/seeded.md",
      );
    } finally {
      cleanup();
    }
  });

  it("/api/current-view/open-note accepts a catalog-only note (R29a) and still rejects phantom:", async () => {
    const { app, cleanup } = freshCatalogVault();
    try {
      const browserToken = (await request(app).get("/api/session")).body
        .token as string;
      const mcpToken = (await request(app).get("/api/session?surface=mcp")).body
        .token as string;
      // Publish an active window.
      await request(app)
        .post("/api/current-view")
        .set("x-sinapso-token", browserToken)
        .send({
          clientId: "catalog-window",
          sequence: 1,
          activate: true,
          view: { readerNoteId: null, researchPanelOpen: false },
        })
        .expect(204);
      // A catalog-only note: loose.md exists on disk but is NOT in graph.nodes.
      await request(app)
        .post("/api/current-view/open-note")
        .set("x-sinapso-token", mcpToken)
        .send({ note: "loose.md" })
        .expect(202);
      // The pre-U2 graph-only guard would have rejected this with 404.
      // phantom: is still rejected (noteFileOrFail's contract).
      await request(app)
        .post("/api/current-view/open-note")
        .set("x-sinapso-token", mcpToken)
        .send({ note: "phantom:never.md" })
        .expect(404);
      // A traversal id is rejected.
      await request(app)
        .post("/api/current-view/open-note")
        .set("x-sinapso-token", mcpToken)
        .send({ note: "../../etc/passwd" })
        .expect(404);
      // The catalog-only action was actually queued.
      const actions = await request(app)
        .get("/api/current-view/actions?clientId=catalog-window")
        .set("x-sinapso-token", browserToken)
        .expect(200);
      expect(actions.body.actions).toEqual([
        { type: "open_note", note: "loose.md" },
      ]);
    } finally {
      cleanup();
    }
  });
});

describe("server: plan 020 U2 qmd catalog hit (R29)", () => {
  it("/api/semantic-search maps a qmd hit for a catalog-only note (not in graph.nodes)", async () => {
    // Build a tiny app with a fake qmd that returns one hit for "loose.md"
    // (a file on disk that the graph omits). Post-U2 the catalog feeds the
    // qmd node mapper, so the hit survives; pre-U2 the graph-only filter
    // would have dropped it.
    const root = mkdtempSync(join(tmpdir(), "sinapso-qmd-cat-"));
    const vault = join(root, "vault");
    const data = join(root, "data");
    mkdirSync(vault, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(vault, "in-graph.md"), "# In Graph\n");
    writeFileSync(join(vault, "loose.md"), "# Loose\n");
    const graphPath = join(data, "graph.json");
    writeFileSync(
      graphPath,
      JSON.stringify({
        meta: { vaultName: "t", vaultPath: vault, notes: 1, excludes: [] },
        nodes: [{ id: "in-graph.md", title: "In Graph", phantom: false }],
        links: [],
      }),
    );
    const cfgPath = join(data, "config.json");
    updateConfig({}, cfgPath);
    const QMD = "/fake/bin/qmd";
    const vsearchOut = JSON.stringify([
      { score: 0.9, file: "qmd://vaultcol/loose.md", snippet: "x" },
      { score: 0.8, file: "qmd://vaultcol/in-graph.md", snippet: "y" },
    ]);
    const { app } = createApp(graphPath, undefined, {
      configPath: cfgPath,
      detectDeps: {
        home: "/h",
        env: { PATH: "/fake/bin", SHELL: "/bin/zsh" },
        fileExists: (p) => p === QMD,
        run: async (cmd, args) => {
          if (cmd !== QMD) return { ok: false, stdout: "", stderr: "" };
          const sub = args[0];
          if (sub === "--version")
            return { ok: true, stdout: "qmd 1.0.0", stderr: "" };
          if (sub === "collection" && args[1] === "list")
            return {
              ok: true,
              stdout: "vaultcol (qmd://vaultcol/)\n  Pattern:  **/*.md",
              stderr: "",
            };
          if (sub === "collection" && args[1] === "show")
            return {
              ok: true,
              stdout: `Collection: ${args[2]}\n  Path:     ${vault}\n`,
              stderr: "",
            };
          if (sub === "status")
            return {
              ok: true,
              stdout:
                "Documents\n  Total:    2 files indexed\n  Vectors:  2 embedded\n  Pending:  0 need embedding\n  Updated:  now",
              stderr: "",
            };
          if (sub === "vsearch")
            return { ok: true, stdout: vsearchOut, stderr: "" };
          return { ok: false, stdout: "", stderr: "" };
        },
      },
    });
    try {
      const res = await request(app).get("/api/semantic-search?q=x");
      expect(res.status).toBe(200);
      // The catalog-only loose.md survives qmd mapping; pre-U2 it would have
      // been dropped by the graph-only filter.
      expect(res.body.results.map((r: { id: string }) => r.id)).toEqual([
        "loose.md",
        "in-graph.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
