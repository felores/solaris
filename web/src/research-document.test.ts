import { describe, expect, it, vi } from "vitest";
import {
  createResearchDocument,
  createResearchDocumentController,
  type ResearchDocument,
  type ResearchDocumentTransport,
} from "./research-document";

function harness(overrides: Partial<ResearchDocumentTransport> = {}) {
  let content = "one";
  let title = "Draft";
  const setDocument = vi.fn((doc: ResearchDocument) => {
    content = doc.content;
    title = doc.title;
  });
  const transport: ResearchDocumentTransport = {
    create: vi.fn(async (nextTitle, nextContent) => ({ id: "doc-1", title: nextTitle, content: nextContent, revision: "r1" })),
    read: vi.fn(async () => ({ id: "doc-1", title: "Remote", content: "remote", revision: "r3" })),
    save: vi.fn(async () => ({ revision: "r2" })),
    promote: vi.fn(async () => ({ noteId: "saved.md" })),
    ...overrides,
  };
  const states: string[] = [];
  const controller = createResearchDocumentController({
    document: { id: "doc-1", title, content, revision: "r1" },
    getContent: () => content,
    getTitle: () => title,
    setDocument,
    transport,
    onState: (state) => states.push(state),
    debounceMs: 60_000,
  });
  return {
    controller,
    transport,
    states,
    setContent(value: string) { content = value; controller.autosave.notifyChange(); },
  };
}

describe("research document state", () => {
  it("creates without an id and persists edits with the current revision", async () => {
    const h = harness();
    await expect(createResearchDocument(h.transport, "New", "")).resolves.toMatchObject({ id: "doc-1", revision: "r1" });
    expect(h.transport.create).toHaveBeenCalledWith("New", "");
    h.setContent("two");
    await h.controller.autosave.flush();
    expect(h.transport.save).toHaveBeenCalledWith({ id: "doc-1", title: "Draft", content: "two", revision: "r1" });
    expect(h.controller.document().revision).toBe("r2");
  });

  it("reloads authoritative content and revision", async () => {
    const h = harness();
    h.setContent("local");
    await h.controller.reload();
    expect(h.controller.document()).toEqual({ id: "doc-1", title: "Remote", content: "remote", revision: "r3" });
    expect(h.states.at(-1)).toBe("clean");
  });

  it("preserves local edits on a stale conflict", async () => {
    const h = harness({ save: vi.fn(async () => { throw { status: 409 }; }) });
    h.setContent("local survives");
    await h.controller.autosave.flush();
    expect(h.controller.document().content).toBe("local survives");
    expect(h.controller.autosave.state()).toBe("conflict");
  });

  it("remains editable and retries after a failed save", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ revision: "r2" });
    const h = harness({ save });
    h.setContent("first");
    await h.controller.autosave.flush();
    expect(h.controller.autosave.state()).toBe("error");
    h.setContent("retry content");
    await h.controller.retry();
    expect(h.controller.autosave.state()).toBe("clean");
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ content: "retry content", revision: "r1" }));
  });

  it("promotes only clean saved content and returns the note for cleanup", async () => {
    const h = harness();
    h.setContent("promoted");
    await expect(h.controller.promote()).resolves.toEqual({ noteId: "saved.md" });
    expect(h.transport.promote).toHaveBeenCalledWith(expect.objectContaining({ content: "promoted", revision: "r2" }));
  });
});
