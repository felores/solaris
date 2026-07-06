import type { Runner } from "./detect.js";

const GIT_TIMEOUT_MS = 10_000;

export interface NoteVersion {
  commit: string;
  committedAt: string;
  author: string;
  subject: string;
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
