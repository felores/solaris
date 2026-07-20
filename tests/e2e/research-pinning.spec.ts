import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

async function installVoiceHarness(page: Page) {
  let socket: WebSocketRoute | undefined;
  let includeLongEntry = false;

  await page.route("**/api/integrations", async (route) => {
    const response = await route.fetch();
    const body: IntegrationsResponse = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
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
    if (!includeLongEntry || route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body: HistoryResponse = await response.json();
    await route.fulfill({
      response,
      json: { entries: [syntheticLongEntry, ...body.entries] },
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

test("pinning coordinates agent opens, refreshes, conflicts, unpin, and user navigation", async ({
  page,
}) => {
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
    await expect(page.locator("#activity-cards .ac-ready")).toContainText(
      "new agent result is ready in the background",
    );
    await expect(page.locator("#activity-cards .ac-ready")).toContainText(
      "current result is pinned",
    );

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
    await expect(page.locator(".research-document-save-state")).toHaveClass(
      /save-conflict/,
    );
    await page.locator("#research-banner-primary").click();
    await expect(page.locator("#research-banner")).toHaveClass(/hidden/);
    await expect(page.locator(".research-document-save-state")).toHaveClass(
      /save-clean/,
    );
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
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    // The new-doc button lives inside the research panel header. Open the
    // research panel via the voice-action harness (mirrors the prior test's
    // setup), then click the now-visible new-doc button.
    const harness = await installVoiceHarness(page);
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
    await page.locator(".inbox-create-row button.primary").click();
    const editor = page.locator("#research .cm-content");
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await editor.click();
    await page.keyboard.type("Browser-authored durable body.");
    // Autosave flushes through PUT /api/notes (baseHash CAS).
    await expect(page.locator("#research-vault-save-state")).toHaveText(
      "saved",
      {
        timeout: 10_000,
      },
    );
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
    const snippet = page.locator(".rel-snippet", {
      hasText: "Visible snippet line 1",
    });
    await expect(snippet).toBeVisible();
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

test("activity card host is anchored opposite the search bar", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    await page.goto("/");
    const host = page.locator("#activity-cards");
    await expect(host).toBeAttached();
    // Empty stack -> host renders nothing but stays in the DOM.
    await expect(host).toBeEmpty();
    // Desktop default: search bar on top -> cards anchored at the bottom.
    await expect(host).toHaveClass(/ac-bottom/);
    await expect(host).not.toHaveClass(/ac-top/);
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
    // the document visible and surface a non-blocking error activity card.
    const ingestTrigger = page.locator("#research-ingest-wiki");
    await expect(ingestTrigger).toBeVisible();
    await ingestTrigger.click();
    const menuIngest = page.locator("#research-wiki-menu-ingest");
    await expect(menuIngest).toBeVisible();
    await menuIngest.click();

    // An error activity card appears (role=alert), and it is dismissable.
    const errorCard = page.locator("#activity-cards .ac-card.ac-error", {
      hasText: "Try again",
    });
    await expect(errorCard).toBeVisible({ timeout: 15_000 });
    await expect(errorCard).toHaveAttribute("role", "alert");

    // Frente B core contract: the visible document is NOT cleared.
    await expectVisibleQuery(page, "PRESERVED DURING WIKI INGEST");

    // Dismiss the card (not hover-only) -> stack empties.
    await errorCard.locator(".ac-dismiss").click();
    await expect(page.locator("#activity-cards")).toBeEmpty();
  } finally {
    await assertCleanBrowser();
  }
});

test("save-to-inbox opens the durable note without depending on rescan", async ({
  page,
}) => {
  // RM001: Inbox membership and opening are graph-independent. A broken
  // rescan must be irrelevant to evidence promotion.
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info(), {
    // The intentional /api/rescan 500 is the point of the test; the route
    // helper only flags HTTP >=500, so allow this URL explicitly.
    allow: (entry) =>
      (entry.kind === "response" || entry.kind === "console") &&
      /\/api\/rescan/.test(entry.url ?? ""),
  });
  try {
    const harness = await installVoiceHarness(page);
    const doc = await createDocument(
      page,
      "Visible After Save Failure",
      "PRESERVED AFTER SAVE content",
    );
    await harness.show(doc.id);
    await expectVisibleQuery(page, "PRESERVED AFTER SAVE content");

    // Force the next /api/rescan to 500 so openAfterIngest reports failure.
    await page.route("**/api/rescan", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "rescan failed" }),
      }),
    );

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
    await expect(page.locator("#research-error")).toHaveClass(/hidden/);

    // And the server really did save the note (the panel was preserved only
    // because the rescan failed, not because the save did). safeName()
    // slugifies the title "Visible After Save Failure" to this path.
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

test("save-to-inbox opens a catalog-only note absent from the graph", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const harness = await installVoiceHarness(page);
    const doc = await createDocument(
      page,
      "Visible When Node Missing",
      "PRESERVED WHEN NODE MISSING content",
    );
    await harness.show(doc.id);
    await expectVisibleQuery(page, "PRESERVED WHEN NODE MISSING content");

    const staleGraph = await (await page.request.get("/api/graph")).json();
    await page.route("**/api/rescan", (route) =>
      route.fulfill({ status: 200, json: { ok: true, graph: staleGraph } }),
    );

    await page.locator("#research-save-inbox").click();

    await expect(page.locator("#research-toggle-inbox")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#research .cm-content")).toContainText(
      "PRESERVED WHEN NODE MISSING content",
    );

    const noteCheck = await page.request.get(
      "/api/note?id=inbox/visible-when-node-missing.md",
    );
    expect(noteCheck.status()).toBe(200);
  } finally {
    await assertCleanBrowser();
  }
});

test("R8/R9 Inbox toggle is persistent, aria-pressed toggles, and prev/next navigate Inbox notes without leaving Inbox", async ({
  page,
}) => {
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

    // Open NOTE_A directly; cursor lands on it, still in Inbox.
    await itemA.click();
    await expect(page.locator("#research .cm-content")).toContainText(
      "First Inbox body for toggle nav.",
    );
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#research-archive")).toBeVisible();

    // Walk the active collection via the nav until NOTE_B is shown. Each prev
    // click must stay inside Inbox (no research swap, no leaving the panel).
    for (let i = 0; i < 10; i++) {
      const bodyNow = await page.locator("#research .cm-content").textContent();
      if (bodyNow && bodyNow.includes("Second Inbox body for toggle nav.")) {
        break;
      }
      await page.locator("#research-prev").click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
    }
    await expect(page.locator("#research .cm-content")).toContainText(
      "Second Inbox body for toggle nav.",
    );

    // Next walks back. Still in Inbox.
    for (let i = 0; i < 10; i++) {
      const bodyNow = await page.locator("#research .cm-content").textContent();
      if (bodyNow && bodyNow.includes("First Inbox body for toggle nav.")) {
        break;
      }
      await page.locator("#research-next").click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
    }
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
