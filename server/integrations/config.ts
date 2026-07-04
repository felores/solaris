/**
 * Integrations config: ~/.solaris/config.json (global to the user, unlike the
 * per-vault data dir). Holds the Exa and OpenRouter keys, web consent, default
 * model, and addons state. Secrets never leave this file: the status endpoint
 * reports booleans only.
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

/** Voice assistant: chosen realtime provider + voice, and a per-provider API
 * key (one only reaches the local voice relay, never the browser). */
export interface VoiceConfig {
  provider: string | null; // "gemini" | "openai" | "xai"
  voice: string | null; // provider-specific voice id
  keys: { gemini: string | null; openai: string | null; xai: string | null };
}

export interface SolarisConfig {
  exaKey: string | null;
  openrouterKey: string | null;
  consents: { web: boolean };
  defaultModel: string | null;
  /** Vault-relative destination folder for created notes (R12). */
  writeDestination: string;
  /** Addon install markers (qmd/markitdown), managed by the installer. */
  addons: Record<string, string>;
  voice: VoiceConfig;
}

export interface ConfigPatch {
  exaKey?: string | null;
  openrouterKey?: string | null;
  consents?: Partial<SolarisConfig["consents"]>;
  defaultModel?: string | null;
  writeDestination?: string;
  addons?: Record<string, string>;
  voice?: {
    provider?: string | null;
    voice?: string | null;
    keys?: Partial<VoiceConfig["keys"]>;
  };
}

export function defaultConfig(): SolarisConfig {
  return {
    exaKey: null,
    openrouterKey: null,
    consents: { web: false },
    defaultModel: null,
    writeDestination: "inbox",
    addons: {},
    voice: {
      provider: null,
      voice: null,
      keys: { gemini: null, openai: null, xai: null },
    },
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
    voice: { ...base.voice, keys: { ...base.voice.keys } },
  };
  if (typeof patch !== "object" || patch === null) return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.exaKey === "string" || p.exaKey === null) out.exaKey = p.exaKey;
  if (typeof p.openrouterKey === "string" || p.openrouterKey === null)
    out.openrouterKey = p.openrouterKey;
  if (typeof p.consents === "object" && p.consents !== null) {
    const c = p.consents as Record<string, unknown>;
    if (typeof c.web === "boolean") out.consents.web = c.web;
  }
  if (typeof p.defaultModel === "string" || p.defaultModel === null)
    out.defaultModel = p.defaultModel;
  if (typeof p.writeDestination === "string" && p.writeDestination)
    out.writeDestination = p.writeDestination;
  if (typeof p.addons === "object" && p.addons !== null) {
    for (const [k, v] of Object.entries(p.addons))
      if (typeof v === "string") out.addons[k] = v;
  }
  if (typeof p.voice === "object" && p.voice !== null) {
    const v = p.voice as Record<string, unknown>;
    if (typeof v.provider === "string" || v.provider === null)
      out.voice.provider = v.provider as string | null;
    if (typeof v.voice === "string" || v.voice === null)
      out.voice.voice = v.voice as string | null;
    if (typeof v.keys === "object" && v.keys !== null) {
      // Per-provider keys merge individually: setting one never clears another.
      for (const k of ["gemini", "openai", "xai"] as const) {
        const kv = (v.keys as Record<string, unknown>)[k];
        if (typeof kv === "string" || kv === null) out.voice.keys[k] = kv;
      }
    }
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
