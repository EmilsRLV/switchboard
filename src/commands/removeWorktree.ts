// The "Remove worktree" sheet's commands (Story 5.4): `branch.removeWorktree` opens it on the
// selected branch card when it has a worktree chip (a `missing` one too). Rust checks first,
// read-only, and sends the exact commands; the sheet shows them. A clean worktree is removed by
// one click on Remove; a dirty one needs Force remove… and then a second, explicit click; a
// locked one, or one a live session runs in, is refused. Nothing runs on Enter. A reply for a
// sheet that has since closed or reopened touches no sheet: a success still applies the
// snapshot, a failure is the notice.

import { worktreeRemove, worktreeRemovePreview, type RemoveWorktreeCheck } from "../ipc";
import { isRemoveSheetOpen, removeWorktreeToken, useRemoveWorktreeStore } from "../state/removeWorktree";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { notify, selectedBranch } from "./navigation";
import { closeOpenPane, openPane } from "./panes";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `when` of `branch.removeWorktree`: a branch card with a worktree chip (missing or not) is selected. */
export function canRemoveWorktree(): boolean {
  const branch = selectedBranch();
  return branch !== null && branch.branch !== null && branch.branch.worktree !== null;
}

/**
 * What the sheet shows under "Runs", in order: the remove (the force command once Force
 * remove… was pressed), then `git branch -d` when "Also delete branch" is ticked. Empty while
 * the checks have not arrived or refuse.
 */
export function plannedCommands(state: { check: RemoveWorktreeCheck | null; deleteBranch: boolean; forceArmed: boolean }): string[] {
  const check = state.check;
  if (check === null || check.refusal !== null) return [];
  const remove = check.dirty > 0 && state.forceArmed && check.forceCommand !== null ? check.forceCommand : check.command;
  return state.deleteBranch ? [remove, check.deleteCommand] : [remove];
}

/**
 * How long the second, explicit button stays disabled after Force remove… was pressed, so a
 * double-click on Force remove… can never also confirm the discard.
 */
export const FORCE_CONFIRM_DELAY_MS = 600;

/** True once the second button may run: force armed at least {@link FORCE_CONFIRM_DELAY_MS} ago. */
export function discardReady(state: { forceArmed: boolean; forceArmedAt: number | null }, now: number = Date.now()): boolean {
  return state.forceArmed && state.forceArmedAt !== null && now - state.forceArmedAt >= FORCE_CONFIRM_DELAY_MS;
}

/** The second button's label while dirty: it states what is discarded. */
export function discardLabel(dirty: number): string {
  return `Discard ${dirty} changed ${dirty === 1 ? "file" : "files"} and remove`;
}

/** The sheet's dirty line, as Rust words its refusal. */
export function dirtyLine(dirty: number): string {
  return `${dirty} changed ${dirty === 1 ? "file" : "files"} (modified or untracked)`;
}

/**
 * Ask Rust for the open sheet's checks and apply them; a rejection is the sheet's error.
 * `keepError` keeps the error shown (the re-read after a refusal).
 */
export async function refreshRemoveCheck(keepError = false): Promise<boolean> {
  const token = removeWorktreeToken();
  if (token === null) return false;
  try {
    const check = await worktreeRemovePreview(token.projectId, token.branch);
    if (!isRemoveSheetOpen(token)) return false;
    useRemoveWorktreeStore.getState().applyCheck(token.opened, check, keepError);
    return true;
  } catch (err) {
    if (isRemoveSheetOpen(token) && !keepError) useRemoveWorktreeStore.getState().fail(describe(err));
    return false;
  }
}

/** `branch.removeWorktree`: open the sheet on the selected branch card and fetch its checks. */
export async function openRemoveWorktreeSheet(): Promise<boolean> {
  const branch = selectedBranch();
  if (branch === null || branch.branch === null || branch.branch.worktree === null) return false;
  useRemoveWorktreeStore.getState().open(branch.projectId, branch.label);
  openPane("removeWorktree");
  await refreshRemoveCheck();
  return true;
}

/**
 * Why nothing may run now, or `null`: the checks are not in, Rust refuses, a click is in
 * flight, or the worktree is already gone.
 */
