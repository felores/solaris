// Hermetic E2E fixture (plan 018 U6): the suite runs against a throwaway
// vault outside the repository, never the developer's real vault. The E2E
// server is pointed here via E2E_GRAPH in playwright.config.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const E2E_TMP = join(tmpdir(), "sinapso-e2e");
export const E2E_VAULT = join(E2E_TMP, "vault");
export const E2E_GRAPH = join(E2E_TMP, "graph.json");

const NOTES: Record<string, string> = {
  "welcome.md":
    "---\ntitle: Welcome\ntype: moc\n---\n\n# Welcome\n\nStart here. See [[Alpha Note]] and [[Beta Note]].\n",
  "alpha-note.md":
    "---\ntitle: Alpha Note\n---\n\n# Alpha Note\n\nAlpha links back to [[Welcome]].\n",
  "beta-note.md":
    "# Beta Note\n\nBeta content with a [[Welcome]] link and a [[Phantom Target]].\n",
  "inbox/.keep.md": "# keep\n\nKeeps the inbox folder present for tests.\n",
  // A hermetic wiki so the wiki-ingest UI menu appears in E2E (auto-discovered,
  // defaults enabled, raw/ infers the RAW destination). Propose still fails
  // cleanly with 400 because no OpenRouter key is configured in E2E.
  "wiki/AGENTS.md":
    "# Test Wiki Contract\n\nNodes live under wiki/. Use [[wikilinks]].\n",
  "wiki/.keep.md": "# keep\n",
  "raw/.keep.md": "# keep\n",
};

export default function globalSetup(): void {
  rmSync(E2E_TMP, { recursive: true, force: true });
  mkdirSync(join(E2E_VAULT, "inbox"), { recursive: true });
  mkdirSync(join(E2E_VAULT, "wiki"), { recursive: true });
  mkdirSync(join(E2E_VAULT, "raw"), { recursive: true });
  for (const [rel, content] of Object.entries(NOTES)) {
    writeFileSync(join(E2E_VAULT, rel), content);
  }
  execFileSync(
    "npx",
    ["tsx", "scanner/scan.ts", E2E_VAULT, "--out", E2E_GRAPH],
    { cwd: ROOT, stdio: "inherit" },
  );
}

// Playwright launches webServer commands BEFORE globalSetup, so the server's
// command chain invokes this file directly to build the vault + graph first.
if (
  process.argv[1] &&
  /global-setup\.(ts|mts|js|mjs)$/i.test(process.argv[1])
) {
  globalSetup();
}
