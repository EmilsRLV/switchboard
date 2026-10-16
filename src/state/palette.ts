import { create } from "zustand";
import type { Command } from "../commands/registry";

/**
 * UI state of the command palette: whether it is showing, what has been typed and which row
 * is selected. The commands themselves live in the registry; this store only filters them.
 */
export type PaletteState = {
  isOpen: boolean;
  query: string;
  /** Index into the filtered list; clamped by `move`, reset by `setQuery` and `open`. */
  selected: number;
  /** Show the palette with an empty query and the first row selected. */
  open: () => void;
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
  query: "",
  selected: 0,
  open: () => set({ isOpen: true, query: "", selected: 0 }),
  close: () => set({ isOpen: false }),
  toggle: () => (get().isOpen ? get().close() : get().open()),
  setQuery: (query) => set({ query, selected: 0 }),
  // `selected` may be stale from a longer list; clamp it first so `delta` moves from a real row.
  move: (delta, count) =>
    set((s) => ({ selected: clampSelection(clampSelection(s.selected, count) + delta, count) })),
  filtered: (commands) => filterCommands(commands, get().query),
}));
