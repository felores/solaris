import { describe, it, expect, vi, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, updateConfig } from "./config";

const DIR = mkdtempSync(join(tmpdir(), "solaris-config-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("integrations config", () => {
  it("returns defaults when no file exists", () => {
    expect(loadConfig(join(DIR, "missing.json"))).toEqual(defaultConfig());
  });

  it("persists a patch and reads it back", () => {
    const p = join(DIR, "config.json");
    const cfg = updateConfig(
      { exaKey: "exa-secret-123", consents: { web: true } },
      p,
    );
    expect(cfg.exaKey).toBe("exa-secret-123");
    expect(cfg.consents).toEqual({ web: true, agent: false });
    expect(loadConfig(p).exaKey).toBe("exa-secret-123");
  });

  it("writes the file with 600 permissions, also on rewrite", () => {
    const p = join(DIR, "perms.json");
    updateConfig({ exaKey: "k" }, p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    updateConfig({ consents: { agent: true } }, p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("merges patches without clobbering unrelated fields", () => {
    const p = join(DIR, "merge.json");
    updateConfig({ exaKey: "keep-me" }, p);
    const cfg = updateConfig({ consents: { web: true } }, p);
    expect(cfg.exaKey).toBe("keep-me");
    expect(cfg.consents.agent).toBe(false);
    expect(cfg.agentMode).toBe("approval");
  });

  it("ignores mistyped or unknown patch fields", () => {
    const p = join(DIR, "sanitize.json");
    const cfg = updateConfig(
      {
        agentMode: "yolo",
        exaKey: 42,
        consents: { web: "yes" },
        bogus: true,
      } as never,
      p,
    );
    expect(cfg.agentMode).toBe("approval");
    expect(cfg.exaKey).toBeNull();
    expect(cfg.consents.web).toBe(false);
    expect((cfg as never as Record<string, unknown>).bogus).toBeUndefined();
    expect(readFileSync(p, "utf-8")).not.toContain("bogus");
  });

  it("yields defaults plus a warning on a corrupt file, never a crash", () => {
    const p = join(DIR, "corrupt.json");
    writeFileSync(p, "{ not json at all");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig(p)).toEqual(defaultConfig());
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
