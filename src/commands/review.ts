// The actions behind the Review pane. Story 8.1: "Review changes" (`r`, the palette, the node
// menu) opens the pane on the selected project, branch or session: Rust resolves the node's folder
// (a project's folder, a branch's linked worktree, a session's cwd) and lists its working-tree
// changes; the pane's filter, layout, file stepping and refresh are palette commands too. While the
// pane is open, a change in the target's project status (the status poll) reads the list again.
//
// Story 7.4's review requests open the same pane on the session's folder, the request on top:
// opening a session's review (the card's `review` flag, the toast's Open, a click on the OS
// notification, the palette's "Open review request") asks Rust (which lowers the flag and returns
// the request), then shows the pane; a refusal is the notice. Each call names the request the UI
// showed (its `seq`), so a replacement the operator never saw keeps its flag. While the pane shows
// a session's request, a new request from it counts as seen: it is opened at once.

import { reviewClear, reviewOpen, type DiffFilter, type ReviewTarget } from "../ipc";
import { useLiveStore } from "../state/live";
import { isFlagged, requestIn, requestList, useReviewStore } from "../state/review";
import { useSettingsStore } from "../state/settings";
import { useStatusStore } from "../state/status";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { MODES, modesFor, otherLayout, stepPath, type ReviewMode } from "../review/model";
import { notify, selectedBranch } from "./navigation";
import { openPane } from "./panes";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The selected session's id, when a session is selected. */
function selectedSessionId(): string | null {
  const selection = useUiStore.getState().selection;
  return selection !== null && selection.kind === "session" ? selection.id : null;
}

// -- Story 8.1: the diff pane ------------------------------------------------------------------

/** What "Review changes" reviews for the selection: the selected project, branch or session; else `null`. */
export function reviewTargetOfSelection(): ReviewTarget | null {
  const selection = useUiStore.getState().selection;
  if (selection === null) return null;
  if (selection.kind === "project") {
    const known = useWorkspaceStore.getState().snapshot?.workspace.projects.some((p) => p.id === selection.id) ?? false;
    return known ? { kind: "project", projectId: selection.id } : null;
  }
  if (selection.kind === "session") return { kind: "session", sessionId: selection.id };
  if (selection.kind === "branch") {
    const branch = selectedBranch();
    return branch === null ? null : { kind: "branch", projectId: branch.projectId, branch: branch.label };
  }
  return null;
}

/** The `when` of "Review changes": a project, branch or session is selected. */
export function canReviewSelection(): boolean {
  return reviewTargetOfSelection() !== null;
}

/** Whether the Review pane is open on a target: the `when` of the pane's own commands. */
export function isReviewOpen(): boolean {
  return useUiStore.getState().pane === "review" && useReviewStore.getState().target !== null;
}

/**
 * The mode the pane opens in for `target`: vs base for a branch without a linked worktree (its
 * Changes would only say `no worktree`), else Changes.
 */
export function openingMode(target: ReviewTarget): ReviewMode {
  if (target.kind !== "branch") return "changes";
  const child = useWorkspaceStore
    .getState()
    .snapshot?.children.find((c) => c.kind === "branch" && c.projectId === target.projectId && c.label === target.branch);
  return child?.branch !== undefined && child.branch !== null && child.branch.worktree === null ? "base" : "changes";
}

/** Open the Review pane on `target` (no review request on top). */
export function openReviewOf(target: ReviewTarget): void {
  useReviewStore.getState().openTarget(target, null, openingMode(target));
  openPane("review");
}

/** "Review changes": the pane on the selected node. Resolves whether it opened. */
export function reviewSelection(): boolean {
  const target = reviewTargetOfSelection();
  if (target === null) return false;
  openReviewOf(target);
  return true;
}

/** "Refresh": read the list (and the selected file) again. */
export function refreshReview(): void {
  if (isReviewOpen()) useReviewStore.getState().refresh();
}

/** The filter toggle: All, Staged or Unstaged. */
export function setReviewFilter(filter: DiffFilter): void {
  useReviewStore.getState().setFilter(filter);
}

/** Story 8.2: whether the open pane's target offers `mode` (a session has Changes only). */
export function canSetReviewMode(mode: ReviewMode): boolean {
  return isReviewOpen() && modesFor(useReviewStore.getState().target).includes(mode);
}

/** Story 8.2: the `when` of a mode command: the target offers `mode` and it is not the one showing. */
export function canSwitchReviewMode(mode: ReviewMode): boolean {
  return canSetReviewMode(mode) && useReviewStore.getState().mode !== mode;
}

/** The `when` of the filter commands: the pane is open on Changes (the filter's only mode). */
export function canSetReviewFilter(): boolean {
  return isReviewOpen() && useReviewStore.getState().mode === "changes";
}

