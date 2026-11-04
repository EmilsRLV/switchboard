// `state_get`'s reply (Stories 10.3, 10.5 and 11.3): one read of `state.json` feeds the Getting
// started checklist, the what's-new chip and the inline hints setting. `App` calls these once
// (guarding against unmount).

import type { AppStateSnapshot } from "../ipc";
import { useChecklistStore } from "./checklist";
import { useHintsStore } from "./hints";
import { useWhatsNewStore } from "./whatsNew";

/** `state_get` replied: load the checklist, the what's-new state and the hints setting from the one snapshot. */
export function applyStateReply(snapshot: AppStateSnapshot): void {
  useChecklistStore.getState().load(snapshot);
  useWhatsNewStore.getState().load(snapshot);
  useHintsStore.getState().load(snapshot);
}

/** `state_get` failed: each runs with its defaults and writes nothing. */
export function applyStateError(message: string): void {
  useChecklistStore.getState().setLoadError(message);
  useWhatsNewStore.getState().setLoadError(message);
  useHintsStore.getState().setLoadError(message);
}
