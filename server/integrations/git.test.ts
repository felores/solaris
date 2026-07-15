import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Runner } from "./detect";
import { gitStageAndCommit, gitStatus, gitSync } from "./git";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Sinapso Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Sinapso Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const run: Runner = (cmd, args, timeoutMs) =>
  new Promise((res) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs ?? 10_000, env: GIT_ENV },
      (err, stdout, stderr) =>
        res({
          ok: !err,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        }),
    );
  });

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

function gitMaybe(args: string[], cwd: string): string {
  try {
    return git(args, cwd);
  } catch {
    return "";
  }
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function repoFixture() {
  const root = tempRoot("sinapso-git-adapter-");
  const repo = join(root, "repo");
  const vault = join(repo, "vault");
  mkdirSync(vault, { recursive: true });
  git(["init", "-b", "main"], repo);
  writeFileSync(join(vault, "note.md"), "# one\n");
  git(["add", "vault/note.md"], repo);
  git(["commit", "-m", "initial"], repo);
  return { root, repo, vault };
}

function remoteFixture() {
  const root = tempRoot("sinapso-git-remote-");
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const local = join(root, "local");
  const peer = join(root, "peer");
  git(["init", "--bare", remote], root);
  mkdirSync(seed);
  git(["init", "-b", "main"], seed);
  writeFileSync(join(seed, "note.md"), "base\n");
  git(["add", "note.md"], seed);
  git(["commit", "-m", "base"], seed);
  git(["remote", "add", "backup", remote], seed);
  git(["push", "-u", "backup", "main"], seed);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  git(["clone", remote, local], root);
  git(["clone", remote, peer], root);
  return { root, remote, seed, local, peer };
}

describe("git adapter", () => {
  it("reports scoped dirty and untracked files", async () => {
    const f = repoFixture();
    writeFileSync(join(f.vault, "note.md"), "# two\n");
    writeFileSync(join(f.vault, "new.md"), "# new\n");

    const status = await gitStatus(run, f.repo, "vault");

    expect(status.clean).toBe(false);
    expect(status.branch).toBe("main");
    expect(status.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "vault/note.md", status: " M" }),
        expect.objectContaining({ path: "vault/new.md", status: "??" }),
      ]),
    );
  });

  it("stages only the requested scope and respects gitignore", async () => {
    const f = repoFixture();
    writeFileSync(join(f.repo, ".gitignore"), "*.tmp\n");
    writeFileSync(join(f.vault, "note.md"), "# two\n");
    writeFileSync(join(f.vault, "ignored.tmp"), "ignore me\n");
    writeFileSync(join(f.repo, "outside.md"), "outside\n");

    const result = await gitStageAndCommit(
      run,
      f.repo,
      "vault",
      "update vault",
    );

    expect(result.ok).toBe(true);
    expect(git(["ls-files", "vault/ignored.tmp"], f.repo)).toBe("");
    expect(git(["ls-files", "outside.md"], f.repo)).toBe("");
    expect(git(["status", "--porcelain=v1", "--", "vault"], f.repo)).toBe("");
    expect(readFileSync(join(f.vault, "ignored.tmp"), "utf-8")).toBe(
      "ignore me\n",
    );
  });

  it("rejects empty commits", async () => {
    const f = repoFixture();
    const emptyMessage = await gitStageAndCommit(run, f.repo, "vault", "  ");
    const noChanges = await gitStageAndCommit(run, f.repo, "vault", "noop");

    expect(emptyMessage).toEqual({
      ok: false,
      error: "Commit message is required.",
    });
    expect(noChanges).toEqual({ ok: false, error: "Nothing to commit." });
  });

  it("reports silent git add timeouts", async () => {
    const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
    const fakeRun: Runner = async (_cmd, args, timeoutMs) => {
      calls.push({ args, timeoutMs });
      const subcommand = args[2];
      if (subcommand === "status") {
        return { ok: true, stdout: " M vault/note.md\n", stderr: "" };
      }
      if (subcommand === "rev-parse") {
        return args.at(-1) === "@{u}"
          ? { ok: false, stdout: "", stderr: "no upstream" }
          : { ok: true, stdout: "main\n", stderr: "" };
      }
      if (subcommand === "add") {
        return { ok: false, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };

    const result = await gitStageAndCommit(fakeRun, "/repo", "vault", "update");

    expect(result).toEqual({
      ok: false,
      error: "git add failed or timed out after 120000ms",
    });
    expect(calls.find((c) => c.args[2] === "add")?.timeoutMs).toBe(120_000);
  });

  it("fast-forwards when behind", async () => {
    const f = remoteFixture();
    writeFileSync(join(f.peer, "note.md"), "remote\n");
    git(["add", "note.md"], f.peer);
    git(["commit", "-m", "remote"], f.peer);
    git(["push"], f.peer);

    const result = await gitSync(run, f.local);

    expect(result.ok).toBe(true);
    expect(readFileSync(join(f.local, "note.md"), "utf-8")).toBe("remote\n");
  });

  it("pushes when ahead, including non-origin upstreams", async () => {
    const f = remoteFixture();
    writeFileSync(join(f.seed, "local.md"), "local\n");
    git(["add", "local.md"], f.seed);
    git(["commit", "-m", "local"], f.seed);

    const result = await gitSync(run, f.seed);

    expect(result.ok).toBe(true);
    expect(
      gitMaybe(["--git-dir", f.remote, "show", "main:local.md"], f.root),
    ).toBe("local");
  });

  it("refuses dirty and no-upstream syncs", async () => {
    const dirty = repoFixture();
    writeFileSync(join(dirty.vault, "note.md"), "dirty\n");
    expect(await gitSync(run, dirty.repo)).toEqual({
      ok: false,
      error: "Working tree must be clean before sync.",
    });

    const noUpstream = repoFixture();
    expect(await gitSync(run, noUpstream.repo)).toEqual({
      ok: false,
      error: "No upstream branch.",
    });
  });

  it("merges and pushes clean divergent branches", async () => {
    const f = remoteFixture();
    writeFileSync(join(f.peer, "peer.md"), "peer\n");
    git(["add", "peer.md"], f.peer);
    git(["commit", "-m", "peer"], f.peer);
    git(["push"], f.peer);
    writeFileSync(join(f.local, "local.md"), "local\n");
    git(["add", "local.md"], f.local);
    git(["commit", "-m", "local"], f.local);

    const result = await gitSync(run, f.local);

    expect(result.ok).toBe(true);
    expect(
      gitMaybe(["--git-dir", f.remote, "show", "main:local.md"], f.root),
    ).toBe("local");
    expect(
      gitMaybe(["--git-dir", f.remote, "show", "main:peer.md"], f.root),
    ).toBe("peer");
  });

  it("aborts conflicting divergent merges", async () => {
    const f = remoteFixture();
    writeFileSync(join(f.peer, "note.md"), "remote\n");
    git(["add", "note.md"], f.peer);
    git(["commit", "-m", "remote"], f.peer);
    git(["push"], f.peer);
    writeFileSync(join(f.local, "note.md"), "local\n");
    git(["add", "note.md"], f.local);
    git(["commit", "-m", "local"], f.local);

    const result = await gitSync(run, f.local);

    if (result.ok) throw new Error("expected sync to fail");
    expect(result.error).toContain("Sinapso aborted the merge.");
    expect(git(["status", "--porcelain=v1"], f.local)).toBe("");
    expect(readFileSync(join(f.local, "note.md"), "utf-8")).toBe("local\n");
  });
});
