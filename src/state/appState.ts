// `state_get`'s reply (Stories 10.3 and 10.5): one read of `state.json` feeds both the Getting
// started checklist and the what's-new chip. `App` calls these once (guarding against unmount).

import type { AppStateSnapshot } from "../ipc";
import { useChecklistStore } from "./checklist";
import { useWhatsNewStore } from "./whatsNew";

/** `state_get` replied: load the checklist and the what's-new state from the one snapshot. */
export function applyStateReply(snapshot: AppStateSnapshot): void {
  useChecklistStore.getState().load(snapshot);
  useWhatsNewStore.getState().load(snapshot);
}

/** `state_get` failed: both run with their defaults and write nothing. */
export function applyStateError(message: string): void {
  useChecklistStore.getState().setLoadError(message);
  useWhatsNewStore.getState().setLoadError(message);
}
