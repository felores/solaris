import { expect, test } from "@playwright/test";
import { captureBrowserDiagnostics } from "./diagnostics";

type Graph = {
  nodes: Array<{ id: string; title: string; phantom?: boolean }>;
};

test("loads Sinapso shell", async ({ page }) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    await page.goto("/");
    await expect(page).toHaveTitle(/Sinapso/);
    await expect(page.locator("#graph")).toBeAttached();
    await expect(page.locator("#research-selection-assist")).toBeHidden();
  } finally {
    await assertCleanBrowser();
  }
});

test("keeps local tools in Tools and opens providers in Settings", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    await page.goto("/");
    // The integrations source lives inside the Settings modal and is hidden
    // until the modal opens (no cards, no wide grid).
    await expect(page.locator("#admin-integrations-source")).toBeHidden();
    await expect(page.locator(".admin-integration-card")).toHaveCount(0);

    // Tools menu keeps only the local integrations (markitdown, qmd) + re-check.
    const toolsMenu = page
      .locator(".menu")
      .filter({ has: page.locator("#mi-integrations") });
    await toolsMenu.locator(".menu-label").click();
    await expect(toolsMenu.locator("#integ-markitdown")).toBeVisible();
    await expect(toolsMenu.locator("#integ-qmd")).toBeVisible();
    await expect(toolsMenu.locator("#admin-git")).toHaveCount(1);
    await expect(toolsMenu.locator("#mi-rescan")).toBeVisible();
    await expect(toolsMenu.locator("#mi-export")).toBeVisible();
    await expect(toolsMenu.locator("#mi-reload")).toBeVisible();
    await expect(toolsMenu.locator("#integ-exa")).toHaveCount(0);
    await expect(toolsMenu.locator("#integ-openrouter")).toHaveCount(0);
    await expect(toolsMenu.locator("#integ-voice")).toHaveCount(0);

    // Settings modal: title, restored narrow width, vertical sections after
    // Wikis, no card chrome, agent rows, voice three-column row.
    const fileMenu = page.locator(".menu").first();
    await expect(
      fileMenu.locator("#mi-rescan, #mi-export, #mi-reload"),
    ).toHaveCount(0);
    await fileMenu.locator(".menu-label").hover();
    await expect(fileMenu.locator("#mi-admin")).toBeVisible();
    await page.locator("#mi-admin").click();
    await expect(page.locator("#modal-title")).toHaveText("Settings");
    await expect(page.locator("#admin-integrations-source")).toBeVisible();
    await expect(page.locator("#admin-integrations #admin-git")).toHaveCount(0);
    await expect(page.locator("#modal")).toHaveCSS("width", /^(\d+)px$/);
    const width = await page
      .locator("#modal")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(521);
    await expect(page.locator(".set-section")).toHaveCount(5);
    await expect(page.locator("#web-search-fetch-provider")).toBeVisible();
    await expect(
      page.locator("#admin-integrations .set-section").first(),
    ).toBeVisible();
    await expect(page.locator("#set-provider-select")).toBeVisible();
    await expect(page.locator("#set-provider-key")).toBeVisible();
    await expect(page.locator(".set-provider-cap")).toHaveCount(3);
    await expect(page.locator(".set-model-status")).toHaveCount(2);
    await expect(page.locator("#set-voice-status")).toBeVisible();
    await expect(page.locator(".set-model-row")).toHaveCount(2);
    await expect(page.locator(".set-effort-select")).toHaveCount(0);
    await expect(page.locator("#worker-model-select")).toBeVisible();
    await expect(page.locator("#thinker-model-select")).toBeVisible();
    await expect(page.locator("#web-provider-select")).toBeVisible();
    await expect(page.locator(".set-voice-row .voice-col")).toHaveCount(3);
    await expect(page.locator("#voice-provider-select")).toBeVisible();
    await expect(page.locator("#voice-model-select")).toBeVisible();
    await expect(page.locator("#voice-name-select")).toBeVisible();
    await expect(page.locator(".admin-prompt-path")).toHaveCount(4);
    await expect(page.locator(".admin-prompt-file-enabled")).toHaveCount(4);

    // Reopening preserves the controls (close + reopen via the config button).
    await page.locator("#modal-close").click();
    await page.locator("#config-btn").click();
    await expect(page.locator("#set-provider-select")).toBeVisible();
    await expect(page.locator(".set-model-row")).toHaveCount(2);
    await expect(page.locator("#voice-name-select")).toBeVisible();
    await expect(page.locator("#web-provider-select")).toBeVisible();
  } finally {
    await assertCleanBrowser();
  }
});

