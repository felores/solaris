/**
 * Integrations config: ~/.solaris/config.json (global to the user, unlike the
 * per-vault data dir). Holds the Exa key, per-mode consents, agent permission
 * mode, default model, and addons state. Secrets never leave this file: the
 * status endpoint reports booleans only.
 *
 * Written with mode 600 on POSIX; on Windows confidentiality relies on the
 * per-user %USERPROFILE% directory ACL (KTD5).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SolarisConfig {
  exaKey: string | null;
  consents: { web: boolean; agent: boolean };
  agentMode: "approval" | "full";
  defaultModel: string | null;
  /** Vault-relative destination folder for created notes (R12). */
  writeDestination: string;
  /** Addon install markers (qmd/opencode), managed by the installer. */
  addons: Record<string, string>;
}

export interface ConfigPatch {
  exaKey?: string | null;
  consents?: Partial<SolarisConfig["consents"]>;
  agentMode?: SolarisConfig["agentMode"];
  defaultModel?: string | null;
  writeDestination?: string;
  addons?: Record<string, string>;
}

export function defaultConfig(): SolarisConfig {
  return {
    exaKey: null,
    consents: { web: false, agent: false },
    agentMode: "approval",
    defaultModel: null,
    writeDestination: "inbox",
    addons: {},
  };
}

export function defaultConfigPath(): string {
  return join(homedir(), ".solaris", "config.json");
}

/** Field-by-field sanitizing merge: unknown/mistyped fields are ignored. */
function merge(base: SolarisConfig, patch: unknown): SolarisConfig {
  const out: SolarisConfig = {
    ...base,
    consents: { ...base.consents },
    addons: { ...base.addons },
  };
  if (typeof patch !== "object" || patch === null) return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.exaKey === "string" || p.exaKey === null) out.exaKey = p.exaKey;
  if (typeof p.consents === "object" && p.consents !== null) {
    const c = p.consents as Record<string, unknown>;
    if (typeof c.web === "boolean") out.consents.web = c.web;
    if (typeof c.agent === "boolean") out.consents.agent = c.agent;
  }
  if (p.agentMode === "approval" || p.agentMode === "full")
    out.agentMode = p.agentMode;
  if (typeof p.defaultModel === "string" || p.defaultModel === null)
    out.defaultModel = p.defaultModel;
  if (typeof p.writeDestination === "string" && p.writeDestination)
    out.writeDestination = p.writeDestination;
  if (typeof p.addons === "object" && p.addons !== null) {
    for (const [k, v] of Object.entries(p.addons))
      if (typeof v === "string") out.addons[k] = v;
  }
  return out;
}

/** Read config; a corrupt file yields defaults plus a logged warning, never a crash. */
export function loadConfig(path = defaultConfigPath()): SolarisConfig {
  if (!existsSync(path)) return defaultConfig();
  try {
    return merge(defaultConfig(), JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    console.warn(
      `Solaris config at ${path} is unreadable, using defaults: ${e instanceof Error ? e.message : String(e)}`,
    );
    return defaultConfig();
  }
}

/** Apply a sanitized patch and persist with 600 perms. Returns the new config. */
export function updateConfig(
  patch: ConfigPatch,
  path = defaultConfigPath(),
): SolarisConfig {
  const cfg = merge(loadConfig(path), patch);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // { mode } only applies on create; enforce on rewrite too
  return cfg;
}
