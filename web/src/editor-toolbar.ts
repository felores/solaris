/**
 * Floating selection toolbar (plan 018 U4): a bubble on non-empty selections
 * offering markdown transforms. Transforms are pure `EditorState -> spec`
 * functions so they test headless; the tooltip is CM6's native `showTooltip`
 * (no library ships this — it's the documented CodeMirror pattern).
 *
 * The row reserves a trailing slot (`toolbarExtras`) for the U7 AI input so
 * adding it never reflows the formatting tools.
 */
import {
  EditorState,
  StateField,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";

export type ToolbarTransform = (state: EditorState) => TransactionSpec | null;

/** Wrap/unwrap the selection in an inline marker (`**`, `*`, `` ` ``). */
export function toggleInline(marker: string): ToolbarTransform {
  return (state) => {
    const r = state.selection.main;
    if (r.empty) return null;
    const doc = state.doc;
    const inner = doc.sliceString(r.from, r.to);
    // Markers inside the selection: **bold** selected whole.
    if (
      inner.length >= marker.length * 2 &&
      inner.startsWith(marker) &&
      inner.endsWith(marker)
    ) {
      return {
        changes: {
          from: r.from,
          to: r.to,
          insert: inner.slice(marker.length, inner.length - marker.length),
        },
        selection: { anchor: r.from, head: r.to - marker.length * 2 },
      };
    }
    // Markers just outside the selection: bold selected without its stars.
    const before = doc.sliceString(Math.max(0, r.from - marker.length), r.from);
    const after = doc.sliceString(
      r.to,
      Math.min(doc.length, r.to + marker.length),
    );
    if (before === marker && after === marker) {
      return {
        changes: [
          { from: r.from - marker.length, to: r.from, insert: "" },
          { from: r.to, to: r.to + marker.length, insert: "" },
        ],
        selection: {
          anchor: r.from - marker.length,
          head: r.to - marker.length,
        },
      };
    }
    return {
      changes: [
        { from: r.from, insert: marker },
        { from: r.to, insert: marker },
      ],
      selection: {
        anchor: r.from + marker.length,
        head: r.to + marker.length,
      },
    };
  };
}

/** Heading cycle on the selection's first line: none → H1 → H2 → H3 → H4 → none. */
export const cycleHeading: ToolbarTransform = (state) => {
  const line = state.doc.lineAt(state.selection.main.from);
  const m = /^(#{1,6})\s/.exec(line.text);
  const level = m ? m[1].length : 0;
  const next = level >= 4 ? 0 : level + 1;
  const prefix = next === 0 ? "" : "#".repeat(next) + " ";
  return {
    changes: {
      from: line.from,
      to: line.from + (m ? m[0].length : 0),
      insert: prefix,
    },
  };
};

/** Toggle `- ` bullets across the selected lines (all-on → remove). */
export const toggleBulletList: ToolbarTransform = (state) => {
  const r = state.selection.main;
  const first = state.doc.lineAt(r.from).number;
  const last = state.doc.lineAt(r.to).number;
  const lines = [];
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
  const content = lines.filter((l) => l.text.trim().length > 0);
  if (content.length === 0) return null;
  const allBulleted = content.every((l) => /^\s*- /.test(l.text));
  const changes = content.map((l) => {
    if (allBulleted) {
      const m = /^(\s*)- /.exec(l.text)!;
      return {
        from: l.from + m[1].length,
        to: l.from + m[0].length,
        insert: "",
      };
    }
    return /^\s*- /.test(l.text)
      ? { from: l.from, to: l.from, insert: "" }
      : { from: l.from, insert: "- " };
  });
  return { changes };
};

/** Wrap the selection as `[selection]()` with the cursor inside the parens. */
export const wrapLink: ToolbarTransform = (state) => {
  const r = state.selection.main;
  if (r.empty) return null;
  const text = state.doc.sliceString(r.from, r.to);
  return {
    changes: { from: r.from, to: r.to, insert: `[${text}]()` },
    selection: { anchor: r.from + text.length + 3 },
  };
};

export type ToolbarExtras = (dom: HTMLElement, view: EditorView) => void;

interface ToolButton {
  icon: string;
  title: string;
  cls: string;
  transform: ToolbarTransform;
}

// Lucide stroke icons (same family as the rest of the chrome — no emojis).
const lucide = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  bold: lucide(
    '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  ),
  italic: lucide(
    '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  ),
  heading: lucide(
    '<path d="M6 12h12"/><path d="M6 20V4"/><path d="M18 20V4"/>',
  ),
  list: lucide(
    '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  ),
  link: lucide(
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  ),
  code: lucide(
    '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  ),
  bot: lucide(
    '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  ),
} as const;

const TOOLS: ToolButton[] = [
  {
    icon: ICONS.bold,
    title: "Bold",
    cls: "cm-tb-bold",
    transform: toggleInline("**"),
  },
  {
    icon: ICONS.italic,
    title: "Italic",
    cls: "cm-tb-italic",
    transform: toggleInline("*"),
  },
  {
    icon: ICONS.heading,
    title: "Heading H1–H4",
    cls: "cm-tb-heading",
    transform: cycleHeading,
  },
  {
    icon: ICONS.list,
    title: "Bullet list",
    cls: "cm-tb-list",
    transform: toggleBulletList,
  },
  { icon: ICONS.link, title: "Link", cls: "cm-tb-link", transform: wrapLink },
  {
    icon: ICONS.code,
    title: "Inline code",
    cls: "cm-tb-code",
    transform: toggleInline("`"),
  },
];

/** Static markup for the AI row's bot icon (consumed by main.ts). */
export const BOT_ICON_SVG = ICONS.bot;

function buildToolbarDom(
  view: EditorView,
  extras?: ToolbarExtras,
): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-selection-toolbar";
  // Row 1: formatting tools. Row 2 (when populated): the AI input.
  const toolsRow = document.createElement("div");
  toolsRow.className = "cm-tb-row";
  for (const tool of TOOLS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cm-tb-btn ${tool.cls}`;
    b.innerHTML = tool.icon; // static markup above, never user content
    b.title = tool.title;
    // mousedown would steal the selection the transform needs — block it.
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      const spec = tool.transform(view.state);
      if (spec) view.dispatch(spec);
      view.focus();
    };
    toolsRow.appendChild(b);
  }
  dom.appendChild(toolsRow);
  if (extras) {
    const aiRow = document.createElement("div");
    aiRow.className = "cm-tb-row cm-tb-row-ai";
    extras(aiRow, view);
    if (aiRow.childNodes.length > 0) dom.appendChild(aiRow);
  }
  return dom;
}

function toolbarTooltip(
  state: EditorState,
  extras?: ToolbarExtras,
): Tooltip | null {
  const r = state.selection.main;
  if (r.empty) return null;
  return {
    pos: Math.min(r.anchor, r.head),
    above: true,
    strictSide: false,
    create: (view) => ({
      dom: buildToolbarDom(view, extras),
      // Breathing room between the selection and the bubble.
      offset: { x: 0, y: 6 },
    }),
  };
}

/** The toolbar extension: a StateField feeding CM6's showTooltip facet. */
export function selectionToolbar(extras?: ToolbarExtras): Extension {
  return StateField.define<Tooltip | null>({
    create: (state) => toolbarTooltip(state, extras),
    update(value, tr) {
      if (tr.docChanged || tr.selection)
        return toolbarTooltip(tr.state, extras);
      return value;
    },
    provide: (f) => showTooltip.from(f),
  });
}
