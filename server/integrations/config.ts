/**
 * Integrations config: ~/.sinapso/config.json (global to the user, unlike the
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
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Voice assistant: chosen realtime provider + voice, and a per-provider API
 * key (one only reaches the local voice relay, never the browser). */
export interface VoiceConfig {
  provider: string | null; // "gemini" | "openai" | "xai"
  voice: string | null; // provider-specific voice id
  /** Gemini live model id; null = the built-in default (KTD5). */
  model: string | null;
  keys: { gemini: string | null; openai: string | null; xai: string | null };
}

export type PromptKey =
  | "wikiIngest"
  | "noteQuestions"
  | "voiceAssistant"
  | "webResearch";

export type PromptOverrides = Record<PromptKey, string | null>;

export interface WikiConfig {
  id: string;
  label: string;
  /** Vault-relative path to the wiki folder. */
  path: string;
  enabled: boolean;
  /** Wiki-relative contract candidates, e.g. AGENTS.md or index.md. */
  contractFiles: string[];
  /** Wiki-relative by default; ../research is allowed after runtime confinement. */
  rawDestination: string | null;
  discovered: boolean;
  confidence: "high" | "medium" | "low";
}

export interface VaultConfig {
  path: string;
  excludes: string[];
  excludesInitialized: boolean;
  wikis: WikiConfig[];
}

export type LlmProviderId = "openrouter" | "deepseek";

export interface SinapsoConfig {
  /** Internal one-time guard after importing ~/.solaris/config.json. */
  legacyConfigMigrated: boolean;
  exaKey: string | null;
  openrouterKey: string | null;
  deepseekKey: string | null;
  consents: { web: boolean };
  /** Legacy single-model fallback; the worker/thinker slots supersede it. */
  defaultModel: string | null;
  /** Two-tier model slots (R1-R3). Model is ignored for DeepSeek (fixed pair). */
  workerProvider: LlmProviderId | null;
  workerModel: string | null;
  thinkerProvider: LlmProviderId | null;
  thinkerModel: string | null;
  /** Allow in-place note editing over MCP (off by default, R15/AE6). */
  mcpEditEnabled: boolean;
  /** Vault-relative destination folder for created notes (R12). */
  writeDestination: string;
  /** Vault-relative destination folder for archived notes. */
  archiveDestination: string;
  /** Vault-relative destination folder for locally stored images. */
  imagesDestination: string;
  /** Addon install markers (qmd/markitdown), managed by the installer. */
  addons: Record<string, string>;
  voice: VoiceConfig;
  activeVaultPath: string | null;
  vaults: Record<string, VaultConfig>;
  /** User prompt overrides. Null means use the built-in default. */
  prompts: PromptOverrides;
}

export interface ConfigPatch {
  exaKey?: string | null;
  openrouterKey?: string | null;
  deepseekKey?: string | null;
  consents?: Partial<SinapsoConfig["consents"]>;
  defaultModel?: string | null;
  workerProvider?: LlmProviderId | null;
  workerModel?: string | null;
  thinkerProvider?: LlmProviderId | null;
  thinkerModel?: string | null;
  mcpEditEnabled?: boolean;
  writeDestination?: string;
  archiveDestination?: string;
  imagesDestination?: string;
  addons?: Record<string, string>;
  voice?: {
    provider?: string | null;
    voice?: string | null;
    model?: string | null;
    keys?: Partial<VoiceConfig["keys"]>;
  };
  activeVaultPath?: string | null;
  vaults?: Record<string, unknown>;
  prompts?: Partial<PromptOverrides>;
}

const PROMPT_DEFAULTS: Record<PromptKey, string> = {
  wikiIngest:
    "Read the selected wiki contracts and turn the source into proposed Markdown creates/edits that preserve the wiki's conventions, links, index, and log.",
  noteQuestions:
    "Generate concise web-research questions that close knowledge gaps around the current note. Reply as JSON strings only.",
  voiceAssistant:
    "You are the Sinapso voice assistant. Ground answers in the current view first, use vault tools for note questions, and ask before spending web credit.",
  webResearch:
    "Use web research only for user-requested external/current information. Return synthesized answers with sources and never auto-run spending searches while typing.",
};

