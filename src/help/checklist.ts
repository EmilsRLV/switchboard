// The Getting started checklist (Story 10.3): six first moves, each ticked from the app's state
// (whatever route the operator took), never from which button was pressed. The step ids are
// mirrored by `appstate::STEP_IDS` in Rust, which refuses any other. `detectSteps` is pure: it
// reads the slices of the stores it is given; `checklistSources` reads them now.

import type { LiveSession, SessionState, TermInfo } from "../ipc";
import { useLiveStore } from "../state/live";
import { usePaletteStore } from "../state/palette";
import { useReviewStore } from "../state/review";
import { sessionIdOfTerminal, useTerminalStore } from "../state/terminals";
import { useUiStore, type Pane } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";

export type StepId = "palette" | "project" | "session" | "terminal" | "edge" | "review";

export type ChecklistStep = {
  id: StepId;
  /** What the row says. */
  title: string;
  /** How to do it, as the app's keys say it; `null` when there is no key. */
  keys: string | null;
  /** The command the row's button runs while it is enabled. */
  command: string;
};

/** The six steps, in order. */
export const CHECKLIST_STEPS: readonly ChecklistStep[] = [
  { id: "palette", title: "Open the command palette", keys: "ctrl+k", command: "palette.toggle" },
  { id: "project", title: "Add a project", keys: "ctrl+o or drop a folder", command: "project.add" },
  { id: "session", title: "Start a session", keys: "n on a project node", command: "project.newSession" },
  { id: "terminal", title: "Open a plain terminal", keys: null, command: "project.terminal" },
  { id: "edge", title: "Link two nodes", keys: "e", command: "edge.link" },
  { id: "review", title: "Review changes", keys: "r", command: "review.changes" },
];

export const STEP_IDS: readonly StepId[] = CHECKLIST_STEPS.map((step) => step.id);

/** True when `id` is one of the six step ids. */
export function isStepId(id: string): id is StepId {
  return (STEP_IDS as readonly string[]).includes(id);
}

/** The known ids of `ids`, once each, in checklist order. */
export function normaliseSteps(ids: Iterable<string>): StepId[] {
  const set = new Set(ids);
  return STEP_IDS.filter((id) => set.has(id));
}

/** What the detection reads from the stores. */
export type ChecklistSources = {
  /** The palette is open (as the command palette or a pick list). */
  paletteOpen: boolean;
  projectCount: number;
  edgeCount: number;
  /** Every terminal Switchboard runs, by id. */
  terminals: Readonly<Record<string, TermInfo>>;
  /** Every session the live poll has seen, by id. */
  sessions: Readonly<Record<string, LiveSession>>;
  pane: Pane | null;
  /** The Review pane has something to show. */
  reviewTarget: boolean;
};

/** A session that got past `starting`: it ran. */
function hasStarted(state: SessionState | undefined): boolean {
  return state !== undefined && (state.kind === "busy" || state.kind === "idle" || state.kind === "waiting" || state.kind === "finished");
}

/** The steps true in `s` now. Latching (a step stays done) is the store's business. */
export function detectSteps(s: ChecklistSources): Set<StepId> {
  const done = new Set<StepId>();
  if (s.paletteOpen) done.add("palette");
  if (s.projectCount > 0) done.add("project");
  if (s.edgeCount > 0) done.add("edge");
  if (s.pane === "review" && s.reviewTarget) done.add("review");
  for (const info of Object.values(s.terminals)) {
    if (info.kind === "plain" && info.error === null) done.add("terminal");
    if (info.kind !== "session") continue;
    const sessionId = sessionIdOfTerminal(info.id);
    if (sessionId !== null && Object.hasOwn(s.sessions, sessionId) && hasStarted(s.sessions[sessionId]?.state)) done.add("session");
  }
  return done;
}

/** The sources as the stores hold them now. */
export function checklistSources(): ChecklistSources {
  const workspace = useWorkspaceStore.getState().snapshot?.workspace;
  return {
    paletteOpen: usePaletteStore.getState().isOpen,
    projectCount: workspace?.projects.length ?? 0,
    edgeCount: workspace?.edges.length ?? 0,
    terminals: useTerminalStore.getState().infos,
    sessions: useLiveStore.getState().snapshot.sessions,
    pane: useUiStore.getState().pane,
    reviewTarget: useReviewStore.getState().target !== null,
  };
}

/** Call `listener` whenever a store the detection reads changes; returns the unsubscribe. */
export function subscribeSources(listener: () => void): () => void {
  const unsubscribes = [
    usePaletteStore.subscribe(listener),
    useWorkspaceStore.subscribe(listener),
    useTerminalStore.subscribe(listener),
    useLiveStore.subscribe(listener),
    useUiStore.subscribe(listener),
    useReviewStore.subscribe(listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
