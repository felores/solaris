import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBrowserDiagnostics } from "./diagnostics";
import { E2E_VAULT } from "./global-setup";

interface SessionResponse {
  token: string;
}

interface SearchResponse {
  historyId?: string;
}

interface DocumentResponse {
  id: string;
  revision: string;
  title?: string;
  content?: string;
}

interface HistoryResponse {
  entries: Array<Record<string, unknown>>;
}

interface IntegrationsResponse {
  [key: string]: unknown;
  voice?: Record<string, unknown>;
}

const syntheticLongEntry = {
  id: "e2e-long-snippet",
  ts: "2026-01-01T00:00:00.000Z",
  mode: "keyword",
  query: "Seven-line clamp proof",
  results: [
    {
      id: "alpha-note.md",
      title: "Alpha Note",
      score: 1,
      snippet: Array.from(
        { length: 18 },
        (_, index) =>
          `Visible snippet line ${index + 1} proves the preview clamp.`,
      ).join("\n"),
    },
  ],
};

const syntheticWebEntry = {
  id: "e2e-research-toolbar",
  ts: "2026-01-01T00:00:00.000Z",
  mode: "web",
  query: "Research toolbar proof",
  answer: null,
  results: Array.from({ length: 12 }, (_, index) => ({
    title: `Toolbar source ${index + 1}`,
    url: `https://example.com/toolbar-${index + 1}`,
    snippet:
      index === 0
        ? "Selected evidence opens the compact research toolbar."
        : `Additional result ${index + 1} makes the Research panel scrollable.`,
    publishedDate: null,
  })),
};

async function token(page: Page) {
  const response = await page.request.get("/api/session");
  const body: SessionResponse = await response.json();
  return body.token;
}

async function clearHistory(page: Page) {
  await page.request.delete("/api/research/history", {
    headers: { "x-sinapso-token": await token(page) },
  });
}

async function createEvidence(page: Page, term: string, label: string) {
  const response = await page.request.get(
    `/api/search?q=${encodeURIComponent(term)}&history=1&displayQuery=${encodeURIComponent(label)}`,
    { headers: { "x-sinapso-token": await token(page) } },
  );
  expect(response.ok()).toBe(true);
  const body: SearchResponse = await response.json();
  expect(body.historyId).toBeTruthy();
  return body.historyId!;
}

