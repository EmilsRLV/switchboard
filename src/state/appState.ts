// `state_get`'s reply (Stories 10.3, 10.5, 11.3 and 11.6): one read of `state.json` feeds the
// Getting started checklist, the what's-new chip, the inline hints setting and the first-run
// tour. `App` calls these once (guarding against unmount).

import type { AppStateSnapshot } from "../ipc";
import { useChecklistStore } from "./checklist";
import { useHintsStore } from "./hints";
import { useTourStore } from "./tour";
import { useWhatsNewStore } from "./whatsNew";

/** `state_get` replied: load the checklist, the what's-new state, the hints setting and the tour from the one snapshot. */
export function applyStateReply(snapshot: AppStateSnapshot): void {
  useChecklistStore.getState().load(snapshot);
  useWhatsNewStore.getState().load(snapshot);
  useHintsStore.getState().load(snapshot);
  useTourStore.getState().load(snapshot);
}

/** `state_get` failed: each runs with its defaults and writes nothing. */
export function applyStateError(message: string): void {
  useChecklistStore.getState().setLoadError(message);
  useWhatsNewStore.getState().setLoadError(message);
  useHintsStore.getState().setLoadError(message);
  useTourStore.getState().setLoadError(message);
}
