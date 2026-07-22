// Plan 018 U6: end-to-end proof of the editable reader against the real
// stack. The suite creates its OWN note through the sanctioned create route,
// edits it in the browser, and byte-diffs the actual file on disk. Existing
// vault notes are never touched; the test note is removed in cleanup.
import { expect, test, type Page } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { captureBrowserDiagnostics } from "./diagnostics";
import { E2E_VAULT } from "./global-setup";

const NOTE_ID = "inbox/sinapso-e2e-editable-reader.md";
const WIKI_NOTE_ID = "wiki/sinapso-e2e-wiki-note.md";
const NOTE_CONTENT =
  "---\ntitle: E2E Editable Reader\ntype: test\n---\n\n# E2E Editable Reader\n\nfirst paragraph stays untouched\n\nsecond paragraph gets edited\n\n```\nthis untyped code line is deliberately much wider than the narrow reader panel so its own block must scroll\n```\n\n```bash\necho typed\n```\n";
const FRONTMATTER = "---\ntitle: E2E Editable Reader\ntype: test\n---\n";

async function apiToken(page: Page): Promise<string> {
  const res = await page.request.get("/api/session");
  return ((await res.json()) as { token: string }).token;
}

async function vaultPath(page: Page): Promise<string> {
  const res = await page.request.get("/api/graph");
  const graph = (await res.json()) as { meta: { vaultPath: string } };
  return graph.meta.vaultPath;
}

async function createTestNote(page: Page): Promise<string> {
  const token = await apiToken(page);
  const vault = await vaultPath(page);
  if (resolve(vault) !== resolve(E2E_VAULT)) {
    throw new Error(
      `E2E backend is not using the hermetic test vault: ${vault}`,
    );
  }
  const file = join(vault, NOTE_ID);
  // Direct write + rescan: guardedCreate would suffix on collision, and a
  // leftover file from an aborted run must not fork into -2.md.
  writeFileSync(file, NOTE_CONTENT);
  await page.request.post("/api/rescan", {
    headers: { "x-sinapso-token": token },
  });
  return file;
}

async function createWikiTestNote(page: Page): Promise<string> {
  const token = await apiToken(page);
  const vault = await vaultPath(page);
  const file = join(vault, WIKI_NOTE_ID);
  mkdirSync(join(vault, "wiki"), { recursive: true });
  writeFileSync(
    file,
    "---\ntitle: Wiki E2E Note\ntype: test\n---\n\n# Wiki E2E Note\n\nVerified wiki content.\n",
  );
  await page.request.post("/api/rescan", {
    headers: { "x-sinapso-token": token },
  });
  return file;
}

async function removeTestNote(page: Page, file: string): Promise<void> {
  try {
    if (existsSync(file)) unlinkSync(file);
    const token = await apiToken(page);
    await page.request.post("/api/rescan", {
      headers: { "x-sinapso-token": token },
    });
  } catch {
    /* cleanup is best-effort */
  }
}

async function openTestNote(page: Page): Promise<void> {
  // The fresh vault triggers the qmd onboarding prompt, which overlays the
  // reader and intercepts clicks; mark it as already answered.
  await page.addInitScript(() =>
    localStorage.setItem("sinapso-qmd-prompted", "1"),
  );
  await page.goto(`/?node=${encodeURIComponent(NOTE_ID)}`);
  await expect(page.locator("#reader")).not.toHaveClass(/hidden/, {
    timeout: 15_000,
  });
  await expect(page.locator("#reader-editor .cm-content")).toBeAttached({
    timeout: 15_000,
  });
}

async function clickIntoParagraph(page: Page, text: string): Promise<void> {
  const line = page.locator("#reader-editor .cm-line", { hasText: text });
  await line.click();
}

test.describe.configure({ mode: "serial" });