export function defaultPrompts(): Record<PromptKey, string> {
  return { ...PROMPT_DEFAULTS };
}

export function effectivePrompts(
  cfg: Pick<SinapsoConfig, "prompts">,
): Record<PromptKey, string> {
  const defaults = defaultPrompts();
  return {
    wikiIngest: cfg.prompts.wikiIngest ?? defaults.wikiIngest,
    noteQuestions: cfg.prompts.noteQuestions ?? defaults.noteQuestions,
    voiceAssistant: cfg.prompts.voiceAssistant ?? defaults.voiceAssistant,
    webResearch: cfg.prompts.webResearch ?? defaults.webResearch,
  };
}

export function defaultConfig(): SinapsoConfig {
  return {
    legacyConfigMigrated: false,
    exaKey: null,
    openrouterKey: null,
    deepseekKey: null,
    consents: { web: false },
    defaultModel: null,
    workerProvider: null,
    workerModel: null,
    thinkerProvider: null,
    thinkerModel: null,
    mcpEditEnabled: false,
    writeDestination: "inbox",
    archiveDestination: "archive",
    imagesDestination: "images",
    addons: {},
    voice: {
      provider: null,
      voice: null,
      model: null,
      keys: { gemini: null, openai: null, xai: null },
    },
    activeVaultPath: null,
    vaults: {},
    prompts: {
      wikiIngest: null,
      noteQuestions: null,
      voiceAssistant: null,
      webResearch: null,
    },
  };
}

export function defaultConfigPath(): string {
  return join(homedir(), ".sinapso", "config.json");
}

function legacyConfigPath(): string {
  return join(homedir(), ".solaris", "config.json");
}

/** Field-by-field sanitizing merge: unknown/mistyped fields are ignored. */
function merge(base: SinapsoConfig, patch: unknown): SinapsoConfig {
  const out: SinapsoConfig = {
    ...base,
    consents: { ...base.consents },
    addons: { ...base.addons },
    voice: { ...base.voice, keys: { ...base.voice.keys } },
    vaults: { ...base.vaults },
    prompts: { ...base.prompts },
  };
  if (typeof patch !== "object" || patch === null) return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.legacyConfigMigrated === "boolean")
    out.legacyConfigMigrated = p.legacyConfigMigrated;
  if (typeof p.exaKey === "string" || p.exaKey === null) out.exaKey = p.exaKey;
  if (typeof p.openrouterKey === "string" || p.openrouterKey === null)
    out.openrouterKey = p.openrouterKey;
  if (typeof p.consents === "object" && p.consents !== null) {
    const c = p.consents as Record<string, unknown>;
    if (typeof c.web === "boolean") out.consents.web = c.web;
  }
  if (typeof p.deepseekKey === "string" || p.deepseekKey === null)
    out.deepseekKey = p.deepseekKey;
  if (typeof p.defaultModel === "string" || p.defaultModel === null)
    out.defaultModel = p.defaultModel;
  // Slot fields merge individually: setting one never clears another.
  for (const k of ["workerProvider", "thinkerProvider"] as const) {
    const v = p[k];
    if (v === "openrouter" || v === "deepseek" || v === null) out[k] = v;
  }
  for (const k of ["workerModel", "thinkerModel"] as const) {
    const v = p[k];
    if (typeof v === "string" || v === null) out[k] = v ? v : null;
  }
  if (typeof p.mcpEditEnabled === "boolean")
    out.mcpEditEnabled = p.mcpEditEnabled;
  if (typeof p.writeDestination === "string" && p.writeDestination)
    out.writeDestination = p.writeDestination;
  if (typeof p.archiveDestination === "string" && p.archiveDestination)
    out.archiveDestination = p.archiveDestination;
  if (typeof p.imagesDestination === "string" && p.imagesDestination)
    out.imagesDestination = p.imagesDestination;
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
    if (typeof v.model === "string" || v.model === null)
      out.voice.model = v.model ? v.model : null;
    if (typeof v.keys === "object" && v.keys !== null) {
      // Per-provider keys merge individually: setting one never clears another.
      for (const k of ["gemini", "openai", "xai"] as const) {
        const kv = (v.keys as Record<string, unknown>)[k];
        if (typeof kv === "string" || kv === null) out.voice.keys[k] = kv;
      }
    }
  }
  if (typeof p.activeVaultPath === "string" || p.activeVaultPath === null)
    out.activeVaultPath = p.activeVaultPath;
  if (typeof p.vaults === "object" && p.vaults !== null) {
    for (const [k, v] of Object.entries(p.vaults)) {
      const vault = sanitizeVault(k, v);
      if (vault) out.vaults[vault.path] = vault;
    }
  }
  if (typeof p.prompts === "object" && p.prompts !== null) {
    const prompts = p.prompts as Record<string, unknown>;
    for (const k of [
      "wikiIngest",
      "noteQuestions",
      "voiceAssistant",
      "webResearch",
    ] as const) {
      const v = prompts[k];
      if (v === null) out.prompts[k] = null;
      else if (typeof v === "string") out.prompts[k] = v.trim() ? v : null;
    }
  }
  return out;
}

