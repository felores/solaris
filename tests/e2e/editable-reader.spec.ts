// Plan 018 U6: end-to-end proof of the editable reader against the real
// stack. The suite creates its OWN note through the sanctioned create route,
// edits it in the browser, and byte-diffs the actual file on disk. Existing
// vault notes are never touched; the test note is removed in cleanup.
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { captureBrowserDiagnostics } from "./diagnostics";
import { E2E_VAULT } from "./global-setup";

const NOTE_ID = "inbox/sinapso-e2e-editable-reader.md";
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

test("AE1: typing autosaves; only the edit differs, frontmatter byte-identical", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
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
    await removeTestNote(page, file);
    await assertCleanBrowser();
  }
});

test("AE1b: opening and closing without edits never touches the file", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
    await page.locator("#reader-close").click();
    await page.waitForTimeout(2500);
    expect(readFileSync(file, "utf-8")).toBe(NOTE_CONTENT);
  } finally {
    await removeTestNote(page, file);
    await assertCleanBrowser();
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
    await removeTestNote(page, file);
    await assertCleanBrowser();
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
    await removeTestNote(page, file);
    await assertCleanBrowser();
  }
});

test("AE3: selection shows the floating toolbar; Bold wraps in ** and renders", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const file = await createTestNote(page);
  try {
    await openTestNote(page);
    const word = page.locator("#reader-editor .cm-line", {
      hasText: "first paragraph stays untouched",
    });
    await word.locator("text=untouched").dblclick();
    const bold = page.locator(".cm-tb-bold");
    await expect(bold).toBeVisible({ timeout: 5_000 });
    await bold.click();
    await expect(page.locator("#reader-editor .cm-strong")).toContainText(
      "untouched",
    );
    await expect
      .poll(() => readFileSync(file, "utf-8"), { timeout: 10_000 })
      .toContain("stays **untouched**");
  } finally {
    await removeTestNote(page, file);
    await assertCleanBrowser();
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
    await removeTestNote(page, file);
    await assertCleanBrowser();
  }
});