test("note properties toggle without reserving collapsed space", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
    const bar = page.locator("#reader-find");
    const properties = page.locator("#reader-properties-toggle");
    await expect(properties).toBeVisible();
    const wiki = page.locator("#reader-wiki-toggle");
    await expect(wiki).toBeVisible();
    await expect(wiki).toHaveAttribute("title", "Not ingested");
    await expect(wiki.locator('path[d="M12 7v14"]')).toHaveCount(1);
    await expect(page.locator(".cm-frontmatter-fold")).toHaveCount(0);
    await expect(
      page.locator("#reader-editor .cm-line", { hasText: "type: test" }),
    ).toHaveCount(0);

    await properties.click();
    await expect(bar).toHaveClass(/properties-expanded/);
    await expect(properties).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator("#reader-editor .cm-line", { hasText: "type: test" }),
    ).toBeVisible();
    await expect(page.locator("#reader-wiki-top")).not.toBeVisible();

    await page.locator("#reader-find-toggle").click();
    await expect(bar).not.toHaveClass(/properties-expanded/);
    await expect(properties).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.locator("#reader-editor .cm-line", { hasText: "type: test" }),
    ).toHaveCount(0);
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("the blank header span copies the open note path", async ({ page }) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
    const actions = page.locator("#reader-actions");
    const archive = page.locator("#reader-archive");
    const right = actions.locator(".reader-actions-right");
    const [actionsBox, archiveBox, rightBox] = await Promise.all([
      actions.boundingBox(),
      archive.boundingBox(),
      right.boundingBox(),
    ]);
    const x = (archiveBox!.x + archiveBox!.width + rightBox!.x) / 2;
    await page.mouse.click(x, actionsBox!.y + actionsBox!.height / 2);
    await expect(page.locator(".copy-toast")).toHaveText("Copied!");
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("wiki notes replace the inline notice with a compact control before Versions", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createWikiTestNote(page);
  try {
    await page.addInitScript(() =>
      localStorage.setItem("sinapso-qmd-prompted", "1"),
    );
    await page.goto(`/?node=${encodeURIComponent(WIKI_NOTE_ID)}`);
    const wiki = page.locator("#reader-wiki-toggle");
    await expect(wiki).toBeVisible({ timeout: 15_000 });
    await expect(wiki).toHaveAttribute("title", "Ingested into Wiki");
    await expect(wiki.locator('path[d="M16 12h2"]')).toHaveCount(1);
    await expect(page.locator("#reader-wiki-top")).toBeHidden();
    expect(
      await wiki.evaluate(
        (button, versions) =>
          !!(
            button.compareDocumentPosition(versions as Node) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ),
        await page.locator("#reader-versions-toggle").elementHandle(),
      ),
    ).toBe(true);

    const versions = page.locator("#reader-versions-toggle");
    await versions.evaluate((button) => button.classList.remove("hidden"));
    const properties = page.locator("#reader-properties-toggle");
    await expect(properties).toBeVisible();
    const wikiBefore = await wiki.boundingBox();
    const versionsBefore = await versions.boundingBox();
    await properties.click();
    await expect(wiki).toBeVisible();
    await expect(versions).toBeVisible();
    const wikiAfter = await wiki.boundingBox();
    const versionsAfter = await versions.boundingBox();
    expect(Math.abs(wikiAfter!.x - wikiBefore!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(versionsAfter!.x - versionsBefore!.x)).toBeLessThanOrEqual(
      1,
    );
    expect(wikiAfter!.x + wikiAfter!.width).toBeLessThanOrEqual(
      versionsAfter!.x,
    );
    await properties.click();

    await page.locator("#reader-find-toggle").click();
    await expect(wiki).toBeHidden();
    await page.locator("#reader-find-toggle").click();
    await expect(wiki).toBeVisible();
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("RAW notes show the source-only Wiki status", async ({ page }) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createWikiTestNote(page);
  try {
    await page.route("**/api/wikis", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        wikis: Array<Record<string, unknown>>;
      };
      await route.fulfill({
        response,
        json: {
          wikis: body.wikis.map((wiki) => ({
            ...wiki,
            rawDestination: wiki.path === "wiki" ? "." : wiki.rawDestination,
          })),
        },
      });
    });
    await page.addInitScript(() =>
      localStorage.setItem("sinapso-qmd-prompted", "1"),
    );
    await page.goto(`/?node=${encodeURIComponent(WIKI_NOTE_ID)}`);
    const wiki = page.locator("#reader-wiki-toggle");
    await expect(wiki).toBeVisible({ timeout: 15_000 });
    await expect(wiki).toHaveAttribute("title", "Source only");
    await expect(wiki.locator('path[d="m16 12 2 2 4-4"]')).toHaveCount(1);
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("AE1: typing autosaves; only the edit differs, frontmatter byte-identical", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
    await expect(page.locator("#reader-save-state")).toHaveCount(0);
    await clickIntoParagraph(page, "second paragraph gets edited");
    await page.keyboard.press("End");
    await page.keyboard.type(" plus typed words");
    // Debounced autosave (~1.8s) plus margin.
    await expect
      .poll(() => readFileSync(file, "utf-8"), { timeout: 10_000 })
      .toContain("second paragraph gets edited plus typed words");
    const onDisk = readFileSync(file, "utf-8");
    expect(onDisk.startsWith(FRONTMATTER)).toBe(true); // R5/R7: fm untouched
    expect(onDisk).toContain("first paragraph stays untouched");
    expect(onDisk).toBe(
      NOTE_CONTENT.replace(
        "second paragraph gets edited",
        "second paragraph gets edited plus typed words",
      ),
    );
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("related notes show relevance and add a protected Connections link", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  let linkPayload: unknown;
  try {
    await page.route("**/api/integrations", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: {
          ...body,
          tools: {
            ...(body.tools as Record<string, unknown>),
            qmd: { installed: true },
          },
        },
      });
    });
    await page.route("**/api/related**", (route) =>
      route.fulfill({
        json: {
          state: "ready",
          results: [
            {
              id: "wiki/index.md",
              title: "Index",
              snippet: "An index should not be suggested.",
              score: 0.99,
            },
            {
              id: "log.md",
              title: "Log",
              snippet: "A log should not be suggested.",
              score: 0.98,
            },
            {
              id: "HOT.md",
              title: "Hot",
              snippet: "A hot note should not be suggested.",
              score: 0.97,
            },
            {
              id: "alpha-note.md",
              title: "Alpha Note",
              snippet: "A related passage.",
              score: 0.87,
            },
            {
              id: "beta-note.md",
              title: "Beta Note",
              snippet: "Already connected.",
              score: 0.86,
              alreadyLinked: true,
            },
          ],
        },
      }),
    );
    await page.route("**/api/gaps/link", async (route) => {
      linkPayload = route.request().postDataJSON();
      await route.fulfill({ json: { added: true } });
    });
    await openTestNote(page);
    const related = page.locator("#related");
    await expect(page.locator("#orphan-link")).toHaveCount(0);
    await expect(related).toContainText("Alpha Note");
    await expect(related).not.toContainText("Index");
    await expect(related).not.toContainText("Log");
    await expect(related).not.toContainText("Hot");
    await expect(
      related.getByRole("button", { name: "already linked" }),
    ).toBeDisabled();
    const row = related.locator(".rel-row", { hasText: "Alpha Note" });
    const score = row.locator(".rel-score");
    const add = row.locator(".rel-add");
    await expect(score).toHaveText("87%");
    const rowBox = await row.boundingBox();
    const scoreBox = await score.boundingBox();
    const addBox = await add.boundingBox();
    expect(scoreBox!.x + scoreBox!.width).toBeCloseTo(addBox!.x - 6, 0);
    expect(addBox!.x + addBox!.width).toBeCloseTo(
      rowBox!.x + rowBox!.width - 8,
      0,
    );
    await add.click();
    await expect(add).toHaveText("linked");
    expect(linkPayload).toEqual({
      id: NOTE_ID,
      target: "alpha-note",
    });
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("vault-relative Markdown links open their target note", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    writeFileSync(
      file,
      "# Relative Source\n\nSee [Alpha](../alpha-note.md).\n",
    );
    await page.request.post("/api/rescan", {
      headers: { "x-sinapso-token": await apiToken(page) },
    });
    await openTestNote(page);
    const link = page.locator('#reader-editor a.cm-md-link[href="#"]');
    await expect(link).toHaveText("Alpha");
    await link.click();
    await expect(page.locator("#reader-editor .cm-content")).toContainText(
      "Alpha links to",
    );
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("live graph links move an edited node and its newly linked low-degree neighbor", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __sinapso: { settled: boolean } })
                .__sinapso.settled,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    const before = await page.evaluate((sourceId) => {
      const debug = (
        window as unknown as {
          __sinapso: {
            graph: {
              graphData(): {
                nodes: Array<{ id: string; x: number; y: number; z: number }>;
                links: Array<{
                  source: string | { id: string };
                  target: string | { id: string };
                }>;
              };
              camera(): { position: { x: number; y: number; z: number } };
            };
          };
        }
      ).__sinapso;
      const nodes = debug.graph.graphData().nodes;
      const source = nodes.find((node) => node.id === sourceId)!;
      const target = nodes.find((node) => node.id === "alpha-note.md")!;
      const unrelated = nodes.find((node) => node.id === "beta-note.md")!;
      const camera = debug.graph.camera().position;
      return {
        source: { x: source.x, y: source.y, z: source.z },
        target: { x: target.x, y: target.y, z: target.z },
        unrelated: { x: unrelated.x, y: unrelated.y, z: unrelated.z },
        cameraOffset: {
          x: camera.x - source.x,
          y: camera.y - source.y,
          z: camera.z - source.z,
        },
      };
    }, NOTE_ID);

    await clickIntoParagraph(page, "first paragraph stays untouched");
    await page.keyboard.press("End");
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/notes" &&
        response.request().method() === "PUT" &&
        response.ok(),
    );
    await page.keyboard.type(" [[alpha-note]]");
    await saved;
    await expect
      .poll(
        () =>
          page.evaluate((sourceId) => {
            const debug = (
              window as unknown as {
                __sinapso: {
                  settled: boolean;
                  graph: {
                    graphData(): {
                      links: Array<{
                        source: string | { id: string };
                        target: string | { id: string };
                      }>;
                    };
                  };
                };
              }
            ).__sinapso;
            const id = (end: string | { id: string }) =>
              typeof end === "string" ? end : end.id;
            return debug.graph
              .graphData()
              .links.some(
                (link) =>
                  id(link.source) === sourceId &&
                  id(link.target) === "alpha-note.md",
              );
          }, NOTE_ID),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __sinapso: { settled: boolean } })
                .__sinapso.settled,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);

    const after = await page.evaluate((sourceId) => {
      const debug = (
        window as unknown as {
          __sinapso: {
            graph: {
              graphData(): {
                nodes: Array<{
                  id: string;
                  x: number;
                  y: number;
                  z: number;
                  fx?: number;
                  fy?: number;
                  fz?: number;
                }>;
                links: Array<{
                  source: string | { id: string };
                  target: string | { id: string };
                }>;
              };
              camera(): { position: { x: number; y: number; z: number } };
            };
          };
        }
      ).__sinapso;
      const nodes = debug.graph.graphData().nodes;
      const source = nodes.find((node) => node.id === sourceId)!;
      const target = nodes.find((node) => node.id === "alpha-note.md")!;
      const unrelated = nodes.find((node) => node.id === "beta-note.md")!;
      const camera = debug.graph.camera().position;
      const id = (end: string | { id: string }) =>
        typeof end === "string" ? end : end.id;
      return {
        source: { x: source.x, y: source.y, z: source.z },
        target: { x: target.x, y: target.y, z: target.z },
        unrelated: { x: unrelated.x, y: unrelated.y, z: unrelated.z },
        cameraOffset: {
          x: camera.x - source.x,
          y: camera.y - source.y,
          z: camera.z - source.z,
        },
        targetDegree: debug.graph
          .graphData()
          .links.filter(
            (link) =>
              id(link.source) === "alpha-note.md" ||
              id(link.target) === "alpha-note.md",
          ).length,
        temporaryPins: nodes.filter(
          (node) => node.fx != null || node.fy != null || node.fz != null,
        ).length,
      };
    }, NOTE_ID);

    const distance = (
      a: { x: number; y: number; z: number },
      b: { x: number; y: number; z: number },
    ) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(distance(after.source, before.source)).toBeGreaterThan(1);
    expect(after.targetDegree).toBeLessThanOrEqual(2);
    expect(distance(after.target, before.target)).toBeGreaterThan(1);
    expect(distance(after.unrelated, before.unrelated)).toBeLessThan(0.01);
    expect(distance(after.cameraOffset, before.cameraOffset)).toBeLessThan(0.1);
    expect(after.temporaryPins).toBe(0);
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("reduced motion hot-swaps a link without moving node or camera", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openTestNote(page);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __sinapso: { settled: boolean } })
                .__sinapso.settled,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    const snapshot = () =>
      page.evaluate((sourceId) => {
        const debug = (
          window as unknown as {
            __sinapso: {
              graph: {
                graphData(): {
                  nodes: Array<{
                    id: string;
                    x: number;
                    y: number;
                    z: number;
                    fx?: number;
                    fy?: number;
                    fz?: number;
                  }>;
                  links: Array<{
                    source: string | { id: string };
                    target: string | { id: string };
                  }>;
                };
                camera(): { position: { x: number; y: number; z: number } };
              };
            };
          }
        ).__sinapso;
        const graphData = debug.graph.graphData();
        const source = graphData.nodes.find((node) => node.id === sourceId)!;
        const camera = debug.graph.camera().position;
        const id = (end: string | { id: string }) =>
          typeof end === "string" ? end : end.id;
        return {
          source: { x: source.x, y: source.y, z: source.z },
          camera: { x: camera.x, y: camera.y, z: camera.z },
          linked: graphData.links.some(
            (link) =>
              id(link.source) === sourceId &&
              id(link.target) === "alpha-note.md",
          ),
          temporaryPins: graphData.nodes.filter(
            (node) => node.fx != null || node.fy != null || node.fz != null,
          ).length,
        };
      }, NOTE_ID);
    const before = await snapshot();

    await clickIntoParagraph(page, "first paragraph stays untouched");
    await page.keyboard.press("End");
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/notes" &&
        response.request().method() === "PUT" &&
        response.ok(),
    );
    await page.keyboard.type(" [[alpha-note]]");
    await saved;
    await expect.poll(async () => (await snapshot()).linked).toBe(true);
    const after = await snapshot();
    const distance = (
      a: { x: number; y: number; z: number },
      b: { x: number; y: number; z: number },
    ) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(distance(after.source, before.source)).toBeLessThan(0.01);
    expect(distance(after.camera, before.camera)).toBeLessThan(0.01);
    expect(after.temporaryPins).toBe(0);
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("AE1b: opening and closing without edits never touches the file", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/note-versions?"),
      ),
      openTestNote(page),
    ]);
    await page.locator("#reader-close").click();
    await page.waitForTimeout(2500);
    expect(readFileSync(file, "utf-8")).toBe(NOTE_CONTENT);
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("code blocks own horizontal overflow regardless of language", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
    await page.locator("#reader").evaluate((el) => {
      (el as HTMLElement).style.width = "320px";
    });
    const blocks = page.locator("#reader-editor .cm-md-codeblock");
    await expect(blocks).toHaveCount(2);
    await expect(blocks.first()).not.toHaveAttribute("data-language");
    await expect(blocks.nth(1)).toHaveAttribute("data-language", "bash");
    await expect(blocks.first().locator(".cm-inline-code")).toHaveCount(0);

    const metrics = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(
        "#reader-editor .cm-scroller",
      )!;
      const pre = document.querySelector<HTMLElement>(
        "#reader-editor .cm-md-codeblock pre",
      )!;
      return {
        editorClient: scroller.clientWidth,
        editorScroll: scroller.scrollWidth,
        editorOverflow: getComputedStyle(scroller).overflowX,
        blockClient: pre.clientWidth,
        blockScroll: pre.scrollWidth,
        blockOverflow: getComputedStyle(pre).overflowX,
      };
    });
    expect(metrics.editorScroll).toBe(metrics.editorClient);
    expect(metrics.editorOverflow).toBe("visible");
    expect(metrics.blockScroll).toBeGreaterThan(metrics.blockClient);
    expect(metrics.blockOverflow).toBe("auto");
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("AE2: external disk change surfaces the conflict banner, no clobber", async ({
  page,
}) => {
  // The 409 is the staleness guard working as designed; the browser still
  // auto-logs it as a console error — allow exactly that entry.
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info(), {
    allow: (e) =>
      e.kind === "console" &&
      e.message.includes("409") &&
      (e.url ?? "").includes("/api/notes"),
  });
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
    // Simulate an external editor (Obsidian, git) rewriting the note.
    const external = NOTE_CONTENT.replace(
      "first paragraph",
      "externally changed paragraph",
    );
    writeFileSync(file, external);
    await clickIntoParagraph(page, "second paragraph gets edited");
    await page.keyboard.press("End");
    await page.keyboard.type(" local edit");
    await expect(page.locator("#reader-banner")).not.toHaveClass(/hidden/, {
      timeout: 10_000,
    });
    // The stale save was rejected: disk still holds the external content.
    expect(readFileSync(file, "utf-8")).toBe(external);
    // Reload adopts the disk version into the editor.
    await page.locator("#reader-banner-primary").click();
    await expect(page.locator("#reader-editor")).toContainText(
      "externally changed paragraph",
      { timeout: 10_000 },
    );
    expect(readFileSync(file, "utf-8")).toBe(external);
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("AE3: selection shows the floating toolbar; Bold wraps in ** and renders", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
    await page.locator("#reader-scroll").evaluate((scroll) => {
      scroll.style.flex = "none";
      scroll.style.height = "180px";
    });
    const word = page.locator("#reader-editor .cm-line", {
      hasText: "first paragraph stays untouched",
    });
    await word.locator("text=untouched").dblclick();
    const bold = page.locator(".cm-tb-bold");
    await expect(bold).toBeVisible({ timeout: 5_000 });
    const initialToolbar = await page
      .locator(".cm-selection-toolbar")
      .boundingBox();
    await page.locator("#reader-scroll").evaluate((scroll) => {
      scroll.scrollTop = 20;
    });
    await expect
      .poll(
        async () =>
          (await page.locator(".cm-selection-toolbar").boundingBox())?.y,
      )
      .toBeLessThan(initialToolbar!.y - 10);
    await page.locator("#reader-scroll").evaluate((scroll) => {
      scroll.scrollTop = 0;
    });
    await bold.click();
    await expect(page.locator("#reader-editor .cm-strong")).toContainText(
      "untouched",
    );
    await expect
      .poll(() => readFileSync(file, "utf-8"), { timeout: 10_000 })
      .toContain("stays **untouched**");
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

test("flush on close: an edit right before closing the reader still lands", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
    await clickIntoParagraph(page, "second paragraph gets edited");
    await page.keyboard.press("End");
    await page.keyboard.type(" last-second words");
    await page.locator("#reader-close").click(); // no debounce wait
    await expect
      .poll(() => readFileSync(file, "utf-8"), { timeout: 10_000 })
      .toContain("last-second words");
  } finally {
    await assertCleanBrowser();
    await removeTestNote(page, file);
  }
});

