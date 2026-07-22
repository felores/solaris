// @vitest-environment jsdom
// U1 round-trip gate: the editor must never change bytes it wasn't asked to
// change. These fixtures are the release gate for the KTD2 editor choice.
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ensureSyntaxTree } from "@codemirror/language";
import { undo } from "@codemirror/commands";
import {
  acceptCompletion,
  closeCompletion,
  completionKeymap,
  completionStatus,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  createNoteEditor,
  detectEol,
  fromLf,
  frontmatterEnd,
  livePreviewPlugin,
  toLf,
  type NoteEditor,
  type WikiLinkCandidate,
} from "./editor.js";

// jsdom has no layout; CodeMirror probes Range rects during measure cycles.
const zeroRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};
if (!Range.prototype.getClientRects || process.env.VITEST) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => zeroRect as DOMRect;
}

const fixturesDir = resolve(process.cwd(), "web/src/editor-fixtures") + "/";
const stylePath = resolve(process.cwd(), "web/src/style.css");
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith(".md"));

function mount(
  content: string,
  opts: Parameters<typeof createNoteEditor>[1] extends infer O
    ? Partial<O>
    : never = {},
): NoteEditor {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return createNoteEditor(host, { content, ...opts });
}

describe("line endings", () => {
  it("detects dominant EOL", () => {
    expect(detectEol("a\nb\nc\n")).toBe("\n");
    expect(detectEol("a\r\nb\r\nc\r\n")).toBe("\r\n");
    expect(detectEol("")).toBe("\n");
  });

  it("round-trips through toLf/fromLf", () => {
    const crlf = "a\r\nb\r\n";
    expect(fromLf(toLf(crlf), "\r\n")).toBe(crlf);
  });
});

describe("frontmatterEnd", () => {
  it("finds the closing fence", () => {
    const text = "---\ntitle: x\n---\nbody\n";
    expect(text.slice(0, frontmatterEnd(text))).toBe("---\ntitle: x\n---");
  });

  it("returns 0 without frontmatter", () => {
    expect(frontmatterEnd("# just a note\n")).toBe(0);
    expect(frontmatterEnd("--- not a fence\n")).toBe(0);
  });
});

describe("round-trip gate (byte-for-byte)", () => {
  for (const name of fixtures) {
    it(`preserves ${name} exactly`, () => {
      const original = readFileSync(fixturesDir + name, "utf8");
      const ed = mount(original);
      expect(ed.getContent()).toBe(original);
      ed.destroy();
    });
  }
});

describe("frontmatter protection (KTD3)", () => {
  const original = readFileSync(fixturesDir + "frontmatter.md", "utf8");
  const fmBlock =
    "---\ntitle: Test Note\ntype: concept\ntags:\n  - alpha\n  - beta\n---\n";

  it("select-all-retype replaces the body, frontmatter survives byte-identical", () => {
    const ed = mount(original);
    ed.view.dispatch({
      changes: {
        from: 0,
        to: ed.view.state.doc.length,
        insert: "replaced body",
      },
    });
    const out = ed.getContent();
    expect(out.startsWith(fmBlock)).toBe(true);
    expect(out).toContain("replaced body");
    expect(out).not.toContain("Body paragraph");
    ed.destroy();
  });

  it("allows frontmatter edits after explicit expansion", () => {
    const ed = mount(original);
    expect(ed.isFrontmatterExpanded()).toBe(false);
    ed.expandFrontmatter(true);
    expect(ed.isFrontmatterExpanded()).toBe(true);
    ed.view.dispatch({ changes: { from: 4, to: 9, insert: "name" } });
    expect(ed.getContent().startsWith("---\nname:")).toBe(true);
    ed.destroy();
  });

  it("collapses frontmatter without rendering a placeholder row", () => {
    const ed = mount(original);
    expect(document.querySelector(".cm-frontmatter-fold")).toBeNull();
    ed.expandFrontmatter(true);
    expect(ed.getContent()).toBe(original);
    ed.destroy();
  });

  it("expand/collapse alone never changes content", () => {
    const ed = mount(original);
    ed.expandFrontmatter(true);
    ed.expandFrontmatter(false);
    expect(ed.getContent()).toBe(original);
    ed.destroy();
  });
});

