import type { Runner } from "./detect.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MUTATION_TIMEOUT_MS = 120_000;
const GIT_NETWORK_TIMEOUT_MS = 120_000;

export interface GitStatusFile {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitRepoStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitStatusFile[];
}

export type GitActionResult =
  | { ok: true; output: string }
  | { ok: false; error: string; output?: string };

export interface NoteVersion {
  commit: string;
  committedAt: string;
  author: string;
  subject: string;
}

async function git(
  run: Runner,
  repoRoot: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
) {
  const r = await run("git", ["-C", repoRoot, ...args], timeoutMs);
  if (!r.ok && !r.stdout.trim() && !r.stderr.trim()) {
    return {
      ...r,
      stderr: `git ${args[0] ?? "command"} failed or timed out after ${timeoutMs}ms`,
    };
  }
  return r;
}

function gitMessage(
  r: { stdout: string; stderr: string },
  fallback: string,
): string {
  return (r.stderr || r.stdout || fallback).trim() || fallback;
}

function parsePorcelain(stdout: string): GitStatusFile[] {
  if (!stdout.trim()) return [];
  return stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      return {
        path: rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()! : rawPath,
        status,
        staged: status[0] !== " " && status[0] !== "?",
        unstaged: status[1] !== " ",
        untracked: status === "??",
      };
    });
}

