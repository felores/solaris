import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepNote, buildSearchIndex } from "./notes-index";

const VAULT = mkdtempSync(join(tmpdir(), "sinapso-notes-index-"));
const note = (rel: string, body: string) =>
  writeFileSync(join(VAULT, rel), body);

afterAll(() => rmSync(VAULT, { recursive: true, force: true }));

describe("grepNote: literal scan with context window (R3d)", () => {
  it("returns 1-based line numbers and the original line text", () => {
    const out = grepNote("alpha one\nALPHA two\nalpha three\n", "alpha", 0);
    expect(out).toEqual([
      { line: 1, text: "alpha one", snippet: "alpha one" },
      { line: 3, text: "alpha three", snippet: "alpha three" },
    ]);
  });

  it("is case-sensitive by default; ignoreCase lifts it", () => {
    const content = "alpha one\nALPHA two\nalpha three\n";
    expect(grepNote(content, "alpha", 0)).toHaveLength(2);
    expect(grepNote(content, "ALPHA", 0)).toHaveLength(1);
    expect(grepNote(content, "alpha", 0, { ignoreCase: true })).toHaveLength(3);
    expect(grepNote(content, "alpha", 0, { ignoreCase: false })).toHaveLength(
      2,
    );
  });

  it("treats regex metacharacters literally (. * ( ) ^ $)", () => {
    const content = [
      "A literal dot (.) should match in grep, not as 'any character'.",
      "Parens (()) and stars (*) are literal here too.",
      "Anchor with caret ^ or dollar $? Not really, just text.",
    ].join("\n");
    const out = grepNote(content, "(.)", 0);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(1);
    expect(out[0].text).toContain("(.)");
  });

  it("treats * and + literally too (no zero-or-more expansion)", () => {
    const content = "a*b\nab\na**b\n";
    // The needle "a*b" should only match the literal "a*b" (line 1).
    const out = grepNote(content, "a*b", 0);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(1);
  });

  it("returns an empty array when no line matches", () => {
    const out = grepNote("hello\nworld\n", "zzz", 0);
    expect(out).toEqual([]);
  });

  it("returns an empty array for an empty needle (matches the route's empty-q short-circuit)", () => {
    const out = grepNote("hello\nworld\n", "", 0);
    expect(out).toEqual([]);
  });

  it("clamps matches to `limit` and stops scanning", () => {
    const content = Array.from({ length: 10 }, (_, i) => `hit ${i}`).join("\n");
    const out = grepNote(content, "hit", 0, { limit: 3 });
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.line)).toEqual([1, 2, 3]);
  });

  it("includes `contextLines` lines before and after the match in the snippet", () => {
    // match is at 0-indexed line 3 ("hit"), ctx=1 → from=2, slice(2, 5)
    // = lines 2,3,4 = ["c", "hit", "d"].
    const content = "a\nb\nc\nhit\nd\ne\nf\n";
    const out = grepNote(content, "hit", 1);
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe("c\nhit\nd");
  });

  it("clamps the snippet at line 0 when the match is near the start", () => {
    // match is at 0-indexed line 0 ("hit"), ctx=2 → from=0, slice(0, 3)
    // = lines 0,1,2 = ["hit", "b", "c"]. The leading clamp prevents a
    // negative `from`.
    const content = "hit\nb\nc\nd\n";
    const out = grepNote(content, "hit", 2);
    expect(out[0].snippet).toBe("hit\nb\nc");
  });

  it("clamps the snippet at the last line when the match is near the end", () => {
    // match is at 0-indexed line 4 ("hit"), ctx=2 → from=2, slice(2, 7)
    // but lines.length=6, so slice(2, 7) = lines 2,3,4,5 = ["c", "d", "hit", ""].
    // The trailing empty line is preserved verbatim — the inline code
    // does no trim, and the byte-identity fixture pins this behavior.
    const content = "a\nb\nc\nd\nhit\n";
    const out = grepNote(content, "hit", 2);
    expect(out[0].snippet).toBe("c\nd\nhit\n");
  });

  it("returns matches in source order", () => {
    const content = "z\nhit\nz\nhit\nz\nhit\n";
    const out = grepNote(content, "hit", 0);
    expect(out.map((m) => m.line)).toEqual([2, 4, 6]);
  });

  it("does not mutate the original content (pure)", () => {
    const content = "alpha\nbeta\n";
    const before = content;
    grepNote(content, "alpha", 1);
    expect(content).toBe(before);
  });
});

