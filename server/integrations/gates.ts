/**
 * Application gates (U2). One seam for the consent/key/tool gates that the
 * server's spending and mutating routes enforce. Every helper writes the
 * exact status + body the route writes today; the message is passed in so
 * the two divergent OpenRouter responses ("no-openrouter-key" vs
 * "Add an OpenRouter key before wiki ingest") are preserved as-is (R10).
 *
 * Handler style stays `if (!gate(...)) return;` or
 * `const bin = await requireMarkitdown(...); if (!bin) return;`, matching
 * the existing markitdownBinOrFail pattern (KTD3).
 */

import type { Response } from "express";
import { WriteError } from "./paths.js";
import type { ToolName, ToolStatus } from "./detect.js";
import type { ResolvedTier } from "./llm.js";

/** Minimal cfg shape each gate reads. Avoids coupling to the full SolarisConfig. */
type WebCfg = { consents: { web: boolean } };
type KeyCfg = { exaKey: string | null };
type OpenRouterCfg = { openrouterKey: string | null };

/**
 * Web-mode consent gate (403 web-consent-required). Returns true when the
 * stored `cfg.consents.web` is true; otherwise writes the 403 body using
 * the caller-supplied message and returns false.
 */
export function requireWebConsent(
  cfg: WebCfg,
  res: Response,
  message: string,
): boolean {
  if (!cfg.consents.web) {
    res.status(403).json({
      error: "web-consent-required",
      message,
    });
    return false;
  }
  return true;
}

/**
 * Exa key gate (400 no-exa-key). All three call sites use the same
 * "Add your Exa API key in Tools → Integrations." message today; we still
 * take the message in so the seam can absorb a future divergence without
 * another refactor. The return is a type predicate so the caller can use
 * `cfg.exaKey` as a `string` on the success branch.
 */
export function requireExaKey(
  cfg: KeyCfg,
  res: Response,
  message: string,
): cfg is KeyCfg & { exaKey: string } {
  if (!cfg.exaKey) {
    res.status(400).json({
      error: "no-exa-key",
      message,
    });
    return false;
  }
  return true;
}

/**
 * OpenRouter key gate (route-level: writes 400 JSON). The body is exactly
 * `{ error: <message> }`; the route passes the message verbatim so the two
 * divergent bodies ("no-openrouter-key" and
 * "Add an OpenRouter key before wiki ingest") are preserved (R10). The
 * return is a type predicate so the caller can use `cfg.openrouterKey`
 * as a `string` on the success branch.
 */
export function requireOpenRouterKey(
  cfg: OpenRouterCfg,
  res: Response,
  message: string,
): cfg is OpenRouterCfg & { openrouterKey: string } {
  if (!cfg.openrouterKey) {
    res.status(400).json({ error: message });
    return false;
  }
  return true;
}

/**
 * LLM tier gate (route-level: writes 400 JSON). Takes the result of
 * `resolveTier()` so any configured provider (OpenRouter or DeepSeek)
 * passes; body stays `{ error: <message> }` like the OpenRouter gate.
 */
export function requireLlmTier(
  resolved: ResolvedTier | null,
  res: Response,
  message: string,
): resolved is ResolvedTier {
  if (!resolved) {
    res.status(400).json({ error: message });
    return false;
  }
  return true;
}

/**
 * LLM tier gate (helper-level: throws WriteError). Used by
 * `wikiIngestProposal` in app.ts, which itself runs BEFORE the route
 * returns — so the gate throws into the route's `catch (writeFail)`.
 * Same body as the route-level gate, same divergent messages.
 */
export function requireLlmTierOrThrow(
  resolved: ResolvedTier | null,
  message: string,
): asserts resolved is ResolvedTier {
  if (!resolved) throw new WriteError(400, message);
}

/**
 * Mutable cache holder for the tool detection results. The route factories
 * own one of these; `requireMarkitdown` populates it on first call and
 * reuses it on subsequent calls. Callers that need a fresh probe (the
 * install route) set `current = null` to invalidate.
 */
export interface ToolCacheRef {
  current: Record<ToolName, ToolStatus> | null;
}

/**
 * markitdown gate (503 markitdown-missing). Lazily probes via `refresh`
 * (typically `() => detectAll(detectDeps)`), caches the result on
 * `cacheRef.current`, and returns the bin path on success. On miss writes
 * the 503 body used by all three former call sites (`/api/ingest`,
 * `/api/ingest-upload`, and the factored `markitdownBinOrFail`) and
 * returns null so the route can early-return.
 */
export async function requireMarkitdown(
  cacheRef: ToolCacheRef,
  refresh: () => Promise<Record<ToolName, ToolStatus>>,
  res: Response,
): Promise<string | null> {
  if (!cacheRef.current) cacheRef.current = await refresh();
  const status = cacheRef.current.markitdown;
  if (!status.installed || !status.path) {
    res.status(503).json({
      error: "markitdown-missing",
      message:
        "markitdown is not installed — Tools → Integrations offers the install.",
    });
    return null;
  }
  return status.path;
}
