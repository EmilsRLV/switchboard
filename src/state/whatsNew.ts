// What's new after an update (Story 10.5): the running version, whether the `new in <version>`
// chip shows, and recording the version as seen once the Changelog is opened (by any route --
// `showHelpPage` calls `markSeen`). Rust loads `state.json` (`state_get`); the seen version is
// written through `whats_new_seen`, at most once a run.

import { create } from "zustand";
import { hasTauriRuntime, whatsNewSeen, type AppStateSnapshot } from "../ipc";
import { shouldShowWhatsNew } from "../help/whatsNew";

export type WhatsNewState = {
  /** The running version, once `state_get` replied; `null` until then (or when it failed). */
  version: string | null;
  /** The chip shows. */
  show: boolean;
  /** The seen version may be written: false until `state.json` loaded, and after a failed load. */
  writable: boolean;
  /** Apply `state_get`'s reply. */
  load: (snapshot: AppStateSnapshot) => void;
  /** `state_get` failed: no chip, nothing written. */
  setLoadError: (error: string) => void;
  /** The Changelog was shown: the chip goes and the version is recorded as seen (once). */
  markSeen: () => void;
};

/** The Changelog was shown this run (also before the file loaded). */
let seen = false;
/** `whats_new_seen` was sent this run. */
let sent = false;
/** The stored version differs from the running one: there is something to record. */
let pending = false;

/** Record the running version as seen, once, when there is something to record. */
function send(): void {
  if (sent || !pending || !hasTauriRuntime() || !useWhatsNewStore.getState().writable) return;
  sent = true;
  pending = false;
  whatsNewSeen().catch((err: unknown) => {
    console.error(`what's new: cannot save state.json: ${String(err)}`);
    // Not recorded: the next showing of the Changelog this run tries again.
    sent = false;
    pending = true;
  });
}

export const useWhatsNewStore = create<WhatsNewState>()((set) => ({
  version: null,
  show: false,
  writable: false,
  load: (snapshot) => {
    pending = snapshot.lastSeenVersion !== snapshot.version;
    const show = !seen && shouldShowWhatsNew(snapshot.lastSeenVersion, snapshot.version, snapshot.firstRun);
    set({ version: snapshot.version, show, writable: true });
    // The Changelog was opened before the file arrived: record it now.
    if (seen) send();
  },
  setLoadError: (error) => {
    console.error(`what's new: cannot load state.json: ${error}`);
    pending = false;
    set({ show: false, writable: false });
  },
  markSeen: () => {
    seen = true;
    if (useWhatsNewStore.getState().show) set({ show: false });
    send();
  },
}));

/** Forget everything (tests). */
export function resetWhatsNew(): void {
  seen = false;
  sent = false;
  pending = false;
  useWhatsNewStore.setState({ version: null, show: false, writable: false });
}