async function upstreamName(
  run: Runner,
  repoRoot: string,
): Promise<string | null> {
  const r = await git(run, repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  return r.ok ? r.stdout.trim() || null : null;
}

async function aheadBehind(
  run: Runner,
  repoRoot: string,
  upstream: string | null,
): Promise<{ ahead: number; behind: number }> {
  if (!upstream) return { ahead: 0, behind: 0 };
  const r = await git(run, repoRoot, [
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${upstream}`,
  ]);
  const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
  return r.ok && Number.isFinite(ahead) && Number.isFinite(behind)
    ? { ahead, behind }
    : { ahead: 0, behind: 0 };
}

async function upstreamParts(run: Runner, repoRoot: string, branch: string) {
  const remote = await git(run, repoRoot, [
    "config",
    `branch.${branch}.remote`,
  ]);
  const merge = await git(run, repoRoot, ["config", `branch.${branch}.merge`]);
  if (!remote.ok || !merge.ok) return null;
  const remoteName = remote.stdout.trim();
  const remoteBranch = merge.stdout.trim().replace(/^refs\/heads\//, "");
  return remoteName && remoteBranch ? { remoteName, remoteBranch } : null;
}

export async function gitTopLevel(
  run: Runner,
  vaultRoot: string,
): Promise<string | null> {
  const r = await run(
    "git",
    ["-C", vaultRoot, "rev-parse", "--show-toplevel"],
    GIT_TIMEOUT_MS,
  );
  if (!r.ok) return null;
  return r.stdout.trim() || null;
}

export async function gitFileHistory(
  run: Runner,
  repoRoot: string,
  repoRelativePath: string,
  limit = 50,
): Promise<NoteVersion[]> {
  const r = await run(
    "git",
    [
      "-C",
      repoRoot,
      "log",
      "--follow",
      `-n${Math.max(1, Math.min(limit, 100))}`,
      "--format=%H%x00%ct%x00%an%x00%s",
      "--",
      repoRelativePath,
    ],
    GIT_TIMEOUT_MS,
  );
  if (!r.ok || !r.stdout.trim()) return [];
  return r.stdout
    .trimEnd()
    .split("\n")
    .map((line) => {
      const [commit, seconds, author, subject] = line.split("\0");
      return commit && seconds
        ? {
            commit,
            committedAt: new Date(Number(seconds) * 1000).toISOString(),
            author: author ?? "",
            subject: subject ?? "",
          }
        : null;
    })
    .filter((v): v is NoteVersion => v !== null);
}

export async function gitFileAtCommit(
  run: Runner,
  repoRoot: string,
  commit: string,
  repoRelativePath: string,
): Promise<string | null> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return null;
  const r = await run(
    "git",
    ["-C", repoRoot, "show", `${commit}:${repoRelativePath}`],
    GIT_TIMEOUT_MS,
  );
  return r.ok ? r.stdout : null;
}

export async function gitStatus(
  run: Runner,
  repoRoot: string,
  repoRelativeScope = ".",
): Promise<GitRepoStatus> {
  const statusArgs = ["status", "--porcelain=v1"];
  if (repoRelativeScope) statusArgs.push("--", repoRelativeScope);
  const [status, branch] = await Promise.all([
    git(run, repoRoot, statusArgs),
    git(run, repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const upstream = await upstreamName(run, repoRoot);
  return {
    branch: branch.ok ? branch.stdout.trim() || "HEAD" : "HEAD",
    upstream,
    ...(await aheadBehind(run, repoRoot, upstream)),
    files: status.ok ? parsePorcelain(status.stdout) : [],
    clean: status.ok ? !status.stdout.trim() : true,
  };
}

export async function gitStageAndCommit(
  run: Runner,
  repoRoot: string,
  repoRelativeScope: string,
  message: string,
): Promise<GitActionResult> {
  const msg = message.trim();
  if (!msg) return { ok: false, error: "Commit message is required." };

  const current = await gitStatus(run, repoRoot, repoRelativeScope);
  if (current.clean) return { ok: false, error: "Nothing to commit." };

  const add = await git(
    run,
    repoRoot,
    ["add", "--", repoRelativeScope],
    GIT_MUTATION_TIMEOUT_MS,
  );
  if (!add.ok) return { ok: false, error: gitMessage(add, "git add failed") };

  const staged = await git(
    run,
    repoRoot,
    ["diff", "--cached", "--name-only", "--", repoRelativeScope],
    GIT_MUTATION_TIMEOUT_MS,
  );
  if (!staged.ok)
    return { ok: false, error: gitMessage(staged, "staged diff failed") };
  if (!staged.stdout.trim()) return { ok: false, error: "Nothing to commit." };

  const commit = await git(
    run,
    repoRoot,
    ["commit", "-m", msg, "--", repoRelativeScope],
    GIT_MUTATION_TIMEOUT_MS,
  );
  if (!commit.ok)
    return { ok: false, error: gitMessage(commit, "git commit failed") };
  return { ok: true, output: commit.stdout.trim() };
}

export async function gitSync(
  run: Runner,
  repoRoot: string,
): Promise<GitActionResult> {
  const status = await gitStatus(run, repoRoot);
  if (!status.clean) {
    return { ok: false, error: "Working tree must be clean before sync." };
  }
  const parts = await upstreamParts(run, repoRoot, status.branch);
  if (!parts) return { ok: false, error: "No upstream branch." };

  const out: string[] = [];
  const fetch = await git(
    run,
    repoRoot,
    ["fetch", parts.remoteName],
    GIT_NETWORK_TIMEOUT_MS,
  );
  out.push(fetch.stdout.trim(), fetch.stderr.trim());
  if (!fetch.ok)
    return { ok: false, error: gitMessage(fetch, "git fetch failed") };

  const upstream =
    status.upstream ??
    (await upstreamName(run, repoRoot)) ??
    `${parts.remoteName}/${parts.remoteBranch}`;
  let counts = await aheadBehind(run, repoRoot, upstream);
  if (counts.ahead > 0 && counts.behind > 0) {
    const merge = await git(
      run,
      repoRoot,
      ["merge", "--no-edit", upstream],
      GIT_MUTATION_TIMEOUT_MS,
    );
    out.push(merge.stdout.trim(), merge.stderr.trim());
    if (!merge.ok) {
      const abort = await git(
        run,
        repoRoot,
        ["merge", "--abort"],
        GIT_MUTATION_TIMEOUT_MS,
      );
      out.push(abort.stdout.trim(), abort.stderr.trim());
      const message = gitMessage(merge, "Merge failed");
      return {
        ok: false,
        error: `${message}${message.endsWith(".") ? "" : "."} Sinapso aborted the merge.`,
        output: out.filter(Boolean).join("\n"),
      };
    }
    counts = await aheadBehind(run, repoRoot, upstream);
  }

  if (counts.behind > 0) {
    const merge = await git(
      run,
      repoRoot,
      ["merge", "--ff-only", upstream],
      GIT_MUTATION_TIMEOUT_MS,
    );
    out.push(merge.stdout.trim(), merge.stderr.trim());
    if (!merge.ok)
      return { ok: false, error: gitMessage(merge, "fast-forward failed") };
    counts = await aheadBehind(run, repoRoot, upstream);
  }

  if (counts.ahead > 0) {
    const push = await git(
      run,
      repoRoot,
      ["push", parts.remoteName, `HEAD:${parts.remoteBranch}`],
      GIT_NETWORK_TIMEOUT_MS,
    );
    out.push(push.stdout.trim(), push.stderr.trim());
    if (!push.ok)
      return { ok: false, error: gitMessage(push, "git push failed") };
  }

  return {
    ok: true,
    output: out.filter(Boolean).join("\n") || "Already synced.",
  };
}
