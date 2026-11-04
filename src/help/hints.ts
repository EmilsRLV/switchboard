// Inline hints (Story 11.3): short captions beside the first project and the first live session
// naming the next key, while the Getting started checklist is in play. `hintsFor` is pure: it
// reads the slices it is given; `useNodeHint` feeds it from the stores for one card.
//
// - `project`: under the first project card (`workspace.projects` order), `n new session · hover
//   for more`, until step `session` is done.
// - `handle`: on that same card while its link handle shows (hovered or selected), `drag to link
//   · e`, until step `edge` is done. It replaces the `project` hint: a card has at most one.
// - `review`: right of the first session child (snapshot order) in a live state whose card is
//   drawn (its project expanded, and not cut by `show all`), `r review changes`, until step
//   `review` is done.
//
// They show while hints are on (`hintsOn`: `state.json`'s `hints.hidden`, and the checklist card)
// and never while a pane is open or the first-run tour is on (Story 11.6: the card is held back
// then, and the hints follow it). The keys come from the registry, so a rebind shows.

import { useMemo, useSyncExternalStore } from "react";
import type { ChildNode, LiveSession, NodeTarget, Project } from "../ipc";
import { commandKey } from "../commands/keybindings";
import { subscribeBindings } from "../commands/registry";
import { cardVisible, useChecklistStore } from "../state/checklist";
import { hintsOn, useHintsStore } from "../state/hints";
import { isTourOn, useTourStore } from "../state/tour";
import { isLiveState, useLiveStore } from "../state/live";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { projectColumn } from "../canvas/nodes";
import type { StepId } from "./checklist";

export type HintKind = "project" | "handle" | "review";

export type Hint = { target: NodeTarget; kind: HintKind; text: string };

/** At most this many hints on the canvas. */
export const MAX_HINTS = 3;

/** The commands whose keys the hints name. */
export const HINT_COMMANDS: Readonly<Record<HintKind, string>> = {
  project: "project.newSession",
  handle: "edge.link",
  review: "review.changes",
};

/** The step whose latching ends each hint for good. */
export const HINT_STEPS: Readonly<Record<HintKind, StepId>> = {
  project: "session",
  handle: "edge",
  review: "review",
};

/** What `hintsFor` reads. */
export type HintSources = {
  /** The projects, in `workspace.projects` order. */
  projects: readonly Pick<Project, "id" | "expanded">[];
  /** The children, in snapshot order. */
  children: readonly HintChild[];
  /** The projects showing all their sessions / branches (the ui store's `showAll`, `showAllBranches`). */
  showAll: readonly string[];
  showAllBranches: readonly string[];
  /** Every session the live poll has seen, by id. */
  sessions: Readonly<Record<string, Pick<LiveSession, "state">>>;
  /** The first project's link handle shows (the card is hovered or selected). */
  handleShown: boolean;
  /** The Getting started card is on the canvas. */
  cardVisible: boolean;
  /** A pane is open: no hints are drawn. */
  paneOpen: boolean;
  /** Each hint command's effective key (`commandKey`), `null` when unbound. */
  keys: Readonly<Record<HintKind, string | null>>;
};

/** What the hints read of a child: enough to know whether its card is drawn (`projectColumn`). */
export type HintChild = Pick<ChildNode, "id" | "kind" | "projectId" | "position" | "branchId">;

/** Whether any step a hint names is still undone; none left, there is nothing to compute. */
export function anyHintStepUndone(done: readonly StepId[]): boolean {
  return Object.values(HINT_STEPS).some((step) => !done.includes(step));
}

/** `key rest`, or just `rest` when there is no key. */
function keyed(key: string | null, rest: string): string {
  return key === null ? rest : `${key} ${rest}`;
}

/** The hint texts, with the keys given. */
export function hintText(kind: HintKind, key: string | null): string {
  if (kind === "project") return keyed(key, "new session · hover for more");
  if (kind === "handle") return key === null ? "drag to link" : `drag to link · ${key}`;
  return keyed(key, "review changes");
}

/**
 * The first session child in a live state whose card is drawn, in snapshot order; `null` when
 * none. Drawn is the canvas's rule: the project is expanded and `projectColumn` keeps the card
 * (not cut by `show all`, unless dragged).
 */
export function firstLiveSession(s: Pick<HintSources, "projects" | "children" | "sessions" | "showAll" | "showAllBranches">): string | null {
  const isLive = (child: HintChild) => {
    if (child.kind !== "session" || !Object.hasOwn(s.sessions, child.id)) return false;
    const session = s.sessions[child.id];
    return session !== undefined && isLiveState(session.state);
  };
  if (!s.children.some(isLive)) return null;
  const byProject = new Map<string, HintChild[]>();
  for (const child of s.children) {
    const list = byProject.get(child.projectId);
    if (list === undefined) byProject.set(child.projectId, [child]);
    else list.push(child);
  }
  const drawn = new Set<string>();
  for (const project of s.projects) {
    if (!project.expanded) continue;
    for (const entry of projectColumn(project.id, byProject.get(project.id) ?? [], s.showAll, s.showAllBranches).drawn) drawn.add(entry.child.id);
  }
  return s.children.find((child) => isLive(child) && drawn.has(child.id))?.id ?? null;
}

