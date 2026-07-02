/**
 * OpenCode bridge (U9, KTD2/KTD3): manages a locked-down `opencode serve`
 * child scoped to the vault and exposes a small client surface for the
 * agent routes. Grounded against @opencode-ai/sdk 1.x and `opencode serve
 * --help` (2026-07):
 *
 *   - No directory flag: the child is scoped by spawning with cwd=vault,
 *     and `permission.external_directory: "deny"` blocks reads outside it.
 *   - The lockdown profile is injected via OPENCODE_CONFIG_CONTENT, never
 *     by touching the user's opencode.json. Write-shaped tools are disabled
 *     in BOTH permission modes: the only mutation path is the Solaris
 *     proposal pipeline (U10) through the guarded write endpoint.
 *   - OPENCODE_SERVER_PASSWORD enables HTTP basic auth (user "opencode");
 *     the password is generated per spawn and never leaves the server.
 *   - Connected state = ~/.local/share/opencode/auth.json has entries
 *     (provider names only; credential values are never read).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";

export interface OpencodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface OpencodeClientLike {
  session: {
    create(o: {
      body: Record<string, unknown>;
    }): Promise<{ data?: { id?: string } }>;
    promptAsync(o: {
      path: { id: string };
      body: Record<string, unknown>;
    }): Promise<unknown>;
    abort(o: { path: { id: string } }): Promise<unknown>;
  };
  event: {
    subscribe(): Promise<{ stream: AsyncIterable<OpencodeEvent> }>;
  };
  config: {
    providers(): Promise<{ data?: unknown }>;
    get(): Promise<{ data?: unknown }>;
  };
}

/** Last opencode version the lockdown profile was validated against. */
export const VALIDATED_OPENCODE_VERSION = "1.17.13";

