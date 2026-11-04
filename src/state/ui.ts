// UI-only state that no snapshot from Rust carries: which pane (if any) slides in from the
// right, which project nodes are being flashed (a duplicate add highlights the node that is
// already there), which node is selected, where the context menu is open and the transient
// notice in the banner strip, and which expanded projects show all their children. Panes
// are mutually exclusive: opening one closes the other.
// Selection is one node or none; xyflow never owns it (`elementsSelectable` is off), the
// canvas writes it here on click and drag, the arrow commands on a key. Whenever the selection
// becomes a session that needs the operator (`finished` / `waiting`), a subscription below
// asks Rust to acknowledge it (Story 3.3): one place, whatever selected it. While the terminal
// pane is open, the selection also switches the pane to the node's terminal tab (Story 4.5).

import { create } from "zustand";
import { drawnFlowIds, isEdgeDrawn } from "../canvas/edges";
import type { CanvasTarget, ChildGroup } from "../canvas/nodes";
import { sessionAcknowledge, type Position, type Project } from "../ipc";
import {
  applyAcknowledgement,
  elsewhereCount,
  isAcknowledging,
  markAcknowledging,
  needsAttention,
  sessionState,
  unmarkAcknowledging,
  useLiveStore,
} from "./live";
import { plainTerminalId, sessionTerminalId, terminalInfo } from "./terminals";
import { useWorkspaceStore } from "./workspace";

/**
 * The right-hand panes; `launch` is the new-session sheet (Story 4.2), `worktree` the new-worktree sheet (Story 5.2),
 * `removeWorktree` the remove-worktree confirmation (Story 5.4), `edge` the edge inspector of the
 * selected edge (Story 6.1), `review` the Review pane: a node's working-tree diff (Story 8.1; Story
 * 7.4's review request on top when opened from one), `help` the Help pane (Story 10.1).
 */
export type Pane = "settings" | "import" | "terminal" | "launch" | "worktree" | "removeWorktree" | "edge" | "review" | "help";

/** The terminal pane's narrowest width, in CSS pixels. */
export const TERMINAL_MIN_WIDTH = 360;
/** The terminal pane's widest width, as a fraction of the window. */
export const TERMINAL_MAX_FRACTION = 0.9;
/** Where the dragged terminal pane width is remembered (a per-viewer convenience). */
export const TERMINAL_WIDTH_KEY = "switchboard.terminalWidth";

/** The default terminal pane width for a window `viewport` px wide: `min(720px, 70vw)`. */
export function defaultTerminalWidth(viewport: number): number {
  return Math.min(720, Math.round(viewport * 0.7));
}

/**
 * A terminal pane width kept between 360 px and 90vw (`viewport` px wide); 90vw wins in a
 * window too narrow for both. A non-finite width is the default.
 */
export function clampTerminalWidth(width: number, viewport: number): number {
  return clampWideWidth(width, viewport, defaultTerminalWidth(viewport));
}

/** Where the dragged Review pane width is remembered (a per-viewer convenience, Story 8.1). */
export const REVIEW_WIDTH_KEY = "switchboard.reviewWidth";

/** The default Review pane width for a window `viewport` px wide: `min(1100px, 85vw)` (Story 8.1). */
export function defaultReviewWidth(viewport: number): number {
  return Math.min(1100, Math.round(viewport * 0.85));
}

/** A Review pane width kept between 360 px and 90vw, like the terminal pane's; non-finite is the default. */
export function clampReviewWidth(width: number, viewport: number): number {
  return clampWideWidth(width, viewport, defaultReviewWidth(viewport));
}

/** A wide pane's width kept between 360 px and 90vw (90vw wins when the window is narrower); non-finite is `fallback`. */
function clampWideWidth(width: number, viewport: number, fallback: number): number {
  const max = Math.floor(viewport * TERMINAL_MAX_FRACTION);
  const wanted = Number.isFinite(width) ? width : fallback;
  return Math.max(Math.min(TERMINAL_MIN_WIDTH, max), Math.min(Math.round(wanted), max));
}