test("configured Tinyfish renders connected status and green key guidance", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  await page.route("**/api/integrations", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...body,
        tools: {
          ...(body.tools as Record<string, unknown>),
          tinyfish: { configured: true },
        },
        webSearch: { provider: "tinyfish", configured: true },
        webFetch: { provider: "tinyfish", configured: true },
      },
    });
  });
  try {
    await page.goto("/");
    const fileMenu = page.locator(".menu").first();
    await fileMenu.locator(".menu-label").click();
    await page.locator("#mi-admin").click();

    const status = page.locator("#set-web-search-fetch-status");
    const key = page.locator("#tinyfish-key");
    await expect(status).toHaveText("connected");
    await expect(status).toHaveClass(/connected/);
    await expect(key).toHaveClass(/configured/);
    await expect(key).toHaveAttribute(
      "placeholder",
      "key configured ✓ — paste another + Enter to replace",
    );
    const [statusColor, placeholderColor] = await Promise.all([
      status.evaluate((el) => getComputedStyle(el).color),
      key.evaluate((el) => getComputedStyle(el, "::placeholder").color),
    ]);
    expect(placeholderColor).toBe(statusColor);
  } finally {
    await assertCleanBrowser();
  }
});

test("mobile rail exposes menus and panels above the bottom bar", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("sinapso-lang", "es"));
    await page.goto("/");

    const topbar = page.locator("#topbar");
    await expect(topbar).toHaveClass(/topbar-rail/);
    await topbar.evaluate((el) => el.classList.add("menu-center"));
    const rail = page.locator("#topbar-rail");
    await expect(rail.locator(".rail-icon")).toHaveCount(10);

    const config = rail.locator('[data-target="config-btn"]');
    await config.hover();
    await expect(page.locator("#tooltip")).toHaveText("Configuración");

    const barTop = await page
      .locator("#search-wrap")
      .evaluate((el) => el.getBoundingClientRect().top);
    for (const button of await rail.locator('[data-rail="menu"]').all()) {
      await button.click();
      const idx = await button.getAttribute("data-idx");
      const dropdown = page
        .locator(".menu")
        .nth(Number(idx))
        .locator(".dropdown");
      await expect(dropdown).toBeVisible();
      expect(
        await dropdown.evaluate((el) => el.getBoundingClientRect().bottom),
      ).toBeLessThanOrEqual(barTop);
      const [buttonBox, dropdownBox] = await Promise.all([
        button.boundingBox(),
        dropdown.boundingBox(),
      ]);
      expect(buttonBox).not.toBeNull();
      expect(dropdownBox).not.toBeNull();
      const expectedLeft = Math.max(
        8,
        Math.min(
          buttonBox!.x + buttonBox!.width / 2 - dropdownBox!.width / 2,
          390 - dropdownBox!.width - 8,
        ),
      );
      expect(Math.abs(dropdownBox!.x - expectedLeft)).toBeLessThanOrEqual(2);
      expect(
        await dropdown.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (
            document
              .elementFromPoint(r.left + 8, r.top + 8)
              ?.closest(".dropdown") === el
          );
        }),
      ).toBe(true);
    }

    await rail.locator('[data-idx="2"]').click();
    await page.locator("#mi-filters").click();
    await expect(page.locator("#filters")).toBeVisible();
    expect(
      await page
        .locator("#filters")
        .evaluate((el) => el.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(barTop);
    expect(
      await page.locator("#filters").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          document
            .elementFromPoint(r.left + 8, r.top + 8)
            ?.closest("#filters") === el
        );
      }),
    ).toBe(true);

    await rail.locator('[data-target="settings-btn"]').click();
    await expect(page.locator("#settings")).toBeVisible();
    expect(
      await page
        .locator("#settings")
        .evaluate((el) => el.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(barTop);
    expect(
      await page.locator("#settings").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          document
            .elementFromPoint(r.right - 8, r.top + 8)
            ?.closest("#settings") === el
        );
      }),
    ).toBe(true);
  } finally {
    await assertCleanBrowser();
  }
});

test("LAN-style HTTP boot and side toggles work without crypto.randomUUID", async ({
  page,
}) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    await page.addInitScript(() => {
      localStorage.setItem("sinapso-qmd-prompted", "1");
      Object.defineProperty(Crypto.prototype, "randomUUID", {
        configurable: true,
        value: undefined,
      });
    });
    const session = (await (await page.request.get("/api/session")).json()) as {
      token: string;
    };
    await page.request.delete("/api/reader-history", {
      headers: { "x-sinapso-token": session.token },
    });
    await page.goto("/?node=alpha-note.md");
    await expect(page.locator("#graph canvas")).toBeVisible();
    await expect(page.locator("#reader")).not.toHaveClass(/hidden/, {
      timeout: 15_000,
    });
    await expect(page.locator("#reader-next")).toBeDisabled();

    await page.keyboard.press("a");
    await expect(page.locator("#reader")).toHaveClass(/hidden/);
    await page.keyboard.press("a");
    await expect(page.locator("#reader")).not.toHaveClass(/hidden/);
    await expect(page.locator("#reader")).toHaveClass(/ctx-left/);
    await expect(page.locator("#research")).toHaveClass(/hidden/);
    await page
      .locator("#reader-dock")
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("#reader")).toHaveClass(/floating/);
    await page.locator("#reopen-content").click();
    await expect(page.locator("#reader")).toHaveClass(/hidden/);

    await page.locator("#new-doc-btn").click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#research")).not.toHaveClass(/hidden/);
    await page.keyboard.press("d");
    await expect(page.locator("#research")).toHaveClass(/hidden/);
    await expect(page.locator("#reader")).toHaveClass(/hidden/);
    await page.keyboard.press("d");
    await expect(page.locator("#research")).not.toHaveClass(/hidden/);
    await expect(page.locator("#reader")).toHaveClass(/hidden/);
  } finally {
    await assertCleanBrowser();
  }
});

