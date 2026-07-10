// Live-preview markdown editor core (F-plan 018 U1).
// The CodeMirror document IS the note's markdown — decorations only change
// how it looks, never what it says, so round-trip is byte-for-byte by
// construction. Line endings are the one normalization CM6 applies (LF
// internally); detectEol/getContent restore the note's dominant ending.
import {
  EditorState,
  StateField,
  StateEffect,
  RangeSetBuilder,
  Compartment,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
  ViewPlugin,
  type ViewUpdate,
  keymap,
  drawSelection,
  tooltips,
} from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages as codeLanguages } from "@codemirror/language-data";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { selectionToolbar, type ToolbarExtras } from "./editor-toolbar.js";
import {
  syntaxTree,
  ensureSyntaxTree,
  syntaxHighlighting,
  HighlightStyle,
  defaultHighlightStyle,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { tags } from "@lezer/highlight";

export interface NoteEditorOptions {
  content: string;
  onChange?: () => void;
  onWikiLinkClick?: (target: string) => void;
  readOnly?: boolean;
  /** Trailing slot in the selection toolbar (U7 AI input). */
  toolbarExtras?: ToolbarExtras;
}

export interface NoteEditor {
  view: EditorView;
  getContent(): string;
  setContent(content: string): void;
  setReadOnly(readOnly: boolean): void;
  isFrontmatterExpanded(): boolean;
  expandFrontmatter(expanded: boolean): void;
  destroy(): void;
}

// ---------- line endings ----------

export function detectEol(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function fromLf(text: string, eol: "\r\n" | "\n"): string {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// ---------- frontmatter ----------

/** End offset (in LF text) of the YAML frontmatter block including the
 * closing fence line, or 0 when the document has none. */
export function frontmatterEnd(lfText: string): number {
  if (!lfText.startsWith("---\n")) return 0;
  let pos = 4;
  for (let i = 0; i < 400; i++) {
    const nl = lfText.indexOf("\n", pos);
    const line = nl === -1 ? lfText.slice(pos) : lfText.slice(pos, nl);
    if (line === "---") return nl === -1 ? lfText.length : nl;
    if (nl === -1) return 0;
    pos = nl + 1;
  }
  return 0;
}

const setFmExpanded = StateEffect.define<boolean>();

interface FmState {
  end: number; // end of closing fence line (LF offsets), 0 = none
  expanded: boolean;
}

const fmField = StateField.define<FmState>({
  create(state) {
    return { end: frontmatterEnd(state.doc.toString()), expanded: false };
  },
  update(value, tr) {
    let v = value;
    for (const e of tr.effects) {
      if (e.is(setFmExpanded)) v = { ...v, expanded: e.value };
    }
    if (tr.docChanged) {
      // Recompute from the head of the doc; frontmatter is always at offset 0.
      const head = tr.newDoc.sliceString(0, Math.min(tr.newDoc.length, 16384));
      const end = frontmatterEnd(
        head.length < tr.newDoc.length ? head : tr.newDoc.toString(),
      );
      v = { ...v, end };
    }
    return v;
  },
});

// Write-protection (KTD3): while collapsed, changes touching the frontmatter
// block are clipped to the body — a select-all-retype replaces the body and
// keeps the typed text; edits wholly inside the block are dropped.
const fmProtection = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const fm = tr.startState.field(fmField, false);
  if (!fm || fm.end <= 0 || fm.expanded) return tr;
  const protectEnd = fm.end < tr.startState.doc.length ? fm.end + 1 : fm.end;
  let touches = false;
  tr.changes.iterChanges((fromA) => {
    if (fromA < protectEnd) touches = true;
  });
  if (!touches) return tr;
  const clipped: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const fullyProtected =
      toA < protectEnd || (toA === protectEnd && fromA < protectEnd);
    if (fullyProtected) return;
    clipped.push({
      from: Math.max(fromA, protectEnd),
      to: toA,
      insert: inserted.toString(),
    });
  });
  return { changes: clipped, effects: tr.effects };
});

function readOnlyExtensions(readOnly: boolean): Extension[] {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    // readOnly must also block programmatic dispatch (phantom-note fallback).
    readOnly ? EditorState.changeFilter.of(() => false) : [],
  ];
}

