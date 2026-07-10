// @vitest-environment jsdom
// U1 round-trip gate: the editor must never change bytes it wasn't asked to
// change. These fixtures are the release gate for the KTD2 editor choice.
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  createNoteEditor,
  detectEol,
  fromLf,
  frontmatterEnd,
  livePreviewPlugin,
  toLf,
  type NoteEditor,
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

  it("code block lines carry the chip classes; fences dim until entered", () => {
    const code = readFileSync(fixturesDir + "codefence.md", "utf8");
    const ed = mount(code);
    const lines = ed.view.dom.querySelectorAll(".cm-codeblock-line");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(ed.view.dom.querySelector(".cm-codeblock-fence-dim")).toBeTruthy();
    const pos = ed.view.state.doc.toString().indexOf("const x");
    ed.view.dispatch({ selection: { anchor: pos } });
    expect(ed.view.dom.querySelector(".cm-codeblock-fence-dim")).toBeNull();
    ed.destroy();
  });

  it("table notes still round-trip byte-for-byte with the widget active", () => {
    const ed = mount(tableMd);
    expect(ed.view.dom.querySelector(".cm-md-table")).toBeTruthy();
    expect(ed.getContent()).toBe(tableMd);
    ed.destroy();
  });
});
