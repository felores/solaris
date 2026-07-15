import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { TOKEN_HEADER } from "./security";
import {
  guardedAppendLink,
  guardedCreate,
  guardedMove,
  noteHash,
  readChangeLog,
  type WriteError,
} from "./write";

// Vault and data dir are separate so the vault can be destroyed in the
// missing-vault scenario without losing the graph file.
const ROOT = mkdtempSync(join(tmpdir(), "sinapso-write-test-"));
const VAULT = join(ROOT, "vault");
const DATA = join(ROOT, "data");
const OUTSIDE = join(ROOT, "outside");
mkdirSync(VAULT, { recursive: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(VAULT, "existing.md"), "# Existing\noriginal body\n");
symlinkSync(OUTSIDE, join(VAULT, "sneaky")); // symlinked dir escaping the vault
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const graphPath = join(DATA, "graph.json");
writeFileSync(
  graphPath,
  JSON.stringify({
    meta: { vaultName: "t", vaultPath: VAULT, notes: 1, excludes: [] },
    nodes: [{ id: "existing.md", title: "Existing", in: 0, out: 0 }],
    links: [],
  }),
);

const { app } = createApp(graphPath, undefined, {
  configPath: join(DATA, "config.json"),
  detectDeps: {
    fileExists: () => false,
    run: async () => ({ ok: false, stdout: "", stderr: "" }),
    home: "/h",
    env: {},
  },
});
const token = async () => (await request(app).get("/api/session")).body.token;

describe("POST /api/notes (create)", () => {
  it("rejects a request without the session token (KTD12)", async () => {
    const res = await request(app)
      .post("/api/notes")
      .send({ title: "x", content: "y" });
    expect(res.status).toBe(403);
  });

  it("rejects traversal, absolute, phantom and non-md paths", async () => {
    const t = await token();
    for (const path of [
      "../escape.md",
      "../../etc/cron.md",
      "/etc/absolute.md",
      "phantom:ghost.md",
      "note.txt",
      "inbox/../../escape.md",
    ]) {
      const res = await request(app)
        .post("/api/notes")
        .set(TOKEN_HEADER, t)
        .send({ path, content: "x" });
      expect(res.status, path).toBe(400);
    }
  });

  it("rejects a write through a symlinked directory escaping the vault", async () => {
    const res = await request(app)
      .post("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ path: "sneaky/escape.md", content: "x" });
    expect(res.status).toBe(400);
    expect(existsSync(join(OUTSIDE, "escape.md"))).toBe(false);
  });

  it("creates in inbox/ by default and journals the write", async () => {
    const res = await request(app)
      .post("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ title: "Saved Result", content: "# Saved\nbody\n" });
    expect(res.status).toBe(200);
    // Vault standard: kebab-case filename, never spaces (FeloVault AGENTS.md).
    expect(res.body.id).toBe(join("inbox", "saved-result.md"));
    expect(
      readFileSync(join(VAULT, "inbox", "saved-result.md"), "utf-8"),
    ).toContain("# Saved");
    const log = readChangeLog(DATA);
    expect(log.at(-1)).toMatchObject({
      actor: "user",
      action: "create",
      path: res.body.id,
    });
  });

  it("honors an explicit destination folder", async () => {
    const res = await request(app)
      .post("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ title: "Elsewhere", content: "x", destination: "captures/web" });
    expect(res.status).toBe(200);
    expect(existsSync(join(VAULT, "captures", "web", "elsewhere.md"))).toBe(
      true,
    );
  });

  it("slugs the title to kebab-case (spaces, accents, punctuation, case)", async () => {
    const res = await request(app)
      .post("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ title: "  Café: Ñoño's Deep-Dive! (v2)  ", content: "x" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(join("inbox", "cafe-nonos-deep-dive-v2.md"));
  });

  it("never overwrites: collisions get a numeric suffix", async () => {
    const t = await token();
    const first = await request(app)
      .post("/api/notes")
      .set(TOKEN_HEADER, t)
      .send({ title: "Twice", content: "first" });
    const second = await request(app)
      .post("/api/notes")
      .set(TOKEN_HEADER, t)
      .send({ title: "Twice", content: "second" });
    expect(first.body.id).toBe(join("inbox", "twice.md"));
    expect(second.body.id).toBe(join("inbox", "twice-2.md"));
    expect(readFileSync(join(VAULT, "inbox", "twice.md"), "utf-8")).toBe(
      "first",
    );
    expect(readFileSync(join(VAULT, "inbox", "twice-2.md"), "utf-8")).toBe(
      "second",
    );
  });
});

describe("PUT /api/notes (edit)", () => {
  it("edits only the target file and journals it", async () => {
    const res = await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ id: "existing.md", content: "# Existing\nedited body\n" });
    expect(res.status).toBe(200);
    expect(readFileSync(join(VAULT, "existing.md"), "utf-8")).toContain(
      "edited body",
    );
    const log = readChangeLog(DATA);
    expect(log.at(-1)).toMatchObject({ action: "edit", path: "existing.md" });
  });

  it("404s on a nonexistent target instead of creating it", async () => {
    const res = await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ id: "nope/missing.md", content: "x" });
    expect(res.status).toBe(404);
    expect(existsSync(join(VAULT, "nope", "missing.md"))).toBe(false);
  });

  it("applies the same confinement guard as create", async () => {
    const res = await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ id: "../escape.md", content: "x" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/archive", () => {
  it("rejects a request without the session token", async () => {
    const res = await request(app)
      .post("/api/archive")
      .send({ id: "existing.md" });
    expect(res.status).toBe(403);
  });

  it("moves a note to archive/ and journals the old and new paths", async () => {
    writeFileSync(join(VAULT, "route-archive.md"), "route body");
    const res = await request(app)
      .post("/api/archive")
      .set(TOKEN_HEADER, await token())
      .send({ id: "route-archive.md" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(join("archive", "route-archive.md"));
    expect(existsSync(join(VAULT, "route-archive.md"))).toBe(false);
    expect(existsSync(join(VAULT, "archive", "route-archive.md"))).toBe(true);
    expect(readChangeLog(DATA).at(-1)).toMatchObject({
      action: "archive",
      path: "route-archive.md",
      newPath: join("archive", "route-archive.md"),
    });
  });

  it("rejects traversal archive ids", async () => {
    const res = await request(app)
      .post("/api/archive")
      .set(TOKEN_HEADER, await token())
      .send({ id: "../escape.md" });
    expect(res.status).toBe(400);
  });
});

describe("write module edge cases", () => {
  it("fails cleanly (503) when the vault root is missing", () => {
    expect(() =>
      guardedCreate(
        { vaultRoot: join(ROOT, "gone"), dataDir: DATA },
        { title: "x", content: "y", actor: "user" },
      ),
    ).toThrowError(
      expect.objectContaining({ status: 503 }) as unknown as WriteError,
    );
  });

  it("keeps the change log across instances (journal is a plain file)", () => {
    const before = readChangeLog(DATA).length;
    expect(before).toBeGreaterThan(0);
    // a fresh read (new "instance") sees the same entries
    expect(readChangeLog(DATA).length).toBe(before);
  });

  it("sanitizes hostile characters in titles", async () => {
    const res = await request(app)
      .post("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ title: 'we/ird:na*me?"x"', content: "x" });
    expect(res.status).toBe(200);
    expect(res.body.id.startsWith("inbox/")).toBe(true);
    expect(res.body.id).not.toContain("*");
    expect(res.body.id.split("/").length).toBe(2); // no extra path segments
  });

  it("guardedMove never overwrites collisions", () => {
    writeFileSync(join(VAULT, "move-me.md"), "source");
    mkdirSync(join(VAULT, "done"), { recursive: true });
    writeFileSync(join(VAULT, "done", "move-me.md"), "existing");
    const r = guardedMove(
      { vaultRoot: VAULT, dataDir: DATA },
      { id: "move-me.md", destination: "done", actor: "user" },
    );
    expect(r.id).toBe(join("done", "move-me-2.md"));
    expect(readFileSync(join(VAULT, "done", "move-me.md"), "utf-8")).toBe(
      "existing",
    );
    expect(readFileSync(join(VAULT, "done", "move-me-2.md"), "utf-8")).toBe(
      "source",
    );
  });
});

describe("guardedAppendLink (F034 orphan linker)", () => {
  it("appends a [[wikilink]] to an existing note and journals it", () => {
    writeFileSync(join(VAULT, "orphan.md"), "# Orphan\nsome body\n");
    const before = readChangeLog(DATA).length;
    const r = guardedAppendLink(
      { vaultRoot: VAULT, dataDir: DATA },
      { id: "orphan.md", target: "Related Note", actor: "user" },
    );
    expect(r).toEqual({ id: "orphan.md", added: true });
    const content = readFileSync(join(VAULT, "orphan.md"), "utf-8");
    expect(content).toContain("[[Related Note]]");
    expect(content.startsWith("# Orphan\nsome body")).toBe(true); // original kept
    const log = readChangeLog(DATA);
    expect(log.length).toBe(before + 1);
    expect(log.at(-1)).toMatchObject({ action: "edit", path: "orphan.md" });
  });

  it("is idempotent: re-linking the same target writes nothing new", () => {
    const before = readChangeLog(DATA).length;
    const r = guardedAppendLink(
      { vaultRoot: VAULT, dataDir: DATA },
      { id: "orphan.md", target: "[[Related Note]]", actor: "user" },
    );
    expect(r.added).toBe(false);
    const content = readFileSync(join(VAULT, "orphan.md"), "utf-8");
    expect(content.split("[[Related Note]]").length - 1).toBe(1); // no dup
    expect(readChangeLog(DATA).length).toBe(before); // no new journal entry
  });

  it("404s on a missing note (never creates it)", () => {
    expect(() =>
      guardedAppendLink(
        { vaultRoot: VAULT, dataDir: DATA },
        { id: "nope/missing.md", target: "X", actor: "user" },
      ),
    ).toThrowError(
      expect.objectContaining({ status: 404 }) as unknown as WriteError,
    );
    expect(existsSync(join(VAULT, "nope", "missing.md"))).toBe(false);
  });

  it("applies the same confinement guard (rejects traversal)", () => {
    expect(() =>
      guardedAppendLink(
        { vaultRoot: VAULT, dataDir: DATA },
        { id: "../escape.md", target: "X", actor: "user" },
      ),
    ).toThrowError(
      expect.objectContaining({ status: 400 }) as unknown as WriteError,
    );
  });
});

describe("POST /api/gaps/link (F034)", () => {
  it("rejects without the session token (mutating route)", async () => {
    const res = await request(app)
      .post("/api/gaps/link")
      .send({ id: "existing.md", target: "X" });
    expect(res.status).toBe(403);
  });

  it("appends the link only after confirmation and journals it", async () => {
    writeFileSync(join(VAULT, "orphan2.md"), "# Orphan2\n");
    const res = await request(app)
      .post("/api/gaps/link")
      .set(TOKEN_HEADER, await token())
      .send({ id: "orphan2.md", target: "Some Target" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "orphan2.md", added: true });
    expect(readFileSync(join(VAULT, "orphan2.md"), "utf-8")).toContain(
      "[[Some Target]]",
    );
    expect(readChangeLog(DATA).at(-1)).toMatchObject({
      action: "edit",
      path: "orphan2.md",
    });
  });

  it("GET /api/gaps surfaces suggestions but writes nothing", async () => {
    const before = readChangeLog(DATA).length;
    const res = await request(app).get("/api/gaps");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(readChangeLog(DATA).length).toBe(before); // read-only: no vault write
  });
});

describe("PUT /api/notes staleness guard + write hardening (plan 018 U3)", () => {
  const notePath = () => join(VAULT, "cas-note.md");

  it("saves with a matching baseHash and journals the edit", async () => {
    writeFileSync(notePath(), "v1\n");
    const res = await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ id: "cas-note.md", content: "v2\n", baseHash: noteHash("v1\n") });
    expect(res.status).toBe(200);
    expect(readFileSync(notePath(), "utf-8")).toBe("v2\n");
    expect(readChangeLog(DATA).at(-1)).toMatchObject({
      action: "edit",
      path: "cas-note.md",
    });
  });

  it("409s on a stale baseHash and leaves disk + journal untouched", async () => {
    writeFileSync(notePath(), "disk-changed\n");
    const before = readChangeLog(DATA).length;
    const res = await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({
        id: "cas-note.md",
        content: "editor-content\n",
        baseHash: noteHash("something-older\n"),
      });
    expect(res.status).toBe(409);
    expect(readFileSync(notePath(), "utf-8")).toBe("disk-changed\n");
    expect(readChangeLog(DATA).length).toBe(before);
  });

  it("overwrites without a baseHash (conflict-overwrite + legacy callers)", async () => {
    writeFileSync(notePath(), "disk-changed\n");
    const res = await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ id: "cas-note.md", content: "forced\n" });
    expect(res.status).toBe(200);
    expect(readFileSync(notePath(), "utf-8")).toBe("forced\n");
  });

  it("two sequential saves succeed when the base is promoted (no self-conflict)", async () => {
    writeFileSync(notePath(), "start\n");
    const r1 = await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({
        id: "cas-note.md",
        content: "step1\n",
        baseHash: noteHash("start\n"),
      });
    expect(r1.status).toBe(200);
    const r2 = await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({
        id: "cas-note.md",
        content: "step2\n",
        baseHash: noteHash("step1\n"),
      });
    expect(r2.status).toBe(200);
    expect(readFileSync(notePath(), "utf-8")).toBe("step2\n");
  });

  it("skips the write and the journal when content equals disk", async () => {
    writeFileSync(notePath(), "same\n");
    const before = readChangeLog(DATA).length;
    const res = await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({
        id: "cas-note.md",
        content: "same\n",
        baseHash: noteHash("same\n"),
      });
    expect(res.status).toBe(200);
    expect(readChangeLog(DATA).length).toBe(before); // audit-only journal not flooded
  });

  it("preserves a symlinked note: writes through to the real target", async () => {
    writeFileSync(join(VAULT, "real-target.md"), "real v1\n");
    symlinkSync(join(VAULT, "real-target.md"), join(VAULT, "linked-note.md"));
    const res = await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({
        id: "linked-note.md",
        content: "via link\n",
        baseHash: noteHash("real v1\n"),
      });
    expect(res.status).toBe(200);
    expect(lstatSync(join(VAULT, "linked-note.md")).isSymbolicLink()).toBe(
      true,
    );
    expect(readFileSync(join(VAULT, "real-target.md"), "utf-8")).toBe(
      "via link\n",
    );
  });

  it("leaves no temp files behind after a save", async () => {
    writeFileSync(notePath(), "tmp check\n");
    await request(app)
      .put("/api/notes")
      .set(TOKEN_HEADER, await token())
      .send({ id: "cas-note.md", content: "tmp checked\n" });
    const leftovers = readdirSync(VAULT).filter((f) =>
      f.includes("sinapso-tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});
