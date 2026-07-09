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
const VAULT = mkdtempSync(join(tmpdir(), "solaris-test-"));
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
  it("reconciles stale graph files with managed archive and images excludes on startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "solaris-startup-managed-excludes-"));
    try {
      mkdirSync(join(root, "archivo"));
      writeFileSync(join(root, "keep.md"), "# Keep\n");
      writeFileSync(join(root, "archivo", "old.md"), "# Archived\n");
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
      expect(graphData.nodes.map((n) => n.id)).toEqual(["keep.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses vault-scoped, archive, and images-folder config excludes on rescan", async () => {
    const root = mkdtempSync(join(tmpdir(), "solaris-rescan-excludes-"));
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
          vaults: { [root]: { path: root, excludes: ["skip"], wikis: [] } },
        },
        configPath,
      );
      const { app } = createApp(graph, undefined, { configPath });

      const res = await request(app).post("/api/rescan");
      const ids = (res.body.graph.nodes as Array<{ id: string }>).map((n) => n.id);

      expect(res.status).toBe(200);
      expect(res.body.graph.meta.excludes).toEqual(["skip", "done", "media"]);
      expect(ids).toContain("keep.md");
      expect(ids).not.toContain("skip/hidden.md");
      expect(ids).not.toContain("done/archived.md");
      expect(ids).not.toContain("media/image-note.md");
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
  const V = mkdtempSync(join(tmpdir(), "solaris-tree-"));
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
  const root = mkdtempSync(join(tmpdir(), "solaris-switch-"));
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
        .set("x-solaris-token", token)
        .send({ path: join(f.root, "missing") });
      expect(missing.status).toBe(404);

      const file = await request(f.server.app)
        .post("/api/vault")
        .set("x-solaris-token", token)
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
        .set("x-solaris-token", token)
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
        .set("x-solaris-token", token)
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
        .set("x-solaris-token", token)
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
    const root = mkdtempSync(join(tmpdir(), "solaris-git-"));
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
    const root = mkdtempSync(join(tmpdir(), "solaris-git-sync-"));
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
    const root = mkdtempSync(join(tmpdir(), "solaris-nogit-"));
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
        .set("x-solaris-token", token)
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
        .set("x-solaris-token", token)
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
        .set("x-solaris-token", token)
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
    const root = mkdtempSync(join(tmpdir(), "solaris-git-status-nogit-"));
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
        .set("x-solaris-token", token)
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
        .set("x-solaris-token", token)
        .send({});
      const sync = await request(app)
        .post("/api/git/sync")
        .set("x-solaris-token", token)
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
        .set("x-solaris-token", token)
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