// Plan 023: wikilink autocomplete — real popup, filtering, selection, save,
// render/open loop, responsive placement, and diagnostics.
test.describe("wikilink autocomplete", () => {
  test("opens on [[, filters, accepts, saves, and the rendered link opens", async ({
    page,
  }) => {
    test.setTimeout(75_000);
    const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
    const file = await createTestNote(page);
    try {
      await openTestNote(page);
      await clickIntoParagraph(page, "first paragraph stays untouched");
      await page.keyboard.press("End");
      await page.keyboard.type(" link: ");
      // Let CM's autocompletion debounce settle from the previous keystrokes.
      await page.waitForTimeout(200);
      // Typing `[[` opens the popup immediately (activateOnTyping).
      await page.keyboard.type("[[");
      const list = page.locator(".cm-tooltip-autocomplete > ul");
      await expect(list).toBeVisible({ timeout: 5_000 });
      // Filter by a fragment of the target note title.
      await page.keyboard.type("alpha n");
      await expect(list.locator("li")).toHaveCount(1, { timeout: 5_000 });
      await expect(list.locator("li")).toContainText("Alpha Note");
      // Enter accepts; one transaction inserts the exact path target.
      const saved = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/notes" &&
          response.request().method() === "PUT" &&
          response.ok(),
      );
      await page.keyboard.press("Enter");
      await saved;
      await expect
        .poll(() => readFileSync(file, "utf-8"), { timeout: 15_000 })
        .toContain("link: [[alpha-note]]");
      // Move the cursor away so live preview renders the link widget.
      await page.keyboard.press("ArrowDown");
      const wiki = page.locator("#reader-editor .cm-wikilink", {
        hasText: "alpha-note",
      });
      await expect(wiki).toBeVisible();
      await wiki.click();
      // The reader swaps to Alpha Note; wait for its body to mount.
      await expect(page.locator("#reader-editor .cm-content")).toContainText(
        "Alpha links to",
        { timeout: 10_000 },
      );
    } finally {
      await assertCleanBrowser();
      await removeTestNote(page, file);
    }
  });

  test("Escape dismisses without changing the buffer", async ({ page }) => {
    test.setTimeout(60_000);
    const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
    const file = await createTestNote(page);
    try {
      await openTestNote(page);
      await clickIntoParagraph(page, "first paragraph stays untouched");
      await page.keyboard.press("End");
      await page.keyboard.type(" stay[[");
      const list = page.locator(".cm-tooltip-autocomplete > ul");
      await expect(list).toBeVisible({ timeout: 5_000 });
      const before = await list
        .locator('li[aria-selected="true"]')
        .textContent();
      await page.keyboard.press("ArrowDown");
      await expect(list.locator('li[aria-selected="true"]')).not.toHaveText(
        before ?? "",
      );
      await page.keyboard.press("Escape");
      await expect(list).toBeHidden({ timeout: 3_000 });
      await page.locator("#reader-close").click();
      await expect
        .poll(() => readFileSync(file, "utf-8"), { timeout: 10_000 })
        .toContain("stay[[");
    } finally {
      await assertCleanBrowser();
      await removeTestNote(page, file);
    }
  });

  test("popup stays within the viewport at 390x844", async ({ page }) => {
    test.setTimeout(60_000);
    const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
    const file = await createTestNote(page);
    try {
      await page.addInitScript(() =>
        localStorage.setItem("sinapso-theme", "manuscript"),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await openTestNote(page);
      await clickIntoParagraph(page, "first paragraph stays untouched");
      await page.keyboard.press("End");
      await page.keyboard.type(" [[");
      const tooltip = page.locator(".cm-tooltip.cm-tooltip-autocomplete");
      await expect(tooltip).toBeVisible({ timeout: 5_000 });
      const box = await tooltip.boundingBox();
      expect(box).toBeTruthy();
      if (!box) throw new Error("autocomplete tooltip has no bounding box");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      const reader = await page.locator("#reader").boundingBox();
      expect(reader).toBeTruthy();
      if (!reader) throw new Error("reader has no bounding box");
      expect(box.x).toBeGreaterThanOrEqual(reader.x);
      expect(box.y).toBeGreaterThanOrEqual(reader.y);
      expect(box.x + box.width).toBeLessThanOrEqual(reader.x + reader.width);
      expect(box.y + box.height).toBeLessThanOrEqual(reader.y + reader.height);
    } finally {
      await assertCleanBrowser();
      await removeTestNote(page, file);
    }
  });
});
