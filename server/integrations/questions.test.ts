/**
 * Note-questions module (U5, R3c). Pure prompt assembly, JSON-array
 * reply parsing, and the orchestrator that calls the LLM and falls
 * back to the template path on any failure.
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildNoteQuestionsPrompt,
  parseQuestionsReply,
  noteQuestionsViaLLM,
} from "./questions";
import type { ChatMessage } from "./openrouter";

describe("buildNoteQuestionsPrompt", () => {
  it("includes the note title, excerpt, and phantom-hint line when phantoms are present", () => {
    const prompt = buildNoteQuestionsPrompt(
      { title: "My Note" },
      "excerpt body",
      ["Zettelkasten", "Inbox"],
    );
    expect(prompt).toContain("Note title: My Note");
    expect(prompt).toContain("Note content (excerpt):\nexcerpt body");
    expect(prompt).toContain(
      "The note references these topics that have no note of their own yet: Zettelkasten, Inbox.",
    );
  });

  it("omits the phantom-hint line when no phantom titles are present", () => {
    const prompt = buildNoteQuestionsPrompt(
      { title: "My Note" },
      "excerpt body",
      [],
    );
    expect(prompt).not.toContain("have no note of their own yet");
  });

  it("preserves the three instructional lines (focus, language, JSON-only reply)", () => {
    const prompt = buildNoteQuestionsPrompt({ title: "x" }, "y", []);
    expect(prompt).toContain(
      "Generate 3-5 web-research questions that would close the knowledge gaps",
    );
    expect(prompt).toContain("Focus on what is missing");
    expect(prompt).toContain("same language as the note content");
    expect(prompt).toContain("ONLY a JSON array of question strings");
  });

  it("falls back to an empty title string when the note is undefined", () => {
    const prompt = buildNoteQuestionsPrompt(undefined, "body", []);
    expect(prompt).toContain("Note title: \n");
  });
});

describe("parseQuestionsReply", () => {
  it("passes a clean JSON array through unchanged", () => {
    expect(parseQuestionsReply('["q1?", "q2?", "q3?"]')).toEqual([
      "q1?",
      "q2?",
      "q3?",
    ]);
  });

  it("extracts an array wrapped in prose (first [ to last ])", () => {
    expect(
      parseQuestionsReply('Here you go:\n["q1?", "q2?"]\nThanks!'),
    ).toEqual(["q1?", "q2?"]);
  });

  it("extracts an array wrapped in a fenced code block (first [ to last ])", () => {
    expect(parseQuestionsReply('```json\n["q1?", "q2?"]\n```')).toEqual([
      "q1?",
      "q2?",
    ]);
  });

  it("caps the result at 5 questions", () => {
    expect(parseQuestionsReply('["q1","q2","q3","q4","q5","q6","q7"]')).toEqual(
      ["q1", "q2", "q3", "q4", "q5"],
    );
  });

  it("filters out non-string and empty-string items", () => {
    expect(parseQuestionsReply('["q1?", 2, "", "q3?", null]')).toEqual([
      "q1?",
      "q3?",
    ]);
  });

  it("returns null when there is no array delimiter", () => {
    expect(parseQuestionsReply("just a prose response, no array")).toBeNull();
  });

  it("returns null when the brackets are mismatched (open without close)", () => {
    expect(parseQuestionsReply("[1, 2, 3")).toBeNull();
  });

  it("returns null on malformed JSON inside the brackets", () => {
    expect(parseQuestionsReply("[q1, q2, q3")).toBeNull();
  });

  it("returns null when the array is empty after filtering", () => {
    expect(parseQuestionsReply('[1, 2, null, ""]')).toBeNull();
  });
});

describe("noteQuestionsViaLLM", () => {
  it("returns source:llm with the parsed questions on a successful reply", async () => {
    const chat = vi.fn(async () => '["what is X?", "why Y?"]');
    const result = await noteQuestionsViaLLM({
      chat,
      note: { title: "T" },
      excerpt: "body",
      phantomTitles: [],
      templates: () => ["tpl"],
    });
    expect(result).toEqual({
      questions: ["what is X?", "why Y?"],
      source: "llm",
    });
    expect(chat).toHaveBeenCalledOnce();
    const messages = (chat.mock.calls[0] as unknown as [ChatMessage[]])[0];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(
      "You generate concise web-research questions",
    );
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("Note title: T");
    expect(messages[1].content).toContain("Note content (excerpt):\nbody");
  });

  it("returns source:templates and calls warn when the LLM throws", async () => {
    const chat = vi.fn(async () => {
      throw new Error("HTTP 502");
    });
    const warn = vi.fn();
    const result = await noteQuestionsViaLLM({
      chat,
      note: { title: "T" },
      excerpt: "body",
      phantomTitles: [],
      templates: () => ["tpl1", "tpl2"],
      warn,
    });
    expect(result).toEqual({
      questions: ["tpl1", "tpl2"],
      source: "templates",
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain(
      "llm questions fell back to templates",
    );
  });

  it("returns source:templates and calls warn when the LLM returns garbage", async () => {
    const chat = vi.fn(async () => "no JSON at all here");
    const warn = vi.fn();
    const result = await noteQuestionsViaLLM({
      chat,
      note: { title: "T" },
      excerpt: "body",
      phantomTitles: [],
      templates: () => ["tpl"],
      warn,
    });
    expect(result).toEqual({ questions: ["tpl"], source: "templates" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns source:templates when the LLM returns unparseable JSON", async () => {
    const chat = vi.fn(async () => "[not valid json");
    const warn = vi.fn();
    const result = await noteQuestionsViaLLM({
      chat,
      note: { title: "T" },
      excerpt: "body",
      phantomTitles: [],
      templates: () => ["tpl"],
      warn,
    });
    expect(result.source).toBe("templates");
    expect(result.questions).toEqual(["tpl"]);
  });

  it("returns source:templates when the parsed array has no string items", async () => {
    const chat = vi.fn(async () => "[1, 2, null]");
    const warn = vi.fn();
    const result = await noteQuestionsViaLLM({
      chat,
      note: { title: "T" },
      excerpt: "body",
      phantomTitles: [],
      templates: () => ["tpl"],
      warn,
    });
    expect(result.source).toBe("templates");
  });

  it("embeds phantom titles in the user prompt when present", async () => {
    const chat = vi.fn(async () => '["q?"]');
    await noteQuestionsViaLLM({
      chat,
      note: { title: "T" },
      excerpt: "body",
      phantomTitles: ["Phantom A", "Phantom B"],
      templates: () => [],
    });
    const messages = (chat.mock.calls[0] as unknown as [ChatMessage[]])[0];
    expect(messages[1].content).toContain(
      "The note references these topics that have no note of their own yet: Phantom A, Phantom B.",
    );
  });

  it("omits the phantom-hint line in the user prompt when no phantoms are present", async () => {
    const chat = vi.fn(async () => '["q?"]');
    await noteQuestionsViaLLM({
      chat,
      note: { title: "T" },
      excerpt: "body",
      phantomTitles: [],
      templates: () => [],
    });
    const messages = (chat.mock.calls[0] as unknown as [ChatMessage[]])[0];
    expect(messages[1].content).not.toContain("have no note of their own yet");
  });

  it("does not call templates() on the llm-success path (no wasted template compute)", async () => {
    const chat = vi.fn(async () => '["q1?"]');
    const templates = vi.fn(() => ["tpl"]);
    const result = await noteQuestionsViaLLM({
      chat,
      note: { title: "T" },
      excerpt: "body",
      phantomTitles: [],
      templates,
    });
    expect(result.source).toBe("llm");
    expect(templates).not.toHaveBeenCalled();
  });
});
