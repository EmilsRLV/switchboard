// Opening and closing the right-hand panes (settings, import, terminal, launch, worktree, remove
// worktree) with their side effects: the import pane loads its list when opened, the settings pane
// drops a stale action error when closed, the import pane forgets its selection, the launch,
// worktree and remove-worktree sheets their forms. Commands call these; components never
// touch the ui store's pane directly.

import { useImportStore } from "../state/import";
import { useLaunchStore } from "../state/launch";
import { useRemoveWorktreeStore } from "../state/removeWorktree";
import { useWorktreeStore } from "../state/worktree";
import { useSettingsStore } from "../state/settings";
import { useUiStore, type Pane } from "../state/ui";
import { loadImportList } from "./projects";

export function openPane(pane: Pane): void {
  const ui = useUiStore.getState();
  if (ui.pane !== null && ui.pane !== pane) leave(ui.pane);
  ui.openPane(pane);
  if (pane === "import") void loadImportList();
}

/** Close whichever pane is open; a no-op when none is. */
export function closeOpenPane(): void {
  const ui = useUiStore.getState();
  if (ui.pane === null) return;
  leave(ui.pane);
  ui.closePane();
}

/** Open `pane`, or close it when it is the one showing. */
export function togglePane(pane: Pane): void {
  if (useUiStore.getState().pane === pane) closeOpenPane();
  else openPane(pane);
}

/** What a pane leaves behind when it goes. */
function leave(pane: Pane): void {
  if (pane === "settings") useSettingsStore.getState().setActionError(null);
  if (pane === "import") useImportStore.getState().reset();
  if (pane === "launch") useLaunchStore.getState().reset();
  if (pane === "worktree") useWorktreeStore.getState().reset();
  if (pane === "removeWorktree") useRemoveWorktreeStore.getState().reset();
}