test("recovers when the backend is unavailable during initial LAN boot", async ({
  page,
}) => {
  let graphRequests = 0;
  await page.route("**/api/graph", async (route) => {
    graphRequests += 1;
    if (graphRequests === 1) {
      await route.fulfill({ status: 503, body: "backend starting" });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await expect(page.locator("#graph canvas")).toBeVisible({ timeout: 15_000 });
  expect(graphRequests).toBeGreaterThanOrEqual(2);
});

test("opens a node from the URL", async ({ page }) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const graph = (await (
      await page.request.get("/api/graph")
    ).json()) as Graph;
    const node = graph.nodes.find((n) => !n.phantom);
    if (!node) {
      test.skip(true, "graph has no real nodes");
      return;
    }

    await page.goto(`/?node=${encodeURIComponent(node.id)}`);
    await expect(page.locator("#reader")).not.toHaveClass(/hidden/, {
      timeout: 15_000,
    });
    await expect(page.locator("#reader-path")).toHaveText(node.id);
  } finally {
    await assertCleanBrowser();
  }
});

test("opens a node from the hash URL", async ({ page }) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const graph = (await (
      await page.request.get("/api/graph")
    ).json()) as Graph;
    const node = graph.nodes.find((n) => !n.phantom);
    if (!node) {
      test.skip(true, "graph has no real nodes");
      return;
    }

    await page.goto(`/#node=${encodeURIComponent(node.id)}`);
    await expect(page.locator("#reader")).not.toHaveClass(/hidden/, {
      timeout: 15_000,
    });
    await expect(page.locator("#reader-path")).toHaveText(node.id);
  } finally {
    await assertCleanBrowser();
  }
});

test("writes selected node to the URL", async ({ page }) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const graph = (await (
      await page.request.get("/api/graph")
    ).json()) as Graph;
    const node = graph.nodes.find((n) => !n.phantom);
    if (!node) {
      test.skip(true, "graph has no real nodes");
      return;
    }

    // A fresh vault triggers the qmd onboarding prompt, which overlays the
    // search results; mark it answered so the click isn't intercepted.
    await page.addInitScript(() =>
      localStorage.setItem("sinapso-qmd-prompted", "1"),
    );
    await page.goto("/");
    await page.locator("#search").fill(node.title);
    await page.locator("#search-results .result").first().click();

    await expect(page.locator("#reader")).not.toHaveClass(/hidden/);
    const selectedId = await page.locator("#reader-path").textContent();
    await expect
      .poll(() =>
        new URLSearchParams(new URL(page.url()).hash.slice(1)).get("node"),
      )
      .toBe(selectedId);
    expect(new URL(page.url()).searchParams.has("node")).toBe(false);
    expect(new URL(page.url()).searchParams.has("focus")).toBe(false);
  } finally {
    await assertCleanBrowser();
  }
});

test("hash node changes do not reload the app", async ({ page }) => {
  const assertCleanBrowser = captureBrowserDiagnostics(page, test.info());
  try {
    const graph = (await (
      await page.request.get("/api/graph")
    ).json()) as Graph;
    const nodes = graph.nodes.filter((n) => !n.phantom).slice(0, 2);
    if (nodes.length < 2) {
      test.skip(true, "graph has fewer than two real nodes");
      return;
    }

    await page.goto(`/#node=${encodeURIComponent(nodes[0].id)}`);
    await expect(page.locator("#reader-path")).toHaveText(nodes[0].id, {
      timeout: 15_000,
    });
    await page.evaluate(() => {
      (
        window as unknown as { __sinapsoReloadProbe: string }
      ).__sinapsoReloadProbe = "alive";
    });
    const next = new URL(page.url());
    next.hash = `node=${encodeURIComponent(nodes[1].id)}`;
    await page.evaluate((url) => {
      window.location.href = url;
    }, next.toString());

    await expect(page.locator("#reader-path")).toHaveText(nodes[1].id);
    const token = (await (await page.request.get("/api/session")).json()) as {
      token: string;
    };
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/current-view", {
          headers: { "x-sinapso-token": token.token },
        });
        const view = (await response.json()) as {
          view?: { readerNoteId?: string };
        };
        return view.view?.readerNoteId;
      })
      .toBe(nodes[1].id);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __sinapsoReloadProbe?: string })
              .__sinapsoReloadProbe,
        ),
      )
      .toBe("alive");
  } finally {
    await assertCleanBrowser();
  }
});
