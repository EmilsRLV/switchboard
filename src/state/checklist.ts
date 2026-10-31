// The Getting started checklist's state (Story 10.3): what `state.json` holds (shown, dismissed,
// the steps done) and whether the card shows. Rust loads the file (`state_get`); every change is
// written back through `checklist_set`, one write at a time, in order.
//
// Steps latch: each detected step is added to `done` and never removed, even when the state that
// ticked it goes (the palette closes, the edge is deleted). Steps seen before the file has loaded
// are kept and added when it arrives. The card shows while the checklist is shown and not
// dismissed, unless every step was already done when the app started: a card that reaches
// `All done` during a run stays until the next launch.

import { create } from "zustand";
import { checklistSet, hasTauriRuntime, type AppStateSnapshot, type ChecklistFile } from "../ipc";
import { checklistSources, detectSteps, normaliseSteps, STEP_IDS, subscribeSources, type StepId } from "../help/checklist";

export type ChecklistState = {
  /** True once `state.json` (or the failure to read it) has been applied. */
  loaded: boolean;
  /** Changes are written to `state.json`: false until it loaded, and for good after a failed load (the file must not be replaced by defaults). */
  writable: boolean;
  /** The workspace was created on this launch (a fresh profile). */
  firstRun: boolean;
  shown: boolean;
  dismissed: boolean;
  /** The steps done, in checklist order. */
  done: readonly StepId[];
  /** Every step was done when the file loaded: the card stays away this run (until "Show getting started"). */
  allDoneAtLoad: boolean;
  /** Apply `state_get`'s reply, adding the steps detected so far. */
  load: (snapshot: AppStateSnapshot) => void;
  /** `state_get` failed: run with the defaults (no card), keeping progress in memory. */
  setLoadError: (error: string) => void;
  /** Add newly detected steps (latched). */
  latch: (detected: Iterable<StepId>) => void;
  /** `checklist.show`: the card shows again (not dismissed). */
  show: () => void;
  /** `checklist.dismiss`: the card goes and stays gone. */
  dismiss: () => void;
};

/** Steps detected before the file loaded, added to it when it does. */
let early = new Set<StepId>();

/** The pending writes, chained so they reach Rust in order. */
let writes: Promise<void> = Promise.resolve();

/** Write the checklist now held (after the queued writes); a failure is logged, the state stays in memory. */
function persist(): void {
  if (!hasTauriRuntime() || !useChecklistStore.getState().writable) return;
  const { shown, dismissed, done } = useChecklistStore.getState();
  const file: ChecklistFile = { shown, dismissed, done: [...done] };
  writes = writes
    .then(() => checklistSet(file))
    .then(
      () => undefined,
      (err: unknown) => console.error(`checklist: cannot save state.json: ${String(err)}`),
    );
}

export const useChecklistStore = create<ChecklistState>()((set, get) => ({
  loaded: false,
  writable: false,
  firstRun: false,
  shown: false,
  dismissed: false,
  done: [],
  allDoneAtLoad: false,
  load: (snapshot) => {
    const saved = normaliseSteps(snapshot.checklist.done);
    // A second load (StrictMode's double effect) keeps what was latched since the first.
    const done = normaliseSteps([...saved, ...get().done, ...early, ...detectSteps(checklistSources())]);
    early = new Set();
    set({
      loaded: true,
      writable: true,
      firstRun: snapshot.firstRun,
      shown: snapshot.checklist.shown,
      dismissed: snapshot.checklist.dismissed,
      done,
      allDoneAtLoad: saved.length === STEP_IDS.length,
    });
    if (done.length !== saved.length) persist();
  },
  setLoadError: (error) => {
    console.error(`checklist: cannot load state.json: ${error}`);
    const done = normaliseSteps([...get().done, ...early, ...detectSteps(checklistSources())]);
    early = new Set();
    set({ loaded: true, writable: false, done });
  },
  latch: (detected) => {
    if (!get().loaded) {
      for (const id of detected) early.add(id);
      return;
    }
    const current = get().done;
    const done = normaliseSteps([...current, ...detected]);
    if (done.length === current.length) return;
    set({ done });
    persist();
  },
  show: () => {
    if (!get().loaded) return;
    set({ shown: true, dismissed: false, allDoneAtLoad: false });
    persist();
  },
  dismiss: () => {
    if (!get().loaded) return;
    set({ dismissed: true });
    persist();
  },
}));

/** Whether the card shows, from the store's state. */
export function cardVisible(s: Pick<ChecklistState, "loaded" | "shown" | "dismissed" | "allDoneAtLoad">): boolean {
  return s.loaded && s.shown && !s.dismissed && !s.allDoneAtLoad;
}

/** True while the Getting started card is on the canvas. */
export function isChecklistCardShown(): boolean {
  return cardVisible(useChecklistStore.getState());
}

/** True once `state.json` has been applied (or failed to load): the checklist commands work from then on. */
export function isChecklistLoaded(): boolean {
  return useChecklistStore.getState().loaded;
}

/** True when every step is done. */
export function isChecklistComplete(done: readonly StepId[]): boolean {
  return done.length === STEP_IDS.length;
}

/**
 * Tick steps from the stores from now on: detect once, then on every change of a store the
 * detection reads, until all six steps are latched. Returns the unsubscribe. Started once by `App`.
 */
export function startChecklist(): () => void {
  let stopped = false;
  let stopSources: (() => void) | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopSources?.();
  };
  const check = () => {
    if (stopped) return;
    useChecklistStore.getState().latch(detectSteps(checklistSources()));
    if (isChecklistComplete(useChecklistStore.getState().done)) stop();
  };
  // Nothing left to detect once all six are done (the file loaded complete, or the last one ticked).
  const stopWhenComplete = useChecklistStore.subscribe((s) => {
    if (isChecklistComplete(s.done)) stop();
  });
  stopSources = subscribeSources(check);
  check();
  return () => {
    stop();
    stopWhenComplete();
  };
}

/** Forget everything (tests). */
export function resetChecklist(): void {
  early = new Set();
  writes = Promise.resolve();
  useChecklistStore.setState({ loaded: false, writable: false, firstRun: false, shown: false, dismissed: false, done: [], allDoneAtLoad: false });
}
