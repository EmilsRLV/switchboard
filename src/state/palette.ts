import { create } from "zustand";
import type { Keybinding } from "../commands/keybindings";
import { runCommand, type Command } from "../commands/registry";
import { isTourOn, useTourStore } from "./tour";

/** One row of a pick list (see {@link PalettePick}). */
export type PickItem = { id: string; title: string };

/**
 * The palette as a pick list (Story 6.1, "Link to…"): instead of the commands it lists `items`,
 * filtered the same way; Enter (or a click) closes it and hands the chosen row's id to
 * `onPick`; Esc closes it with nothing picked.
 */
export type PalettePick = {
  /** The input's placeholder and the list's accessible name. */
  placeholder: string;
  items: readonly PickItem[];
  onPick: (id: string) => void;
};

/**
 * UI state of the command palette: whether it is showing, what has been typed and which row
 * is selected. The commands themselves live in the registry; this store only filters them.
 */
export type PaletteState = {
  isOpen: boolean;
  /** The pick list showing in place of the commands, or `null` (the command palette). */
  pick: PalettePick | null;
  query: string;
  /** Index into the filtered list; clamped by `move`, reset by `setQuery` and `open`. */
  selected: number;
  /** Show the palette with an empty query and the first row selected. */
  open: () => void;
  /** Show the palette as the pick list `pick`, with an empty query and the first row selected. */
  openPick: (pick: PalettePick) => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  /** Move the selection by `delta` rows, clamped to `[0, count - 1]` (0 when the list is empty). */
  move: (delta: number, count: number) => void;
  /** The commands matching the current query, in the order given. */
  filtered: <C extends Pick<Command, "id" | "title">>(commands: readonly C[]) => C[];
};

/** Case-insensitive substring match of `query` against each command's title and id. */
export function filterCommands<C extends Pick<Command, "id" | "title">>(
  commands: readonly C[],
  query: string,
): C[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...commands];
  return commands.filter(
    (command) =>
      command.title.toLowerCase().includes(needle) || command.id.toLowerCase().includes(needle),
  );
}

/** Case-insensitive substring match of `query` against each pick row's title only (its id is internal). */
export function filterPickItems<I extends PickItem>(items: readonly I[], query: string): I[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...items];
  return items.filter((item) => item.title.toLowerCase().includes(needle));
}

/**
 * One row the palette shows: a command (with its key, and `keyFrom` when it shows another
 * command's, Story 11.1) or a pick row (without).
 */
export type PaletteRow = { id: string; title: string; binding: Keybinding | null; keyFrom?: string };

/**
 * The rows the palette shows for `query`: the pick list's rows (matched on titles) while it is a
 * pick list, else `commands` (matched on title and id).
 */
export function paletteRows(
  pick: PalettePick | null,
  commands: readonly (Pick<Command, "id" | "title" | "keyFrom"> & { binding: Keybinding | null })[],
  query: string,
): PaletteRow[] {
  if (pick !== null) return filterPickItems(pick.items, query).map(({ id, title }) => ({ id, title, binding: null }));
  return filterCommands(commands, query).map(({ id, title, binding, keyFrom }) =>
    keyFrom === undefined ? { id, title, binding } : { id, title, binding, keyFrom },
  );
}

/**
 * Run the palette row `rowId` (Enter or a click). A pick row closes the palette, then goes to the
 * pick's `onPick`. A command runs first and then the palette closes -- "Toggle command palette"
 * closes it once rather than closing and reopening -- unless the command turned the palette into
 * a pick list ("Link to…"), which stays open.
 */
export function runPaletteRow(rowId: string): void {
  const pick = usePaletteStore.getState().pick;
  // Story 11.6: a command picked over the tour would change the app under the dim, so the tour
  // ends first, exactly as Skip does (recorded done); the tour's own commands leave it on.
  if (pick === null && isTourOn() && !rowId.startsWith("tour.")) useTourStore.getState().end();
  if (pick !== null) {
    usePaletteStore.getState().close();
    pick.onPick(rowId);
    return;
  }
  runCommand(rowId);
  if (usePaletteStore.getState().pick === null) usePaletteStore.getState().close();
}

/** Keep `index` within a list of `count` rows; an empty list has nothing to select but 0. */
export function clampSelection(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/** What a key pressed in the palette's input does; `null` leaves it to the input (typing). */
export type PaletteKeyAction = "up" | "down" | "run" | "trap";

/**
 * Map a `KeyboardEvent.key` from the palette input to its action. Tab is trapped: the input
 * is the palette's only focusable element, so leaving it would land behind the backdrop.
 * Escape is not here; it bubbles to the dispatcher (`palette.close`).
 */
export function paletteKeyAction(key: string): PaletteKeyAction | null {
  switch (key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "Enter":
      return "run";
    case "Tab":
      return "trap";
    default:
      return null;
  }
}

export const usePaletteStore = create<PaletteState>()((set, get) => ({
  isOpen: false,
  pick: null,
  query: "",
  selected: 0,
  open: () => set({ isOpen: true, pick: null, query: "", selected: 0 }),
  openPick: (pick) => set({ isOpen: true, pick, query: "", selected: 0 }),
  close: () => set({ isOpen: false, pick: null }),
  toggle: () => (get().isOpen ? get().close() : get().open()),
  setQuery: (query) => set({ query, selected: 0 }),
  // `selected` may be stale from a longer list; clamp it first so `delta` moves from a real row.
  move: (delta, count) =>
    set((s) => ({ selected: clampSelection(clampSelection(s.selected, count) + delta, count) })),
  filtered: (commands) => filterCommands(commands, get().query),
}));
