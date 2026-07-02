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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const TOKEN_HEADER = "x-solaris-token";

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("["))
    return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0];
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

export function requireToken(token: string): RequestHandler {
  return (req, res, next) => {
    if (req.headers[TOKEN_HEADER] !== token) {
      res.status(403).json({ error: "missing or invalid session token" });
      return;
    }
    next();
  };
}
