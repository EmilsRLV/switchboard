// The "New worktree" sheet's commands (Story 5.2): `project.newWorktree` opens it on the selected
// project (a new branch from a base), `branch.newWorktree` on the selected branch card's project
// with that branch preselected (an existing branch). Every edit asks Rust for the preview -- the
// exact `git worktree add` command and folder -- so what the sheet shows is what Rust will run;
// the submit is the consent (no second confirm). On success the new branch card is selected; a
// refusal stays in the sheet. A reply for a sheet that has since closed or reopened touches no
// sheet: a success still applies the snapshot, a refusal is the notice.

import { SHOW_LIMIT } from "../canvas/nodes";
import { worktreeAdd, worktreePreview, type WorktreeRequest } from "../ipc";
import { useStatusStore } from "../state/status";
import { selectedProject, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { isWorktreeSheetOpen, useWorktreeStore, worktreeToken, type WorktreeForm } from "../state/worktree";
import { notify, selectedBranch } from "./navigation";
import { closeOpenPane, openPane } from "./panes";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `when` of `project.newWorktree`: a project is selected and the status poll says it is a repo. */
export function canNewWorktree(): boolean {
  const project = selectedProject();
  return project !== null && useStatusStore.getState().statuses[project.id]?.kind === "repo";
}

/**
 * The `when` of `branch.newWorktree`: a branch card without a worktree chip is selected, and
 * it is not the branch checked out in the project's own folder (git refuses that one).
 */
export function canNewWorktreeOnBranch(): boolean {
  const branch = selectedBranch();
  return branch !== null && branch.branch !== null && branch.branch.worktree === null && !branch.branch.head;
}

/** The request the form sends: the name trimmed; the base only for a new branch. */
export function worktreeRequest(form: WorktreeForm): WorktreeRequest {
  return form.mode === "new"
    ? { mode: "new", branch: form.name.trim(), base: form.base }
    : { mode: "existing", branch: form.branch, base: null };
}

/**
 * Why Create is disabled, shown beside it; `null` when it may run. Rust's preview decides: no
 * command (a blank name, a refusal) means nothing would run.
 */
export function createBlockedReason(state: {
  form: WorktreeForm | null;
  preview: { command: string | null; error: string | null } | null;
  creating: boolean;
  previewSeq: number;
  appliedSeq: number;
}): string | null {
  if (state.creating) return "creating…";
  if (state.form === null || state.preview === null) return "reading branches…";
  // The latest edit's preview has not arrived: what is shown may not be what would run.
  if (state.appliedSeq !== state.previewSeq) return "checking…";
  if (state.form.mode === "new" && state.form.name.trim() === "") return "Create needs a branch name";
  if (state.form.mode === "existing" && state.form.branch === "") return "No branch is free for a worktree";
  if (state.preview.error !== null) return "Nothing would run: see below";
  if (state.preview.command === null) return "checking…";
  return null;
}

/**
 * Ask Rust for the open sheet's preview and apply it, unless a newer request (or another
 * sheet) took its place. A rejection (not a repository, git unavailable) is the sheet's error.
 */
export async function refreshPreview(): Promise<boolean> {
  const token = worktreeToken();
  const sheet = useWorktreeStore.getState();
  if (token === null || sheet.form === null) return false;
  const seq = sheet.nextPreview();
  try {
    const preview = await worktreePreview(token.projectId, worktreeRequest(sheet.form));
    if (!isWorktreeSheetOpen(token)) return false;
    const before = useWorktreeStore.getState().form;
    useWorktreeStore.getState().applyPreview(seq, preview);
    const after = useWorktreeStore.getState();
    // Applying picked a branch (Existing, none picked yet): preview that one.
    if (after.appliedSeq === seq && after.form !== null && before !== null && after.form.branch !== before.branch) return refreshPreview();
    return true;
  } catch (err) {
    if (isWorktreeSheetOpen(token)) useWorktreeStore.getState().failPreview(seq, describe(err));
    return false;
  }
}

/**
 * Edit the sheet's form and refresh the preview. Switching to "Existing branch" with none
 * picked yet picks the first free one.
 */
export function editWorktree(patch: Partial<WorktreeForm>): Promise<boolean> {
  const sheet = useWorktreeStore.getState();
  if (sheet.form === null) return Promise.resolve(false);
  const next = { ...patch };
  if (next.mode === "existing" && sheet.form.branch === "" && next.branch === undefined) {
    next.branch = sheet.preview?.available[0] ?? "";
  }
  sheet.edit(next);
  return refreshPreview();
}

/**
 * `project.newWorktree` / `branch.newWorktree`: open the sheet on `projectId` -- "New branch"
 * by default, or "Existing branch" with `branch` preselected -- and fetch its first preview.
 * Resolves whether the sheet opened.
 */
export async function openWorktreeSheet(projectId: string, branch?: string): Promise<boolean> {
  const project = useWorkspaceStore.getState().snapshot?.workspace.projects.find((p) => p.id === projectId);
  if (project === undefined) return false;
  const form: WorktreeForm =
    branch === undefined
      ? { mode: "new", name: "", base: null, branch: "" }
      : { mode: "existing", name: "", base: null, branch };
  useWorktreeStore.getState().open({ id: project.id, label: project.label }, form);
  openPane("worktree");
  await refreshPreview();
  return true;
}

/** `branch.newWorktree`: the sheet on the selected branch card's project, that branch preselected. */
export function openWorktreeSheetForBranch(): Promise<boolean> {
  const branch = selectedBranch();
  if (branch === null) return Promise.resolve(false);
  return openWorktreeSheet(branch.projectId, branch.label);
}

/**
 * Create (Enter, ctrl+Enter or the button): Rust re-plans and runs `git worktree add`. On
 * success the snapshot (with the new card and its chip) is applied, the sheet goes and the new
 * branch card is selected (its group showing all when the card is past the limit). On a
 * refusal the sheet stays with the reason. Resolves whether a worktree was created.
 */
export async function submitWorktree(): Promise<boolean> {
  const sheet = useWorktreeStore.getState();
  const token = worktreeToken();
  if (token === null || sheet.form === null || createBlockedReason(sheet) !== null) return false;
  sheet.setCreating(true);
  let added;
  try {
    added = await worktreeAdd(token.projectId, worktreeRequest(sheet.form));
  } catch (err) {
    if (isWorktreeSheetOpen(token)) useWorktreeStore.getState().fail(describe(err));
    else notify(describe(err));
    return false;
  }
  const workspace = useWorkspaceStore.getState();
  workspace.applySnapshot(added.snapshot);
  workspace.setLoadError(null);
  if (isWorktreeSheetOpen(token)) {
    if (useUiStore.getState().pane === "worktree") closeOpenPane();
    else useWorktreeStore.getState().reset();
  }
  const ui = useUiStore.getState();
  ui.select({ kind: "branch", id: added.branchId });
  const branches = (useWorkspaceStore.getState().snapshot?.children ?? []).filter(
    (c) => c.projectId === token.projectId && c.kind === "branch",
  );
  const index = branches.findIndex((c) => c.id === added.branchId);
  if (index >= SHOW_LIMIT && branches[index]?.position === null && !ui.showAllBranches.includes(token.projectId)) {
    ui.toggleShowAll(token.projectId, "branches");
  }
  return true;
}

// -- Story 9.4: the sheet's buttons as commands -----------------------------------------------

/** True while the worktree sheet shows (its form loaded). */
function worktreeSheetShows(): boolean {
  return useUiStore.getState().pane === "worktree" && useWorktreeStore.getState().form !== null;
}

/** The `when` of `worktree.modeNew` / `worktree.modeExisting`: the sheet shows in the other mode, not creating. */
export function canSetWorktreeMode(mode: WorktreeForm["mode"]): boolean {
  const sheet = useWorktreeStore.getState();
  return worktreeSheetShows() && !sheet.creating && sheet.form?.mode !== mode;
}

/** The `when` of `worktree.create` (the sheet's Create): the sheet shows and nothing blocks Create. */
export function canCreateWorktree(): boolean {
  return worktreeSheetShows() && createBlockedReason(useWorktreeStore.getState()) === null;
}