function sanitizeVault(key: string, value: unknown): VaultConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const path = typeof v.path === "string" && v.path ? v.path : key;
  if (!path) return null;
  const hasSavedExcludes = Array.isArray(v.excludes);
  return {
    path,
    excludes: sanitizeExcludes(v.excludes),
    excludesInitialized: v.excludesInitialized === true || hasSavedExcludes,
    wikis: Array.isArray(v.wikis)
      ? v.wikis.map(sanitizeWiki).filter((w): w is WikiConfig => w !== null)
      : [],
  };
}

function sanitizeExcludes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .trim();
    if (
      !clean ||
      clean === "." ||
      clean.includes("..") ||
      seen.has(clean.toLowerCase())
    )
      continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

function sanitizeWiki(value: unknown): WikiConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const w = value as Record<string, unknown>;
  if (typeof w.id !== "string" || !w.id) return null;
  if (typeof w.path !== "string" || !w.path) return null;
  const confidence =
    w.confidence === "high" ||
    w.confidence === "medium" ||
    w.confidence === "low"
      ? w.confidence
      : "low";
  return {
    id: w.id,
    label: typeof w.label === "string" && w.label ? w.label : w.path,
    path: w.path,
    enabled: typeof w.enabled === "boolean" ? w.enabled : true,
    contractFiles: Array.isArray(w.contractFiles)
      ? w.contractFiles.filter((f): f is string => typeof f === "string" && !!f)
      : [],
    rawDestination:
      typeof w.rawDestination === "string"
        ? w.rawDestination
        : w.rawDestination === null
          ? null
          : "../raw/",
    discovered: typeof w.discovered === "boolean" ? w.discovered : true,
    confidence,
  };
}

