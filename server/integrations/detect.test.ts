import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  detectTool,
  detectAll,
  type DetectDeps,
  type RunResult,
} from "./detect";

const ok = (stdout: string): RunResult => ({ ok: true, stdout, stderr: "" });
const fail = (): RunResult => ({ ok: false, stdout: "", stderr: "not found" });

const HOME = "/home/tester";

function deps(over: Partial<DetectDeps>): Partial<DetectDeps> {
  return {
    home: HOME,
    env: { PATH: "", SHELL: "/bin/zsh" },
    fileExists: () => false,
    run: async () => fail(),
    ...over,
  };
}

describe("tool detection", () => {
  it("reports a tool absent when nothing finds it", async () => {
    const st = await detectTool("qmd", deps({}));
    expect(st).toEqual({ installed: false, version: null, path: null });
  });

  it("finds a tool on the inherited PATH", async () => {
    const bin = join("/usr/local/bin", "opencode");
    const st = await detectTool(
      "opencode",
      deps({
        env: { PATH: "/usr/local/bin", SHELL: "/bin/zsh" },
        fileExists: (p) => p === bin,
        run: async (cmd) => (cmd === bin ? ok("opencode v1.2.3\n") : fail()),
      }),
    );
    expect(st).toEqual({
      installed: true,
      version: "opencode v1.2.3",
      path: bin,
    });
  });

  it("falls back to known install locations missed by a GUI launchd PATH", async () => {
    const bunQmd = join(HOME, ".bun", "bin", "qmd");
    const st = await detectTool(
      "qmd",
      deps({
        fileExists: (p) => p === bunQmd,
        run: async (cmd) => (cmd === bunQmd ? ok("qmd 0.5.0") : fail()),
      }),
    );
    expect(st.installed).toBe(true);
    expect(st.path).toBe(bunQmd);
    expect(st.version).toBe("qmd 0.5.0");
  });

  it("falls back to a login-shell command -v probe", async () => {
    const st = await detectTool(
      "opencode",
      deps({
        run: async (cmd, args) =>
          cmd === "/bin/zsh" && args[0] === "-lc"
            ? ok("/opt/oc/bin/opencode\n")
            : ok("9.9.9"),
      }),
    );
    expect(st.installed).toBe(true);
    expect(st.path).toBe("/opt/oc/bin/opencode");
  });

  it("tolerates a failing --version and still reports installed", async () => {
    const bunQmd = join(HOME, ".bun", "bin", "qmd");
    const st = await detectTool(
      "qmd",
      deps({ fileExists: (p) => p === bunQmd }),
    );
    expect(st.installed).toBe(true);
    expect(st.version).toBeNull();
  });

  it("detectAll covers both tools", async () => {
    const all = await detectAll(deps({}));
    expect(all.qmd.installed).toBe(false);
    expect(all.opencode.installed).toBe(false);
  });
});