/** The minimal `Storage` slice the width uses; tests pass a fake. */
export type WidthStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): WidthStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The remembered terminal pane width, or `null` (none stored, unreadable storage). */
export function loadTerminalWidth(storage: WidthStorage | null = browserStorage()): number | null {
  return loadWidth(TERMINAL_WIDTH_KEY, storage);
}

/** The remembered width under `key`, or `null` (none stored, unreadable storage). */
export function loadWidth(key: string, storage: WidthStorage | null = browserStorage()): number | null {
  try {
    const raw = storage?.getItem(key);
    if (raw === null || raw === undefined) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

/** Remember the terminal pane width; storage that throws (private window) is ignored. */
export function saveTerminalWidth(width: number, storage: WidthStorage | null = browserStorage()): void {
  saveWidth(TERMINAL_WIDTH_KEY, width, storage);
}

/** Remember a width under `key`; storage that throws (private window) is ignored. */
export function saveWidth(key: string, width: number, storage: WidthStorage | null = browserStorage()): void {
  try {
    storage?.setItem(key, String(Math.round(width)));
  } catch {
    // A convenience only: the pane still works at its default width.
  }
}

/** How long a duplicate-add highlight stays on the existing node. */
export const FLASH_MS = 1500;

/** How long a notice stays in the banner strip. */
export const NOTICE_MS = 3000;

/** Where the context menu is open: a client (CSS pixel) point, usually the pointer. */
export type MenuPoint = { x: number; y: number };

/** Which context menu (Story 11.1): a right-clicked node's, or the canvas background's. */
export type MenuKind = "node" | "canvas";

/** An open context menu: where, and which one. */
export type OpenMenu = MenuPoint & { menu: MenuKind };

/**
 * A transient line in the banner strip: what a stub will do later, or why an action could
 * not run. Information, not attention: it renders without the accent. One at a time, the
 * newest wins; `commands/navigation`'s `notify` clears it after `NOTICE_MS`.
 */
export type Notice = { text: string };

export type UiState = {
  /** The open pane, or `null`. */
  pane: Pane | null;
  /** Project ids currently highlighted; reference-stable while unchanged. */
  flashed: readonly string[];
  /** The selected node (or `more` row), or `null`; reference-stable while it stays selected. */
  selection: CanvasTarget | null;
  /** The open context menu's anchor and kind, or `null` while closed. */
  contextMenu: OpenMenu | null;
  /** The notice showing, or `null`. */
  notice: Notice | null;
  /**
   * Project ids whose column shows every child rather than the first ten (`show all`). UI
   * only, never persisted; reference-stable while unchanged.
   */
  showAll: readonly string[];
  /** Project ids whose branch group shows every branch (Story 5.1); like `showAll`. */
  showAllBranches: readonly string[];
  /** Whether the Elsewhere tray's list is open (it shows only while it has rows). */
  elsewhereOpen: boolean;
  /** The terminal the terminal pane shows: the most recently opened or selected one. */
  activeTerminal: string | null;
  /**
   * The terminal pane's tabs, in order (Story 4.5): every terminal opened or shown in it, until
   * its × closes the tab. Reference-stable while unchanged.
   */
  openTerminals: readonly string[];
  /** Terminals popped out into their own window: terminal id → window label (Story 4.5). */
  poppedOut: Readonly<Record<string, string>>;
  /**
   * Whether the pane focuses the terminal it shows next: true for an open, a tab click or a tab
   * key, false when a canvas selection switched the tab (focus stays on the canvas).
   */
  focusOnShow: boolean;
  /** The dragged terminal pane width in CSS pixels, or `null` for the default. */
  terminalWidth: number | null;
  /** The dragged Review pane width in CSS pixels, or `null` for the default (Story 8.1). */
  reviewWidth: number | null;
  /** The guide page the Help pane shows, or `null` for Contents (Story 10.1). */
  helpPage: string | null;
  /** The heading the Help pane scrolls to on its page (a slug id), or `null` for the top. */
  helpAnchor: string | null;
  /** Bumped on every Help navigation, so following the same link again scrolls again. */
  helpNav: number;
  /**
   * The pane Help opened over (Story 10.2), kept as it was left: closing Help brings it back.
   * `null` when Help opened on the canvas or is not open.
   */
  helpReturn: Pane | null;
  /** The guide page last shown this run (in memory only), or `null`: where F1 opens with nothing else to go by. */
  helpLastRead: string | null;
  openPane: (pane: Pane) => void;
  /** Close whichever pane is open (no-op when none is). */
  closePane: () => void;
  /** Open `pane`, or close it when it is the one already open. */
  togglePane: (pane: Pane) => void;
  /** Start highlighting `ids` (adds to any already flashing). */
  flash: (ids: readonly string[]) => void;
  /** Stop highlighting `ids`; others keep flashing. */
  unflash: (ids: readonly string[]) => void;
  /** Select one node (replacing any selection); the same node again changes nothing. */
  select: (target: CanvasTarget) => void;
  clearSelection: () => void;
  /** Open a context menu at `at`; the node menu unless `menu` says otherwise. */
  openContextMenu: (at: MenuPoint, menu?: MenuKind) => void;
  closeContextMenu: () => void;
  /** Show `text` as the notice, replacing any showing. */
  showNotice: (text: string) => void;
  clearNotice: () => void;
  /** Show all of one group of a project's children (its sessions by default), or only the first ten again. */
  toggleShowAll: (projectId: string, group?: ChildGroup) => void;
  toggleElsewhere: () => void;
  openElsewhere: () => void;
  closeElsewhere: () => void;
  /** Show terminal `id` (as {@link UiState.openTab}), or none (`null`; the tabs stay). */
  setActiveTerminal: (id: string | null) => void;
  /** Add a tab for `id` at the end when missing and activate it; `focus` (default true) focuses it once shown. */
  openTab: (id: string, focus?: boolean) => void;
  /** Remove `id`'s tab; when it was active, its neighbour (right, else left) becomes active, or none. */
  closeTab: (id: string) => void;
  /** Activate the tab `delta` places from the active one, wrapping around (ctrl+pageup / pagedown). */
  nextTab: (delta: number) => void;
  /** Terminal `id` is popped out into window `label`, or back in the pane (`null`). */
  setPopped: (id: string, label: string | null) => void;
  setTerminalWidth: (width: number | null) => void;
  setReviewWidth: (width: number | null) => void;
  /** Show guide page `page` (`null`: Contents) in the Help pane, scrolled to `anchor` (`null`: the top). */
  setHelpPage: (page: string | null, anchor?: string | null) => void;
  /** Remember the pane Help opened over (`null`: none). */
  setHelpReturn: (pane: Pane | null) => void;
};

const NO_IDS: readonly string[] = Object.freeze([]);
const NO_POPPED: Readonly<Record<string, string>> = Object.freeze({});

/** `tabs` with `id` added at the end, or `tabs` itself when it is already there. */
export function withTab(tabs: readonly string[], id: string): readonly string[] {
  return tabs.includes(id) ? tabs : [...tabs, id];
}

/**
 * `tabs` without `id`, and the active tab after: unchanged unless `id` was active, then the tab
 * that takes its place (the one after it, else the one before), or `null` when none is left.
 * `tabs` itself comes back when `id` was not a tab.
 */
export function withoutTab(
  tabs: readonly string[],
  active: string | null,
  id: string,
): { tabs: readonly string[]; active: string | null } {
  const index = tabs.indexOf(id);
  if (index < 0) return { tabs, active: active === id ? null : active };
  const next = tabs.filter((tab) => tab !== id);
  if (active !== id) return { tabs: next, active };
  return { tabs: next, active: next[index] ?? next[index - 1] ?? null };
}

/**
 * The tab `delta` places from `active`, wrapping around; the first tab when `active` is not
 * one; `null` without tabs.
 */
export function stepTab(tabs: readonly string[], active: string | null, delta: number): string | null {
  if (tabs.length === 0) return null;
  const index = active === null ? -1 : tabs.indexOf(active);
  if (index < 0) return tabs[0] ?? null;
  const n = tabs.length;
  return tabs[(((index + delta) % n) + n) % n] ?? null;
}

/** True when terminal `id` is popped out into its own window (Story 4.5). */
export function isPoppedOut(id: string | null): boolean {
  return id !== null && Object.hasOwn(useUiStore.getState().poppedOut, id);
}

export const useUiStore = create<UiState>()((set, get) => ({
  pane: null,
  flashed: NO_IDS,
  selection: null,
  contextMenu: null,
  notice: null,
  showAll: NO_IDS,
  showAllBranches: NO_IDS,
  elsewhereOpen: false,
  activeTerminal: null,
  openTerminals: NO_IDS,
  poppedOut: NO_POPPED,
  focusOnShow: true,
  terminalWidth: loadTerminalWidth(),
  reviewWidth: loadWidth(REVIEW_WIDTH_KEY),
  helpPage: null,
  helpAnchor: null,
  helpNav: 0,
  helpReturn: null,
  helpLastRead: null,
  openPane: (pane) => set({ pane }),
  closePane: () => set({ pane: null }),
  togglePane: (pane) => set({ pane: get().pane === pane ? null : pane }),
  flash: (ids) => {
    if (ids.length === 0) return;
    set((s) => {
      const next = [...s.flashed];
      for (const id of ids) if (!next.includes(id)) next.push(id);
      return next.length === s.flashed.length ? {} : { flashed: next };
    });
  },
  unflash: (ids) => {
    if (ids.length === 0) return;
    set((s) => {
      const next = s.flashed.filter((id) => !ids.includes(id));
      if (next.length === s.flashed.length) return {};
      return { flashed: next.length === 0 ? NO_IDS : next };
    });
  },
  select: (target) =>
    set((s) => (sameTarget(s.selection, target) ? {} : { selection: copyTarget(target) })),
  clearSelection: () => set((s) => (s.selection === null ? {} : { selection: null })),
  openContextMenu: (at, menu = "node") => set({ contextMenu: { x: at.x, y: at.y, menu } }),
  closeContextMenu: () => set((s) => (s.contextMenu === null ? {} : { contextMenu: null })),
  showNotice: (text) => set({ notice: { text } }),
  clearNotice: () => set((s) => (s.notice === null ? {} : { notice: null })),
  toggleShowAll: (projectId, group = "sessions") =>
    set((s) => {
      const field = group === "sessions" ? "showAll" : "showAllBranches";
      const list = s[field];
      if (!list.includes(projectId)) return { [field]: [...list, projectId] };
      const next = list.filter((id) => id !== projectId);
      return { [field]: next.length === 0 ? NO_IDS : next };
    }),
  toggleElsewhere: () => set((s) => ({ elsewhereOpen: !s.elsewhereOpen })),
  openElsewhere: () => set((s) => (s.elsewhereOpen ? {} : { elsewhereOpen: true })),
  closeElsewhere: () => set((s) => (s.elsewhereOpen ? { elsewhereOpen: false } : {})),
  setActiveTerminal: (id) => {
    if (id === null) set((s) => (s.activeTerminal === null ? {} : { activeTerminal: null }));
    else get().openTab(id);
  },
  openTab: (id, focus = true) =>
    set((s) => {
      const tabs = withTab(s.openTerminals, id);
      if (tabs === s.openTerminals && s.activeTerminal === id && s.focusOnShow === focus) return {};
      return { openTerminals: tabs, activeTerminal: id, focusOnShow: focus };
    }),
  closeTab: (id) =>
    set((s) => {
      const next = withoutTab(s.openTerminals, s.activeTerminal, id);
      if (next.tabs === s.openTerminals) return {};
      return { openTerminals: next.tabs.length === 0 ? NO_IDS : next.tabs, activeTerminal: next.active, focusOnShow: true };
    }),
  nextTab: (delta) =>
    set((s) => {
      const id = stepTab(s.openTerminals, s.activeTerminal, delta);
      return id === null || id === s.activeTerminal ? {} : { activeTerminal: id, focusOnShow: true };
    }),
  setPopped: (id, label) =>
    set((s) => {
      const current = Object.hasOwn(s.poppedOut, id) ? s.poppedOut[id] : undefined;
      if ((current ?? null) === label) return {};
      const poppedOut = { ...s.poppedOut };
      if (label === null) delete poppedOut[id];
      else poppedOut[id] = label;
      return { poppedOut };
    }),
  setTerminalWidth: (width) => set((s) => (s.terminalWidth === width ? {} : { terminalWidth: width })),
  setReviewWidth: (width) => set((s) => (s.reviewWidth === width ? {} : { reviewWidth: width })),
  setHelpPage: (page, anchor = null) =>
    set((s) => ({
      helpPage: page,
      helpAnchor: page === null ? null : anchor,
      helpNav: s.helpNav + 1,
      helpLastRead: page ?? s.helpLastRead,
    })),
  setHelpReturn: (pane) => set((s) => (s.helpReturn === pane ? {} : { helpReturn: pane })),
}));

// The tray's list closes for good when its last row leaves, so a later row shows the chip
// alone instead of popping the list open again.
useLiveStore.subscribe((live) => {
  if (live.snapshot.elsewhere.length === 0 && useUiStore.getState().elsewhereOpen) useUiStore.getState().closeElsewhere();
});

/**
 * Ask Rust to acknowledge session `id` when it needs attention, whether or not an
 * acknowledgement is already marked on its way (the reveal marks it before it awaits). It
 * sends the `attention_since` the frontend saw, so an older turn never clears a newer one,
 * and applies the session from the reply at once (an emit Rust failed cannot leave the
 * accent on). Resolves whether a request was sent; a failure (no runtime) is logged, never
 * shown.
 */
export function sendAcknowledge(id: string): boolean {
  const session = Object.hasOwn(useLiveStore.getState().snapshot.sessions, id) ? useLiveStore.getState().snapshot.sessions[id] : undefined;
  if (session === undefined || !needsAttention(session.state)) {
    unmarkAcknowledging(id);
    return false;
  }
  const since = session.attention_since;
  markAcknowledging(id);
  sessionAcknowledge(id, since).then(
    (reply) => {
      if (reply === null) unmarkAcknowledging(id);
      else applyAcknowledgement(id, since, reply);
    },
    (err: unknown) => {
      unmarkAcknowledging(id);
      console.warn(`session acknowledge failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  );
  return true;
}

/**
 * Acknowledge `target` when it is a session that needs attention and no acknowledgement for
 * it is already on its way (see {@link sendAcknowledge}). Resolves whether a request was sent.
 */
export function acknowledgeIfNeeded(target: CanvasTarget | null): boolean {
  if (target === null || target.kind !== "session") return false;
  if (!needsAttention(sessionState(target.id)) || isAcknowledging(target.id)) return false;
  return sendAcknowledge(target.id);
}

// The selection becoming a session in attention acknowledges it (a click, an arrow, a toast
// click, `attention.next`). Selecting a project acknowledges nothing. Opening the Elsewhere
// tray acknowledges every session it lists that needs attention (they cannot be selected).
useUiStore.subscribe((ui, previous) => {
  if (ui.selection !== previous.selection) {
    acknowledgeIfNeeded(ui.selection);
    followSelection(ui.selection);
    // The edge inspector shows the selected edge (Story 6.1): it goes with it.
    if (ui.pane === "edge" && ui.selection?.kind !== "edge") useUiStore.getState().closePane();
  }
  if (ui.selection !== previous.selection || ui.showAll !== previous.showAll || ui.showAllBranches !== previous.showAllBranches) {
    dropHiddenEdge();
  }
  if (ui.elsewhereOpen && !previous.elsewhereOpen) {
    for (const row of useLiveStore.getState().snapshot.elsewhere) {
      if (needsAttention(row.state)) acknowledgeIfNeeded({ kind: "session", id: row.session_id });
    }
  }
});

/**
 * A selected edge that is no longer drawn -- deleted, pruned with its project, or an end hidden
 * (collapsed, cut by the limit) -- is no longer selected (which closes its inspector), so Del never
 * deletes an edge the operator cannot see.
 */
function dropHiddenEdge(): void {
  const ui = useUiStore.getState();
  const selection = ui.selection;
  const snapshot = useWorkspaceStore.getState().snapshot;
  if (selection === null || selection.kind !== "edge" || snapshot === null) return;
  const edge = snapshot.workspace.edges.find((e) => e.id === selection.id);
  const drawn = drawnFlowIds(snapshot.workspace.projects, snapshot.children, ui.showAll, ui.showAllBranches);
  if (edge === undefined || !isEdgeDrawn(edge, drawn)) ui.clearSelection();
}

useWorkspaceStore.subscribe(dropHiddenEdge);

/**
 * The terminal a selected node has, when it has one: a session's Switchboard terminal, or a
 * project's plain terminal (open or exited). Else `null`.
 */
export function terminalOfTarget(target: CanvasTarget | null): string | null {
  if (target === null) return null;
  const id =
    target.kind === "session" ? sessionTerminalId(target.id) : target.kind === "project" ? plainTerminalId(target.id) : null;
  return id !== null && terminalInfo(id) !== null ? id : null;
}

/**
 * Selection follows the tab (Story 4.5): while the terminal pane is open, selecting a node with
 * a terminal switches to that terminal's tab (adding it when missing); focus stays on the canvas.
 * With the pane closed nothing changes.
 */
export function followSelection(target: CanvasTarget | null): void {
  const ui = useUiStore.getState();
  if (ui.pane !== "terminal") return;
  const id = terminalOfTarget(target);
  if (id !== null && id !== ui.activeTerminal) ui.openTab(id, false);
}

/** True when both name the same node (or both are `null`). */
export function sameTarget(a: CanvasTarget | null, b: CanvasTarget | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.kind === b.kind &&
      a.id === b.id &&
      (a.kind !== "more" || b.kind !== "more" || (a.group ?? "sessions") === (b.group ?? "sessions")))
  );
}

/** A fresh copy of a target (a `more` row keeps its group). */
function copyTarget(target: CanvasTarget): CanvasTarget {
  if (target.kind === "more" && target.group !== undefined) return { kind: "more", id: target.id, group: target.group };
  return { kind: target.kind, id: target.id } as CanvasTarget;
}

/** True when a pane is open: with the palette and menu closed, that is the `when` of `pane.close`. */
export function isPaneOpen(): boolean {
  return useUiStore.getState().pane !== null;
}

/** True when a node is selected: the `when` of `selection.clear` once everything else is closed. */
export function hasSelection(): boolean {
  return useUiStore.getState().selection !== null;
}

/** True while the context menu shows: the `when` of `contextMenu.close`, first in the Esc order. */
export function isContextMenuOpen(): boolean {
  return useUiStore.getState().contextMenu !== null;
}

/**
 * True while the Elsewhere tray's list shows: opened and with at least one row (a tray whose
 * last row left closes with its chip). The `when` of `elsewhere.close`, second in the Esc order.
 */
export function isElsewhereOpen(): boolean {
  return useUiStore.getState().elsewhereOpen && elsewhereCount() > 0;
}

/**
 * The selected project, or `null` when nothing (or a child) is selected or the project is no
 * longer in the snapshot. The target of `project.expand`, `project.collapse` and
 * `project.relayout`.
 */
export function selectedProject(): Project | null {
  const selection = useUiStore.getState().selection;
  if (selection === null || selection.kind !== "project") return null;
  const projects = useWorkspaceStore.getState().snapshot?.workspace.projects;
  return projects?.find((p) => p.id === selection.id) ?? null;
}

/** The size of something to be placed, and of the area it must fit in. */
export type Size = { width: number; height: number };

/**
 * Where a box of `size` opened at `at` goes so it stays inside an area of `within`: shifted
 * left/up as far as needed, never past the area's top-left. The context menu uses it with the
 * window; a box larger than the area sits at the origin.
 */
export function clampToArea(at: Position, size: Size, within: Size): Position {
  return {
    x: Math.max(0, Math.min(at.x, within.width - size.width)),
    y: Math.max(0, Math.min(at.y, within.height - size.height)),
  };
}
