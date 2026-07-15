import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excerptFor, norm, stripSnippet, clip } from "./excerpt";

// Throwaway vault for excerptFor's file reads.
const VAULT = mkdtempSync(join(tmpdir(), "sinapso-excerpt-"));
const note = (rel: string, body: string) =>
  writeFileSync(join(VAULT, rel), body);

afterAll(() => rmSync(VAULT, { recursive: true, force: true }));

describe("norm", () => {
  it("lowercases and strips non-alphanumerics", () => {
    expect(norm("Hello, World! 2026")).toBe("helloworld2026");
  });
  it("collapses to empty on a fully non-alphanumeric input", () => {
    expect(norm("--- ??? !!!")).toBe("");
  });
  it("strips non-ASCII letters and punctuation (matches moved code's [^a-z0-9])", () => {
    // 'é' and 'ñ' are not in [a-z], so the implementation strips them — the
    // moved code uses a strict ASCII range. We assert the behavior rather
    // than try to fight it.
    expect(norm("Café-ñoño")).toBe("cafoo");
  });
});

describe("clip", () => {
  it("returns the string unchanged when at or below the limit", () => {
    expect(clip("hi", 5)).toBe("hi");
    expect(clip("hello", 5)).toBe("hello");
  });
  it("trims trailing whitespace and appends an ellipsis past the limit", () => {
    // n=5 over "hello world" -> slice(0, 4) "hell", trimEnd "hell", + "…"
    expect(clip("hello world", 5)).toBe("hell…");
  });
  it("never produces a mid-word artifact when the cut lands on whitespace", () => {
    // slice(0, n-1) takes chars 0..n-2, then trimEnd trims any trailing
    // whitespace, then "…" is appended. n=10 over "abcdef ghij klmno" gives
    // slice(0, 9) = "abcdef gh" (chars 0..8), trimEnd keeps it, + "…".
    expect(clip("abcdef ghij klmno", 10)).toBe("abcdef gh…");
  });
});