/** Story 8.2: the mode toggle: Changes, vs base or Commits (vs base and Commits are read as they open). */
export function setReviewMode(mode: ReviewMode): void {
  if (!canSetReviewMode(mode)) return;
  useReviewStore.getState().setMode(mode);
}

/** The palette title of mode `mode`'s command: `Review: changes`, `Review: vs base`, `Review: commits`. */
export function reviewModeTitle(mode: ReviewMode): string {
  const label = MODES.find((m) => m.id === mode)?.label ?? mode;
  return `Review: ${label.toLowerCase()}`;
}

/** Whether the pane shows the working tree (the only mode the status poll and the own poll keep fresh). */
function showsChanges(): boolean {
  return useReviewStore.getState().mode === "changes";
}

/** The layout toggle: side by side ↔ unified. */
export function toggleReviewLayout(): void {
  const store = useReviewStore.getState();
  store.setLayout(otherLayout(store.layout));
}

/** The toggle's palette title: what it switches to. */
export function toggleLayoutTitle(): string {
  return useReviewStore.getState().layout === "split" ? "Review: unified view" : "Review: side-by-side view";
}

/** Select the file `delta` places from the selected one in the tree's order (requested files first). */
export function stepReviewFile(delta: number): void {
  const store = useReviewStore.getState();
  const next = stepPath(store.order, store.selected, delta);
  if (next !== null) store.select(next);
}

/** The project `target` belongs to (whose status poll keeps the list fresh), or `null`. */
export function projectOfTarget(target: ReviewTarget): string | null {
  if (target.kind !== "session") return target.projectId;
  const child = useWorkspaceStore.getState().snapshot?.children.find((c) => c.kind === "session" && c.id === target.sessionId);
  if (child !== undefined) return child.projectId;
  const sessions = useLiveStore.getState().snapshot.sessions;
  return Object.hasOwn(sessions, target.sessionId) ? (sessions[target.sessionId]?.project_id ?? null) : null;
}

// While the pane is open on Changes, a change in its project's status (the dirty count, the
// branch) reads the list again. vs base and Commits never poll: they are read as they open and on
// Refresh.
useStatusStore.subscribe((state, previous) => {
  if (state.statuses === previous.statuses || useUiStore.getState().pane !== "review" || !showsChanges()) return;
  const target = useReviewStore.getState().target;
  const project = target === null ? null : projectOfTarget(target);
  if (project === null) return;
  const was = Object.hasOwn(previous.statuses, project) ? previous.statuses[project] : undefined;
  const now = Object.hasOwn(state.statuses, project) ? state.statuses[project] : undefined;
  if (JSON.stringify(was) !== JSON.stringify(now)) useReviewStore.getState().refresh();
});

/** The default of `poll.git_ms` when no settings arrived yet. */
const DEFAULT_GIT_POLL_MS = 5000;

/** A path compared loosely: `/` separators, no trailing one, case-folded on Windows-style paths. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/**
 * Whether the pane's target needs its own poll: its folder (`root`, as Rust reported it) is not its
 * project's folder (a branch's worktree, a session in a linked worktree or elsewhere), so the
 * project's status poll, which leaves linked worktrees out, never sees its changes.
 */
export function needsOwnPoll(target: ReviewTarget, root: string | null): boolean {
  if (root === null) return false;
  if (target.kind === "project") return false;
  const project = projectOfTarget(target);
  const path = project === null ? undefined : useWorkspaceStore.getState().snapshot?.workspace.projects.find((p) => p.id === project)?.path;
  return path === undefined || !samePath(path, root);
}

/** The interval of the target's own poll: `poll.git_ms` from settings. */
function gitPollMs(): number {
  const ms = useSettingsStore.getState().snapshot?.settings.poll.git_ms;
  return typeof ms === "number" && ms > 0 ? ms : DEFAULT_GIT_POLL_MS;
}

// While the pane is open on Changes for a target that needs its own poll, the list (and the
// selected file) is read again every `poll.git_ms`; the pane keeps what it shows when nothing
// changed. vs base and Commits never poll.
let ownPoll: ReturnType<typeof setInterval> | null = null;
let ownPollKey = "";
function syncOwnPoll(): void {
  const { target, root } = useReviewStore.getState();
  const open = useUiStore.getState().pane === "review" && target !== null && showsChanges() && needsOwnPoll(target, root);
  const key = open ? `${JSON.stringify(target)}|${root}|${gitPollMs()}` : "";
  if (key === ownPollKey) return;
  ownPollKey = key;
  if (ownPoll !== null) clearInterval(ownPoll);
  ownPoll = open ? setInterval(() => useReviewStore.getState().refresh(), gitPollMs()) : null;
}
useReviewStore.subscribe(syncOwnPoll);
useUiStore.subscribe(syncOwnPoll);
useSettingsStore.subscribe(syncOwnPoll);

