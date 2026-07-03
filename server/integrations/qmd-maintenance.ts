/**
 * qmd index maintenance (A): user-controlled `update`/`embed` and the `status`
 * parsing that drives the progress UI. Split out of qmd.ts (which owns the
 * search bridge) to keep each file focused and under the size limit.
 */

import type { RunResult, Runner } from "./detect.js";

const STATUS_TIMEOUT_MS = 60_000;
const JOB_TIMEOUT_MS = 3_600_000; // update + embed can run for minutes on big vaults

/** Parsed `qmd status` health line (drives the maintenance progress UI). */
export interface QmdIndexStatus {
  total: number;
  vectors: number;
  pending: number;
  updatedAgo: string;
}

/** Parse the human `qmd status` text. Fields absent on older qmd default to 0/"". */
export function parseQmdStatus(text: string): QmdIndexStatus | null {
  const num = (re: RegExp) => {
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  };
  const updated = text.match(/Updated:\s*(.+)/);
  const status: QmdIndexStatus = {
    total: num(/Total:\s*(\d+)/),
    vectors: num(/Vectors:\s*(\d+)/),
    pending: num(/Pending:\s*(\d+)/),
    updatedAgo: updated ? updated[1].trim() : "",
  };
  // Nothing parsed at all -> treat as unavailable rather than an all-zero index.
  return status.total || status.vectors || status.pending || status.updatedAgo
    ? status
    : null;
}

export async function qmdIndexStatus(
  run: Runner,
  qmd: string,
): Promise<QmdIndexStatus | null> {
  const r = await run(qmd, ["status"], STATUS_TIMEOUT_MS);
  return r.ok ? parseQmdStatus(r.stdout) : null;
}

export type QmdMaintOp = "update" | "embed";

/**
 * User-controlled index maintenance (A): run `qmd update` and/or `qmd embed` in
 * the background, one job at a time. Progress is observed separately via
 * `qmdIndexStatus` (the Pending count shrinks as embed proceeds).
 */
export function createQmdMaintenance(run: Runner) {
  let running = false;
  let op: QmdMaintOp | null = null;
  let error = "";
  return {
    running: () => running,
    op: () => op,
    error: () => error,
    start(
      qmd: string,
      steps: { update?: boolean; embed?: boolean },
      opts: { embedModel?: string | null; force?: boolean } = {},
    ): boolean {
      if (running) return false;
      const seq: QmdMaintOp[] = [];
      if (steps.update) seq.push("update");
      if (steps.embed) seq.push("embed");
      if (!seq.length) return false;
      running = true;
      error = "";
      void (async () => {
        for (const s of seq) {
          op = s;
          // Only `embed` uses the embedding model; force (-f) re-embeds all so a
          // model switch doesn't leave mixed-dimension vectors.
          const args = s === "embed" && opts.force ? ["embed", "-f"] : [s];
          const env =
            s === "embed" && opts.embedModel
              ? { QMD_EMBED_MODEL: opts.embedModel }
              : undefined;
          let r: RunResult;
          try {
            r = await run(qmd, args, JOB_TIMEOUT_MS, env);
          } catch (e) {
            r = { ok: false, stdout: "", stderr: String(e) };
          }
          if (!r.ok) {
            error = (r.stderr || `qmd ${s} failed`).slice(0, 500);
            op = null;
            running = false;
            return;
          }
        }
        op = null;
        running = false;
      })();
      return true;
    },
  };
}
