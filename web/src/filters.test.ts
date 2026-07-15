import { describe, it, expect } from "vitest";
import { subsequence, filterFields, compileMatcher } from "./filters";
import type { GNode } from "./types";

const n = (over: Partial<GNode> = {}): GNode => ({
  id: "id",
  title: "",
  pillar: "",
  words: 0,
  in: 0,
  out: 0,
  ...over,
});

// Minimal groupOf for tests: most use pillar. A few pass a custom one to
// verify the group field is wired into the predicate.
const groupByPillar = (g: GNode) => g.pillar;

describe("subsequence", () => {
  it("matches when needle's chars appear in order inside hay", () => {
    expect(subsequence("abc", "axxbyxc")).toBe(true);
  });

  it("returns false when a needle char is missing from hay in order", () => {
    expect(subsequence("abc", "acb")).toBe(false);
  });

  it("returns true for an empty needle (zero chars to match)", () => {
    expect(subsequence("", "anything")).toBe(true);
  });

  it("returns true when needle equals hay exactly", () => {
    expect(subsequence("abc", "abc")).toBe(true);
  });

  it("returns false when hay is empty but needle is not", () => {
    expect(subsequence("a", "")).toBe(false);
  });
});

describe("filterFields", () => {
  it("returns lowercased [title, group, ...tags]", () => {
    const fields = filterFields(
      n({ title: "Biology 101", pillar: "Science", tags: ["#cell", "#RNA"] }),
      groupByPillar,
    );
    expect(fields).toEqual(["biology 101", "science", "#cell", "#rna"]);
  });

  it("treats a missing title as empty string", () => {
    const fields = filterFields(
      n({ title: "", pillar: "Root" }),
      groupByPillar,
    );
    expect(fields[0]).toBe("");
  });

  it("treats a missing group as empty string", () => {
    const fields = filterFields(n({ title: "x", pillar: "" }), () => "");
    expect(fields[1]).toBe("");
  });

  it("treats a missing tags array as empty (does not add undefined)", () => {
    const fields = filterFields(n({ title: "x", pillar: "y" }), groupByPillar);
    expect(fields).toEqual(["x", "y"]);
  });

  it("lowercases every tag regardless of input case", () => {
    const fields = filterFields(
      n({ title: "x", pillar: "y", tags: ["#Mixed", "#UPPER"] }),
      groupByPillar,
    );
    expect(fields.slice(2)).toEqual(["#mixed", "#upper"]);
  });

  it("uses the provided groupOf, not the pillar field", () => {
    const fields = filterFields(
      n({ title: "x", pillar: "Biology" }),
      () => "computed",
    );
    expect(fields[1]).toBe("computed");
  });
});