describe("live preview", () => {
  it("typing '# ' at line start produces an ATX heading node", () => {
    const ed = mount("hello\n");
    ed.view.dispatch({ changes: { from: 0, insert: "# " } });
    const tree = ensureSyntaxTree(
      ed.view.state,
      ed.view.state.doc.length,
      2000,
    );
    expect(tree).toBeTruthy();
    let found = false;
    tree!.iterate({
      enter: (n) => {
        if (n.name === "ATXHeading1") found = true;
      },
    });
    expect(found).toBe(true);
    ed.destroy();
  });

  it("hides heading marks when the cursor is elsewhere, reveals on the line", () => {
    const ed = mount("# Head\n\nbody text\n");
    const lastPos = ed.view.state.doc.length - 1;
    ensureSyntaxTree(ed.view.state, ed.view.state.doc.length, 2000);
    // Cursor on the body line: the "# " mark should be hidden (replace deco).
    ed.view.dispatch({ selection: { anchor: lastPos } });
    const plugin = ed.view.plugin(livePreviewPlugin);
    expect(plugin).toBeTruthy();
    let hiddenWhileAway = 0;
    plugin!.decorations.between(0, 6, () => {
      hiddenWhileAway++;
    });
    expect(hiddenWhileAway).toBeGreaterThan(0);
    // Cursor on the heading line: marks reveal (no replace deco over the mark).
    ed.view.dispatch({ selection: { anchor: 2 } });
    let hiddenOnLine = 0;
    ed.view.plugin(livePreviewPlugin)!.decorations.between(0, 6, () => {
      hiddenOnLine++;
    });
    expect(hiddenOnLine).toBe(0);
    ed.destroy();
  });
});

describe("wiki links", () => {
  const content = readFileSync(fixturesDir + "wikilinks.md", "utf8");

  it("renders widgets and fires the click callback with the target", () => {
    const onWikiLinkClick = vi.fn();
    const ed = mount(content, { onWikiLinkClick });
    const widgets = ed.view.dom.querySelectorAll(".cm-wikilink");
    expect(widgets.length).toBe(2);
    (widgets[0] as HTMLElement).click();
    expect(onWikiLinkClick).toHaveBeenCalledWith("Other Note");
    (widgets[1] as HTMLElement).click();
    expect(onWikiLinkClick).toHaveBeenCalledWith("folder/deep note");
    // Aliased link shows its alias, not the target.
    expect((widgets[1] as HTMLElement).textContent).toBe("the alias");
    ed.destroy();
  });

  it("keeps clicks on wiki and external links out of editing", () => {
    const onWikiLinkClick = vi.fn();
    const ed = mount(
      "See [[Other Note]] and [website](https://example.com)\n",
      {
        onWikiLinkClick,
      },
    );
    const wiki = ed.view.dom.querySelector<HTMLElement>(".cm-wikilink")!;
    const external = ed.view.dom.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com"]',
    )!;

    wiki.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    wiki.click();

    expect(onWikiLinkClick).toHaveBeenCalledWith("Other Note");
    expect(ed.view.state.selection.main.head).toBe(0);
    expect(external.textContent).toBe("website");
    expect(external.target).toBe("_blank");
    expect(external.rel).toBe("noopener noreferrer");
    ed.destroy();
  });

  it("renders bare and wiki-form HTTPS URLs as external links", () => {
    const ed = mount(
      "[labeled](https://example.com/labeled) https://example.com/bare [[https://example.com/wiki]]\n",
    );
    ed.view.dispatch({ selection: { anchor: ed.view.state.doc.length } });
    const links = [
      ...ed.view.dom.querySelectorAll<HTMLAnchorElement>("a.cm-md-link"),
    ];

    expect(links.map((link) => link.href)).toEqual([
      "https://example.com/labeled",
      "https://example.com/bare",
      "https://example.com/wiki",
    ]);
    const cursor = ed.view.state.selection.main.head;
    links[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(ed.view.state.selection.main.head).toBe(cursor);
    ed.destroy();
  });

  it("routes vault-relative Markdown links through the note callback", () => {
    const onMarkdownLinkClick = vi.fn();
    const ed = mount("See [source](../raw/source.md)\n", {
      onMarkdownLinkClick,
    });
    ed.view.dispatch({ selection: { anchor: ed.view.state.doc.length } });
    const link = ed.view.dom.querySelector<HTMLAnchorElement>("a.cm-md-link")!;
    expect(link.textContent).toBe("source");
    expect(link.target).toBe("");
    link.click();
    expect(onMarkdownLinkClick).toHaveBeenCalledWith("../raw/source.md");
    ed.destroy();
  });

  it("shows raw syntax when the cursor is inside the link", () => {
    const ed = mount(content);
    const pos = content.indexOf("[[Other Note]]") + 4;
    ed.view.dispatch({ selection: { anchor: pos } });
    const widgets = ed.view.dom.querySelectorAll(".cm-wikilink");
    expect(widgets.length).toBe(1); // the second link stays a widget
    expect(
      ed.view.dom.querySelectorAll(".cm-wikilink-raw").length,
    ).toBeGreaterThan(0);
    ed.destroy();
  });
});

