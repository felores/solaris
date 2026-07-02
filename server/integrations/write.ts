/**
 * Guarded note-write path (U7): the ONLY code that writes into the vault.
 * Used by save-as-note (Web mode) and by the agent proposal pipeline (U10);
 * OpenCode never touches the filesystem directly.
 *
 * Confinement mirrors /api/note: resolve under the vault root, .md only,
 * phantom: rejected — plus a realpath check on the nearest existing ancestor
 * so a symlinked directory inside the vault cannot route a write outside it.
 * Every applied write appends a change-log entry (R19) in the local data dir.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export class WriteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface WriteDeps {
  vaultRoot: string;
  /** Local data dir (beside graph.json) where the change log lives. */
  dataDir: string;
}

export interface ChangeLogEntry {
  at: string;
  actor: "user" | "agent";
  mode?: "approval" | "full";
  action: "create" | "edit";
  path: string;
}

const CHANGELOG = "changes.jsonl";

export function appendChangeLog(dataDir: string, entry: ChangeLogEntry): void {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, CHANGELOG), JSON.stringify(entry) + "\n");
}

export function readChangeLog(dataDir: string): ChangeLogEntry[] {
  const p = join(dataDir, CHANGELOG);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as ChangeLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is ChangeLogEntry => e !== null);
}

/** Resolve a vault-relative md path under the confinement guard, or throw 400. */
function confine(vaultRoot: string, rel: string): string {
  if (!rel || rel.startsWith("phantom:"))
    throw new WriteError(400, "invalid note path");
  const base = resolve(vaultRoot);
  const full = resolve(base, rel);
  if (!full.startsWith(base + sep) || !full.toLowerCase().endsWith(".md"))
    throw new WriteError(400, "invalid note path");
  // Symlink escape: the nearest existing ancestor must realpath inside the
  // vault (the vault root itself may legitimately be a symlink, e.g. /tmp).
  let dir = dirname(full);
  while (!existsSync(dir)) dir = dirname(dir);
  const real = realpathSync(dir);
  const realBase = realpathSync(base);
  if (real !== realBase && !real.startsWith(realBase + sep))
    throw new WriteError(400, "invalid note path");
  return full;
}

function requireVault(vaultRoot: string): void {
  if (!vaultRoot || !existsSync(vaultRoot))
    throw new WriteError(503, "vault root is missing or not reachable");
}

/** Strip filesystem-hostile characters from a title used as a filename. */
function safeName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  if (!cleaned) throw new WriteError(400, "empty note title");
  return cleaned;
}

export interface CreateOptions {
  content: string;
  /** Explicit vault-relative path (wins over title+destination). */
  path?: string;
  /** Title used as filename when no explicit path is given. */
  title?: string;
  /** Vault-relative destination folder for title-based creates. */
  destination?: string;
  actor: ChangeLogEntry["actor"];
  mode?: ChangeLogEntry["mode"];
}

export function guardedCreate(
  deps: WriteDeps,
  opts: CreateOptions,
): { id: string } {
  requireVault(deps.vaultRoot);
  const rel =
    opts.path ??
    join(opts.destination ?? "inbox", safeName(opts.title ?? "") + ".md");
  let full = confine(deps.vaultRoot, rel);
  // Never overwrite on create: filename collisions get a numeric suffix.
  if (existsSync(full)) {
    const stem = full.slice(0, -3);
    let n = 2;
    while (existsSync(`${stem}-${n}.md`)) n++;
    full = confine(
      deps.vaultRoot,
      relative(resolve(deps.vaultRoot), `${stem}-${n}.md`),
    );
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, opts.content);
  const id = relative(resolve(deps.vaultRoot), full);
  appendChangeLog(deps.dataDir, {
    at: new Date().toISOString(),
    actor: opts.actor,
    mode: opts.mode,
    action: "create",
    path: id,
  });
  return { id };
}

export interface EditOptions {
  id: string;
  content: string;
  actor: ChangeLogEntry["actor"];
  mode?: ChangeLogEntry["mode"];
}

export function guardedEdit(
  deps: WriteDeps,
  opts: EditOptions,
): { id: string } {
  requireVault(deps.vaultRoot);
  const full = confine(deps.vaultRoot, opts.id);
  if (!existsSync(full)) throw new WriteError(404, "note not found");
  writeFileSync(full, opts.content);
  const id = relative(resolve(deps.vaultRoot), full);
  appendChangeLog(deps.dataDir, {
    at: new Date().toISOString(),
    actor: opts.actor,
    mode: opts.mode,
    action: "edit",
    path: id,
  });
  return { id };
}