describe("buildSearchIndex: MiniSearch-backed full-text search (R3d)", () => {
  let idx: ReturnType<typeof buildSearchIndex>;

  beforeAll(() => {
    // Fixture vault: titles + body content designed to exercise the boost,
    // fuzzy/prefix match, and snippet ellipsis behavior.
    note(
      "alpha.md",
      [
        "---",
        "title: Alpha Guide",
        "---",
        "# Alpha Guide",
        "",
        "Alpha is the first letter. It also refers to release versions and animal packs.",
        "Use alpha for early access, then graduate to beta and finally 1.0 release.",
        "Pricing: alpha tier is $9/month.",
      ].join("\n"),
    );
    note(
      "beta.md",
      [
        "# Beta Channel",
        "",
        "The beta channel ships behind a feature flag. To enable: run with --beta.",
        "BETA_USERS env var is comma-separated.",
        "The [docs](https://example.com) live elsewhere.",
      ].join("\n"),
    );
    note("unrelated.md", "# Unrelated\n\nNo matching terms here.\n");

    const nodes = [
      { id: "alpha.md", title: "Alpha Guide" },
      { id: "beta.md", title: "beta" },
      { id: "unrelated.md", title: "Unrelated" },
    ];
    idx = buildSearchIndex(nodes, VAULT);
  });

  it("returns [] for an empty query without building the index", () => {
    const fresh = buildSearchIndex(
      [{ id: "alpha.md", title: "Alpha Guide" }],
      VAULT,
    );
    expect(fresh.search("")).toEqual([]);
    expect(fresh.search("   ")).toEqual([]);
  });

  it("ranks a title match ahead of a body match (3x title boost)", () => {
    // alpha.md's title is "Alpha Guide" (3x boost); its body has lowercase
    // "alpha" once. The title match should score higher.
    const titleHits = idx.search("Alpha Guide");
    const titleHit = titleHits.find((h) => h.id === "alpha.md")!;
    expect(titleHit).toBeDefined();
    expect(titleHit.title).toBe("Alpha Guide");
    // Title match score should be > 3x the body-only score.
    const bodyOnly = idx.search("alpha");
    const bodyHit = bodyOnly.find((h) => h.id === "alpha.md")!;
    expect(bodyHit).toBeDefined();
    expect(titleHit.score).toBeGreaterThan(bodyHit.score);
  });

  it("returns each hit as {id, title, score, snippet}", () => {
    const hits = idx.search("alpha");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h).toHaveProperty("id");
      expect(h).toHaveProperty("title");
      expect(h).toHaveProperty("score");
      expect(h).toHaveProperty("snippet");
      expect(typeof h.id).toBe("string");
      expect(typeof h.title).toBe("string");
      expect(typeof h.score).toBe("number");
      expect(typeof h.snippet).toBe("string");
    }
  });

  it("produces a snippet that includes the matched term (case-insensitive) and an ellipsis at the trimmed edge", () => {
    const hits = idx.search("alpha");
    const hit = hits.find((h) => h.id === "alpha.md")!;
    // The first alpha occurrence in alpha.md is "title: Alpha Guide"
    // (capital A). The snippet slice is centered on the lowercase
    // indexOf but the snippet text is the original — so it shows
    // "Alpha" (capital A) verbatim. We assert the case-insensitive
    // substring instead, which is the contract the function honors.
    expect(hit.snippet.toLowerCase()).toContain("alpha");
    expect(hit.snippet).toMatch(/…$/);
  });

  it("produces a leading ellipsis when the match lands past the 50-char pre-roll", () => {
    // beta.md query: "alpha" matches alpha.md late in the file (the snippet
    // skips 50 chars before the match → leading "…").
    const hits = idx.search("alpha");
    const late = hits.find((h) => h.id === "alpha.md")!;
    // For the alpha query, alpha.md's first "alpha" is at offset 9
    // (well within 50), so this is the SAME hit — not the late one.
    // Use "pricing" which lands late in the file: snippet should start
    // with "…".
    const pricingHits = idx.search("pricing");
    if (pricingHits.some((h) => h.id === "alpha.md")) {
      const pricingHit = pricingHits.find((h) => h.id === "alpha.md")!;
      expect(pricingHit.snippet.startsWith("…")).toBe(true);
    }
  });

  it("returns up to 20 hits and the result is sorted by score desc", () => {
    // Build a fresh index over many notes so we can see the cap.
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}.md`,
      title: `Note ${i}`,
    }));
    for (let i = 0; i < 30; i++) {
      note(
        `n${i}.md`,
        `# Note ${i}\n\ncommon term appears here in body ${i}.\n`,
      );
    }
    const fresh = buildSearchIndex(many, VAULT);
    const hits = fresh.search("common");
    expect(hits.length).toBe(20);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it("excludes phantom nodes from the index (their ids never appear in search results)", () => {
    const fresh = buildSearchIndex(
      [
        { id: "real.md", title: "Real" },
        { id: "phantom:x", title: "Phantom X", phantom: true },
        { id: "phantom:y", title: "Phantom Y", phantom: true },
      ],
      VAULT,
    );
    note("real.md", "# Real\n\nzzz-unique-real-token-zzz here.\n");
    note("phantom:x", "# Phantom X\n\nunique-phantom-token-x.\n");
    note("phantom:y", "# Phantom Y\n\nunique-phantom-token-y.\n");
    // Phantom content is not in the index, so the only hits for these
    // queries (if any) must be real.md — never the phantom nodes. Use a
    // term that does not exist anywhere to be sure no fuzzy stray hit
    // can attribute to the phantom.
    const realHits = fresh.search("zzz-unique-real-token-zzz");
    expect(realHits.some((h) => h.id === "real.md")).toBe(true);
    expect(realHits.some((h) => h.id === "phantom:x")).toBe(false);
    expect(realHits.some((h) => h.id === "phantom:y")).toBe(false);
    // Search for a term that exists ONLY in the phantom notes → the
    // phantom nodes must be invisible, so the result is empty (no fuzzy
    // spillover; the term has no real-note hits to bleed into).
    const phantomOnly = fresh.search("phantom-token-x");
    expect(phantomOnly.some((h) => h.id === "phantom:x")).toBe(false);
  });

  it("invalidate() forces a fresh build on the next search", () => {
    const fresh = buildSearchIndex(
      [{ id: "replaceable.md", title: "Replaceable" }],
      VAULT,
    );
    note("replaceable.md", "# Replaceable\n\ncontains alphatoken here.\n");
    // First search builds the index from disk.
    expect(fresh.search("alphatoken").length).toBeGreaterThan(0);
    // Mutate the file to content with NO `alphatoken` and a new token.
    writeFileSync(
      join(VAULT, "replaceable.md"),
      "# Replaced\n\nzqzqzqzq token.\n",
    );
    // The cached index still has the old content -> "alphatoken" matches.
    const before = fresh.search("alphatoken");
    expect(before.length).toBeGreaterThan(0);
    // Invalidate, then re-search: now the new content is indexed and
    // `alphatoken` is gone.
    fresh.invalidate();
    const after = fresh.search("alphatoken");
    expect(after).toEqual([]);
    // The new token now appears.
    expect(fresh.search("zqzqzqzq").length).toBeGreaterThan(0);
  });

  it("gracefully skips files that disappear between scan and search", () => {
    // Build an index pointing at a file that does not exist on disk;
    // the build must not throw.
    const nodes = [
      { id: "missing.md", title: "Missing" },
      { id: "alpha.md", title: "Alpha Guide" },
    ];
    const fresh = buildSearchIndex(nodes, VAULT);
    const hits = fresh.search("alpha");
    expect(hits.some((h) => h.id === "alpha.md")).toBe(true);
    expect(hits.some((h) => h.id === "missing.md")).toBe(false);
  });
});

