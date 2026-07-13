import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "./app";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { scanVault } from "../scanner/scan";
import { updateConfig } from "./integrations/config";

// Throwaway vault with one real note. The graph.json points /api/note's
// vaultRoot here so the path-traversal guard can be exercised end-to-end.
const VAULT = mkdtempSync(join(tmpdir(), "sinapso-test-"));
const NOTE_BODY = "# Real Note\n\nA real markdown note inside the vault.\n";
writeFileSync(join(VAULT, "real.md"), NOTE_BODY);

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
    const root = mkdtempSync(join(tmpdir(), "sinapso-startup-default-excludes-"));
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
      const ids = (res.body.graph.nodes as Array<{ id: string }>).map((n) => n.id);

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
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
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
    return createApp(f.graphPath, undefined, { configPath: join(f.root, "config.json") });
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
      }).toString().trim();
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
      }).toString().trim();
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
        execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], {
          cwd: f.vault,
        })
          .toString()
          .trim(),
      ).toBe("real.md");
      expect(
        execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: f.vault })
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
      const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.vault })
        .toString()
        .trim();

      const res = await request(app)
        .post("/api/note-version/checkpoint")
        .set("x-sinapso-token", token)
        .send({ id: "real.md" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({ ok: true, checkpointed: false, versioned: true }),
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
      expect(res.body).toEqual({ available: false });
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

describe("server: delegation routes trust negatives (U6, release-blocking)", () => {
  it("rejects delegate start and status without the session token", async () => {
    const start = await request(app)
      .post("/api/delegate")
      .send({ sessionId: "s", task: "t" });
    expect(start.status).toBe(403);
    const status = await request(app).get("/api/delegate/status?sessionId=s");
    expect(status.status).toBe(403);
  });

  it("refuses to start without any LLM configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-delegate-"));
    try {
      const { app: app2 } = createApp(graphPath, undefined, {
        configPath: join(dir, "config.json"),
      });
      const token = (await request(app2).get("/api/session")).body.token;
      const res = await request(app2)
        .post("/api/delegate")
        .set("x-sinapso-token", token)
        .send({ sessionId: "s", task: "t" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("no LLM configured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("thinker-unconfigured start runs on the worker slot (R5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sinapso-delegate-worker-"));
    try {
      const bodies: string[] = [];
      const configPath = join(dir, "config.json");
      updateConfig(
        {
          openrouterKey: "or-k",
          workerProvider: "openrouter",
          workerModel: "meta/worker-model",
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
                choices: [{ message: { content: "# Doc\nbody" } }],
              }),
              { status: 200 },
            );
          }) as never,
        },
      });
      const token = (await request(app2).get("/api/session")).body.token;
      const started = await request(app2)
        .post("/api/delegate")
        .set("x-sinapso-token", token)
        .send({ sessionId: "s-worker", task: "synthesize" });
      expect(started.status).toBe(200);
      expect(started.body.job.documentId).toMatch(/^doc-/);
      await new Promise((r) => setTimeout(r, 50));
      const status = await request(app2)
        .get("/api/delegate/status?sessionId=s-worker")
        .set("x-sinapso-token", token);
      // The loopback document write hits the real ephemeral base (no live
      // listener in supertest), so the job may fail at the write step — the
      // tier resolution evidence is the model in the captured LLM body.
      expect(["running", "succeeded", "failed"]).toContain(status.body.job.state);
      expect(bodies[0]).toContain("meta/worker-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
  it("creates, reads, updates, and rejects a stale revision without mutation", async () => {
    const token = await sessionToken(app);
    const created = await request(app)
      .post("/api/document")
      .set("x-sinapso-token", token)
      .send({ title: "Draft", content: "one" });
    expect(created.status).toBe(200);
    expect(created.body.id).toMatch(/^doc-[a-z0-9-]+$/);
    expect(created.body.revision).toEqual(expect.any(String));

    const read = await request(app).get(`/api/document/${created.body.id}`);
    expect(read.body).toEqual({
      id: created.body.id,
      title: "Draft",
      content: "one",
      revision: created.body.revision,
    });

    const updated = await request(app)
      .post("/api/document")
      .set("x-sinapso-token", token)
      .send({
        id: created.body.id,
        revision: created.body.revision,
        title: "Draft",
        content: "two",
      });
    expect(updated.status).toBe(200);
    expect(updated.body.revision).not.toBe(created.body.revision);

    const stale = await request(app)
      .post("/api/document")
      .set("x-sinapso-token", token)
      .send({
        id: created.body.id,
        revision: created.body.revision,
        title: "Draft",
        content: "lost update",
      });
    expect(stale.status).toBe(409);
    const after = await request(app).get(`/api/document/${created.body.id}`);
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
    expect((await request(app).get("/api/document/evidence-id")).status).toBe(404);
    expect(
      JSON.parse(readFileSync(join(researchDir, "evidence-id.json"), "utf-8")).mode,
    ).toBe("web");
  });
});