class FrontmatterFoldWidget extends WidgetType {
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-frontmatter-fold";
    el.textContent = "· · · properties · · ·";
    el.title = "Click to show frontmatter";
    el.onclick = () => view.dispatch({ effects: setFmExpanded.of(true) });
    return el;
  }
  override eq(): boolean {
    return true;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

const fmDecorations = EditorView.decorations.compute(
  [fmField],
  (state): DecorationSet => {
    const fm = state.field(fmField);
    if (fm.end <= 0) return Decoration.none;
    const b = new RangeSetBuilder<Decoration>();
    if (!fm.expanded) {
      b.add(
        0,
        fm.end,
        Decoration.replace({
          widget: new FrontmatterFoldWidget(),
          block: true,
        }),
      );
    } else {
      const doc = state.doc;
      const lastLine = doc.lineAt(Math.min(fm.end, doc.length));
      for (let n = 1; n <= lastLine.number; n++) {
        b.add(
          doc.line(n).from,
          doc.line(n).from,
          Decoration.line({ class: "cm-frontmatter-line" }),
        );
      }
    }
    return b.finish();
  },
);

// ---------- markdown styling ----------

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-h1" },
  { tag: tags.heading2, class: "cm-h2" },
  { tag: tags.heading3, class: "cm-h3" },
  { tag: tags.heading4, class: "cm-h4" },
  { tag: tags.heading5, class: "cm-h5" },
  { tag: tags.heading6, class: "cm-h6" },
  { tag: tags.strong, class: "cm-strong" },
  { tag: tags.emphasis, class: "cm-em" },
  { tag: tags.strikethrough, class: "cm-strike" },
  { tag: tags.monospace, class: "cm-inline-code" },
  { tag: tags.link, class: "cm-md-link" },
  { tag: tags.url, class: "cm-md-url" },
  { tag: tags.quote, class: "cm-quote" },
]);

// Syntax marks hidden unless the selection touches the construct they belong
// to — arrowing or clicking into a heading/emphasis reveals its markers.
const HIDDEN_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "URL",
]);

// Notes are small; decorating the full doc keeps behavior deterministic in
// environments without layout (jsdom) and costs nothing at vault-note sizes.
const FULL_DECORATION_LIMIT = 50_000;

function decorationRanges(
  view: EditorView,
): readonly { from: number; to: number }[] {
  if (view.state.doc.length <= FULL_DECORATION_LIMIT) {
    return [{ from: 0, to: view.state.doc.length }];
  }
  return view.visibleRanges;
}

function selectionTouches(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  for (const r of state.selection.ranges) {
    if (r.to >= from && r.from <= to) return true;
  }
  return false;
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      const state = view.state;
      for (const { from, to } of decorationRanges(view)) {
        syntaxTree(state).iterate({
          from,
          to,
          enter: (node) => {
            if (!HIDDEN_MARKS.has(node.name)) return;
            const parent = node.node.parent;
            const scopeFrom = parent ? parent.from : node.from;
            const scopeTo = parent ? parent.to : node.to;
            if (selectionTouches(state, scopeFrom, scopeTo)) return;
            let hideTo = node.to;
            if (
              node.name === "HeaderMark" &&
              state.doc.sliceString(node.to, node.to + 1) === " "
            ) {
              hideTo = node.to + 1; // hide the space after the # run too
            }
            b.add(node.from, hideTo, Decoration.replace({}));
          },
        });
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------- wiki links ----------

const WIKI_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

class WikiLinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string,
    readonly onClick?: (target: string) => void,
  ) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-wikilink wiki";
    el.textContent = this.label;
    el.onclick = (ev) => {
      ev.preventDefault();
      this.onClick?.(this.target);
    };
    return el;
  }
  override eq(other: WikiLinkWidget): boolean {
    return other.target === this.target && other.label === this.label;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function wikiLinkPlugin(onClick?: (target: string) => void) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = this.build(u.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const b = new RangeSetBuilder<Decoration>();
        for (const { from, to } of decorationRanges(view)) {
          const text = view.state.doc.sliceString(from, to);
          WIKI_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = WIKI_RE.exec(text))) {
            const start = from + m.index;
            const end = start + m[0].length;
            if (selectionTouches(view.state, start, end)) {
              b.add(start, end, Decoration.mark({ class: "cm-wikilink-raw" }));
            } else {
              b.add(
                start,
                end,
                Decoration.replace({
                  widget: new WikiLinkWidget(
                    m[1].trim(),
                    (m[2] || m[1]).trim(),
                    onClick,
                  ),
                }),
              );
            }
          }
        }
        return b.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (p) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(p)?.decorations ?? Decoration.none,
        ),
    },
  );
}

// ---------- block previews: tables render, code blocks chip ----------

/** Rendered preview of a markdown table; click places the cursor inside so
 * the raw source reveals for editing (same pattern as wiki links, scaled
 * to a block). The HTML is sanitized — notes carry untrusted content. */
