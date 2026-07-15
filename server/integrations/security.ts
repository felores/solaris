/**
 * Local-origin enforcement (KTD12). The localhost server has no auth by
 * design; write/research/agent/install endpoints create a CSRF/DNS-rebinding
 * surface any local webpage could hit. Two layers:
 *
 *   1. localOnly: every request's Host and Origin (when present) must resolve
 *      to a loopback name, defeating DNS rebinding.
 *   2. requireToken: mutating/spending routes demand a per-session token in a
 *      custom header (never a cookie, so browsers do not attach it
 *      cross-origin). The page fetches it from GET /api/session, which is
 *      safe: rebinding is blocked by (1) and CORS blocks cross-origin reads.
 */

import { randomBytes } from "node:crypto";
import type { RequestHandler } from "express";

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  ...(process.env.TAILSCALE_HOST ? [process.env.TAILSCALE_HOST] : []),
]);

export const TOKEN_HEADER = "x-sinapso-token";

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("["))
    return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0];
}

/** True unless a *present* Host header names a non-loopback host (mirrors
 * localOnly: an absent Host is allowed). Reused by the voice WS upgrade guard. */
export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  return LOCAL_HOSTS.has(hostnameOf(hostHeader).toLowerCase());
}

/** True unless a *present* Origin is non-loopback (absent Origin allowed). */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const localOnly: RequestHandler = (req, res, next) => {
  const host = req.headers.host;
  if (host && !LOCAL_HOSTS.has(hostnameOf(host).toLowerCase())) {
    res.status(403).json({ error: "forbidden host" });
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      ok = LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
    } catch {
      ok = false; // includes Origin: null (sandboxed iframe, file://)
    }
    if (!ok) {
      res.status(403).json({ error: "forbidden origin" });
      return;
    }
  }
  next();
};

export function createSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export interface ScopedTokenOptions {
  /** Surface-scoped token (MCP/CLI): accepted only on routes the predicate
   *  allows, so a leaked bridge token cannot reach browser/voice-only
   *  routes (R17). Enforced here, server-side, not inside the bridge. */
  scopedToken: string;
  allows: (method: string, path: string) => boolean;
}

export function requireToken(
  token: string,
  scoped?: ScopedTokenOptions,
): RequestHandler {
  return (req, res, next) => {
    const presented = req.headers[TOKEN_HEADER];
    if (presented === token) return next();
    if (
      scoped &&
      presented === scoped.scopedToken &&
      scoped.allows(req.method, req.path)
    )
      return next();
    res.status(403).json({ error: "missing or invalid session token" });
  };
}
