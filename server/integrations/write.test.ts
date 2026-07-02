import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { TOKEN_HEADER } from "./security";
import { guardedCreate, readChangeLog, WriteError } from "./write";

// Vault and data dir are separate so the vault can be destroyed in the
// missing-vault scenario without losing the graph file.
const ROOT = mkdtempSync(join(tmpdir(), "solaris-write-test-"));
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
    expect(res.body.id).toBe(join("inbox", "Saved Result.md"));
    expect(
      readFileSync(join(VAULT, "inbox", "Saved Result.md"), "utf-8"),
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
    expect(existsSync(join(VAULT, "captures", "web", "Elsewhere.md"))).toBe(
      true,
    );
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
    expect(first.body.id).toBe(join("inbox", "Twice.md"));
    expect(second.body.id).toBe(join("inbox", "Twice-2.md"));
    expect(readFileSync(join(VAULT, "inbox", "Twice.md"), "utf-8")).toBe(
      "first",
    );
    expect(readFileSync(join(VAULT, "inbox", "Twice-2.md"), "utf-8")).toBe(
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
});