class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly pos: number,
  ) {
    super();
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-md-table";
    const parsed = marked.parse(this.source);
    if (typeof parsed === "string") {
      el.innerHTML = DOMPurify.sanitize(parsed, { FORBID_ATTR: ["style"] });
    } else {
      el.textContent = this.source;
    }
    el.onclick = () => {
      view.dispatch({ selection: { anchor: this.pos } });
      view.focus();
    };
    return el;
  }
  override eq(other: TableWidget): boolean {
    return other.source === this.source && other.pos === this.pos;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

// Block decorations must come from a StateField, not a ViewPlugin (they
// affect vertical layout). Full-doc scan; notes are small (see
// FULL_DECORATION_LIMIT).
function buildBlockPreviews(state: EditorState): DecorationSet {
  if (state.doc.length > FULL_DECORATION_LIMIT) return Decoration.none;
  const b = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  // Force the parse to cover the whole (small) doc so tables render on the
  // first paint — the field only recomputes on transactions, not on the
  // parser's idle progress.
  ensureSyntaxTree(state, doc.length, 100);
  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter: (node) => {
      if (node.name === "Table") {
        if (selectionTouches(state, node.from, node.to)) return false;
        b.add(
          node.from,
          node.to,
          Decoration.replace({
            widget: new TableWidget(
              doc.sliceString(node.from, node.to),
              node.from,
            ),
            block: true,
          }),
        );
        return false;
      }
      if (node.name === "FencedCode" || node.name === "CodeBlock") {
        const active = selectionTouches(state, node.from, node.to);
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          const line = doc.line(n);
          const isFence =
            node.name === "FencedCode" && (n === first || n === last);
          b.add(
            line.from,
            line.from,
            Decoration.line({
              class:
                "cm-codeblock-line" +
                (n === first ? " cm-codeblock-first" : "") +
                (n === last ? " cm-codeblock-last" : "") +
                (isFence && !active ? " cm-codeblock-fence-dim" : ""),
            }),
          );
        }
        return false;
      }
      return undefined;
    },
  });
  return b.finish();
}

const blockPreviewField = StateField.define<DecorationSet>({
  create: buildBlockPreviews,
  update(value, tr) {
    if (tr.docChanged || tr.selection) return buildBlockPreviews(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- factory ----------

const readOnlyCompartment = new Compartment();

/** Tooltips (the selection toolbar) mount on document.body: inside the
 * editor they can fall back to absolute positioning and widen the note's
 * scrollable area (the phantom right gap), and they get clipped by the
 * panel. tooltipSpace confines flipping to the reader panel's box. */
function tooltipHost(): Extension {
  if (typeof document === "undefined") return [];
  return tooltips({
    position: "fixed",
    parent: document.body,
    tooltipSpace: (view) => {
      const panel = view.dom.closest("#reader")?.getBoundingClientRect();
      const win = {
        top: 0,
        left: 0,
        right: document.documentElement.clientWidth,
        bottom: document.documentElement.clientHeight,
      };
      if (!panel) return win;
      return {
        top: Math.max(panel.top, win.top),
        left: Math.max(panel.left, win.left),
        right: Math.min(panel.right, win.right),
        bottom: Math.min(panel.bottom, win.bottom),
      };
    },
  });
}

function buildExtensions(opts: NoteEditorOptions): Extension[] {
  return [
    fmField,
    fmProtection,
    fmDecorations,
    markdown({ base: markdownLanguage, codeLanguages }),
    syntaxHighlighting(mdHighlight),
    // Fallback token colors for fenced-code languages (ts, py, …).
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    livePreviewPlugin,
    wikiLinkPlugin(opts.onWikiLinkClick),
    blockPreviewField,
    tooltipHost(),
    selectionToolbar(opts.toolbarExtras),
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    readOnlyCompartment.of(readOnlyExtensions(!!opts.readOnly)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange?.();
    }),
  ];
}

export function createEditorState(
  content: string,
  opts: NoteEditorOptions,
): EditorState {
  return EditorState.create({
    doc: toLf(content),
    extensions: buildExtensions(opts),
  });
}

export function createNoteEditor(
  parent: HTMLElement,
  opts: NoteEditorOptions,
): NoteEditor {
  let eol = detectEol(opts.content);
  const view = new EditorView({
    state: createEditorState(opts.content, opts),
    parent,
  });
  return {
    view,
    getContent() {
      return fromLf(view.state.doc.toString(), eol);
    },
    setContent(content: string) {
      eol = detectEol(content);
      view.setState(createEditorState(content, opts));
    },
    setReadOnly(readOnly: boolean) {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly)),
      });
    },
    isFrontmatterExpanded() {
      return view.state.field(fmField).expanded;
    },
    expandFrontmatter(expanded: boolean) {
      view.dispatch({ effects: setFmExpanded.of(expanded) });
    },
    destroy() {
      view.destroy();
    },
  };
}
