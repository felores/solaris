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
  Annotation,
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
import {
  autocompletion,
  closeCompletion,
  pickedCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";

export interface WikiLinkCandidate {
  /** Vault-relative path without the trailing `.md`. Inserted between `[[ ]]`. */
  target: string;
  /** Display title shown as the primary label. */
  label: string;
}

export interface NoteEditorOptions {
  content: string;
  onChange?: () => void;
  onWikiLinkClick?: (target: string) => void;
  onMarkdownLinkClick?: (target: string) => void;
  /** When set on a writable editor, typing `[[` opens a fuzzy note list built
   *  from the current candidates. Read-only editors never autocomplete. */
  getWikiLinkCandidates?: () => readonly WikiLinkCandidate[];
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

class HiddenFrontmatterWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.style.display = "none";
    return el;
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
          widget: new HiddenFrontmatterWidget(),
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
const MARKDOWN_LINK_RE =
  /(?<!!)\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const BARE_EXTERNAL_LINK_RE = /(?<!\]\()(?<!\[\[)\bhttps?:\/\/[^\s<>()\]]+/g;

class LinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly href: string,
    readonly onClick?: (target: string) => void,
  ) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement("a");
    el.className = "cm-md-link";
    el.textContent = this.label;
    el.href = this.onClick ? "#" : this.href;
    if (!this.onClick) {
      el.target = "_blank";
      el.rel = "noopener noreferrer";
    }
    // Keep the editor selection out of the link so its click reaches the anchor.
    el.onmousedown = (ev) => ev.preventDefault();
    if (this.onClick)
      el.onclick = (ev) => {
        ev.preventDefault();
        this.onClick?.(this.href);
      };
    return el;
  }
  override eq(other: LinkWidget): boolean {
    return other.label === this.label && other.href === this.href;
  }
}

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
    el.onmousedown = (ev) => ev.preventDefault();
    el.onclick = (ev) => {
      ev.preventDefault();
      this.onClick?.(this.target);
    };
    return el;
  }
  override eq(other: WikiLinkWidget): boolean {
    return other.target === this.target && other.label === this.label;
  }
}

function wikiLinkPlugin(
  onClick?: (target: string) => void,
  onMarkdownLinkClick?: (target: string) => void,
) {
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
        const ranges: { from: number; to: number; decoration: Decoration }[] =
          [];
        const add = (from: number, to: number, decoration: Decoration) =>
          ranges.push({ from, to, decoration });
        for (const { from, to } of decorationRanges(view)) {
          const text = view.state.doc.sliceString(from, to);
          WIKI_RE.lastIndex = 0;
          let m = WIKI_RE.exec(text);
          while (m) {
            const start = from + m.index;
            const end = start + m[0].length;
            if (selectionTouches(view.state, start, end)) {
              add(start, end, Decoration.mark({ class: "cm-wikilink-raw" }));
            } else {
              add(
                start,
                end,
                Decoration.replace({
                  widget: /^https?:\/\//.test(m[1].trim())
                    ? new LinkWidget(m[1].trim(), m[2]?.trim() || m[1].trim())
                    : new WikiLinkWidget(
                        m[1].trim(),
                        (m[2] || m[1]).trim(),
                        onClick,
                      ),
                }),
              );
            }
            m = WIKI_RE.exec(text);
          }
          MARKDOWN_LINK_RE.lastIndex = 0;
          let markdown = MARKDOWN_LINK_RE.exec(text);
          while (markdown) {
            const start = from + markdown.index;
            const end = start + markdown[0].length;
            if (!selectionTouches(view.state, start, end)) {
              add(
                start,
                end,
                Decoration.replace({
                  widget: new LinkWidget(
                    markdown[1],
                    markdown[2],
                    /^https?:\/\//.test(markdown[2])
                      ? undefined
                      : onMarkdownLinkClick,
                  ),
                }),
              );
            }
            markdown = MARKDOWN_LINK_RE.exec(text);
          }
          BARE_EXTERNAL_LINK_RE.lastIndex = 0;
          let bare = BARE_EXTERNAL_LINK_RE.exec(text);
          while (bare) {
            const start = from + bare.index;
            const end = start + bare[0].length;
            if (!selectionTouches(view.state, start, end)) {
              add(
                start,
                end,
                Decoration.replace({
                  widget: new LinkWidget(bare[0], bare[0]),
                }),
              );
            }
            bare = BARE_EXTERNAL_LINK_RE.exec(text);
          }
        }
        ranges
          .sort((a, b) => a.from - b.from || a.to - b.to)
          .forEach(({ from, to, decoration }) => {
            b.add(from, to, decoration);
          });
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

// ---------- wikilink autocomplete (plan 023) ----------

// Active only for an unclosed `[[target` immediately before the cursor on the
// same line. Headings (`#`), aliases (`|`), and the closer `]]` end the range.
function activeWikiOpen(ctx: CompletionContext): number | null {
  const { state } = ctx;
  const pos = ctx.pos;
  const line = state.doc.lineAt(pos);
  const upto = line.text.slice(0, pos - line.from);
  const open = upto.lastIndexOf("[[");
  if (open < 0) return null;
  const tail = upto.slice(open + 2);
  if (tail.includes("]]") || tail.includes("#") || tail.includes("|")) {
    return null;
  }
  return line.from + open + 2;
}

function inProtectedContext(ctx: CompletionContext): boolean {
  const { state } = ctx;
  const pos = ctx.pos;
  const fm = state.field(fmField, false);
  if (fm && fm.end > 0 && pos <= fm.end) return true;
  let inCode = false;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter: (node) => {
      if (
        node.name === "FencedCode" ||
        node.name === "CodeBlock" ||
        node.name === "InlineCode" ||
        node.name === "CodeMark" ||
        node.name === "CodeText"
      ) {
        inCode = true;
        return false;
      }
      return undefined;
    },
  });
  return inCode;
}