describe("compileMatcher", () => {
  const mk = (over: Partial<GNode>) => n(over);
  const m = (pattern: string, g: (n: GNode) => string = groupByPillar) =>
    compileMatcher(pattern, g);

  it("returns a predicate that always returns false for empty/whitespace pattern", () => {
    const test = m("   ");
    expect(test(mk({ title: "anything" }))).toBe(false);
  });

  it("plain pattern: case-insensitive substring match against title", () => {
    const test = m("Biology");
    expect(test(mk({ title: "Intro to biology 101" }))).toBe(true);
    expect(test(mk({ title: "Intro to BIO 101" }))).toBe(false);
    expect(test(mk({ title: "Intro to Biology 101" }))).toBe(true);
  });

  it("plain pattern: matches against pillar (group)", () => {
    const test = m("science");
    expect(test(mk({ pillar: "Science" }))).toBe(true);
  });

  it("plain pattern: matches against any tag", () => {
    const test = m("rna");
    expect(test(mk({ tags: ["#cell", "#RNA"] }))).toBe(true);
    expect(test(mk({ tags: ["#dna"] }))).toBe(false);
  });

  it("plain pattern: substring match works on all fields; the fuzzy subsequence fallback is title-only", () => {
    const test = m("cgr");
    // fuzzy subsequence: 'cgr' chars in 'cell growth' (title) -> true
    expect(test(mk({ title: "Cell Growth" }))).toBe(true);
    // substring match on a tag also hits (plain pattern scans every field)
    expect(test(mk({ title: "X", tags: ["#cgr"] }))).toBe(true);
    // the fuzzy subsequence fallback is title-only; 'cgr' against pillar 'zcgzr' (no plain substring) must miss
    expect(test(mk({ title: "X", pillar: "zcgzr" }))).toBe(false);
  });

  it("plain pattern: does NOT apply subsequence fallback when pattern length < 3", () => {
    const test = m("ab");
    expect(test(mk({ title: "axb" }))).toBe(false);
  });

  it("plain pattern: non-matching pattern returns false", () => {
    const test = m("nope");
    expect(test(mk({ title: "yes", pillar: "ok", tags: ["#fine"] }))).toBe(
      false,
    );
  });

  it("plain pattern: matches uppercase pattern against lowercased fields", () => {
    const test = m("BIOLOGY");
    expect(test(mk({ title: "Biology" }))).toBe(true);
  });

  it("plain pattern: matches against the groupOf value, not just the pillar", () => {
    const test = m("cluster-1", () => "cluster-1");
    expect(test(mk({ pillar: "Biology" }))).toBe(true);
  });

  it("wildcard: '*' becomes '.*' (matches any tail)", () => {
    const test = m("mac*");
    expect(test(mk({ title: "macro evolution" }))).toBe(true);
    expect(test(mk({ title: "micro" }))).toBe(false);
  });

  it("wildcard: '?' becomes '.' (matches one char)", () => {
    const test = m("bi?logy");
    expect(test(mk({ title: "biology" }))).toBe(true);
    expect(test(mk({ title: "bialogy" }))).toBe(true);
    expect(test(mk({ title: "biologyy" }))).toBe(false);
  });

  it("wildcard: anchored end-to-end (full string match, not substring)", () => {
    // 'bio*' anchored at both ends matches 'biology' (not just 'bio')
    const test = m("bio*");
    expect(test(mk({ title: "biology" }))).toBe(true);
    expect(test(mk({ title: "bio" }))).toBe(true);
    // does NOT match a string that only contains 'bio' mid-word as a substring
    expect(test(mk({ title: "abio" }))).toBe(false);
  });

  it("wildcard: escapes regex metacharacters so they match literally", () => {
    const test = m("a.b");
    expect(test(mk({ title: "a.b" }))).toBe(true);
    expect(test(mk({ title: "axb" }))).toBe(false);
  });

  it("wildcard: escapes parentheses, plus, dollar, caret, pipe, brackets, backslash", () => {
    const cases: Array<[string, string, boolean]> = [
      ["(a)", "literal (a)", true],
      ["(a)", "literal axa", false],
      ["a+b", "literal a+b", true],
      ["a+b", "literal aab", false],
      ["$10", "the $10 prize", true],
      ["$10", "the 10 prize", false],
      ["^top", "^top of file", true],
      ["^top", "top of file", false],
      ["a|b", "a|b token", true],
      ["a|b", "atb token", false],
      ["[x]", "[x] bucket", true],
      ["[x]", "ax bucket", false],
      ["a\\b", "a\\b file", true],
    ];
    for (const [pat, field, expected] of cases) {
      const test = m(pat);
      expect(test(mk({ title: field })), `${pat} vs ${field}`).toBe(expected);
    }
  });

  it("wildcard: matches against pillar (full field anchored)", () => {
    const test = m("sci*");
    expect(test(mk({ pillar: "Science" }))).toBe(true);
    // tags carry a leading '#', so a wildcard pattern starting at the field
    // start will not match the tag value (which starts with '#')
    expect(test(mk({ tags: ["#scientific"] }))).toBe(false);
  });

  it("wildcard: matches a tag when the pattern accounts for the leading '#'", () => {
    const test = m("#sci*");
    expect(test(mk({ tags: ["#scientific"] }))).toBe(true);
    expect(test(mk({ pillar: "Science" }))).toBe(false);
  });

  it("plain pattern: trims surrounding whitespace before matching", () => {
    const test = m("  biology  ");
    expect(test(mk({ title: "Biology" }))).toBe(true);
  });
});
