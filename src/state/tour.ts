// The first-run tour's state (Story 11.6): whether it is on, the stop it is at, and whether it
// was ever taken (`state.json`'s `tour.done`). Rust loads the file (`state_get`); ending the tour
// (Finish or Skip) writes `done: true` through `tour_set`, once (a re-run writes nothing new).
//
// It starts on its own once per launch at most: on a fresh profile (`first_run`) whose tour is not
// done, after the canvas's first frame (`tourFirstFrame`) and once `state.json` has loaded, in
// whichever order those two arrive. A profile that existed before never starts it on its own;
// `tour.start` ("Take the tour") runs it from stop 1 at any time.

import { create } from "zustand";
import { hasTauriRuntime, tourSet, type AppStateSnapshot } from "../ipc";
import { TOUR_STOP_COUNT } from "../help/tour";

export type TourState = {
  /** True once `state.json` (or the failure to read it) has been applied. */
  loaded: boolean;
  /** Ending writes `state.json`: false until it loaded, and for good after a failed load. */
  writable: boolean;
  /** The workspace was created on this launch (a fresh profile). */
  firstRun: boolean;
  /** The tour is showing. */
  on: boolean;
  /** The stop it is at (0-based); 0 while off. */
  stop: number;
  /** It was finished or skipped (now or on an earlier launch). */
  done: boolean;
  /** Apply `state_get`'s reply (and start the tour when it is due). */
  load: (snapshot: AppStateSnapshot) => void;
  /** `state_get` failed: no auto-start, and nothing is written. */
  setLoadError: (error: string) => void;
  /** `tour.start`: from stop 1 (also while on). */
  start: () => void;
  /** `tour.next`: the next stop; on the last stop, the end (Finish). */
  next: () => void;
  /** `tour.back`: the previous stop; stop 1 stays. */
  back: () => void;
  /** `tour.skip`, Finish: off, and `done` recorded. */
  end: () => void;
};

/** The canvas's first frame was painted this launch. */
let framed = false;
/** The tour started this launch (on its own or asked for): it never starts on its own again. */
let started = false;
/** The pending writes, chained so they reach Rust in order. */
let writes: Promise<void> = Promise.resolve();

function persist(): void {
  if (!hasTauriRuntime() || !useTourStore.getState().writable) return;
  writes = writes
    .then(() => tourSet(true))
    .then(
      () => undefined,
      (err: unknown) => console.error(`tour: cannot save state.json: ${String(err)}`),
    );
}

/** Whether the tour should start on its own now: framed, loaded, a fresh profile, not done, not yet this launch. */
export function autoStartDue(s: { framed: boolean; started: boolean } & Pick<TourState, "loaded" | "firstRun" | "done" | "on">): boolean {
  return s.framed && !s.started && s.loaded && s.firstRun && !s.done && !s.on;
}

function maybeAutoStart(): void {
  const s = useTourStore.getState();
  if (autoStartDue({ ...s, framed, started })) s.start();
}

export const useTourStore = create<TourState>()((set, get) => ({
  loaded: false,
  writable: false,
  firstRun: false,
  on: false,
  stop: 0,
  done: false,
  load: (snapshot) => {
    // A missing field (an older reply) is the default. A second load (StrictMode) keeps a `done`
    // reached since the first.
    set({ loaded: true, writable: true, firstRun: snapshot.firstRun, done: get().done || (snapshot.tour?.done ?? false) });
    maybeAutoStart();
  },
  setLoadError: (error) => {
    console.error(`tour: cannot load state.json: ${error}`);
    set({ loaded: true, writable: false });
  },
  start: () => {
    started = true;
    set({ on: true, stop: 0 });
  },
  next: () => {
    const { on, stop } = get();
    if (!on) return;
    if (stop >= TOUR_STOP_COUNT - 1) get().end();
    else set({ stop: stop + 1 });
  },
  back: () => {
    const { on, stop } = get();
    if (!on || stop === 0) return;
    set({ stop: stop - 1 });
  },
  end: () => {
    if (!get().on) return;
    const wasDone = get().done;
    set({ on: false, stop: 0, done: true });
    if (!wasDone) persist();
  },
}));

/**
 * The canvas painted its first frame (beside `reportFirstFrame` in `Canvas.tsx`): start the tour
 * when it is due, now or once `state.json` loads.
 */
export function tourFirstFrame(): void {
  framed = true;
  maybeAutoStart();
}

/** The `when` of the tour's own commands: the tour is showing. */
export function isTourOn(): boolean {
  return useTourStore.getState().on;
}

/** True once the tour was taken (finished or skipped). */
export function isTourDone(): boolean {
  return useTourStore.getState().done;
}

/** Forget everything (tests). */
export function resetTour(): void {
  framed = false;
  started = false;
  writes = Promise.resolve();
  useTourStore.setState({ loaded: false, writable: false, firstRun: false, on: false, stop: 0, done: false });
}
