import { describe, expect, it } from "vitest";
import {
  browserDiagnosticFailures,
  redactDiagnosticText,
  type BrowserDiagnostic,
} from "./e2e/diagnostics";

describe("browserDiagnosticFailures", () => {
  it("keeps unallowlisted diagnostics and drops allowlisted ones", () => {
    const entries: BrowserDiagnostic[] = [
      { kind: "console", message: "boom" },
      {
        kind: "response",
        message: "expected dev 500",
        status: 500,
        url: "/allowed",
      },
    ];

    expect(
      browserDiagnosticFailures(entries, (entry) => entry.url === "/allowed"),
    ).toEqual([{ kind: "console", message: "boom" }]);
  });
});

describe("redactDiagnosticText", () => {
  it("redacts bearer, API key, token, and sk values", () => {
    const text =
      "Bearer abc.def api_key=secret token: token-value authorization='Basic secret' sk-abcdefgh12345678";

    expect(redactDiagnosticText(text)).toBe(
      "Bearer [REDACTED] api_key=[REDACTED] token: [REDACTED] authorization=[REDACTED] [REDACTED]",
    );
  });

  it("truncates redacted text to 4096 characters", () => {
    expect(redactDiagnosticText("x".repeat(5000), 4096)).toHaveLength(4096);
  });
});