/**
 * The hints to draw now: at most one per card and `MAX_HINTS` in all. `done` is the checklist's
 * latched steps; `hidden` is `state.json`'s `hints.hidden` (`null` follows the card).
 */
export function hintsFor(s: HintSources, done: readonly StepId[], hidden: boolean | null): Hint[] {
  if (!hintsOn(hidden, s.cardVisible) || s.paneOpen || !anyHintStepUndone(done)) return [];
  const undone = (kind: HintKind) => !done.includes(HINT_STEPS[kind]);
  const hint = (kind: HintKind, target: NodeTarget): Hint => ({ target, kind, text: hintText(kind, s.keys[kind]) });
  const out: Hint[] = [];
  const first = s.projects[0];
  if (first !== undefined) {
    const target: NodeTarget = { kind: "project", id: first.id };
    if (s.handleShown && undone("handle")) out.push(hint("handle", target));
    else if (undone("project")) out.push(hint("project", target));
  }
  const session = firstLiveSession(s);
  if (session !== null && undone("review")) out.push(hint("review", { kind: "session", id: session }));
  return out.slice(0, MAX_HINTS);
}

/** The hint `hints` holds for `target`, if any. */
export function hintOf(hints: readonly Hint[], target: NodeTarget): Hint | null {
  return hints.find((h) => h.target.kind === target.kind && h.target.id === target.id) ?? null;
}

const NO_PROJECTS: readonly Project[] = [];
const NO_CHILDREN: readonly ChildNode[] = [];
const NO_HINTS: Hint[] = [];

/** The hint keys as the registry has them now. */
export function hintKeys(): Record<HintKind, string | null> {
  return {
    project: commandKey(HINT_COMMANDS.project),
    handle: commandKey(HINT_COMMANDS.handle),
    review: commandKey(HINT_COMMANDS.review),
  };
}

/** The hints now, from the stores; `handleShown` is the first project's handle showing. */
export function currentHints(handleShown: boolean): Hint[] {
  const checklist = useChecklistStore.getState();
  const hidden = useHintsStore.getState().hidden;
  // Off, or nothing left to hint: no work at all (every card runs this on every store change).
  // Story 11.6: none while the tour is on (it holds the Getting started card back too).
  if (isTourOn() || !hintsOn(hidden, cardVisible(checklist)) || !anyHintStepUndone(checklist.done)) return NO_HINTS;
  const workspace = useWorkspaceStore.getState().snapshot;
  const ui = useUiStore.getState();
  return hintsFor(
    {
      projects: workspace?.workspace.projects ?? NO_PROJECTS,
      children: workspace?.children ?? NO_CHILDREN,
      sessions: useLiveStore.getState().snapshot.sessions,
      showAll: ui.showAll,
      showAllBranches: ui.showAllBranches,
      handleShown,
      cardVisible: cardVisible(checklist),
      paneOpen: ui.pane !== null,
      keys: hintKeys(),
    },
    checklist.done,
    hidden,
  );
}

/** Call `listener` whenever anything `currentHints` reads changes; returns the unsubscribe. */
export function subscribeHintSources(listener: () => void): () => void {
  const unsubscribes = [
    useWorkspaceStore.subscribe(listener),
    useLiveStore.subscribe(listener),
    useChecklistStore.subscribe(listener),
    useHintsStore.subscribe(listener),
    useTourStore.subscribe(listener),
    useUiStore.subscribe(listener),
    subscribeBindings(listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** A hint as one string (`kind|text`: a kind never holds `|`), `""` for none: a stable snapshot for React. */
function encode(hint: Hint | null): string {
  return hint === null ? "" : `${hint.kind}|${hint.text}`;
}

function decode(target: NodeTarget, key: string): Hint | null {
  if (key === "") return null;
  const at = key.indexOf("|");
  return { target, kind: key.slice(0, at) as HintKind, text: key.slice(at + 1) };
}

/**
 * Story 11.3: the hint for one card now, from the stores: the workspace (projects, children), the
 * live poll, the checklist (steps done, card shown), the hints setting, the pane and the bindings.
 * `handleShown` is the card's link handle showing (hovered or selected). The card re-renders only
 * when its own hint changes (the snapshot is a string). Returns the hint (or `null`) and whether a
 * pane is open, so a hint that goes under a pane goes at once (no fade).
 */
export function useNodeHint(target: NodeTarget, handleShown: boolean): { hint: Hint | null; paneOpen: boolean } {
  const { kind, id } = target;
  const snapshot = () => encode(hintOf(currentHints(handleShown), { kind, id }));
  const key = useSyncExternalStore(subscribeHintSources, snapshot, snapshot);
  const paneOpen = useUiStore((st) => st.pane !== null);
  return { hint: useMemo(() => decode({ kind, id }, key), [kind, id, key]), paneOpen };
}
