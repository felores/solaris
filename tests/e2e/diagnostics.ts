import { expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type BrowserDiagnostic = {
  kind: "console" | "pageerror" | "requestfailed" | "response";
  message: string;
  url?: string;
  status?: number;
  body?: string;
};

export function redactDiagnosticText(text: string, limit = Infinity) {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .slice(0, limit);
}

export function captureBrowserDiagnostics(
  page: Page,
  testInfo: TestInfo,
  options: { allow?: (entry: BrowserDiagnostic) => boolean } = {},
) {
  const entries: BrowserDiagnostic[] = [];
  const pending: Promise<void>[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    entries.push({
      kind: "console",
      message: redactDiagnosticText(message.text()),
      url: redactDiagnosticText(location.url),
    });
  });

  page.on("pageerror", (error) => {
    entries.push({
      kind: "pageerror",
      message: redactDiagnosticText(error.stack || error.message),
    });
  });

  page.on("requestfailed", (request) => {
    entries.push({
      kind: "requestfailed",
      message: redactDiagnosticText(
        request.failure()?.errorText || "request failed",
      ),
      url: redactDiagnosticText(request.url()),
    });
  });

  page.on("response", (response) => {
    if (response.status() < 500) return;
    const entry: BrowserDiagnostic = {
      kind: "response",
      message: redactDiagnosticText(response.statusText()),
      status: response.status(),
      url: redactDiagnosticText(response.url()),
    };
    entries.push(entry);
    pending.push(
      response
        .text()
        .then((body) => {
          entry.body = redactDiagnosticText(body, 4096);
        })
        .catch(() => undefined),
    );
  });

  return async () => {
    await Promise.all(pending);
    const failures = browserDiagnosticFailures(entries, options.allow);
    const diagnostics = {
      test: testInfo.title,
      entries,
      failures,
    };
    const body = JSON.stringify(diagnostics, null, 2);
    const perTestFile = testInfo.outputPath("browser-diagnostics.json");
    const latestFile = join(
      process.cwd(),
      "test-results",
      "browser-diagnostics.json",
    );
    mkdirSync(dirname(perTestFile), { recursive: true });
    mkdirSync(dirname(latestFile), { recursive: true });
    writeFileSync(perTestFile, body);
    writeFileSync(latestFile, body);
    await testInfo.attach("browser-diagnostics", {
      body,
      contentType: "application/json",
    });
    expect(failures, "browser console/network diagnostics").toEqual([]);
  };
}

export function browserDiagnosticFailures(
  entries: BrowserDiagnostic[],
  allow?: (entry: BrowserDiagnostic) => boolean,
) {
  return entries.filter((entry) => !allow?.(entry));
}