export function removeBlockedReason(state: {
  check: RemoveWorktreeCheck | null;
  removing: boolean;
  removed: boolean;
}): string | null {
  if (state.removed) return "removed";
  if (state.removing) return "removing…";
  if (state.check === null) return "checking…";
  return state.check.refusal;
}

/**
 * Run the remove: **Remove** (`force` false) on a clean or missing worktree, or the second,
 * explicit button (`force` true) once Force remove… was pressed on a dirty one and
 * {@link FORCE_CONFIRM_DELAY_MS} have passed; any other call sends nothing. A force carries the
 * dirty count the button stated. A refusal re-reads the checks (the error stays shown), so the
 * sheet never keeps a stale state. On success the snapshot is applied and the sheet closes (the project is
 * selected when its branch was deleted); a refused branch delete keeps the sheet open with
 * git's message (the worktree stays removed). A refusal or git's error stays in the sheet.
 * Resolves whether the worktree was removed.
 */
export async function submitRemoveWorktree(force: boolean, now: number = Date.now()): Promise<boolean> {
  const sheet = useRemoveWorktreeStore.getState();
  const token = removeWorktreeToken();
  if (token === null || removeBlockedReason(sheet) !== null || sheet.check === null) return false;
  const dirty = sheet.check.dirty > 0;
  if (dirty !== force || (force && !discardReady(sheet, now))) return false;
  sheet.setRemoving(true);
  let removed;
  try {
    removed = await worktreeRemove(token.projectId, token.branch, force, force ? sheet.check.dirty : null, sheet.deleteBranch);
  } catch (err) {
    if (isRemoveSheetOpen(token)) {
      useRemoveWorktreeStore.getState().fail(describe(err));
      await refreshRemoveCheck(true);
    } else notify(describe(err));
    return false;
  }
  const workspace = useWorkspaceStore.getState();
  workspace.applySnapshot(removed.snapshot);
  workspace.setLoadError(null);
  if (removed.deleteError !== null) {
    if (isRemoveSheetOpen(token)) useRemoveWorktreeStore.getState().removedKeepingBranch(removed.deleteError);
    else notify(`worktree removed; branch kept: ${removed.deleteError}`);
    return true;
  }
  if (isRemoveSheetOpen(token)) {
    if (useUiStore.getState().pane === "removeWorktree") closeOpenPane();
    else useRemoveWorktreeStore.getState().reset();
  }
  if (removed.branchDeleted) useUiStore.getState().select({ kind: "project", id: token.projectId });
  return true;
}

// -- Story 9.4: the sheet's buttons as commands -----------------------------------------------

/** The sheet's state when it shows with its checks in and nothing blocking a remove; else `null`. */
function runnableSheet() {
  const sheet = useRemoveWorktreeStore.getState();
  if (useUiStore.getState().pane !== "removeWorktree" || sheet.projectId === null || sheet.check === null) return null;
  return removeBlockedReason(sheet) === null ? sheet : null;
}

/** The `when` of `worktree.remove` (the sheet's Remove): a clean (or missing) worktree may be removed. */
export function canRemoveCleanWorktree(): boolean {
  const sheet = runnableSheet();
  return sheet !== null && sheet.check !== null && sheet.check.dirty === 0;
}

/** The `when` of `worktree.forceRemove` (Force remove…): a dirty worktree, not armed yet. */
export function canArmForceRemove(): boolean {
  const sheet = runnableSheet();
  return sheet !== null && sheet.check !== null && sheet.check.dirty > 0 && !sheet.forceArmed;
}

/** Force remove…: reveal the second, explicit button (it waits {@link FORCE_CONFIRM_DELAY_MS}). */
export function armForceRemove(): void {
  if (canArmForceRemove()) useRemoveWorktreeStore.getState().armForce();
}

/**
 * The `when` of `worktree.discardAndRemove` (the `Discard N changed files and remove` button):
 * Force remove… was pressed at least {@link FORCE_CONFIRM_DELAY_MS} ago on a dirty worktree.
 */
export function canDiscardAndRemove(now: number = Date.now()): boolean {
  const sheet = runnableSheet();
  return sheet !== null && sheet.check !== null && sheet.check.dirty > 0 && discardReady(sheet, now);
}