export function isNewerVersion(
  installed: string | null,
  validated: string,
): boolean {
  const vi = installed
    ?.match(/\d+(\.\d+)*/)?.[0]
    ?.split(".")
    .map(Number);
  if (!vi) return false;
  const vv = validated.split(".").map(Number);
  for (let i = 0; i < Math.max(vi.length, vv.length); i++) {
    const a = vi[i] ?? 0;
    const b = vv[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

export interface SandboxState {
  ok: boolean;
  /** Injected lockdown keys missing/weakened in the effective config. */
  problems: string[];
  /** User-level tool enables (e.g. global MCP servers) riding along. */
  notes: string[];
}

/**
 * Fail-closed self-test (F017): assert the running server's MERGED config
 * still carries every lockdown key. Schema drift (a renamed permission or
 * tool key silently dropped) becomes a hard stop instead of a silently
 * weakened sandbox.
 */
export async function verifySandbox(
  client: OpencodeClientLike,
): Promise<SandboxState> {
  const cfg = (await client.config.get()).data as {
    permission?: Record<string, unknown>;
    tools?: Record<string, unknown>;
  } | null;
  const problems: string[] = [];
  const perm = cfg?.permission ?? {};
  for (const k of ["edit", "bash", "webfetch", "external_directory"]) {
    if (perm[k] !== "deny")
      problems.push(
        `permission.${k}=${String(perm[k] ?? "unset")} (expected deny)`,
      );
  }
  const tools = cfg?.tools ?? {};
  for (const k of [
    "write",
    "edit",
    "patch",
    "bash",
    "webfetch",
    "websearch",
    "task",
    "skill",
  ]) {
    if (tools[k] !== false)
      problems.push(
        `tools.${k}=${String(tools[k] ?? "unset")} (expected false)`,
      );
  }
  const notes = Object.entries(tools)
    .filter(([, v]) => v === true)
    .map(([k]) => `user-config tool enabled: ${k}`);
  return { ok: problems.length === 0, problems, notes };
}

export interface ZenModel {
  /** Config-ready id, e.g. "opencode/big-pickle". */
  id: string;
  name: string;
}

/** Free models on the OpenCode Zen provider (id "opencode", cost 0). */
export function zenFreeModels(providersPayload: unknown): ZenModel[] {
  const providers = (
    providersPayload as {
      providers?: Array<{
        id: string;
        models?: Record<
          string,
          {
            id: string;
            name?: string;
            cost?: { input: number; output: number };
          }
        >;
      }>;
    }
  )?.providers;
  const zen = providers?.find((p) => p.id === "opencode");
  return Object.values(zen?.models ?? {})
    .filter((m) => m.cost && m.cost.input === 0 && m.cost.output === 0)
    .map((m) => ({ id: `opencode/${m.id}`, name: m.name ?? m.id }));
}

export interface SpawnedProc {
  stdout: { on(ev: "data", fn: (chunk: Buffer | string) => void): void } | null;
  on(ev: "exit", fn: (code: number | null) => void): void;
  kill(): void;
}

export interface OpencodeBridgeDeps {
  /** Resolve the opencode binary (from detection); null = not installed. */
  binPath: () => Promise<string | null>;
  vaultRoot: () => string;
  /** Extra config merged into the lockdown profile (model, instructions). */
  extraConfig: () => Record<string, unknown>;
  /** Extra env for the child (propose endpoint + secret, U10). */
  extraEnv: () => Record<string, string>;
  spawn: (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => SpawnedProc;
  makeClient: (baseUrl: string, password: string) => OpencodeClientLike;
  authJsonPath: string;
  startTimeoutMs: number;
  /** Crash-restart backoff; injectable so tests run in ms. */
  backoff: (restarts: number) => number;
}

/** KTD3: deny every write/egress/spawn-shaped capability in both modes. */
export function lockdownConfig(): Record<string, unknown> {
  return {
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
    },
    tools: {
      write: false,
      edit: false,
      patch: false,
      bash: false,
      webfetch: false,
      websearch: false,
      task: false,
      skill: false,
    },
  };
}

/** Exponential backoff for crash restarts, capped at 30s. */
export function restartBackoffMs(restarts: number): number {
  return Math.min(1000 * 2 ** restarts, 30_000);
}

export function defaultAuthJsonPath(): string {
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

function realClient(baseUrl: string, password: string): OpencodeClientLike {
  const auth =
    "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  return createOpencodeClient({
    baseUrl,
    headers: { Authorization: auth },
  }) as unknown as OpencodeClientLike;
}

function realDeps(): OpencodeBridgeDeps {
  return {
    binPath: async () => null, // caller must supply detection
    vaultRoot: () => process.cwd(),
    extraConfig: () => ({}),
    extraEnv: () => ({}),
    spawn: (cmd, args, opts) =>
      nodeSpawn(cmd, args, opts) as unknown as SpawnedProc,
    makeClient: realClient,
    authJsonPath: defaultAuthJsonPath(),
    startTimeoutMs: 15_000,
    backoff: restartBackoffMs,
  };
}

export type AgentState = "missing" | "not-connected" | "ready";

export function createOpencodeBridge(overrides: Partial<OpencodeBridgeDeps>) {
  const deps: OpencodeBridgeDeps = { ...realDeps(), ...overrides };

  let proc: SpawnedProc | null = null;
  let url = "";
  let password = "";
  let starting: Promise<void> | null = null;
  let restarts = 0;
  let nextAllowedStart = 0;
  let sandbox: SandboxState | null = null;

  function connected(): boolean {
    try {
      if (!existsSync(deps.authJsonPath)) return false;
      const d = JSON.parse(readFileSync(deps.authJsonPath, "utf-8"));
      return typeof d === "object" && d !== null && Object.keys(d).length > 0;
    } catch {
      return false;
    }
  }

  async function state(): Promise<AgentState> {
    const bin = await deps.binPath();
    if (!bin) return "missing";
    return connected() ? "ready" : "not-connected";
  }

  async function start(): Promise<void> {
    const bin = await deps.binPath();
    if (!bin) throw new Error("opencode not installed");
    const wait = nextAllowedStart - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    password = randomBytes(24).toString("hex");
    const config = { ...lockdownConfig(), ...deps.extraConfig() };
    const child = deps.spawn(
      bin,
      ["serve", "--hostname=127.0.0.1", "--port=0"],
      {
        cwd: deps.vaultRoot(),
        env: {
          ...process.env,
          ...deps.extraEnv(),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    proc = child;
    url = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("timeout waiting for opencode serve"));
      }, deps.startTimeoutMs);
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
        const m = out.match(
          /opencode server listening\s+on\s+(https?:\/\/\S+)/,
        );
        if (m) {
          clearTimeout(timer);
          resolveUrl(m[1]);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode serve exited with code ${code}`));
      });
    });
    // Crash restart with capped backoff: mark down, gate the next start.
    child.on("exit", () => {
      if (proc === child) {
        proc = null;
        url = "";
        nextAllowedStart = Date.now() + deps.backoff(restarts++);
      }
    });
    // Fail-closed sandbox self-test (F017): the effective merged config
    // must carry every lockdown key, or Agent mode refuses to serve.
    sandbox = await verifySandbox(deps.makeClient(url, password));
    if (!sandbox.ok) {
      child.kill();
      proc = null;
      url = "";
      throw new Error(`sandbox-unverified: ${sandbox.problems.join("; ")}`);
    }
    restarts = 0;
  }

  async function ensureRunning(): Promise<OpencodeClientLike> {
    if (!proc || !url) {
      starting ??= start().finally(() => {
        starting = null;
      });
      await starting;
    }
    return deps.makeClient(url, password);
  }

  return {
    state,
    connected,
    ensureRunning,
    running: () => !!proc && !!url,
    restartCount: () => restarts,
    sandboxState: () => sandbox,
    stop() {
      const p = proc;
      proc = null;
      url = "";
      p?.kill();
    },
  };
}

export type OpencodeBridge = ReturnType<typeof createOpencodeBridge>;

/** Pull the sessionID out of an event's (variously nested) properties. */
export function eventSessionId(e: OpencodeEvent): string | null {
  const p = e.properties as Record<string, any> | undefined;
  return (
    p?.sessionID ??
    p?.info?.sessionID ??
    p?.part?.sessionID ??
    p?.message?.sessionID ??
    null
  );
}
