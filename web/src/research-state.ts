export type ResearchDisplayDecision =
  | "shown"
  | "blocked-pinned"
  | "blocked-dirty"
  | "missing";

export interface ResearchDisplayState {
  targetId: string;
  visibleId: string | null;
  pinnedId: string | null;
  hasUnsavedLocalEdits: boolean;
  targetExists: boolean;
}

export interface ResearchDisplayAcknowledgment {
  decision: ResearchDisplayDecision;
  visibleId: string | null;
  pinnedId: string | null;
}

export function decideAgentResearchDisplay(
  state: ResearchDisplayState,
): ResearchDisplayDecision {
  if (!state.targetExists) return "missing";
  if (state.pinnedId !== null && state.targetId !== state.pinnedId)
    return "blocked-pinned";
  if (state.targetId === state.visibleId && state.hasUnsavedLocalEdits)
    return "blocked-dirty";
  return "shown";
}

export function clearStaleResearchPin(
  pinnedId: string | null,
  historyIds: readonly string[],
): string | null {
  return pinnedId !== null && !historyIds.includes(pinnedId) ? null : pinnedId;
}