describe("editor chrome CSS", () => {
  it("keeps CodeMirror widget buffers out of generic note image styling", () => {
    const css = readFileSync(stylePath, "utf8");
    expect(css).toContain("#reader-editor img.cm-widgetBuffer");
    expect(css.indexOf("#reader-editor img.cm-widgetBuffer")).toBeGreaterThan(
      css.indexOf("#reader-body img"),
    );
  });
});

describe("lifecycle", () => {
  it("destroy detaches; remount leaves a single editor", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const a = createNoteEditor(host, { content: "one\n" });
    a.destroy();
    const b = createNoteEditor(host, { content: "two\n" });
    expect(host.querySelectorAll(".cm-editor").length).toBe(1);
    b.destroy();
    expect(host.querySelectorAll(".cm-editor").length).toBe(0);
  });

  it("setContent swaps notes and re-detects line endings", () => {
    const ed = mount("a\nb\n");
    const crlf = readFileSync(fixturesDir + "crlf.md", "utf8");
    ed.setContent(crlf);
    expect(ed.getContent()).toBe(crlf);
    ed.destroy();
  });

  it("read-only blocks edits and can be toggled", () => {
    const ed = mount("locked\n", { readOnly: true });
    ed.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(ed.getContent()).toBe("locked\n");
    ed.setReadOnly(false);
    ed.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(ed.getContent()).toBe("xlocked\n");
    ed.destroy();
  });

  it("onChange fires on doc changes only", () => {
    const onChange = vi.fn();
    const ed = mount("text\n", { onChange });
    ed.view.dispatch({ selection: { anchor: 2 } });
    expect(onChange).not.toHaveBeenCalled();
    ed.view.dispatch({ changes: { from: 0, insert: "y" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    ed.destroy();
  });
});

describe("block previews (tables + code blocks)", () => {
  const tableMd = readFileSync(fixturesDir + "table.md", "utf8");

  it("renders a table widget when the cursor is outside, raw when inside", () => {
    const ed = mount(tableMd);
    const widget = ed.view.dom.querySelector(".cm-md-table");
    expect(widget).toBeTruthy();
    expect(widget!.querySelectorAll("th").length).toBe(3);
    expect(widget!.querySelectorAll("td").length).toBe(6);
    // Move the cursor into the table: the widget yields to raw source.
    const pos = ed.view.state.doc.toString().indexOf("| alpha");
    ed.view.dispatch({ selection: { anchor: pos + 2 } });
    expect(ed.view.dom.querySelector(".cm-md-table")).toBeNull();
    ed.destroy();
  });

  it("table widget click callback places the cursor at the table", () => {
    const ed = mount(tableMd);
    const widget = ed.view.dom.querySelector<HTMLElement>(".cm-md-table")!;
    widget.click();
    const tableStart = ed.view.state.doc.toString().indexOf("| name");
    expect(ed.view.state.selection.main.from).toBe(tableStart);
    ed.destroy();
  });

  it("renders each code block as its own widget until entered", () => {
    const code = readFileSync(fixturesDir + "codefence.md", "utf8");
    const ed = mount(code);
    const widget = ed.view.dom.querySelector<HTMLElement>(".cm-md-codeblock")!;
    expect(widget).toBeTruthy();
    expect(widget.querySelector("code")!.textContent).toContain(
      "const x: number = 1;",
    );
    expect(widget.dataset.language).toBe("ts");
    widget.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const lines = ed.view.dom.querySelectorAll(".cm-codeblock-line");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(ed.view.dom.querySelector(".cm-codeblock-fence-dim")).toBeNull();
    ed.destroy();
  });

  it("renders untyped fenced blocks without inline-code chips", () => {
    const ed = mount("before\n\n```\nline one\nline two\n```\n");
    const widget = ed.view.dom.querySelector<HTMLElement>(".cm-md-codeblock")!;
    expect(widget.dataset.language).toBeUndefined();
    expect(widget.querySelector("code")!.textContent).toBe(
      "line one\nline two\n",
    );
    expect(widget.querySelector(".cm-inline-code")).toBeNull();
    ed.destroy();
  });

  it("table notes still round-trip byte-for-byte with the widget active", () => {
    const ed = mount(tableMd);
    expect(ed.view.dom.querySelector(".cm-md-table")).toBeTruthy();
    expect(ed.getContent()).toBe(tableMd);
    ed.destroy();
  });
});

// Plan 023: wikilink autocomplete. Source activation, insertion, and
// rejection rules; native keymap and filtering are exercised end-to-end in
// Playwright.
describe("wikilink autocomplete", () => {
  const candidates: WikiLinkCandidate[] = [
    { target: "team/a/brief", label: "Brief (A)" },
    { target: "team/b/brief", label: "Brief (B)" },
    { target: "welcome", label: "Welcome" },
  ];

  // autocompletion closes the popup on blur and debounces source queries
  // (~50ms). Focus + start, then wait for the source to settle. Re-focus
  // after the wait because jsdom can lose focus between awaits.
  async function startAndSettle(view: NoteEditor["view"]): Promise<void> {
    view.focus();
    startCompletion(view);
    await new Promise((r) => setTimeout(r, 120));
    view.focus();
  }

  function mountWiki(
    content: string,
    opts: Partial<Parameters<typeof createNoteEditor>[1]> = {},
  ): NoteEditor {
    return mount(content, {
      getWikiLinkCandidates: () => candidates,
      ...opts,
    });
  }

  function cursorAfter(view: NoteEditor["view"], text: string) {
    const pos = view.state.doc.toString().indexOf(text) + text.length;
    view.dispatch({ selection: { anchor: pos } });
  }

  it("opens immediately at an unclosed [[cad", async () => {
    const ed = mountWiki("body [[");
    cursorAfter(ed.view, "[[");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBe("active");
    const comps = currentCompletions(ed.view.state);
    expect(comps.map((c) => c.label)).toEqual([
      "Brief (A)",
      "Brief (B)",
      "Welcome",
    ]);
    ed.destroy();
  });

  it("inserts exact path target, one closing pair, cursor after ]]", async () => {
    const ed = mountWiki("body [[");
    cursorAfter(ed.view, "[[");
    await startAndSettle(ed.view);
    // Drive the completion's apply function directly. In the real browser the
    // acceptCompletion command does the same thing; in jsdom focus/timing
    // make the public command flaky, and Playwright proves the integration.
    const comps = currentCompletions(ed.view.state);
    expect(comps.length).toBe(3);
    const first = comps[0];
    const from = ed.view.state.doc.toString().indexOf("[[") + 2;
    (
      first.apply as (
        v: NoteEditor["view"],
        c: typeof first,
        f: number,
        t: number,
      ) => void
    )(ed.view, first, from, from);
    expect(ed.getContent()).toBe("body [[team/a/brief]]");
    expect(ed.view.state.selection.main.head).toBe(
      ed.view.state.doc.toString().length,
    );
    ed.destroy();
  });

  it("accepts the selected completion immediately after it opens", async () => {
    const ed = mountWiki("body [[wel");
    cursorAfter(ed.view, "[[wel");
    ed.view.focus();
    startCompletion(ed.view);
    // The source settles after about 50ms. Accept before CM's former 75ms
    // interaction delay would expire, matching a fast Enter in the UI.
    await new Promise((r) => setTimeout(r, 110));
    expect(completionStatus(ed.view.state)).toBe("active");
    expect(acceptCompletion(ed.view)).toBe(true);
    expect(ed.getContent()).toBe("body [[welcome]]");
    ed.destroy();
  });

  it("replaces the typed query, not just appends", async () => {
    const ed = mountWiki("body [[wel");
    cursorAfter(ed.view, "[[wel");
    await startAndSettle(ed.view);
    const comps = currentCompletions(ed.view.state);
    // Source returned 3 candidates; native fuzzy filter narrowed to Welcome.
    expect(comps.length).toBe(1);
    expect(comps[0].label).toBe("Welcome");
    const first = comps[0];
    const from = ed.view.state.doc.toString().indexOf("[[") + 2;
    (
      first.apply as (
        v: NoteEditor["view"],
        c: typeof first,
        f: number,
        t: number,
      ) => void
    )(ed.view, first, from, ed.view.state.selection.main.head);
    expect(ed.getContent()).toBe("body [[welcome]]");
    ed.destroy();
  });

  it("keeps completion valid while typing spaces in note titles", async () => {
    const ed = mountWiki("body [[Brief ");
    cursorAfter(ed.view, "[[Brief ");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBe("active");
    expect(currentCompletions(ed.view.state)).toHaveLength(2);
    ed.destroy();
  });

  it("one undo restores the pre-acceptance source", async () => {
    const ed = mountWiki("body [[wel");
    cursorAfter(ed.view, "[[wel");
    await startAndSettle(ed.view);
    const comps = currentCompletions(ed.view.state);
    const first = comps[0];
    const from = ed.view.state.doc.toString().indexOf("[[") + 2;
    (
      first.apply as (
        v: NoteEditor["view"],
        c: typeof first,
        f: number,
        t: number,
      ) => void
    )(ed.view, first, from, ed.view.state.selection.main.head);
    expect(ed.getContent()).toBe("body [[welcome]]");
    undo(ed.view);
    expect(ed.getContent()).toBe("body [[wel");
    ed.destroy();
  });

  it("Escape closes the list and leaves source unchanged", async () => {
    const ed = mountWiki("body [[wel");
    cursorAfter(ed.view, "[[wel");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBe("active");
    closeCompletion(ed.view);
    expect(completionStatus(ed.view.state)).toBeNull();
    expect(ed.getContent()).toBe("body [[wel");
    ed.destroy();
  });

  it("does not activate without an opener", async () => {
    const ed = mountWiki("just text");
    cursorAfter(ed.view, "just ");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBeNull();
    ed.destroy();
  });

  it("rejects after # (heading/alias markers)", async () => {
    const ed = mountWiki("body [[welcome#");
    cursorAfter(ed.view, "[[welcome#");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBeNull();
    ed.destroy();
  });

  it("rejects after an alias marker", async () => {
    const ed = mountWiki("body [[welcome|");
    cursorAfter(ed.view, "[[welcome|");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBeNull();
    ed.destroy();
  });

  it("rejects YAML frontmatter by cursor position", async () => {
    const ed = mountWiki("---\ntitle: x\n---\nbody\n");
    const text = ed.view.state.doc.toString();
    const pos = text.indexOf("title:") + 2; // inside frontmatter
    ed.view.dispatch({ selection: { anchor: pos } });
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBeNull();
    ed.destroy();
  });

  it("rejects fenced code", async () => {
    const fenced = "before\n\n```\ncode here\n```\n";
    const ed = mountWiki(fenced);
    ensureSyntaxTree(ed.view.state, ed.view.state.doc.length, 2000);
    const codeLine = ed.view.state.doc.toString().indexOf("code");
    ed.view.dispatch({ selection: { anchor: codeLine } });
    ed.view.dispatch({ changes: { from: codeLine + 9, insert: "[[" } });
    ed.view.dispatch({
      selection: {
        anchor: ed.view.state.doc.toString().indexOf("[[") + 2,
      },
    });
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBeNull();
    ed.destroy();
  });

  it("rejects inline code", async () => {
    const ed = mountWiki("before `code [[` after");
    ensureSyntaxTree(ed.view.state, ed.view.state.doc.length, 2000);
    cursorAfter(ed.view, "code [[");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBeNull();
    ed.destroy();
  });

  it("does not activate in a read-only editor", async () => {
    const ed = mountWiki("body [[", { readOnly: true });
    cursorAfter(ed.view, "[[");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBeNull();
    ed.destroy();
  });

  it("does not activate when no candidate callback is supplied", async () => {
    const ed = mount("body [[");
    cursorAfter(ed.view, "[[");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBeNull();
    ed.destroy();
  });

  it("does not activate when candidate callback returns empty", async () => {
    const ed = mount("body [[", { getWikiLinkCandidates: () => [] });
    cursorAfter(ed.view, "[[");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBeNull();
    ed.destroy();
  });

  it("respects dynamic read-only toggling", async () => {
    const ed = mountWiki("body [[");
    cursorAfter(ed.view, "[[");
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBe("active");
    ed.setReadOnly(true);
    expect(completionStatus(ed.view.state)).toBeNull();
    ed.setReadOnly(false);
    await startAndSettle(ed.view);
    expect(completionStatus(ed.view.state)).toBe("active");
    ed.destroy();
  });

  it("does not bind Tab to completion acceptance", () => {
    expect(completionKeymap.some((binding) => binding.key === "Tab")).toBe(
      false,
    );
  });

  it("reads fresh candidates for each completion session", async () => {
    let current = [{ target: "old", label: "Old" }];
    const ed = mount("body [[", { getWikiLinkCandidates: () => current });
    cursorAfter(ed.view, "[[");
    await startAndSettle(ed.view);
    expect(currentCompletions(ed.view.state).map((item) => item.label)).toEqual(
      ["Old"],
    );
    closeCompletion(ed.view);
    current = [{ target: "new", label: "New" }];
    await startAndSettle(ed.view);
    expect(currentCompletions(ed.view.state).map((item) => item.label)).toEqual(
      ["New"],
    );
    ed.destroy();
  });

  it("lists only what the candidate callback returns", async () => {
    const ed = mount("body [[", {
      // Caller is responsible for excluding phantoms (main.ts does this).
      getWikiLinkCandidates: () => [{ target: "real", label: "Real" }],
    });
    cursorAfter(ed.view, "[[");
    await startAndSettle(ed.view);
    const comps = currentCompletions(ed.view.state);
    expect(comps.length).toBe(1);
    expect(comps[0].label).toBe("Real");
    ed.destroy();
  });
});