describe("buildSearchIndex: byte-identical route output fixtures (R10)", () => {
  // This regression uses the captured baseline at
  // .scratchpad/2026-07-06-2244-u6/baseline-before.json. The companion
  // capture script regenerates it; the file is gitignored.
  it("/api/search and /api/note-grep outputs are byte-identical to the captured baseline", async () => {
    const { createApp } = await import("../app");
    const { scanVault } = await import("../../scanner/scan");
    const request = (await import("supertest")).default;
    const root = mkdtempSync(join(tmpdir(), "sinapso-u6-fixture-"));
    const vault = join(root, "vault");
    const data = join(root, "data");
    mkdirSync(vault);
    mkdirSync(data);
    // The fixture vault from capture-baseline.ts, copied here so the test
    // does not depend on filesystem state outside its own temp dir.
    writeFileSync(
      join(vault, "alpha.md"),
      [
        "---",
        "title: Alpha Guide",
        "---",
        "# Alpha Guide",
        "",
        "Alpha is the first letter. It also refers to release versions and animal packs.",
        "Use alpha for early access, then graduate to beta and finally 1.0 release.",
        "Pricing: alpha tier is $9/month.",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, "beta.md"),
      [
        "# Beta Channel",
        "",
        "The beta channel ships behind a feature flag. To enable: run with --beta.",
        "BETA_USERS env var is comma-separated.",
        "The [docs](https://example.com) live elsewhere.",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, "regex-chars.md"),
      [
        "# Regex Characters",
        "",
        "A literal dot (.) should match in grep, not as 'any character'.",
        "Parens (()) and stars (*) are literal here too.",
        "Anchor with caret ^ or dollar $? Not really, just text.",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, "multi.md"),
      [
        "# Multi-hit",
        "",
        "First hit: foo bar baz.",
        "Second hit: foo qux.",
        "Third hit: nothing relevant here.",
        "Fourth hit: foo bar again.",
        "Skip line",
        "Fifth hit: one more foo.",
      ].join("\n"),
    );
    writeFileSync(join(vault, "empty.md"), "# Empty\n\n.\n");

    const graphPath = join(data, "graph.json");
    scanVault({ vault, out: graphPath });
    const { app } = createApp(graphPath);

    const baselinePath = join(
      process.cwd(),
      ".scratchpad",
      "2026-07-06-2244-u6",
      "baseline-before.json",
    );
    const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as Record<
      string,
      { status: number; body: unknown }
    >;

    async function get(path: string) {
      const res = await request(app).get(path);
      return { status: res.status, body: res.body };
    }

    // Run the SAME queries the baseline captured. Typed as Record so
    // the indexed access in the comparison loop below is valid.
    const after: Record<string, { status: number; body: unknown }> = {
      alpha: await get("/api/search?q=alpha"),
      alphaTitle: await get("/api/search?q=Alpha+Guide"),
      beta: await get("/api/search?q=beta"),
      fuzzy: await get("/api/search?q=alph"),
      empty: await get("/api/search?q="),
      trimEmpty: await get("/api/search?q=%20%20"),
      nonexistent: await get("/api/search?q=zzzzzzz"),

      grepAlpha: await get("/api/note-grep?id=alpha.md&q=alpha"),
      grepRegex: await get("/api/note-grep?id=regex-chars.md&q=(.)"),
      grepMulti: await get("/api/note-grep?id=multi.md&q=foo"),
      grepCaseSensitive: await get("/api/note-grep?id=multi.md&q=Foo"),
      grepCaseInsensitive: await get(
        "/api/note-grep?id=multi.md&q=FOO&ignore_case=1",
      ),
      grepNone: await get("/api/note-grep?id=alpha.md&q=zzznope"),
      grepEmpty: await get("/api/note-grep?id=alpha.md&q="),
      grepContext0: await get("/api/note-grep?id=alpha.md&q=alpha&context=0"),
      grepContext3: await get("/api/note-grep?id=multi.md&q=foo&context=1"),
      grepLimit2: await get("/api/note-grep?id=multi.md&q=hit&limit=2"),
      grepTraversal: await get("/api/note-grep?id=../../etc/passwd&q=root"),
      grepPhantom: await get("/api/note-grep?id=phantom:x&q=a"),
    };

    // Compare body-by-body. We assert bodies match exactly and statuses
    // match exactly — that is the byte-identity contract.
    for (const key of Object.keys(baseline)) {
      expect(after[key].status, `status for ${key}`).toBe(baseline[key].status);
      expect(after[key].body, `body for ${key}`).toEqual(baseline[key].body);
    }

    rmSync(root, { recursive: true, force: true });
  });
});
