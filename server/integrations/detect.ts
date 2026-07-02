/**
 * Tool detection (KTD7). GUI/desktop launches inherit macOS's minimal launchd
 * PATH that excludes ~/.bun/bin (qmd) and OpenCode's installer bin dir, so
 * detection probes: inherited PATH, known install locations, then a login
 * shell. Everything is injectable so tests never depend on real binaries.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export interface DetectDeps {
  run: Runner;
  fileExists: (p: string) => boolean;
  home: string;
  env: Record<string, string | undefined>;
}

export const realRunner: Runner = (cmd, args) =>
  new Promise((res) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) =>
      res({
        ok: !err,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      }),
    );
  });

function realDeps(): DetectDeps {
  return {
    run: realRunner,
    fileExists: existsSync,
    home: homedir(),
    env: process.env,
  };
}

export type ToolName = "qmd" | "opencode";

export interface ToolStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

// Known install locations the launchd PATH misses.
const CANDIDATES: Record<ToolName, (home: string) => string[]> = {
  qmd: (h) => [join(h, ".bun", "bin", "qmd")],
  opencode: (h) => [join(h, ".opencode", "bin", "opencode")],
};

export async function detectTool(
  name: ToolName,
  deps: Partial<DetectDeps> = {},
): Promise<ToolStatus> {
  const d: DetectDeps = { ...realDeps(), ...deps };
  let found: string | null = null;

  for (const dir of (d.env.PATH ?? "").split(delimiter)) {
    if (dir && d.fileExists(join(dir, name))) {
      found = join(dir, name);
      break;
    }
  }
  if (!found) {
    for (const c of CANDIDATES[name](d.home)) {
      if (d.fileExists(c)) {
        found = c;
        break;
      }
    }
  }
  if (!found) {
    const shell = d.env.SHELL || "/bin/sh";
    const r = await d.run(shell, ["-lc", `command -v ${name}`]);
    const p = r.stdout.trim().split("\n")[0];
    if (r.ok && p) found = p;
  }
  if (!found) return { installed: false, version: null, path: null };

  const v = await d.run(found, ["--version"]);
  return {
    installed: true,
    version: v.ok ? v.stdout.trim().split("\n")[0] || null : null,
    path: found,
  };
}

export async function detectAll(
  deps: Partial<DetectDeps> = {},
): Promise<Record<ToolName, ToolStatus>> {
  const [qmd, opencode] = await Promise.all([
    detectTool("qmd", deps),
    detectTool("opencode", deps),
  ]);
  return { qmd, opencode };
}