function wikiLinkCompletionSource(
  getCandidates: () => readonly WikiLinkCandidate[],
) {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (ctx.state.readOnly) return null;
    const from = activeWikiOpen(ctx);
    if (from === null) return null;
    if (inProtectedContext(ctx)) return null;
    const candidates = getCandidates();
    if (candidates.length === 0) return null;
    return {
      from,
      to: ctx.pos,
      options: candidates.map((c) => ({
        label: c.label,
        detail: c.target,
        apply: (view, completion, applyFrom, applyTo) => {
          // from/to point at the query text after `[[`. Replace the query
          // with `target]]` so the already-typed opener stays put and the
          // cursor lands after the closer (one transaction = one undo).
          const insert = `${c.target}]]`;
          view.dispatch({
            changes: { from: applyFrom, to: applyTo, insert },
            selection: { anchor: applyFrom + insert.length },
            annotations: pickedCompletion.of(completion),
          });
        },
      })),
      // Stay open only while the cursor remains in a plain unclosed target
      // on the same line: reject `]]`, `#`, `|`, and any newline.
      validFor: (text) => !/[\]#|\n]/.test(text),
    };
  };
}

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

class CodeBlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly pos: number,
    readonly fenced: boolean,
  ) {
    super();
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-md-codeblock";
    let content = this.source;
    if (this.fenced) {
      const firstBreak = content.indexOf("\n");
      const firstLine = firstBreak < 0 ? content : content.slice(0, firstBreak);
      const language = firstLine.match(/^(?:`{3,}|~{3,})\s*([^\s`]*)/)?.[1];
      if (language) el.dataset.language = language;
      const closing = content.match(/\n(?:`{3,}|~{3,})[ \t]*$/);
      content =
        firstBreak < 0
          ? ""
          : content.slice(
              firstBreak + 1,
              closing?.index === undefined ? content.length : closing.index + 1,
            );
    } else {
      content = content.replace(/^(?: {4}|\t)/gm, "");
    }
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = content;
    pre.appendChild(code);
    el.appendChild(pre);
    el.title = "Double-click to edit code";
    el.ondblclick = () => {
      view.dispatch({ selection: { anchor: this.pos } });
      view.focus();
    };
    return el;
  }
  override eq(other: CodeBlockWidget): boolean {
    return (
      other.source === this.source &&
      other.pos === this.pos &&
      other.fenced === this.fenced
    );
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
        if (!active) {
          b.add(
            node.from,
            node.to,
            Decoration.replace({
              widget: new CodeBlockWidget(
                doc.sliceString(node.from, node.to),
                node.from,
                node.name === "FencedCode",
              ),
              block: true,
            }),
          );
          return false;
        }
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

const parseSettled = Annotation.define<boolean>();

const blockPreviewField = StateField.define<DecorationSet>({
  create: buildBlockPreviews,
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.annotation(parseSettled))
      return buildBlockPreviews(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// The field computes at state creation, when the incremental markdown parse
// may not have reached a table yet (parse-heavy notes, inline code in
// cells) — and a StateField never sees the parser's idle progress. This
// watcher pokes ONE recompute once the tree covers the document, so block
// previews appear on first paint instead of after the first click.
const parseSettleWatcher = ViewPlugin.fromClass(
  class {
    settled = false;
    timer: ReturnType<typeof setTimeout> | null = null;
    constructor(readonly view: EditorView) {
      this.check(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.settled = false;
      if (!this.settled) this.check(u.state);
    }
    check(state: EditorState) {
      if (syntaxTree(state).length < state.doc.length) return;
      this.settled = true;
      if (this.timer !== null) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.view.dispatch({ annotations: parseSettled.of(true) });
      }, 0);
    }
    destroy() {
      if (this.timer !== null) clearTimeout(this.timer);
    }
  },
);

// ---------- factory ----------

const readOnlyCompartment = new Compartment();

/** Mount selection tooltips in the panel's scroll container so they move
 * natively with the note. Headless states keep the fixed body fallback. */
function tooltipHost(parent?: HTMLElement): Extension {
  if (typeof document === "undefined") return [];
  const scrollHost = parent?.closest<HTMLElement>(
    "#reader-scroll, #research-body",
  );
  return tooltips({
    position: scrollHost ? "absolute" : "fixed",
    parent: scrollHost ?? document.body,
    tooltipSpace: (view) => {
      const panel = view.dom
        .closest("#reader, #research")
        ?.getBoundingClientRect();
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

function buildExtensions(
  opts: NoteEditorOptions,
  tooltipParent?: HTMLElement,
): Extension[] {
  return [
    fmField,
    fmProtection,
    fmDecorations,
    markdown({ base: markdownLanguage, codeLanguages }),
    syntaxHighlighting(mdHighlight),
    // Fallback token colors for fenced-code languages (ts, py, …).
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    livePreviewPlugin,
    wikiLinkPlugin(opts.onWikiLinkClick, opts.onMarkdownLinkClick),
    blockPreviewField,
    parseSettleWatcher,
    tooltipHost(tooltipParent),
    opts.readOnly ? [] : selectionToolbar(opts.toolbarExtras),
    opts.getWikiLinkCandidates
      ? autocompletion({
          override: [wikiLinkCompletionSource(opts.getWikiLinkCandidates)],
          // The default completion keymap (Arrows/Enter/Escape/Ctrl-Space) is
          // installed by autocompletion itself at highest precedence; Tab keeps
          // its existing editor behavior because it is not in completionKeymap.
          activateOnTyping: true,
          defaultKeymap: true,
          icons: false,
          // A visible completion must accept the user's immediate Enter.
          interactionDelay: 0,
        })
      : [],
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
  tooltipParent?: HTMLElement,
): EditorState {
  return EditorState.create({
    doc: toLf(content),
    extensions: buildExtensions(opts, tooltipParent),
  });
}

export function createNoteEditor(
  parent: HTMLElement,
  opts: NoteEditorOptions,
): NoteEditor {
  let eol = detectEol(opts.content);
  const view = new EditorView({
    state: createEditorState(opts.content, opts, parent),
    parent,
  });
  return {
    view,
    getContent() {
      return fromLf(view.state.doc.toString(), eol);
    },
    setContent(content: string) {
      eol = detectEol(content);
      view.setState(createEditorState(content, opts, parent));
    },
    setReadOnly(readOnly: boolean) {
      if (readOnly) closeCompletion(view);
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
