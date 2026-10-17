// The settings actions behind `settings.reveal` and `binaries.redetect`. They used to be
// handlers inside SettingsPane; now the pane's buttons and the palette run the same code.
// Outcome (busy flag, error text) goes into the settings store so the pane can show it
// whichever way the command was triggered; a failure opens the pane so the error line is
// seen. Neither rejects: `runCommand` has no error UI.

import { binariesRedetect, settingsReveal } from "../ipc";
import { useSettingsStore } from "../state/settings";
import { openPane } from "./panes";

/** True when the snapshot has a settings path: the `when` of `settings.reveal`. */
export function hasSettingsPath(): boolean {
  return useSettingsStore.getState().snapshot?.path != null;
}

/** Open the config folder with `settings.json` selected. */
export function revealSettingsFile(): Promise<void> {
  return runAction(async () => {
    await settingsReveal();
  });
}

/** Re-run `claude`/`git` detection and apply the resulting snapshot. */
export function redetectBinaries(): Promise<void> {
  return runAction(async () => {
    const snapshot = await binariesRedetect();
    useSettingsStore.getState().applySnapshot(snapshot);
  });
}

/** One action at a time: `actionBusy` guards against double runs (two file-manager windows). */
async function runAction(action: () => Promise<void>): Promise<void> {
  const store = useSettingsStore.getState();
  if (store.actionBusy) return;
  store.setActionError(null);
  store.setActionBusy(true);
  try {
    await action();
  } catch (err) {
    useSettingsStore.getState().setActionError(describe(err));
    openPane("settings"); // through the pane lifecycle: an open import pane is left properly
  } finally {
    useSettingsStore.getState().setActionBusy(false);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
