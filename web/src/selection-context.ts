export type SelectionSource = "reader" | "research";

export interface BaseSelectionContext {
  source: SelectionSource;
  text: string;
  truncated?: boolean;
  originalWordCount?: number;
  originalCharCount?: number;
}

export interface ReaderSelectionContext extends BaseSelectionContext {
  source: "reader";
  noteId?: string;
  noteTitle?: string;
}

export interface ResearchSelectionContext extends BaseSelectionContext {
  source: "research";
  entryId?: string;
  mode?: string;
  title?: string;
  query?: string;
  url?: string;
}

export type SelectionContext = ReaderSelectionContext | ResearchSelectionContext;

export interface SelectionContextState {
  current: SelectionContext | null;
}

export type SelectionSnapshot = SelectionContextState;

export const MAX_CONTEXT_WORDS = 300;
export const MAX_CONTEXT_CHARS = 3000;

export const emptySelectionState = (): SelectionContextState => ({
  current: null,
});

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean);

export function selectionSlot(
  slot: Omit<ReaderSelectionContext, "text"> & { text: string },
): ReaderSelectionContext | null;
export function selectionSlot(
  slot: Omit<ResearchSelectionContext, "text"> & { text: string },
): ResearchSelectionContext | null;
export function selectionSlot(slot: SelectionContext): SelectionContext | null {
  const text = normalize(slot.text);
  return text ? ({ ...slot, text } as SelectionContext) : null;
}

export function updateSelectionSlot(
  _state: SelectionContextState,
  slot: SelectionContext | null,
): SelectionContextState {
  return slot ? { current: slot } : emptySelectionState();
}

export function clearSelectionSlot(
  state: SelectionContextState,
  source?: SelectionSource,
): SelectionContextState {
  return source && state.current?.source !== source ? state : emptySelectionState();
}

function capSlot(slot: SelectionContext): SelectionContext | null {
  const originalWordCount = wordsOf(slot.text).length;
  const originalCharCount = slot.text.length;
  let text = wordsOf(slot.text).slice(0, MAX_CONTEXT_WORDS).join(" ");
  if (text.length > MAX_CONTEXT_CHARS) text = text.slice(0, MAX_CONTEXT_CHARS).trim();
  if (!text) return null;
  const truncated = text !== slot.text;
  return truncated
    ? { ...slot, text, truncated, originalWordCount, originalCharCount }
    : { ...slot, text };
}

export function buildSelectionSnapshot(
  state: SelectionContextState,
): SelectionSnapshot {
  return { current: state.current ? capSlot(state.current) : null };
}

export function hasSelectionContext(state: SelectionContextState): boolean {
  return !!state.current;
}

export function selectedText(snapshot: SelectionSnapshot): string {
  return snapshot.current?.text ?? "";
}

export function sourceLabel(slot: SelectionContext): string {
  if (slot.source === "reader") return `Reader: ${slot.noteTitle || slot.noteId || "selection"}`;
  return `Research: ${slot.title || slot.query || slot.url || "selection"}`;
}

export function contextUseNotice(snapshot: SelectionSnapshot): string | null {
  return snapshot.current ? "Using selected text as context." : null;
}

export function contextTrimNotice(snapshot: SelectionSnapshot): string | null {
  return snapshot.current?.truncated
    ? `Selected context was trimmed to ${MAX_CONTEXT_WORDS} words.`
    : null;
}

function contextualLines(query: string, snapshot: SelectionSnapshot): string[] {
  const lines = [];
  if (query.trim()) lines.push(`Query: ${normalize(query)}`);
  const slot = snapshot.current;
  if (!slot) return lines;
  lines.push(`Source: ${sourceLabel(slot)}`);
  if (slot.source === "reader" && slot.noteId) lines.push(`Note: ${slot.noteId}`);
  if (slot.source === "research" && slot.mode) lines.push(`Mode: ${slot.mode}`);
  lines.push(`Selected text: ${slot.text}`);
  return lines;
}

export function buildSemanticQuery(query: string, snapshot: SelectionSnapshot): string {
  return `vec:${contextualLines(query, snapshot).join("\n")}`.trim();
}

export function buildKeywordQuery(query: string, snapshot: SelectionSnapshot): string {
  return contextualLines(query, snapshot).join("\n").trim();
}

export function displayQuery(query: string, fallback: string): string {
  return normalize(query) || fallback;
}
