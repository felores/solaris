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

import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import {
  requireWebConsent,
  requireExaKey,
  requireOpenRouterKey,
  requireLlmTier,
  requireLlmTierOrThrow,
  requireMarkitdown,
} from "./gates";
import { WriteError } from "./paths";
import type { ToolStatus } from "./detect";

// Minimal Response double: only status() and json() are touched by the gates.
function mockRes() {
  const res: {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  } = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

describe("requireWebConsent", () => {
  it("writes 403 + web-consent-required and returns false when consent is missing", () => {
    const res = mockRes();
    expect(
      requireWebConsent({ consents: { web: false } }, res, "consent message"),
    ).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "web-consent-required",
      message: "consent message",
    });
  });

  it("preserves the Web-mode 403 message verbatim (R10)", () => {
    const res = mockRes();
    requireWebConsent(
      { consents: { web: false } },
      res,
      "Web mode needs your one-time consent first (activate Web mode to review it).",
    );
    expect(res.json).toHaveBeenCalledWith({
      error: "web-consent-required",
      message:
        "Web mode needs your one-time consent first (activate Web mode to review it).",
    });
  });

  it("returns true and writes nothing when consent is true", () => {
    const res = mockRes();
    expect(requireWebConsent({ consents: { web: true } }, res, "ignored")).toBe(
      true,
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("requireExaKey", () => {
  it("writes 400 + no-exa-key and returns false when key is missing", () => {
    const res = mockRes();
    expect(
      requireExaKey(
        { exaKey: null },
        res,
        "Add your Exa API key in Tools → Integrations.",
      ),
    ).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "no-exa-key",
      message: "Add your Exa API key in Tools → Integrations.",
    });
  });

  it("returns true and writes nothing when key is configured", () => {
    const res = mockRes();
    expect(requireExaKey({ exaKey: "key-123" }, res, "ignored")).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("requireOpenRouterKey (route-level: writes 400 JSON)", () => {
  it("writes 400 + the no-openrouter-key body verbatim and returns false (R10)", () => {
    const res = mockRes();
    expect(
      requireOpenRouterKey({ openrouterKey: null }, res, "no-openrouter-key"),
    ).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "no-openrouter-key" });
  });

  it("writes 400 + the wiki-ingest prose body verbatim and returns false (R10)", () => {
    const res = mockRes();
    expect(
      requireOpenRouterKey(
        { openrouterKey: null },
        res,
        "Add an OpenRouter key before wiki ingest",
      ),
    ).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Add an OpenRouter key before wiki ingest",
    });
  });

  it("returns true and writes nothing when the key is configured", () => {
    const res = mockRes();
    expect(requireOpenRouterKey({ openrouterKey: "k" }, res, "ignored")).toBe(
      true,
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("requireLlmTier (route-level: writes 400 JSON)", () => {
  it("writes { error: message } with 400 when no tier resolved", () => {
    const res = mockRes();
    expect(
      requireLlmTier(null, res, "Add an OpenRouter key before wiki ingest"),
    ).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Add an OpenRouter key before wiki ingest",
    });
  });

  it("passes any resolved tier through", () => {
    const res = mockRes();
    expect(
      requireLlmTier(
        { provider: "deepseek", model: "deepseek-v4-pro", key: "k" },
        res,
        "ignored",
      ),
    ).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("requireLlmTierOrThrow (helper-level: throws WriteError)", () => {
  it("throws WriteError(400, message) when no tier resolved", () => {
    try {
      requireLlmTierOrThrow(null, "Add an OpenRouter key before wiki ingest");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WriteError);
      expect((e as WriteError).status).toBe(400);
      expect((e as WriteError).message).toBe(
        "Add an OpenRouter key before wiki ingest",
      );
    }
  });

  it("throws nothing when a tier is resolved", () => {
    expect(() =>
      requireLlmTierOrThrow(
        { provider: "openrouter", model: "m", key: "k" },
        "ignored",
      ),
    ).not.toThrow();
  });
});

describe("requireMarkitdown", () => {
  const installed: ToolStatus = {
    installed: true,
    version: "1.0",
    path: "/usr/local/bin/markitdown",
  };
  const missing: ToolStatus = { installed: false, version: null, path: null };

  it("writes 503 + markitdown-missing and returns null when markitdown is not installed", async () => {
    const res = mockRes();
    const refresh = vi.fn(async () => ({ qmd: missing, markitdown: missing }));
    const cacheRef: { current: Record<string, ToolStatus> | null } = {
      current: null,
    };
    const bin = await requireMarkitdown(cacheRef, refresh, res);
    expect(bin).toBeNull();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: "markitdown-missing",
      message:
        "markitdown is not installed — Tools → Integrations offers the install.",
    });
  });

  it("returns the markitdown bin path and writes nothing when installed", async () => {
    const res = mockRes();
    const refresh = vi.fn(async () => ({
      qmd: missing,
      markitdown: installed,
    }));
    const cacheRef: { current: Record<string, ToolStatus> | null } = {
      current: null,
    };
    const bin = await requireMarkitdown(cacheRef, refresh, res);
    expect(bin).toBe("/usr/local/bin/markitdown");
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("populates the cache on the first call and reuses it on subsequent calls", async () => {
    const res = mockRes();
    const refresh = vi.fn(async () => ({
      qmd: missing,
      markitdown: installed,
    }));
    const cacheRef: { current: Record<string, ToolStatus> | null } = {
      current: null,
    };
    await requireMarkitdown(cacheRef, refresh, res);
    await requireMarkitdown(cacheRef, refresh, res);
    await requireMarkitdown(cacheRef, refresh, res);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(cacheRef.current?.markitdown.path).toBe("/usr/local/bin/markitdown");
  });

  it("re-probes when the cache has been cleared (e.g. after install)", async () => {
    const res = mockRes();
    let call = 0;
    const refresh = vi.fn(async () => {
      call += 1;
      return call === 1
        ? { qmd: missing, markitdown: missing }
        : { qmd: missing, markitdown: installed };
    });
    const cacheRef: { current: Record<string, ToolStatus> | null } = {
      current: null,
    };
    const first = await requireMarkitdown(cacheRef, refresh, res);
    expect(first).toBeNull();
    expect(cacheRef.current?.markitdown.installed).toBe(false);
    // Caller clears the cache (mirrors the install route's `toolCache = null`).
    cacheRef.current = null;
    const second = await requireMarkitdown(cacheRef, refresh, res);
    expect(second).toBe("/usr/local/bin/markitdown");
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