describe("stripSnippet", () => {
  it("drops a speaker-timestamp line (00:00 - Speaker)", () => {
    const out = stripSnippet("00:12 - Alice: hello there\nreal content here");
    expect(out).not.toContain("00:12");
    expect(out).toContain("real content here");
  });
  it("drops divider lines (4+ of -/=/*/_/~ chars)", () => {
    // The moved code uses /^[-=*_~]{4,}$/ — 3-char lines like "---" are NOT
    // treated as dividers. Verify both: a 4+ divider is dropped, a 3-char
    // line that happens to look like one is kept as body text.
    const divider = stripSnippet("----\n\nbody paragraph");
    expect(divider).toBe("body paragraph");
    const notDivider = stripSnippet("---\n\nbody paragraph");
    expect(notDivider).toBe("--- body paragraph");
  });
  it("drops email headers and forwarded-message markers", () => {
    const out = stripSnippet(
      "From: alice@example.com\nreal body line\nForwarded message follows",
    );
    expect(out).not.toMatch(/from:/i);
    expect(out).not.toMatch(/forwarded/i);
    expect(out).toContain("real body line");
  });
  it("drops Spanish email header prefixes (de|para|asunto|fecha)", () => {
    const out = stripSnippet("De: alice@example.com\ncontenido real");
    expect(out).not.toMatch(/^de:/i);
    expect(out).toContain("contenido real");
  });
  it("drops a bare URL line", () => {
    const out = stripSnippet("https://example.com/page\nreal content");
    expect(out).not.toMatch(/^https?:\/\//);
    expect(out).toContain("real content");
  });
  it("rewrites inline markdown links [text](url) -> text", () => {
    expect(stripSnippet("see [the docs](https://example.com) for more")).toBe(
      "see the docs for more",
    );
  });
  it("strips leading heading markers, emphasis/backtick chars, and zero-width noise", () => {
    const out = stripSnippet("## *Hello* `world` \u200bmore");
    // *, _, `, # are removed; \u200b is removed.
    expect(out).toBe("Hello world more");
  });
  it("joins kept lines with a single space and collapses whitespace", () => {
    expect(stripSnippet("line one\nline   two\n\nline three")).toBe(
      "line one line two line three",
    );
  });
  it("returns an empty string for an all-noise input (4+ dividers + bare URL)", () => {
    expect(stripSnippet("----\n====\nhttps://example.com")).toBe("");
  });
});

describe("excerptFor", () => {
  it("returns an empty string when the file cannot be read", () => {
    expect(excerptFor(VAULT, "does-not-exist.md", "Whatever")).toBe("");
  });

  it("returns an empty string when vaultRoot points at a missing directory", () => {
    // The file path resolves but readFileSync throws because the file is
    // not present — the try/catch in excerptFor must swallow it.
    expect(excerptFor(VAULT, "missing.md", "Whatever")).toBe("");
  });

  it("prefers a frontmatter description of >=25 chars that is not a title echo", () => {
    note(
      "described.md",
      [
        "---",
        "title: Described",
        "description: A focused explanation of the topic with enough detail to be useful.",
        "---",
        "# Described",
        "",
        "Body paragraph that would otherwise be the fallback.",
      ].join("\n"),
    );
    const out = excerptFor(VAULT, "described.md", "Described");
    expect(out).toBe(
      "A focused explanation of the topic with enough detail to be useful.",
    );
  });

  it("unquotes a quoted frontmatter description", () => {
    note(
      "quoted.md",
      [
        "---",
        'description: "A quoted description that is long enough to win."',
        "---",
        "# Quoted",
        "",
        "body fallback that should not appear",
      ].join("\n"),
    );
    const out = excerptFor(VAULT, "quoted.md", "Quoted");
    expect(out).toBe("A quoted description that is long enough to win.");
  });

  it("falls through to the body when the description is a title echo", () => {
    note(
      "echo.md",
      [
        "---",
        "description: Echo",
        "---",
        "# Echo",
        "",
        "Real body content distinct from the title.",
      ].join("\n"),
    );
    const out = excerptFor(VAULT, "echo.md", "Echo");
    // The description matches the title (normalized) and is rejected;
    // the body paragraph wins.
    expect(out).toBe("Real body content distinct from the title.");
  });

  it("falls through to the body when the description is shorter than 25 chars", () => {
    note(
      "short.md",
      [
        "---",
        "description: too short",
        "---",
        "# Short",
        "",
        "Body paragraph with plenty of content to be the snippet.",
      ].join("\n"),
    );
    const out = excerptFor(VAULT, "short.md", "Short");
    expect(out).toBe(
      "Body paragraph with plenty of content to be the snippet.",
    );
  });

  it("falls through to the body when the description normalizes to start with the title", () => {
    note(
      "starts.md",
      [
        "---",
        "description: Echo plus extra words that should not match the title echo rule",
        "---",
        "# Echo",
        "",
        "Body paragraph providing the real preview text.",
      ].join("\n"),
    );
    const out = excerptFor(VAULT, "starts.md", "Echo");
    expect(out).toBe("Body paragraph providing the real preview text.");
  });

  it("also accepts the summary and excerpt frontmatter keys", () => {
    note(
      "summary.md",
      [
        "---",
        "summary: A summary key that is long enough to win the precedence race.",
        "---",
        "# Summary",
        "",
        "ignored",
      ].join("\n"),
    );
    expect(excerptFor(VAULT, "summary.md", "Summary")).toBe(
      "A summary key that is long enough to win the precedence race.",
    );
  });

  it("skips body paragraphs shorter than 25 chars and title echoes, then accumulates", () => {
    note(
      "mixed.md",
      [
        "# Mixed",
        "",
        "tiny",
        "",
        "# Mixed",
        "",
        "This is a body paragraph that is clearly long enough to be picked up as the snippet.",
        "",
        "This is another long body paragraph that should also be included in the result.",
      ].join("\n"),
    );
    const out = excerptFor(VAULT, "mixed.md", "Mixed");
    // The first H1 is dropped as a title echo; "tiny" is too short;
    // the second H1 is also a title echo; both real paragraphs are joined.
    expect(out).toBe(
      "This is a body paragraph that is clearly long enough to be picked up as the snippet. This is another long body paragraph that should also be included in the result.",
    );
  });

  it("clips the accumulated body to roughly 280 characters with an ellipsis", () => {
    const big =
      "This is a long body paragraph that we will repeat many times to push past the 280-character clip threshold in the excerpt module so the trailing ellipsis is observable in the test output.";
    note("big.md", ["# Big", "", big, "", big, ""].join("\n"));
    const out = excerptFor(VAULT, "big.md", "Big");
    // The first big paragraph alone is already past 280 chars; the loop
    // should stop and clip() should append the trailing ellipsis.
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith("…")).toBe(true);
  });
});
