// Opening and closing the right-hand panes (settings, import, terminal, launch, worktree, remove
// worktree, edge, review, help) with their side effects: the import pane loads its list when opened,
// the settings pane drops a stale action error when closed, the import pane forgets its
// selection, the launch, worktree and remove-worktree sheets their forms, the Review pane its
// target, the Help pane its page (it opens on Contents again). Help is the exception to "opening
// one pane leaves the other": the pane it opens over is remembered and comes back when Help
// closes (Story 10.2). Commands call these; components never touch the ui store's pane directly.

import { useImportStore } from "../state/import";
import { useLaunchStore } from "../state/launch";
import { useRemoveWorktreeStore } from "../state/removeWorktree";
import { useReviewStore } from "../state/review";
import { useWorktreeStore } from "../state/worktree";
import { useSettingsStore } from "../state/settings";
import { useUiStore, type Pane } from "../state/ui";
import { loadImportList } from "./projects";

export function openPane(pane: Pane): void {
  const ui = useUiStore.getState();
  const current = ui.pane;
  if (pane === "help") {
    // Help over another pane keeps that pane as it was left (Story 10.2): no `leave` yet.
    if (current !== null && current !== "help") ui.setHelpReturn(current);
  } else if (current === "help") {
    // Leaving Help elsewhere: the pane it replaced is left now, unless it is the one opening.
    leave("help");
    const back = ui.helpReturn;
    ui.setHelpReturn(null);
    if (back !== null && back !== pane) leave(back);
  } else if (current !== null && current !== pane) {
    leave(current);
  }
  ui.openPane(pane);
  if (pane === "import") void loadImportList();
}

/**
 * Close whichever pane is open; a no-op when none is. Closing Help that opened over another
 * pane brings that pane back as it was left (Story 10.2): the edge inspector only while an edge
 * is still selected, the terminal pane only while it has a tab, a sheet or Review only while it
 * still has its form or target; otherwise Help closes to the
 * canvas and the remembered pane is left.
 */
export function closeOpenPane(): void {
  const ui = useUiStore.getState();
  if (ui.pane === null) return;
  leave(ui.pane);
  if (ui.pane === "help" && ui.helpReturn !== null) {
    const back = ui.helpReturn;
    ui.setHelpReturn(null);
    if (canReturnTo(back)) {
      ui.openPane(back);
      return;
    }
    leave(back);
  }
  ui.closePane();
}

/** Open `pane`, or close it when it is the one showing. */
export function togglePane(pane: Pane): void {
  if (useUiStore.getState().pane === pane) closeOpenPane();
  else openPane(pane);
}

/** Whether Help may hand back to `pane`: it still has something to show. */
function canReturnTo(pane: Pane): boolean {
  const ui = useUiStore.getState();
  if (pane === "edge") return ui.selection?.kind === "edge";
  if (pane === "terminal") return ui.openTerminals.length > 0;
  // A sheet or Review whose store was reset while Help covered it (a submit that finished) has nothing to show.
  if (pane === "launch") return useLaunchStore.getState().form !== null;
  if (pane === "worktree") return useWorktreeStore.getState().form !== null;
  if (pane === "removeWorktree") return useRemoveWorktreeStore.getState().projectId !== null;
  if (pane === "review") return useReviewStore.getState().target !== null;
  return true;
}

/** What a pane leaves behind when it goes. */
function leave(pane: Pane): void {
  if (pane === "settings") useSettingsStore.getState().setActionError(null);
  if (pane === "import") useImportStore.getState().reset();
  if (pane === "launch") useLaunchStore.getState().reset();
  if (pane === "worktree") useWorktreeStore.getState().reset();
  if (pane === "removeWorktree") useRemoveWorktreeStore.getState().reset();
  if (pane === "review") useReviewStore.getState().closeTarget();
  if (pane === "help") useUiStore.getState().setHelpPage(null);
}