async function createDocument(page: Page, title: string, content: string) {
  // Plan 020 U7: /api/document no longer accepts first-party creates. The
  // E2E suite still exercises the legacy revision-CAS / show_document flow,
  // so seed a mode=document entry directly in the hermetic vault's app-local
  // research directory (the same place the route reads/writes it).
  const id = `doc-e2e-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const revision = `rev-${Date.now().toString(36)}`;
  const researchDir = join(tmpdir(), "sinapso-e2e", "research");
  mkdirSync(researchDir, { recursive: true });
  writeFileSync(
    join(researchDir, `${id}.json`),
    JSON.stringify({
      id,
      ts: new Date().toISOString(),
      mode: "document",
      query: title,
      document: { title, content, revision },
    }),
  );
  return { id, revision, title, content };
}

async function updateDocument(
  page: Page,
  document: DocumentResponse,
  title: string,
  content: string,
) {
  const response = await page.request.post("/api/document", {
    headers: { "x-sinapso-token": await token(page) },
    data: { id: document.id, revision: document.revision, title, content },
  });
  expect(response.ok()).toBe(true);
  const body: DocumentResponse = await response.json();
  return { id: document.id, revision: body.revision, title, content };
}

async function installVoiceHarness(page: Page, researchTools = false) {
  let socket: WebSocketRoute | undefined;
  let includeLongEntry = false;
  let includeWebEntry = false;
  const extraHistoryEntries: Array<Record<string, unknown>> = [];

  await page.route("**/api/integrations", async (route) => {
    const response = await route.fetch();
    const body: IntegrationsResponse = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        ...(researchTools
          ? {
              consents: {
                ...(body.consents as Record<string, unknown>),
                web: true,
              },
              tools: {
                ...(body.tools as Record<string, unknown>),
                exa: { configured: true },
                openrouter: { configured: true },
              },
              webResearch: { configured: true },
              webSearch: { provider: "exa", configured: true },
              webFetch: { provider: "exa", configured: true },
            }
          : {}),
        voice: {
          ...body.voice,
          provider: "gemini",
          voice: "Kore",
          keys: { gemini: true },
        },
      },
    });
  });
  await page.route("**/api/research/history", async (route) => {
    if (
      (!includeLongEntry && !includeWebEntry) ||
      route.request().method() !== "GET"
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body: HistoryResponse = await response.json();
    const entries = [...extraHistoryEntries, ...body.entries];
    if (includeLongEntry) entries.unshift(syntheticLongEntry);
    if (includeWebEntry) entries.unshift(syntheticWebEntry);
    await route.fulfill({
      response,
      json: { entries },
    });
  });
  await page.routeWebSocket("**/api/voice/ws?token=*", (route) => {
    socket = route;
    setTimeout(() => route.send(JSON.stringify({ type: "ready" })), 50);
  });
  await page.addInitScript(() => {
    localStorage.setItem("sinapso-qmd-prompted", "1");
    const analyser = {
      fftSize: 512,
      smoothingTimeConstant: 0,
      connect() {},
      getByteTimeDomainData(buffer: Uint8Array) {
        buffer.fill(128);
      },
    };
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      audioWorklet = { addModule: async () => undefined };
      resume = async () => undefined;
      close = async () => undefined;
      createAnalyser() {
        return { ...analyser };
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
      createScriptProcessor() {
        return { connect() {}, disconnect() {}, onaudioprocess: null };
      }
      createBuffer() {
        return { duration: 0, getChannelData: () => new Float32Array(0) };
      }
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          start() {},
          stop() {},
          onended: null,
        };
      }
      createGain() {
        return { gain: { value: 1 }, connect() {} };
      }
    }
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }],
        }),
      },
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
    Object.defineProperty(window, "AudioWorkletNode", {
      configurable: true,
      value: class {
        port = { onmessage: null };
        connect() {}
      },
    });
  });

  await page.goto("/");
  await expect(page.locator("#voice-toggle")).toBeEnabled();
  await page.locator("#voice-toggle").click();
  await expect(page.locator("#voice-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  return {
    show: async (id: string, action = "open_research") => {
      expect(socket, "voice WebSocket connected").toBeDefined();
      await page.evaluate(() => {
        document.documentElement.dataset.researchDisplayAck = "pending";
        window.addEventListener(
          "sinapso:research-display-ack",
          () => {
            document.documentElement.dataset.researchDisplayAck = "received";
          },
          { once: true },
        );
      });
      socket!.send(JSON.stringify({ type: "action", action, id }));
      await page.waitForFunction(
        () =>
          document.documentElement.dataset.researchDisplayAck === "received",
      );
    },
    includeLongEntry: () => {
      includeLongEntry = true;
    },
    includeWebEntry: () => {
      includeWebEntry = true;
    },
    addHistoryEntry: (entry: Record<string, unknown>) => {
      extraHistoryEntries.unshift(entry);
    },
  };
}

async function expectVisibleQuery(page: Page, query: string) {
  await expect(page.locator("#research")).not.toHaveClass(/hidden/);
  await expect(page.locator("#research-body")).toContainText(query);
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await clearHistory(page);
});

test("working documents accept wikilink autocomplete with the mouse", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const draft = await createDocument(page, "Linked draft", "Draft body");
    const harness = await installVoiceHarness(page);
    await harness.show(draft.id, "show_document");
    const editor = page.locator(".research-document-editor .cm-content");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" [[alpha n");
    const option = page.locator(".cm-tooltip-autocomplete li", {
      hasText: "Alpha Note",
    });
    await expect(option).toBeVisible();
    await option.click();
    await expect
      .poll(async () => {
        const stored = await page.request.get(`/api/document/${draft.id}`);
        const body: DocumentResponse = await stored.json();
        return body.content;
      })
      .toContain("[[alpha-note]]");
  } finally {
    await assertCleanBrowser();
  }
});

test("Research vault notes expose wikilink autocomplete", async ({ page }) => {
  test.setTimeout(60_000);
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const noteId = "inbox/autocomplete-research.md";
  const file = join(E2E_VAULT, noteId);
  const sessionToken = await token(page);
  try {
    writeFileSync(file, "# Autocomplete Research\n\nResearch body.\n");
    await page.request.post("/api/rescan", {
      headers: { "x-sinapso-token": sessionToken },
    });
    await page.addInitScript(() =>
      localStorage.setItem("sinapso-qmd-prompted", "1"),
    );
    await page.goto("/");
    await page.locator("#new-doc-btn").click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page
      .locator(".inbox-list-item", { hasText: "autocomplete-research" })
      .click();
    const editor = page.locator("#research .cm-content");
    await expect(editor).toContainText("Research body.");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" [[alpha n");
    await expect(
      page.locator(".cm-tooltip-autocomplete li", { hasText: "Alpha Note" }),
    ).toBeVisible();
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/notes" &&
        response.request().method() === "PUT" &&
        response.ok(),
    );
    await page.keyboard.press("Enter");
    await saved;
    await expect
      .poll(() => readFileSync(file, "utf-8"))
      .toContain("[[alpha-note]]");
    await page.locator("#research-close").click();
  } finally {
    rmSync(file, { force: true });
    await page.request.post("/api/rescan", {
      headers: { "x-sinapso-token": sessionToken },
    });
    await assertCleanBrowser();
  }
});

test("Research Inbox notes render code blocks in their own scrolling container", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const noteId = "inbox/code-block-research.md";
  const file = join(E2E_VAULT, noteId);
  const sessionToken = await token(page);
  try {
    writeFileSync(
      file,
      "# Code Block Research\n\n```ts\nconst veryLongLine = 'this must scroll inside its own code block rather than widening the research panel';\n```\n",
    );
    await page.request.post("/api/rescan", {
      headers: { "x-sinapso-token": sessionToken },
    });
    await page.addInitScript(() =>
      localStorage.setItem("sinapso-qmd-prompted", "1"),
    );
    await page.goto("/");
    await page.locator("#new-doc-btn").click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page
      .locator(".inbox-list-item", { hasText: "code-block-research" })
      .click();
    const block = page.locator(".inbox-editor .cm-md-codeblock pre");
    await expect(block).toBeVisible();
    await expect(block).toHaveCSS("overflow-x", "auto");
    await expect(block).toHaveCSS("border-top-style", "solid");
  } finally {
    rmSync(file, { force: true });
    await page.request.post("/api/rescan", {
      headers: { "x-sinapso-token": sessionToken },
    });
    await assertCleanBrowser();
  }
});

test("pinning coordinates agent opens, refreshes, conflicts, unpin, and user navigation", async ({
  page,
}) => {
  test.setTimeout(75_000);
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info(), {
    allow: (entry) =>
      entry.kind === "console" &&
      entry.message.includes("409") &&
      (entry.url ?? "").endsWith("/api/document"),
  });
  try {
    const resultA = await createEvidence(page, "Alpha", "Persisted result A");
    const harness = await installVoiceHarness(page);
    await harness.show(resultA);
    await expectVisibleQuery(page, "Persisted result A");

    await page.locator("#research-pin").click();
    await expect(page.locator("#research-pin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const resultB = await createEvidence(page, "Beta", "Agent result B");
    await harness.show(resultB);
    await expectVisibleQuery(page, "Persisted result A");
    await expect(page.locator("#research-pos")).toHaveText(/\/2$/);
    await expect(
      page.locator("#workflow-terminal-cards .terminal-card"),
    ).toContainText("new agent result is ready in the background");
    await expect(
      page.locator("#workflow-terminal-cards .terminal-card"),
    ).toContainText("current result is pinned");

    await page.locator("#research-next").click();
    await expectVisibleQuery(page, "Agent result B");
    await page.locator("#research-prev").click();
    await expectVisibleQuery(page, "Persisted result A");
    await expect(page.locator("#research-pin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.locator("#research-pin").click();

    const cleanDoc = await createDocument(
      page,
      "Clean pinned draft",
      "first server version",
    );
    await harness.show(cleanDoc.id, "show_document");
    await expect(page.locator(".research-document-title")).toHaveValue(
      "Clean pinned draft",
    );
    await page.locator("#research-pin").click();
    const refreshed = await updateDocument(
      page,
      cleanDoc,
      "Clean pinned draft",
      "same-id refreshed version",
    );
    await harness.show(cleanDoc.id, "show_document");
    await expect(page.locator(".research-document-editor")).toContainText(
      "same-id refreshed version",
    );

    const editor = page.locator(".research-document-editor .cm-content");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" local unsaved words");
    const external = await updateDocument(
      page,
      refreshed,
      "Clean pinned draft",
      "external competing version",
    );
    await harness.show(cleanDoc.id, "show_document");
    await expect(page.locator("#research-error")).toContainText(
      "unsaved changes",
    );
    await expect(editor).toContainText("local unsaved words");
    const disk = await page.request.get(`/api/document/${external.id}`);
    const diskBody: DocumentResponse = await disk.json();
    expect(diskBody.content).toBe("external competing version");
    await expect(page.locator("#research-banner")).toBeVisible();
    await expect(page.locator("#research-error")).toContainText(
      "unsaved changes",
    );
    await page.locator("#research-banner-primary").click();
    await expect(page.locator("#research-banner")).toHaveClass(/hidden/);
    await expect(editor).toContainText("external competing version");

    await page.locator("#research-pin").click();
    await expect(page.locator("#research-pin")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await harness.show(resultB);
    await expectVisibleQuery(page, "Agent result B");
  } finally {
    await assertCleanBrowser();
  }
});

test("plan 020: titled creation writes a durable Inbox note and opens it in research", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "subtle", { value: undefined });
  });
  await page.reload();
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    // The new-doc button lives inside the research panel header. Open the
    // research panel via the voice-action harness (mirrors the prior test's
    // setup), then click the now-visible new-doc button.
    const harness = await installVoiceHarness(page, true);
    const resultA = await createEvidence(
      page,
      "Alpha",
      "Open panel for new-doc",
    );
    await harness.show(resultA);
    await page.locator("#new-doc-btn").click();
    const title = `Inbox E2E ${Date.now()}`;
    const titleInput = page.locator(".inbox-create-row input");
    await expect(titleInput).toBeVisible();
    await titleInput.fill(title);
    let clientRescans = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/rescan") clientRescans++;
    });
    const createdResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/notes" &&
        response.request().method() === "POST" &&
        response.ok(),
    );
    await page.locator(".inbox-create-row button.primary").click();
    const created = (await (await createdResponse).json()) as {
      id: string;
      graphUpdated: boolean;
    };
    expect(created.graphUpdated).toBe(true);
    const createdGraph = (await (
      await page.request.get("/api/graph")
    ).json()) as { nodes: Array<{ id: string }> };
    expect(createdGraph.nodes.map((node) => node.id)).toContain(created.id);
    expect(clientRescans).toBe(0);
    const editor = page.locator("#research .cm-content");
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await editor.click();
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/notes" &&
        response.request().method() === "PUT" &&
        response.ok(),
    );
    await page.keyboard.type("Browser-authored durable body.");
    await editor.locator("text=durable").dblclick();
    const toolbar = page.locator(".cm-selection-toolbar");
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator(".cm-tb-chat")).toBeVisible();
    await expect(toolbar.locator(".cm-tb-bold")).toBeVisible();
    // Autosave flushes through PUT /api/notes (baseHash CAS) without UI noise.
    await saved;
    await expect(page.locator("#research-vault-save-state")).toHaveCount(0);
    await expect(page.locator("#reader-save-state")).toHaveCount(0);
    // The note is durable on disk under the configured Inbox; no new
    // mode=document research-history entry was created.
    const history = await page.request.get("/api/research/history");
    const body: HistoryResponse = await history.json();
    const newDoc = body.entries.find((entry) => entry.mode === "document");
    expect(newDoc).toBeUndefined();
    const noteResp = await page.request.get("/api/inbox?destination=inbox");
    expect(noteResp.ok()).toBe(true);
    const inboxBody = (await noteResp.json()) as {
      entries: Array<{ id: string }>;
    };
    expect(inboxBody.entries.some((e) => e.id.startsWith("inbox/"))).toBe(true);
  } finally {
    await assertCleanBrowser();
  }
});

test("evidence is immutable and long snippets expand without opening the note", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const evidenceId = await createEvidence(
      page,
      "Alpha",
      "Immutable evidence",
    );
    const overwrite = await page.request.post("/api/document", {
      headers: { "x-sinapso-token": await token(page) },
      data: {
        id: evidenceId,
        revision: "stale",
        title: "No",
        content: "overwrite",
      },
    });
    expect(overwrite.status()).toBe(409);
    const evidence = await page.request.get("/api/research/history");
    const evidenceBody: HistoryResponse = await evidence.json();
    expect(
      evidenceBody.entries.find((entry) => entry.id === evidenceId)?.mode,
    ).toBe("keyword");

    const harness = await installVoiceHarness(page);
    harness.includeLongEntry();
    await harness.show(syntheticLongEntry.id);
    const title = page.locator("#research-body .research-content-title");
    const snippet = page.locator(".rel-snippet", {
      hasText: "Visible snippet line 1",
    });
    await expect(snippet).toBeVisible();
    const [titleSize, snippetSize] = await Promise.all([
      title.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      ),
      snippet.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      ),
    ]);
    expect(titleSize / snippetSize).toBeGreaterThanOrEqual(1.6);
    const lineHeight = await snippet.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).lineHeight),
    );
    const collapsedHeight = await snippet.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(collapsedHeight).toBeLessThanOrEqual(lineHeight * 7 + 2);
    await page.locator(".expand-btn").click();
    await expect(snippet).toHaveClass(/expanded/);
    await expect(page.locator("#reader")).toHaveClass(/hidden/);
    const expandedHeight = await snippet.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(expandedHeight).toBeGreaterThan(collapsedHeight);
  } finally {
    await assertCleanBrowser();
  }
});

test("web result external icon stays beside the internal title link", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const harness = await installVoiceHarness(page);
    harness.includeWebEntry();
    await harness.show(syntheticWebEntry.id);
    const result = page.locator(".web-result").first();
    const layout = await result.evaluate((element) => {
      const link = element.querySelector<HTMLElement>(".web-result-title");
      const icon = element.querySelector<HTMLElement>(".web-result-external");
      const snippet = element.querySelector<HTMLElement>(".web-snippet");
      if (!link || !icon || !snippet)
        throw new Error("Expected web result layout elements");
      link.textContent =
        "HY3 Preview FULL Test - Hands-On With Tencent's Next-Generation Model";
      const lines = [...link.getClientRects()];
      const lastLine = lines[lines.length - 1];
      const iconBox = icon.getBoundingClientRect();
      const snippetBox = snippet.getBoundingClientRect();
      return {
        lines: lines.length,
        gap: iconBox.left - lastLine.right,
        verticalOffset: Math.abs(
          iconBox.top +
            iconBox.height / 2 -
            (lastLine.top + lastLine.height / 2),
        ),
        iconBottom: iconBox.bottom,
        snippetTop: snippetBox.top,
      };
    });

    expect(layout.lines).toBeGreaterThan(1);
    expect(layout.verticalOffset).toBeLessThanOrEqual(3);
    expect(layout.gap).toBeGreaterThanOrEqual(3);
    expect(layout.gap).toBeLessThanOrEqual(8);
    expect(layout.iconBottom).toBeLessThanOrEqual(layout.snippetTop);
  } finally {
    await assertCleanBrowser();
  }
});

test("deep research source titles wrap without separating their external icon", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const entry = {
      id: "e2e-long-synthesis-source",
      ts: "2026-01-01T00:00:00.000Z",
      mode: "web",
      query: "Long synthesis source",
      answer: {
        content: "Synthesis body",
        citations: [
          {
            title:
              "https://docs.poolside.ai/release-notes/models/laguna-s-2-1-for-agentic-coding-workflows",
            url: "https://docs.poolside.ai/release-notes/models/laguna-s-2-1",
          },
        ],
      },
      results: [],
    };
    const harness = await installVoiceHarness(page);
    harness.includeWebEntry();
    harness.addHistoryEntry(entry);
    await harness.show(entry.id);
    const layout = await page.locator(".answer-source").evaluate((link) => {
      const body = link.closest<HTMLElement>("#research-body");
      const icon = link.nextElementSibling as HTMLElement | null;
      if (!body || !icon) throw new Error("Expected synthesis source layout");
      const lines = [...link.getClientRects()];
      const lastLine = lines[lines.length - 1];
      const iconBox = icon.getBoundingClientRect();
      return {
        lines: lines.length,
        overflows: body.scrollWidth > body.clientWidth,
        gap: iconBox.left - lastLine.right,
        verticalOffset: Math.abs(
          iconBox.top +
            iconBox.height / 2 -
            (lastLine.top + lastLine.height / 2),
        ),
      };
    });

    expect(layout.lines).toBeGreaterThan(1);
    expect(layout.overflows).toBe(false);
    expect(layout.verticalOffset).toBeLessThanOrEqual(3);
    expect(layout.gap).toBeGreaterThanOrEqual(3);
    expect(layout.gap).toBeLessThanOrEqual(8);
  } finally {
    await assertCleanBrowser();
  }
});

test("read-only research selections use the compact opaque action toolbar", async ({
  page,
}) => {
  test.setTimeout(75_000);
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const inboxId = `inbox/selection-terminal-${Date.now()}.md`;
  const inboxFile = join(E2E_VAULT, inboxId);
  try {
    const researchRequests: Array<{
      query: string;
      deep: boolean;
      contexts?: {
        current?: {
          title?: string;
          query?: string;
          url?: string;
          text?: string;
        };
      };
    }> = [];
    const releaseResearch: Array<() => Promise<void>> = [];
    await page.route("**/api/research", async (route) => {
      if (new URL(route.request().url()).pathname !== "/api/research") {
        await route.continue();
        return;
      }
      researchRequests.push(route.request().postDataJSON());
      await new Promise<void>((resolve) => {
        releaseResearch.push(async () => {
          const id = `selection-research-${researchRequests.length}`;
          await route.fulfill({
            json: {
              answer: null,
              results: [],
              contextWarning: null,
              historyId: id,
            },
          });
          resolve();
        });
      });
    });
    const harness = await installVoiceHarness(page, true);
    harness.includeWebEntry();
    await harness.show(syntheticWebEntry.id);
    await page.locator(".web-snippet").first().selectText();

    const toolbar = page.locator("#research-selection-assist");
    await expect(toolbar).toBeVisible();
    const buttons = toolbar.locator(".research-selection-actions button");
    await expect(buttons).toHaveCount(3);
    await expect(buttons.nth(0)).toHaveAttribute("title", "Go deep");
    await expect(buttons.nth(1)).toHaveAttribute("title", "Alternatives");
    await expect(buttons.nth(2)).toHaveAttribute("title", "Ask AI…");
    await expect(toolbar.locator(".research-selection-input")).toBeHidden();
    await expect(toolbar.locator(".research-selection-answer")).toBeHidden();
    const collapsedToolbar = await toolbar.boundingBox();
    const collapsedActions = await toolbar
      .locator(".research-selection-actions")
      .boundingBox();
    expect(collapsedToolbar).not.toBeNull();
    expect(collapsedActions).not.toBeNull();
    expect(
      collapsedToolbar!.width - collapsedActions!.width,
    ).toBeLessThanOrEqual(12);
    expect(
      collapsedToolbar!.height - collapsedActions!.height,
    ).toBeLessThanOrEqual(12);
    const selectionBounds = await page.evaluate(() => {
      const selection = window.getSelection();
      const rects = Array.from(selection!.getRangeAt(0).getClientRects());
      return {
        left: Math.min(...rects.map((rect) => rect.left)),
        right: Math.max(...rects.map((rect) => rect.right)),
      };
    });
    expect(
      Math.abs(
        collapsedToolbar!.x +
          collapsedToolbar!.width / 2 -
          (selectionBounds.left + selectionBounds.right) / 2,
      ),
    ).toBeLessThanOrEqual(3);
    await page.locator("#research-body").evaluate((body) => {
      body.scrollTop = 30;
    });
    await expect
      .poll(async () => (await toolbar.boundingBox())?.y)
      .toBeLessThan(collapsedToolbar!.y - 20);
    await page.locator("#research-body").evaluate((body) => {
      body.scrollTop = 0;
    });

    await buttons.nth(2).click();
    const input = toolbar.locator(".research-selection-input input");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(buttons.nth(2)).toHaveClass(/active/);
    await expect(buttons.nth(2)).toHaveAttribute("aria-expanded", "true");
    await expect(
      toolbar.locator(
        ".research-selection-actions > .research-selection-input",
      ),
    ).toBeVisible();
    expect(
      await toolbar
        .locator(".research-selection-input")
        .evaluate((element) => getComputedStyle(element).borderBottomWidth),
    ).toBe("0px");
    const expandedToolbar = await toolbar.boundingBox();
    expect(expandedToolbar!.width).toBeGreaterThan(
      collapsedToolbar!.width + 150,
    );
    const researchPanel = await page.locator("#research").boundingBox();
    expect(expandedToolbar!.x + expandedToolbar!.width).toBeLessThanOrEqual(
      researchPanel!.x + researchPanel!.width,
    );
    expect(
      await toolbar.evaluate(
        (element) => getComputedStyle(element).backgroundImage,
      ),
    ).not.toBe("none");

    await page.locator("#research-pin").click();
    await buttons.nth(0).click();
    await expect.poll(() => researchRequests.length).toBe(1);
    await expect(page.locator("#research-body")).toContainText(
      "Toolbar source 1",
    );
    await expect(page.locator("#research-body")).not.toContainText(
      "researching in depth",
    );
    await expect(page.locator("#ops-status")).toContainText(
      "Researching selected evidence",
    );
    await expect(page.locator("#workflow-terminal-cards")).toBeEmpty();
    expect(researchRequests[0]).toMatchObject({
      query: "Find deeper primary-source detail on this topic.",
      deep: true,
      contexts: {
        current: {
          title: syntheticWebEntry.query,
          query: syntheticWebEntry.query,
          url: syntheticWebEntry.results[0].url,
          text: syntheticWebEntry.results[0].snippet,
        },
      },
    });

    expect(releaseResearch).toHaveLength(1);
    await releaseResearch.shift()!();
    harness.addHistoryEntry({
      id: "selection-research-1",
      ts: "2026-01-02T00:00:00.000Z",
      mode: "web",
      query: "Find deeper primary-source detail on this topic.",
      answer: null,
      results: [],
    });
    const readyCard = page.locator("#workflow-terminal-cards .terminal-card", {
      hasText: "Find deeper primary-source detail",
    });
    await expect(readyCard).toBeVisible();
    await expect(
      readyCard.getByRole("button", { name: "Open research" }),
    ).toBeVisible();
    const desktopCard = await readyCard.boundingBox();
    const desktopResearch = await page.locator("#research").boundingBox();
    expect(desktopCard).not.toBeNull();
    expect(desktopResearch).not.toBeNull();
    expect(desktopCard!.x + desktopCard!.width).toBeLessThanOrEqual(
      desktopResearch!.x + 1,
    );
    await buttons.nth(1).click();
    await expect.poll(() => researchRequests.length).toBe(2);
    expect(researchRequests[1]).toMatchObject({
      query: "Find credible alternative perspectives on this topic.",
      deep: true,
    });
    expect(releaseResearch).toHaveLength(1);
    await releaseResearch.shift()!();
    harness.addHistoryEntry({
      id: "selection-research-2",
      ts: "2026-01-03T00:00:00.000Z",
      mode: "web",
      query: "Find credible alternative perspectives on this topic.",
      answer: null,
      results: [],
    });
    await expect(
      page.locator("#workflow-terminal-cards .terminal-card"),
    ).toHaveCount(2);
    writeFileSync(inboxFile, "# Selection terminal\n\nInbox stays editable.\n");
    await page.locator("#research-toggle-inbox").click();
    const inboxItem = page.locator(".inbox-list-item", {
      hasText: "selection-terminal",
    });
    await inboxItem.click();
    const inboxEditor = page.locator("#research .cm-content");
    await inboxEditor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Dirty before opening result.");
    await expect(readyCard).toBeVisible();
    await readyCard.getByRole("button", { name: "Open research" }).click();
    await expect(page.locator("#research-body")).toContainText(
      "Find deeper primary-source detail",
    );
    await expect
      .poll(() => readFileSync(inboxFile, "utf-8"))
      .toContain("Dirty before opening result.");
    await expect(page.locator("#research-pin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page
      .locator("#workflow-terminal-cards .terminal-card", {
        hasText: "Find credible alternative perspectives",
      })
      .getByRole("button", { name: "Open research" })
      .click();
    await expect(page.locator("#research-body")).toContainText(
      "Find credible alternative perspectives",
    );
  } finally {
    rmSync(inboxFile, { force: true });
    await assertCleanBrowser();
  }
});

test("rescan blocks at seven unresolved actions without dropping a retry", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  let researchRequests = 0;
  let rescanRequests = 0;
  try {
    await page.route("**/api/research", async (route) => {
      if (new URL(route.request().url()).pathname !== "/api/research") {
        await route.continue();
        return;
      }
      researchRequests++;
      await route.fulfill({
        json: {
          answer: null,
          results: [],
          contextWarning: null,
          historyId: `capacity-${researchRequests}`,
        },
      });
    });
    await page.route("**/api/rescan*", async (route) => {
      rescanRequests++;
      await route.fulfill({ json: { ok: false, error: "vault unavailable" } });
    });
    const harness = await installVoiceHarness(page, true);
    harness.includeWebEntry();
    await harness.show(syntheticWebEntry.id);
    for (let index = 0; index < 7; index++) {
      await page.locator(".web-snippet").first().selectText();
      await page.getByRole("button", { name: "Go deep" }).click();
      await expect.poll(() => researchRequests).toBe(index + 1);
    }
    await expect(
      page.locator("#workflow-terminal-cards .terminal-card"),
    ).toHaveCount(3);

    await page.evaluate(() =>
      (document.querySelector("#mi-rescan") as HTMLButtonElement).click(),
    );

    await expect(page.locator("#ops-status")).toContainText(
      "Finish or dismiss a ready action before starting another.",
    );
    expect(rescanRequests).toBe(0);
    await expect(
      page.locator("#workflow-terminal-cards .terminal-card", {
        hasText: "Could not rescan",
      }),
    ).toHaveCount(0);
  } finally {
    await assertCleanBrowser();
  }
});

test("pending web search preserves pinned research and a dirty Inbox editor", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const inboxId = `inbox/pending-web-${Date.now()}.md`;
  const inboxFile = join(E2E_VAULT, inboxId);
  let releaseResearch: (() => Promise<void>) | undefined;
  try {
    await page.route("**/api/research", async (route) => {
      await new Promise<void>((resolve) => {
        releaseResearch = async () => {
          await route.fulfill({
            json: { answer: null, results: [], contextWarning: null },
          });
          resolve();
        };
      });
    });
    const harness = await installVoiceHarness(page, true);
    harness.includeWebEntry();
    await harness.show(syntheticWebEntry.id);
    await page.locator("#research-pin").click();

    writeFileSync(inboxFile, "# Pending web\n\nInbox stays dirty.\n");
    await page.locator("#research-toggle-inbox").click();
    await page.locator(".inbox-list-item", { hasText: "pending-web" }).click();
    const editor = page.locator("#research .cm-content");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Unsaved while searching.");

    await page.locator("#mode-web").evaluate((button: HTMLButtonElement) => {
      button.disabled = false;
    });
    await page.locator("#mode-web").click();
    await page.locator("#search").fill("pending normal web search");
    await page.locator("#search").press("Enter");
    await expect(page.locator("#ops-status")).toContainText(
      "researching deeply",
    );
    await expect(editor).toContainText("Unsaved while searching.");
    await expect(page.locator("#research-title")).toHaveText("Inbox Note");
    await expect(page.locator("#research-toggle-inbox")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#research-body")).not.toContainText(
      "researching deeply",
    );

    await releaseResearch?.();
  } finally {
    rmSync(inboxFile, { force: true });
    await assertCleanBrowser();
  }
});

test("terminal workflow host is available without creating a second surface", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    await page.goto("/");
    const host = page.locator("#workflow-terminal-cards");
    await expect(host).toBeAttached();
    // Empty host -> no lifecycle card is rendered.
    await expect(host).toBeEmpty();
  } finally {
    await assertCleanBrowser();
  }
});

test("wiki ingest preparation preserves the visible document and surfaces an error card", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info(), {
    // Propose is expected to fail with a clean 400 here (no OpenRouter key in
    // the hermetic E2E); that controlled failure is the point of the test, so
    // allow its console message without weakening the other diagnostics.
    allow: (entry) =>
      entry.kind === "console" &&
      /wiki-ingest\/propose/.test(entry.url ?? "") &&
      /400/.test(entry.message),
  });
  try {
    const harness = await installVoiceHarness(page);
    const doc = await createDocument(
      page,
      "Visible While Proposing",
      "PRESERVED DURING WIKI INGEST content",
    );
    await harness.show(doc.id);
    await expectVisibleQuery(page, "PRESERVED DURING WIKI INGEST");

    // Trigger "Save + ingest" from the research footer. Propose hits the
    // server without an OpenRouter key -> clean 400 -> the frontend must keep
    // the document visible and surface a non-blocking terminal retry card.
    const ingestTrigger = page.locator("#research-ingest-wiki");
    await expect(ingestTrigger).toBeVisible();
    await ingestTrigger.click();
    const menuIngest = page.locator("#research-wiki-menu-ingest");
    await expect(menuIngest).toBeVisible();
    await menuIngest.click();

    // An error terminal card appears (role=alert), and it is dismissable.
    const errorCard = page.locator("#workflow-terminal-cards .terminal-card", {
      hasText: "Try again",
    });
    await expect(errorCard).toBeVisible({ timeout: 15_000 });
    await expect(errorCard).toHaveAttribute("role", "alert");

    // Frente B core contract: the visible document is NOT cleared.
    await expectVisibleQuery(page, "PRESERVED DURING WIKI INGEST");

    // Dismiss only collapses the unresolved action into the aggregate.
    await errorCard.locator(".terminal-card-dismiss").click();
    await expect(
      page.locator("#workflow-terminal-cards .terminal-card-aggregate"),
    ).toBeVisible();
  } finally {
    await assertCleanBrowser();
  }
});

test("wiki ingest apply preserves the Research return context", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const harness = await installVoiceHarness(page);
    const doc = await createDocument(
      page,
      "Research Before Ingest",
      "RESTORE THIS RESEARCH DOCUMENT",
    );
    await harness.show(doc.id);
    let applied = false;
    await page.route("**/api/wiki-ingest/propose", (route) =>
      route.fulfill({
        json: {
          wiki: { id: "wiki", label: "Test Wiki", path: "wiki" },
          source: "Research Before Ingest",
          title: "Derived note",
          researchId: doc.id,
          operations: [
            { type: "create", path: "raw/source.md", raw: true },
            {
              type: "create",
              path: "wiki/primary.md",
              content: "# Primary wiki note\n",
            },
          ],
        },
      }),
    );
    await page.route("**/api/wiki-ingest/apply", (route) => {
      applied = true;
      return route.fulfill({
        json: {
          ids: ["wiki/primary.md", "raw/source.md"],
          primaryId: "wiki/primary.md",
          graphUpdated: true,
        },
      });
    });
    await page.route("**/api/graph", async (route) => {
      const response = await route.fetch();
      if (!applied) {
        await route.fulfill({ response });
        return;
      }
      const graph = (await response.json()) as {
        nodes: Array<Record<string, unknown>>;
      };
      await route.fulfill({
        response,
        json: {
          ...graph,
          nodes: [
            ...graph.nodes,
            {
              id: "wiki/primary.md",
              title: "Primary wiki note",
              in: 0,
              out: 0,
            },
          ],
        },
      });
    });
    await page.route("**/api/note?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("id") !== "wiki/primary.md") {
        await route.continue();
        return;
      }
      await route.fulfill({
        json: {
          markdown: "# Primary wiki note\n\nCreated by ingest.\n",
          baseHash: "0".repeat(64),
        },
      });
    });
    await page.route("**/api/note-versions?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("id") !== "wiki/primary.md") {
        await route.continue();
        return;
      }
      await route.fulfill({ json: { versions: [] } });
    });

    await page.locator("#research-ingest-wiki").click();
    await page.locator("#research-wiki-menu-ingest").click();
    await page.locator("#workflow-terminal-cards .terminal-card-open").click();
    await page.locator(".wiki-proposal-actions .web-save").first().click();

    await expectVisibleQuery(page, "RESTORE THIS RESEARCH DOCUMENT");
    await expect(page.locator("#reader-editor .cm-content")).toHaveCount(0);
  } finally {
    await assertCleanBrowser();
  }
});

test("wiki ingest apply returns a moved Inbox source to its recorded context", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const sourceId = "inbox/ingest-source.md";
  const remainingId = "inbox/remaining-note.md";
  const sourceFile = join(E2E_VAULT, sourceId);
  const remainingFile = join(E2E_VAULT, remainingId);
  const sessionToken = await token(page);
  try {
    writeFileSync(sourceFile, "# Ingest source\n\nMove me to RAW.\n");
    writeFileSync(remainingFile, "# Remaining Inbox Note\n\nKeep me open.\n");
    await page.request.post("/api/rescan", {
      headers: { "x-sinapso-token": sessionToken },
    });
    let applied = false;
    await page.route("**/api/wiki-ingest/propose", (route) =>
      route.fulfill({
        json: {
          wiki: { id: "wiki", label: "Test Wiki", path: "wiki" },
          source: "Ingest source",
          title: "Derived note",
          sourceNote: sourceId,
          operations: [
            {
              type: "move",
              path: "raw/ingest-source.md",
              raw: true,
              sourceNote: sourceId,
            },
            {
              type: "create",
              path: "wiki/primary.md",
              content: "# Primary wiki note\n",
            },
          ],
        },
      }),
    );
    await page.route("**/api/wiki-ingest/apply", (route) => {
      applied = true;
      return route.fulfill({
        json: {
          ids: ["wiki/primary.md", "raw/ingest-source.md"],
          primaryId: "wiki/primary.md",
          graphUpdated: true,
        },
      });
    });
    await page.route("**/api/inbox", async (route) => {
      if (!applied) {
        await route.continue();
        return;
      }
      await route.fulfill({
        json: {
          destination: "inbox",
          entries: [
            {
              id: remainingId,
              title: "Remaining Inbox Note",
              modifiedAt: new Date().toISOString(),
              baseHash: "0".repeat(64),
            },
          ],
        },
      });
    });
    await page.route("**/api/graph", async (route) => {
      const response = await route.fetch();
      if (!applied) {
        await route.fulfill({ response });
        return;
      }
      const graph = (await response.json()) as {
        nodes: Array<Record<string, unknown>>;
      };
      await route.fulfill({
        response,
        json: {
          ...graph,
          nodes: [
            ...graph.nodes,
            {
              id: "wiki/primary.md",
              title: "Primary wiki note",
              in: 0,
              out: 0,
            },
          ],
        },
      });
    });
    await page.route("**/api/note?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("id") !== "wiki/primary.md") {
        await route.continue();
        return;
      }
      await route.fulfill({
        json: {
          markdown: "# Primary wiki note\n\nCreated by ingest.\n",
          baseHash: "0".repeat(64),
        },
      });
    });
    await page.route("**/api/note-versions?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("id") !== "wiki/primary.md") {
        await route.continue();
        return;
      }
      await route.fulfill({ json: { versions: [] } });
    });

    await page.addInitScript(() =>
      localStorage.setItem("sinapso-qmd-prompted", "1"),
    );
    await page.goto("/");
    await page.locator("#new-doc-btn").click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page
      .locator(".inbox-list-item", { hasText: "ingest-source" })
      .click();
    await page.locator("#research-save-inbox").click();
    await expect(page.locator("#reader-editor .cm-content")).toContainText(
      "Ingest source",
    );
    const ingest = page.locator("#reader-wiki-top .web-save");
    await expect(ingest).toBeEnabled();
    await ingest.click();
    await page.locator("#workflow-terminal-cards .terminal-card-open").click();
    await page.locator(".wiki-proposal-actions .web-save").first().click();

    await expect(page.locator("#reader-editor .cm-content")).toContainText(
      "Ingest source",
    );
    await expect(page.locator(".inbox-list")).toBeVisible();
    await expect(page.locator("#research .cm-content")).toHaveCount(0);
  } finally {
    rmSync(sourceFile, { force: true });
    rmSync(remainingFile, { force: true });
    await page.request.post("/api/rescan", {
      headers: { "x-sinapso-token": sessionToken },
    });
    await assertCleanBrowser();
  }
});

test("save-to-inbox creates and selects the graph node without a client rescan", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const harness = await installVoiceHarness(page);
    const doc = await createDocument(
      page,
      "Visible After Save Failure",
      "PRESERVED AFTER SAVE content",
    );
    await harness.show(doc.id);
    await expectVisibleQuery(page, "PRESERVED AFTER SAVE content");

    let clientRescans = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/rescan") clientRescans++;
    });

    const saveInbox = page.locator("#research-save-inbox");
    await expect(saveInbox).toBeVisible();
    await saveInbox.click();

    await expect(page.locator("#research-toggle-inbox")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#research .cm-content")).toContainText(
      "PRESERVED AFTER SAVE content",
    );
    await expect(saveInbox).toContainText("Send to other panel");
    await expect(saveInbox).toBeEnabled();
    await expect(page.locator("#research-error")).toHaveClass(/hidden/);
    expect(clientRescans).toBe(0);

    const graph = (await (await page.request.get("/api/graph")).json()) as {
      nodes: Array<{ id: string }>;
    };
    expect(graph.nodes.map((node) => node.id)).toContain(
      "inbox/visible-after-save-failure.md",
    );
    const noteCheck = await page.request.get(
      "/api/note?id=inbox/visible-after-save-failure.md",
    );
    expect(noteCheck.status()).toBe(200);
    const noteBody = (await noteCheck.json()) as { markdown?: string };
    expect(noteBody.markdown).toContain("PRESERVED AFTER SAVE content");
  } finally {
    await assertCleanBrowser();
  }
});

test("save-to-inbox remains usable when the graph payload is unavailable", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const harness = await installVoiceHarness(page);
    const sessionToken = await token(page);
    await page.request.delete("/api/reader-history", {
      headers: { "x-sinapso-token": sessionToken },
    });
    const graph = (await (await page.request.get("/api/graph")).json()) as {
      nodes: Array<{ id: string; phantom?: boolean }>;
    };
    const previousNote = graph.nodes.find(
      (node) =>
        !node.phantom && node.id !== "inbox/visible-when-node-missing.md",
    )?.id;
    expect(previousNote).toBeTruthy();
    await page.evaluate((id) => {
      window.location.hash = new URLSearchParams({ node: id }).toString();
    }, previousNote!);
    await expect(page.locator("#reader-path")).toHaveText(previousNote!);
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/reader-history");
        const body = (await response.json()) as {
          entries: Array<{ id: string }>;
        };
        return body.entries.map((entry) => entry.id);
      })
      .toEqual([previousNote!]);
    const doc = await createDocument(
      page,
      "Visible When Node Missing",
      "PRESERVED WHEN NODE MISSING content",
    );
    await harness.show(doc.id);
    await expectVisibleQuery(page, "PRESERVED WHEN NODE MISSING content");

    await page.route("**/api/research/history/*/save-inbox", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: { ...body, graphUpdated: false, graphRefreshFailed: true },
      });
    });

    await page.locator("#research-save-inbox").click();

    await expect(page.locator("#research-toggle-inbox")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#research .cm-content")).toContainText(
      "PRESERVED WHEN NODE MISSING content",
    );
    await expect(page.locator("#research-error")).toContainText(
      "graph could not refresh",
    );

    const noteCheck = await page.request.get(
      "/api/note?id=inbox/visible-when-node-missing.md",
    );
    expect(noteCheck.status()).toBe(200);

    await page.locator("#research-save-inbox").click();
    await expect(page.locator("#reader-path")).toHaveText(
      "inbox/visible-when-node-missing.md",
    );
    const historyResponse = await page.request.get("/api/reader-history");
    const historyBody = (await historyResponse.json()) as {
      entries: Array<{ id: string }>;
    };
    expect(historyBody.entries.map((entry) => entry.id)).toEqual([
      "inbox/visible-when-node-missing.md",
      previousNote!,
    ]);
    await expect(page.locator("#reader-prev")).toBeEnabled();
    await page.locator("#reader-prev").click();
    await expect(page.locator("#reader-path")).toHaveText(previousNote!);
    await page.locator("#reader-next").click();
    await expect(page.locator("#reader-path")).toHaveText(
      "inbox/visible-when-node-missing.md",
    );
  } finally {
    await assertCleanBrowser();
  }
});

test("R8/R9 Inbox toggle is persistent, aria-pressed toggles, and prev/next navigate Inbox notes without leaving Inbox", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const NOTE_A = "inbox/toggle-nav-a.md";
  const NOTE_B = "inbox/toggle-nav-b.md";
  const fileA = join(E2E_VAULT, NOTE_A);
  const fileB = join(E2E_VAULT, NOTE_B);
  // Clear inbox leftovers from earlier tests so position assertions are stable.
  for (const f of readdirSync(join(E2E_VAULT, "inbox"))) {
    if (f === ".keep.md") continue;
    rmSync(join(E2E_VAULT, "inbox", f), { force: true });
  }
  writeFileSync(fileA, "# Toggle Nav A\n\nFirst Inbox body for toggle nav.\n");
  writeFileSync(fileB, "# Toggle Nav B\n\nSecond Inbox body for toggle nav.\n");
  const now = Date.now();
  utimesSync(fileA, new Date(now - 1_000), new Date(now - 1_000));
  utimesSync(fileB, new Date(now), new Date(now));
  const sessionToken = await token(page);
  await page.request.post("/api/rescan", {
    headers: { "x-sinapso-token": sessionToken },
  });
  try {
    await page.addInitScript(() => {
      localStorage.setItem("sinapso-qmd-prompted", "1");
      localStorage.setItem("sinapso-lang", "en");
    });
    await page.goto("/");
    await expect(page.locator("#brand-stats")).toContainText("notes");

    // Open the research panel via the new-doc flow, then Cancel into the list.
    // The new-doc flow itself activates Inbox, proving the toggle is wired up.
    await page.locator("#new-doc-btn").click();
    await expect(page.locator("#research")).not.toHaveClass(/hidden/);
    await page.getByRole("button", { name: "Cancel" }).click();

    // The toggle is always present in the research header (R9 persistence).
    const toggle = page.locator("#research-toggle-inbox");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(await toggle.evaluate((el) => el.previousElementSibling?.id)).toBe(
      "research-archive",
    );
    await expect(page.locator("#research-archive")).toHaveClass(/hidden/);

    // Trash is research-history-only and must be hidden while Inbox is active.
    await expect(page.locator("#research-trash")).toHaveClass(/hidden/);

    // Toggle off → research history (empty here), then back on → Inbox list.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    // Two Inbox notes are listed; position starts at 0/N (no selection).
    await expect(page.locator("#research-pos")).toHaveText(/\d+\/\d+/);
    const itemA = page
      .locator(".inbox-list-item", { hasText: "toggle-nav-a" })
      .first();
    const itemB = page
      .locator(".inbox-list-item", { hasText: "toggle-nav-b" })
      .first();
    await expect(itemA).toBeVisible();
    await expect(itemB).toBeVisible();

    // Refresh is an icon-only, rightmost toolbar button with a localized
    // tooltip/aria-label and no visible text (replaces the old Review button).
    const refreshBtn = page.locator(".inbox-toolbar .inbox-refresh");
    await expect(refreshBtn).toBeVisible();
    await expect(refreshBtn).toHaveAttribute("aria-label", "Refresh Inbox");
    await expect(refreshBtn).toHaveAttribute("title", "Refresh Inbox");
    await expect(refreshBtn).toHaveText("");
    expect(
      await refreshBtn.evaluate(
        (el) => el === el.parentElement?.lastElementChild,
      ),
    ).toBe(true);
    let inboxRefreshHits = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/inbox") inboxRefreshHits++;
    });
    await refreshBtn.click();
    await expect.poll(() => inboxRefreshHits).toBeGreaterThanOrEqual(1);
    await expect(itemA).toBeVisible();

    // Page 0 → page 1 opens the latest note (B).
    await page.locator("#research-prev").click();
    await expect(page.locator("#research .cm-content")).toContainText(
      "Second Inbox body for toggle nav.",
    );
    await expect(page.locator("#research-pos")).toHaveText(/^1\//);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#research-archive")).toBeVisible();

    // Previous walks to the older note A; next returns to latest B.
    await page.locator("#research-prev").click();
    await expect(page.locator("#research .cm-content")).toContainText(
      "First Inbox body for toggle nav.",
    );
    await expect(page.locator("#research-pos")).toHaveText(/^2\//);
    await page.locator("#research .cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Saved before switching notes.");
    await page.locator("#research-next").click();
    await expect(page.locator("#research .cm-content")).toContainText(
      "Second Inbox body for toggle nav.",
    );
    await expect
      .poll(() => readFileSync(fileA, "utf-8"))
      .toContain("Saved before switching notes.");

    // Next from page 1 returns to the Inbox list at page 0.
    await page.locator("#research-next").click();
    await expect(page.locator(".inbox-list")).toBeVisible();
    await expect(page.locator("#research-pos")).toHaveText(/^0\//);
    await expect(page.locator("#research-archive")).toHaveClass(/hidden/);

    await itemA.click();
    await expect(page.locator("#research .cm-content")).toContainText(
      "First Inbox body for toggle nav.",
    );

    // Archive is note-only, posts the open Inbox path, and returns to the list.
    let archivedId: string | null = null;
    await page.route("**/api/archive", async (route) => {
      archivedId = (route.request().postDataJSON() as { id: string }).id;
      await route.fulfill({
        status: 200,
        json: { ok: true, id: "archive/toggle-nav-a.md" },
      });
    });
    await page.locator("#research-archive").click();
    expect(archivedId).toBe(NOTE_A);
    await expect(page.locator(".inbox-list")).toBeVisible();
    await expect(page.locator("#research-archive")).toHaveClass(/hidden/);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    // Toggling off restores the research side; aria-pressed flips back.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  } finally {
    rmSync(fileA, { force: true });
    rmSync(fileB, { force: true });
    await page.request.post("/api/rescan", {
      headers: { "x-sinapso-token": sessionToken },
    });
    await assertCleanBrowser();
  }
});

test("an Inbox note footer transfers the saved note to the left Notes panel", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  const noteId = "inbox/footer-transfer.md";
  const file = join(E2E_VAULT, noteId);
  const sessionToken = await token(page);
  writeFileSync(file, "# Footer Transfer\n\nOriginal Inbox body.\n");
  await page.request.delete("/api/reader-history", {
    headers: { "x-sinapso-token": sessionToken },
  });
  await page.request.post("/api/rescan", {
    headers: { "x-sinapso-token": sessionToken },
  });
  const graph = (await (await page.request.get("/api/graph")).json()) as {
    nodes: Array<{ id: string; phantom?: boolean }>;
  };
  const previousNote = graph.nodes.find(
    (node) => !node.phantom && node.id !== noteId,
  )?.id;
  expect(previousNote).toBeTruthy();
  try {
    await page.addInitScript(() => {
      localStorage.setItem("sinapso-qmd-prompted", "1");
      localStorage.setItem("sinapso-lang", "en");
    });
    await page.goto(`/#node=${encodeURIComponent(previousNote!)}`);
    await expect(page.locator("#reader-path")).toHaveText(previousNote!, {
      timeout: 15_000,
    });
    await page.locator("#new-doc-btn").click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page
      .locator(".inbox-list-item", { hasText: "footer-transfer" })
      .click();

    const transfer = page.locator("#research-save-inbox");
    await expect(transfer).toBeVisible();
    await expect(transfer).toContainText("Send to other panel");
    const wikiIngest = page.locator("#research-ingest-wiki");
    await expect(wikiIngest).toBeVisible();
    await wikiIngest.click();
    await expect(page.locator("#research-wiki-menu-ingest")).toBeVisible();
    await expect(page.locator("#research-wiki-menu svg")).toHaveCount(0);
    await wikiIngest.click();
    await expect(
      transfer.locator('g[transform="translate(24 0) scale(-1 1)"]'),
    ).toHaveCount(1);
    expect(
      await transfer.evaluate((button) => {
        const parts = Array.from(button.children).map((child) =>
          child.getBoundingClientRect(),
        );
        const bounds = button.getBoundingClientRect();
        const left = Math.min(...parts.map((part) => part.left));
        const right = Math.max(...parts.map((part) => part.right));
        return Math.abs((left + right) / 2 - (bounds.left + bounds.right) / 2);
      }),
    ).toBeLessThanOrEqual(1);

    const editor = page.locator("#research .cm-content");
    await editor.click();
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/notes" &&
        response.request().method() === "PUT" &&
        response.ok(),
    );
    await page.keyboard.press("End");
    await page.keyboard.type(" Saved before transfer.");
    const versionsLoaded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/note-versions" &&
        response.ok(),
    );
    await transfer.click();
    await Promise.all([saved, versionsLoaded]);

    await expect(page.locator("#reader")).not.toHaveClass(/hidden/);
    await expect(page.locator("#reader")).toHaveClass(/ctx-left/);
    await expect(page.locator("#reader .cm-content")).toContainText(
      "Saved before transfer.",
    );
    await expect(page.locator("#reader-path")).toHaveText(noteId);
    await expect
      .poll(() => new URLSearchParams(page.url().split("#")[1]).get("node"))
      .toBe(noteId);
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/reader-history");
        const body = (await response.json()) as {
          entries: Array<{ id: string }>;
        };
        return body.entries.map((entry) => entry.id);
      })
      .toEqual([noteId, previousNote!]);
    await expect(page.locator("#reader-prev")).toBeEnabled();
    await expect(page.locator("#reader-next")).toBeDisabled();
    await expect(page.locator(".inbox-list")).toBeVisible();
    await expect(page.locator("#research-footer")).toHaveClass(/hidden/);
  } finally {
    rmSync(file, { force: true });
    await page.request.post("/api/rescan", {
      headers: { "x-sinapso-token": sessionToken },
    });
    await assertCleanBrowser();
  }
});