// -- Story 7.4: review requests ----------------------------------------------------------------

/**
 * The review "Open review request" opens: the selected session's whenever it has a request
 * (flagged or not), else the newest request. `null` with none.
 */
export function reviewToOpen(): string | null {
  const { requests } = useReviewStore.getState();
  const selected = selectedSessionId();
  if (selected !== null && requestIn(requests, selected) !== null) return selected;
  return requestList(requests).at(-1)?.sessionId ?? null;
}

/** The flag "Clear review flag" lowers: the selected session's when it is flagged, else the newest flagged one. */
export function flagToClear(): string | null {
  const { requests } = useReviewStore.getState();
  const selected = selectedSessionId();
  if (selected !== null && isFlagged(requests, selected)) return selected;
  return (
    requestList(requests)
      .filter((r) => r.flagged)
      .at(-1)?.sessionId ?? null
  );
}

/** The `when` of "Open review request": some session has a review request. */
export function canOpenReview(): boolean {
  return reviewToOpen() !== null;
}

/** The `when` of "Clear review flag": some session is flagged. */
export function canClearReview(): boolean {
  return flagToClear() !== null;
}

/** Whether the toast stack shows: some approval request is pending or some review toast is up. */
export function showsToastStack(pending: number, reviews: number): boolean {
  return pending > 0 || reviews > 0;
}

/**
 * Open session `sessionId`'s review, request `seq` (default: the one the UI shows now): Rust
 * lowers the flag and returns the request; the Review pane then shows the session's folder with
 * the request on top. Resolves whether the pane opened; a refusal (no request, or one replaced
 * since) is the notice.
 */
export async function openReview(sessionId: string, seq?: number): Promise<boolean> {
  const shown = seq ?? requestIn(useReviewStore.getState().requests, sessionId)?.seq;
  if (shown === undefined) {
    notify("could not open the review: no review request for this session");
    return false;
  }
  try {
    const request = await reviewOpen(sessionId, shown);
    const store = useReviewStore.getState();
    store.applyRequest(request);
    store.openTarget({ kind: "session", sessionId }, sessionId);
    openPane("review");
    return true;
  } catch (err) {
    notify(`could not open the review: ${describe(err)}`);
    return false;
  }
}

/** Lower session `sessionId`'s review flag (request `seq`, default the one shown) without opening the pane. */
export async function clearReview(sessionId: string, seq?: number): Promise<boolean> {
  const current = requestIn(useReviewStore.getState().requests, sessionId);
  const shown = seq ?? current?.seq;
  if (shown === undefined) return false;
  try {
    await reviewClear(sessionId, shown);
    const now = requestIn(useReviewStore.getState().requests, sessionId);
    if (now !== null && now.seq === shown && now.flagged) useReviewStore.getState().applyRequest({ ...now, flagged: false });
    return true;
  } catch (err) {
    notify(`could not clear the review flag: ${describe(err)}`);
    return false;
  }
}

/** "Open review request" from the palette. */
export async function openReviewFromPalette(): Promise<boolean> {
  const id = reviewToOpen();
  return id === null ? false : openReview(id);
}

/** "Clear review flag" from the palette. */
export async function clearReviewFromPalette(): Promise<boolean> {
  const id = flagToClear();
  return id === null ? false : clearReview(id);
}

/** A review toast's Dismiss: the toast goes, the flag stays. */
export function dismissReviewToast(sessionId: string, seq: number): void {
  useReviewStore.getState().dismiss(sessionId, seq);
}

// The pane shows a session's request and the session asks again: the new request is seen, so it
// is opened (its flag and toast never rise). Once per `seq`.
let seenSeq: { id: string; seq: number } | null = null;
useReviewStore.subscribe((state) => {
  const id = state.requestId;
  if (id === null || useUiStore.getState().pane !== "review") return;
  const request = requestIn(state.requests, id);
  if (request === null || !request.flagged) return;
  if (seenSeq !== null && seenSeq.id === id && seenSeq.seq === request.seq) return;
  seenSeq = { id, seq: request.seq };
  reviewOpen(id, request.seq).then(
    (opened) => {
      useReviewStore.getState().applyRequest(opened);
      // The new request's paths may name other files: read the list again.
      if (useReviewStore.getState().requestId === id) useReviewStore.getState().refresh();
    },
    (err: unknown) => console.warn(`review open failed: ${describe(err)}`),
  );
});