function writeConfigFile(path: string, cfg: SinapsoConfig) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readConfigFile(path: string): SinapsoConfig | null {
  if (!existsSync(path)) return null;
  try {
    return merge(defaultConfig(), JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

function withLegacyFallback(current: SinapsoConfig, legacy: SinapsoConfig) {
  const defaults = defaultConfig();
  const out: SinapsoConfig = {
    ...current,
    consents: { ...current.consents },
    addons: { ...legacy.addons, ...current.addons },
    voice: { ...current.voice, keys: { ...current.voice.keys } },
    vaults: { ...current.vaults },
    prompts: { ...current.prompts },
    legacyConfigMigrated: true,
  };

  out.exaKey ??= legacy.exaKey;
  out.openrouterKey ??= legacy.openrouterKey;
  out.deepseekKey ??= legacy.deepseekKey;
  out.defaultModel ??= legacy.defaultModel;
  out.workerProvider ??= legacy.workerProvider;
  out.workerModel ??= legacy.workerModel;
  out.thinkerProvider ??= legacy.thinkerProvider;
  out.thinkerModel ??= legacy.thinkerModel;
  out.consents.web = current.consents.web || legacy.consents.web;
  out.mcpEditEnabled = current.mcpEditEnabled || legacy.mcpEditEnabled;
  if (current.writeDestination === defaults.writeDestination)
    out.writeDestination = legacy.writeDestination;
  if (current.archiveDestination === defaults.archiveDestination)
    out.archiveDestination = legacy.archiveDestination;
  if (current.imagesDestination === defaults.imagesDestination)
    out.imagesDestination = legacy.imagesDestination;
  for (const k of ["gemini", "openai", "xai"] as const)
    out.voice.keys[k] ??= legacy.voice.keys[k];
  out.voice.provider ??= legacy.voice.provider;
  out.voice.voice ??= legacy.voice.voice;
  out.voice.model ??= legacy.voice.model;
  out.activeVaultPath ??= legacy.activeVaultPath;
  if (!Object.keys(out.vaults).length) out.vaults = { ...legacy.vaults };
  for (const k of [
    "wikiIngest",
    "noteQuestions",
    "voiceAssistant",
    "webResearch",
  ] as const)
    out.prompts[k] ??= legacy.prompts[k];
  return out;
}

function maybeMigrateLegacyConfig(path: string, cfg: SinapsoConfig) {
  if (path !== defaultConfigPath() || cfg.legacyConfigMigrated) return cfg;
  const legacy = readConfigFile(legacyConfigPath());
  if (!legacy) return cfg;
  const migrated = withLegacyFallback(cfg, legacy);
  if (JSON.stringify(migrated) !== JSON.stringify(cfg)) {
    writeConfigFile(path, migrated);
    try {
      configCache.set(path, {
        mtimeMs: statSync(path).mtimeMs,
        value: migrated,
      });
    } catch {
      /* next load will re-read */
    }
  }
  return migrated;
}

/** Read config; a corrupt file yields defaults plus a logged warning, never a crash. */
export function loadConfig(path = defaultConfigPath()): SinapsoConfig {
  if (!existsSync(path)) return maybeMigrateLegacyConfig(path, defaultConfig());
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return defaultConfig();
  }
  const cached = configCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  let value: SinapsoConfig;
  try {
    value = merge(defaultConfig(), JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    console.warn(
      `Sinapso config at ${path} is unreadable, using defaults: ${e instanceof Error ? e.message : String(e)}`,
    );
    return defaultConfig();
  }
  value = maybeMigrateLegacyConfig(path, value);
  configCache.set(path, { mtimeMs: statSync(path).mtimeMs, value });
  return value;
}

/** Apply a sanitized patch and persist with 600 perms. Returns the new config. */
export function updateConfig(
  patch: ConfigPatch,
  path = defaultConfigPath(),
): SinapsoConfig {
  const cfg = merge(loadConfig(path), patch);
  writeConfigFile(path, cfg); // { mode } only applies on create; helper enforces on rewrite too
  // Refresh the memo with the post-write mtime so the next loadConfig hits
  // the cache. Skip if the file vanished between write and stat (rare).
  try {
    configCache.set(path, { mtimeMs: statSync(path).mtimeMs, value: cfg });
  } catch {
    /* stat failed: leave the cache untouched; next loadConfig will re-read */
  }
  return cfg;
}

interface ConfigCacheEntry {
  mtimeMs: number;
  value: SinapsoConfig;
}

// ponytail: module-level memo keyed by path. stat per call, read+parse only
// on mtime change. No invalidation API — mtime is the source of truth.
// Missing/corrupt results are not cached, so external fixes are seen on the
// next call without an explicit reset.
const configCache = new Map<string, ConfigCacheEntry>();
