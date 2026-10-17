// UI-only state that no snapshot from Rust carries: which pane (if any) slides in from the
// right, which project nodes are being flashed (a duplicate add highlights the node that is
// already there), which node is selected, where the context menu is open and the transient
// notice in the banner strip, and which expanded projects show all their children. Panes
// are mutually exclusive: opening one closes the other.
// Selection is one node or none; xyflow never owns it (`elementsSelectable` is off), the
// canvas writes it here on click and drag, the arrow commands on a key.

import { create } from "zustand";
import type { CanvasTarget } from "../canvas/nodes";
import type { Position, Project } from "../ipc";
import { elsewhereCount, useLiveStore } from "./live";
import { useWorkspaceStore } from "./workspace";

export type Pane = "settings" | "import";

/** How long a duplicate-add highlight stays on the existing node. */
export const FLASH_MS = 1500;

/** How long a notice stays in the banner strip. */
export const NOTICE_MS = 3000;

/** Where the context menu is open: a client (CSS pixel) point, usually the pointer. */
export type MenuPoint = { x: number; y: number };

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
  /** The open context menu's anchor, or `null` while closed. */
  contextMenu: MenuPoint | null;
  /** The notice showing, or `null`. */
  notice: Notice | null;
  /**
   * Project ids whose column shows every child rather than the first ten (`show all`). UI
   * only, never persisted; reference-stable while unchanged.
   */
  showAll: readonly string[];
  /** Whether the Elsewhere tray's list is open (it shows only while it has rows). */
  elsewhereOpen: boolean;
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
  openContextMenu: (at: MenuPoint) => void;
  closeContextMenu: () => void;
  /** Show `text` as the notice, replacing any showing. */
  showNotice: (text: string) => void;
  clearNotice: () => void;
  /** Show all of a project's children, or only the first ten again. */
  toggleShowAll: (projectId: string) => void;
  toggleElsewhere: () => void;
  closeElsewhere: () => void;
};

const NO_IDS: readonly string[] = Object.freeze([]);

export const useUiStore = create<UiState>()((set, get) => ({
  pane: null,
  flashed: NO_IDS,
  selection: null,
  contextMenu: null,
  notice: null,
  showAll: NO_IDS,
  elsewhereOpen: false,
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
    set((s) => (sameTarget(s.selection, target) ? {} : { selection: { kind: target.kind, id: target.id } })),
  clearSelection: () => set((s) => (s.selection === null ? {} : { selection: null })),
  openContextMenu: (at) => set({ contextMenu: { x: at.x, y: at.y } }),
  closeContextMenu: () => set((s) => (s.contextMenu === null ? {} : { contextMenu: null })),
  showNotice: (text) => set({ notice: { text } }),
  clearNotice: () => set((s) => (s.notice === null ? {} : { notice: null })),
  toggleShowAll: (projectId) =>
    set((s) => {
      if (!s.showAll.includes(projectId)) return { showAll: [...s.showAll, projectId] };
      const next = s.showAll.filter((id) => id !== projectId);
      return { showAll: next.length === 0 ? NO_IDS : next };
    }),
  toggleElsewhere: () => set((s) => ({ elsewhereOpen: !s.elsewhereOpen })),
  closeElsewhere: () => set((s) => (s.elsewhereOpen ? { elsewhereOpen: false } : {})),
}));

// The tray's list closes for good when its last row leaves, so a later row shows the chip
// alone instead of popping the list open again.
useLiveStore.subscribe((live) => {
  if (live.snapshot.elsewhere.length === 0 && useUiStore.getState().elsewhereOpen) useUiStore.getState().closeElsewhere();
});

/** True when both name the same node (or both are `null`). */
export function sameTarget(a: CanvasTarget | null, b: CanvasTarget | null): boolean {
  return a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);
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
