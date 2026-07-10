// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { showTooltip } from "@codemirror/view";
import {
  cycleHeading,
  selectionToolbar,
  toggleBulletList,
  toggleInline,
  wrapLink,
} from "./editor-toolbar";
import { createNoteEditor } from "./editor";

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
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => zeroRect as DOMRect;

function state(doc: string, anchor: number, head?: number): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor, head: head ?? anchor },
    extensions: [selectionToolbar()],
  });
}

function apply(
  doc: string,
  anchor: number,
  head: number,
  transform: (s: EditorState) => object | null,
) {
  const s = state(doc, anchor, head);
  const spec = transform(s);
  if (!spec) return { doc, selection: s.selection.main };
  const tr = s.update(spec);
  return { doc: tr.state.doc.toString(), selection: tr.state.selection.main };
}

describe("toolbar transforms", () => {
  it("bold wraps and unwraps (toggle)", () => {
    const bolded = apply("hello world", 0, 5, toggleInline("**"));
    expect(bolded.doc).toBe("**hello** world");
    // Selection now covers "hello" inside the stars; toggling again unbolds.
    const un = apply(
      bolded.doc,
      bolded.selection.from,
      bolded.selection.to,
      toggleInline("**"),
    );
    expect(un.doc).toBe("hello world");
  });

  it("unwraps when the selection includes the markers", () => {
    const r = apply("**bold** text", 0, 8, toggleInline("**"));
    expect(r.doc).toBe("bold text");
  });

  it("italic and inline code use their own markers", () => {
    expect(apply("word", 0, 4, toggleInline("*")).doc).toBe("*word*");
    expect(apply("word", 0, 4, toggleInline("`")).doc).toBe("`word`");
  });

  it("heading cycles none → # → ## → ### → #### → none", () => {
    let doc = "title line\n";
    for (const expected of [
      "# title line\n",
      "## title line\n",
      "### title line\n",
      "#### title line\n",
      "title line\n",
    ]) {
      doc = apply(doc, 2, 2, cycleHeading).doc;
      expect(doc).toBe(expected);
    }
  });

  it("bullet list toggles across multi-line selections", () => {
    const on = apply("one\ntwo\nthree\n", 0, 13, toggleBulletList);
    expect(on.doc).toBe("- one\n- two\n- three\n");
    const off = apply(on.doc, 0, on.doc.length - 1, toggleBulletList);
    expect(off.doc).toBe("one\ntwo\nthree\n");
  });

  it("bullet list fills gaps when only some lines are bulleted", () => {
    const r = apply("- one\ntwo\n", 0, 9, toggleBulletList);
    expect(r.doc).toBe("- one\n- two\n");
  });

  it("link wraps as [sel]() with the cursor inside the parens", () => {
    const r = apply("click here now", 6, 10, wrapLink);
    expect(r.doc).toBe("click [here]() now");
    expect(r.selection.from).toBe("click [here](".length);
    expect(r.selection.empty).toBe(true);
  });

  it("multi-line bold keeps line structure intact", () => {
    const r = apply("a line\nb line\n", 0, 13, toggleInline("**"));
    expect(r.doc).toBe("**a line\nb line**\n");
    expect(r.doc.split("\n")).toHaveLength(3);
  });
});

describe("toolbar tooltip lifecycle", () => {
  it("absent for a bare cursor, present for a selection, gone on collapse", () => {
    const empty = state("hello world", 3);
    expect(empty.facet(showTooltip).filter(Boolean)).toHaveLength(0);
    const sel = state("hello world", 0, 5);
    expect(sel.facet(showTooltip).filter(Boolean)).toHaveLength(1);
    const collapsed = sel.update({ selection: { anchor: 2 } }).state;
    expect(collapsed.facet(showTooltip).filter(Boolean)).toHaveLength(0);
  });

  it("renders buttons in the mounted editor and applies a transform", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ed = createNoteEditor(host, { content: "make me bold\n" });
    ed.view.dispatch({ selection: { anchor: 0, head: 4 } });
    // Tooltips mount on document.body (fixed positioning host).
    const btn = document.querySelector<HTMLButtonElement>(".cm-tb-bold");
    expect(btn).toBeTruthy();
    btn!.click();
    expect(ed.getContent()).toBe("**make** me bold\n");
    ed.destroy();
  });

  it("renders the extras in a second row below the tools", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ed = createNoteEditor(host, {
      content: "extras test\n",
      toolbarExtras: (dom) => {
        const marker = document.createElement("span");
        marker.className = "ai-slot-marker";
        dom.appendChild(marker);
      },
    });
    ed.view.dispatch({ selection: { anchor: 0, head: 6 } });
    const toolbar = document.querySelector(".cm-selection-toolbar");
    expect(toolbar).toBeTruthy();
    const rows = toolbar!.querySelectorAll(".cm-tb-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll(".cm-tb-btn").length).toBeGreaterThan(0);
    expect(rows[1].querySelector(".ai-slot-marker")).toBeTruthy();
    ed.destroy();
  });

  it("omits the second row when extras add nothing", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ed = createNoteEditor(host, {
      content: "no extras\n",
      toolbarExtras: () => {},
    });
    ed.view.dispatch({ selection: { anchor: 0, head: 2 } });
    const toolbar = document.querySelector(".cm-selection-toolbar");
    expect(toolbar!.querySelectorAll(".cm-tb-row")).toHaveLength(1);
    ed.destroy();
  });
});
