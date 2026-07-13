import { describe, expect, it } from "vitest";
import {
  clearStaleResearchPin,
  decideAgentResearchDisplay,
} from "./research-state.js";

const base = {
  targetId: "B",
  visibleId: "A",
  pinnedId: null,
  hasUnsavedLocalEdits: false,
  targetExists: true,
};

describe("decideAgentResearchDisplay", () => {
  it("keeps pinned A visible when an agent opens B", () => {
    expect(decideAgentResearchDisplay({ ...base, pinnedId: "A" })).toBe(
      "blocked-pinned",
    );
  });

  it("allows a clean same-id refresh", () => {
    expect(
      decideAgentResearchDisplay({
        ...base,
        targetId: "A",
        visibleId: "A",
        pinnedId: "A",
      }),
    ).toBe("shown");
  });

  it("preserves a dirty same-id working document", () => {
    expect(
      decideAgentResearchDisplay({
        ...base,
        targetId: "A",
        visibleId: "A",
        pinnedId: "A",
        hasUnsavedLocalEdits: true,
      }),
    ).toBe("blocked-dirty");
  });

  it("allows an unpinned agent open", () => {
    expect(decideAgentResearchDisplay(base)).toBe("shown");
  });
});

describe("clearStaleResearchPin", () => {
  it("clears a pin removed by reload, deletion, or promotion", () => {
    expect(clearStaleResearchPin("A", ["B"])).toBeNull();
  });

  it("retains a pin while user navigation changes the visible entry", () => {
    expect(clearStaleResearchPin("A", ["B", "A"])).toBe("A");
  });
});
