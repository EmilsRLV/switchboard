// UI-only state that no snapshot from Rust carries: which pane (if any) slides in from the
// right, which project nodes are being flashed (a duplicate add highlights the node that is
// already there), which node is selected, where the context menu is open and the transient
// notice in the banner strip, and which expanded projects show all their children. Panes
// are mutually exclusive: opening one closes the other.
// Selection is one node or none; xyflow never owns it (`elementsSelectable` is off), the
// canvas writes it here on click and drag, the arrow commands on a key. Whenever the selection
// becomes a session that needs the operator (`finished` / `waiting`), a subscription below
// asks Rust to acknowledge it (Story 3.3): one place, whatever selected it.

import { create } from "zustand";
import type { CanvasTarget } from "../canvas/nodes";
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
import { useWorkspaceStore } from "./workspace";

export type Pane = "settings" | "import" | "terminal";

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
  if (!Number.isFinite(width)) return defaultTerminalWidth(viewport);
  const max = Math.floor(viewport * TERMINAL_MAX_FRACTION);
  return Math.max(Math.min(TERMINAL_MIN_WIDTH, max), Math.min(Math.round(width), max));
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
  try {
    const raw = storage?.getItem(TERMINAL_WIDTH_KEY);
    if (raw === null || raw === undefined) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

/** Remember the terminal pane width; storage that throws (private window) is ignored. */
export function saveTerminalWidth(width: number, storage: WidthStorage | null = browserStorage()): void {
  try {
    storage?.setItem(TERMINAL_WIDTH_KEY, String(Math.round(width)));
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
  /** The terminal the terminal pane shows: the most recently opened or selected one. */
  activeTerminal: string | null;
  /** The dragged terminal pane width in CSS pixels, or `null` for the default. */
  terminalWidth: number | null;
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
  openElsewhere: () => void;
  closeElsewhere: () => void;
  setActiveTerminal: (id: string | null) => void;
  setTerminalWidth: (width: number | null) => void;
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
  activeTerminal: null,
  terminalWidth: loadTerminalWidth(),
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
  openElsewhere: () => set((s) => (s.elsewhereOpen ? {} : { elsewhereOpen: true })),
  closeElsewhere: () => set((s) => (s.elsewhereOpen ? { elsewhereOpen: false } : {})),
  setActiveTerminal: (id) => set((s) => (s.activeTerminal === id ? {} : { activeTerminal: id })),
  setTerminalWidth: (width) => set((s) => (s.terminalWidth === width ? {} : { terminalWidth: width })),
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
  if (ui.selection !== previous.selection) acknowledgeIfNeeded(ui.selection);
  if (ui.elsewhereOpen && !previous.elsewhereOpen) {
    for (const row of useLiveStore.getState().snapshot.elsewhere) {
      if (needsAttention(row.state)) acknowledgeIfNeeded({ kind: "session", id: row.session_id });
    }
  }
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
