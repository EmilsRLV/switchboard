// The canvas's inline hints setting (Story 11.3): `state.json`'s `hints.hidden`. `null` (the
// default) follows the Getting started card (hints show while it shows), `false` shows them even
// with the card dismissed or never shown, `true` hides them. Rust loads the file (`state_get`);
// every change is written back through `hints_set`, one write at a time, in order.

import { create } from "zustand";
import { hasTauriRuntime, hintsSet, type AppStateSnapshot } from "../ipc";
import { isChecklistCardShown } from "./checklist";

export type HintsState = {
  /** True once `state.json` (or the failure to read it) has been applied. */
  loaded: boolean;
  /** Changes are written to `state.json`: false until it loaded, and for good after a failed load. */
  writable: boolean;
  hidden: boolean | null;
  /** Apply `state_get`'s reply. */
  load: (snapshot: AppStateSnapshot) => void;
  /** `state_get` failed: run with the default, keeping changes in memory. */
  setLoadError: (error: string) => void;
  /** `hints.hide` (`true`) / `hints.show` (`false`): store and write the setting. */
  setHidden: (hidden: boolean | null) => void;
};

/** The pending writes, chained so they reach Rust in order. */
let writes: Promise<void> = Promise.resolve();

function persist(): void {
  if (!hasTauriRuntime() || !useHintsStore.getState().writable) return;
  const { hidden } = useHintsStore.getState();
  writes = writes
    .then(() => hintsSet(hidden))
    .then(
      () => undefined,
      (err: unknown) => console.error(`hints: cannot save state.json: ${String(err)}`),
    );
}

export const useHintsStore = create<HintsState>()((set, get) => ({
  loaded: false,
  writable: false,
  hidden: null,
  load: (snapshot) => {
    // A missing field (an older reply) is the default.
    set({ loaded: true, writable: true, hidden: snapshot.hints?.hidden ?? null });
  },
  setLoadError: (error) => {
    console.error(`hints: cannot load state.json: ${error}`);
    set({ loaded: true, writable: false });
  },
  setHidden: (hidden) => {
    if (!get().loaded || get().hidden === hidden) return;
    set({ hidden });
    persist();
  },
}));

/**
 * Whether hints are on: `hidden` is `false`, or `null` while the Getting started card shows. (A
 * pane being open stops them being drawn, not being on.)
 */
export function hintsOn(hidden: boolean | null, cardVisible: boolean): boolean {
  return hidden === false || (hidden === null && cardVisible);
}

/** Whether hints are on now (`hints.hide` while they are, `hints.show` while not). */
export function areHintsOn(): boolean {
  return hintsOn(useHintsStore.getState().hidden, isChecklistCardShown());
}

/** True once `state.json` has been applied (or failed to load): the hints commands work from then on. */
export function isHintsLoaded(): boolean {
  return useHintsStore.getState().loaded;
}

/** Forget everything (tests). */
export function resetHints(): void {
  writes = Promise.resolve();
  useHintsStore.setState({ loaded: false, writable: false, hidden: null });
}
