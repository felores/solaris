import { describe, expect, it } from "vitest";
import {
  MAX_CONTEXT_WORDS,
  buildKeywordQuery,
  buildSelectionSnapshot,
  buildSemanticQuery,
  clearSelectionSlot,
  emptySelectionState,
  selectionSlot,
  updateSelectionSlot,
} from "./selection-context";

const words = (n: number, prefix = "w") =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

describe("selection context helpers", () => {
  it("ignores empty and whitespace-only text", () => {
    expect(selectionSlot({ source: "reader", text: " \n\t " })).toBeNull();
  });

  it("keeps only the latest selected slot", () => {
    let state = emptySelectionState();
    state = updateSelectionSlot(
      state,
      selectionSlot({
        source: "reader",
        text: "reader text",
        noteId: "notes/a.md",
        noteTitle: "A",
      }),
    );
    state = updateSelectionSlot(
      state,
      selectionSlot({
        source: "research",
        text: "research text",
        entryId: "r1",
        title: "Question",
      }),
    );

    expect(state.current?.source).toBe("research");
    expect(state.current?.text).toBe("research text");

    const next = clearSelectionSlot(state, "reader");
    expect(next.current?.text).toBe("research text");
    expect(clearSelectionSlot(next, "research").current).toBeNull();
  });

  it("caps a long single slot to 300 words", () => {
    const state = updateSelectionSlot(
      emptySelectionState(),
      selectionSlot({ source: "reader", text: words(400) }),
    );
    const snap = buildSelectionSnapshot(state);
    expect(snap.current?.text.split(/\s+/)).toHaveLength(MAX_CONTEXT_WORDS);
    expect(snap.current?.truncated).toBe(true);
    expect(snap.current?.originalWordCount).toBe(400);
  });

  it("caps a long unbroken slot by 3000 characters", () => {
    const text = "x".repeat(4000);
    const state = updateSelectionSlot(
      emptySelectionState(),
      selectionSlot({ source: "reader", text }),
    );
    const snap = buildSelectionSnapshot(state);
    expect(snap.current?.text).toHaveLength(3000);
    expect(snap.current?.truncated).toBe(true);
    expect(snap.current?.originalCharCount).toBe(4000);
  });

  it("replaces a long slot instead of combining contexts", () => {
    let state = emptySelectionState();
    state = updateSelectionSlot(
      state,
      selectionSlot({ source: "reader", text: words(200, "r") }),
    );
    state = updateSelectionSlot(
      state,
      selectionSlot({ source: "research", text: words(200, "s") }),
    );
    const snap = buildSelectionSnapshot(state);

    expect(snap.current?.source).toBe("research");
    expect(snap.current?.text.split(/\s+/)).toHaveLength(200);
    expect(snap.current?.truncated).toBeUndefined();
  });

  it("builds typed semantic and keyword effective queries", () => {
    const state = updateSelectionSlot(
      emptySelectionState(),
      selectionSlot({
        source: "reader",
        text: "selected passage",
        noteId: "notes/a.md",
        noteTitle: "A",
      }),
    );
    const snap = buildSelectionSnapshot(state);

    const semantic = buildSemanticQuery("typed question", snap);
    expect(semantic.startsWith("vec:")).toBe(true);
    expect(semantic).toContain("typed question");
    expect(semantic).toContain("Source: Reader: A");
    expect(semantic).toContain("Note: notes/a.md");
    expect(semantic).toContain("Selected text: selected passage");

    const keyword = buildKeywordQuery("typed question", snap);
    expect(keyword.startsWith("vec:")).toBe(false);
    expect(keyword).toContain("typed question");
  });
});
