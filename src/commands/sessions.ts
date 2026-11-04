// The session commands of Story 4.2: `project.newSession` (`n`) opens the launch sheet with
// Rust's prefill, Start sends the request, and `session.showTerminal` shows the terminal a
// launched session runs in. Rust owns the launch; these only call it and keep the stores and
// panes in step. A result that arrives after its sheet closed (or another opened) is not applied
// to the sheet showing now; a failure is the sheet's error, or the notice when its sheet is
// gone, never a throw. Story 4.4 adds `session.resume`, `session.fork` and `session.stop`
// (no sheet; a refusal is the notice).

import { launchDefaults, projectPickFolder, sessionFork, sessionLaunch, sessionResume, sessionStop, type ChildNode, type LaunchChoices, type LaunchResult, type SkippedEdge } from "../ipc";
import { isSheetOpen, sheetToken, useLaunchStore } from "../state/launch";
import { sessionState } from "../state/live";
import { isTerminalRunning, sessionTerminal, sessionTerminalId, terminalInfo, useTerminalStore } from "../state/terminals";
import { disposeView, restore } from "../terminal/registry";
import { currentPane, currentSelection, isPoppedOut, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { canStart, formFromPrefill, launchRequest, missingAddDirs, skippedNote, startBlockedReason, withAddDir, withoutAddDir } from "./launch";
import { notify, selectedBranch } from "./navigation";
import { setExpanded } from "./nodes";
import { closeOpenPane, openPane } from "./panes";
import { returnToPane, showTerminal } from "./terminal";

/** The add-dir picker's title. */
export const ADD_DIR_PICKER_TITLE = "Add folder for this session";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `project.newSession` (`n`, "New session…"): open the launch sheet on `projectId`, prefilled
 * by Rust (its last choices, else settings, else `default`; the name `<label>-<4 hex>` of the
 * session id it proposes). Resolves whether the sheet opened; a failure is the notice.
 */
export async function openLaunchSheet(projectId: string, branch?: string): Promise<boolean> {
  const project = useWorkspaceStore.getState().snapshot?.workspace.projects.find((p) => p.id === projectId);
  if (project === undefined) return false;
  try {
    const prefill = await launchDefaults(projectId, branch ?? null);
    // On a branch (Story 5.3) the folder is Rust's: its worktree, the project folder for the
    // checked-out branch, or the worktree the Start will create (`worktreePlan`).
    // Story 6.2: the project's context edges, resolved by Rust, prefill the add-dirs on both sheets.
    const edges = { edgeDirs: prefill.addDirs ?? [], skipped: prefill.skipped ?? [] };
    const target =
      branch === undefined
        ? { repoTop: prefill.repoTop ?? null, ...edges }
        : { branch, targetPath: prefill.targetPath ?? null, worktreePlan: prefill.worktreePlan ?? null, ...edges };
    useLaunchStore.getState().open({ id: project.id, path: project.path, label: project.label }, prefill.sessionId, formFromPrefill(prefill), target);
    openPane("launch");
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  }
}

/**
 * The `when` of `branch.newSession` (Story 5.3): a branch card is selected whose worktree chip
 * is not `missing` -- it has a worktree, is the checked-out branch, or has none (the sheet then
 * creates one) -- and the sheet is not open already (so `n` typed in it never resets the form).
 */
export function canNewSessionOnBranch(): boolean {
  const branch = selectedBranch();
  return branch !== null && branch.branch !== null && branch.branch.worktree?.missing !== true && currentPane() !== "launch";
}

/** `branch.newSession` ("New session…", `n` on a branch card): the launch sheet aimed at that branch. */
export function openLaunchSheetForBranch(): Promise<boolean> {
  const branch = selectedBranch();
  if (branch === null) return Promise.resolve(false);
  return openLaunchSheet(branch.projectId, branch.label);
}

/** Re-read the branch sheet `token` names from Rust and take its target and session id; a failure changes nothing. */
async function retarget(token: NonNullable<ReturnType<typeof sheetToken>>, projectId: string, branch: string): Promise<void> {
  try {
    const prefill = await launchDefaults(projectId, branch);
    if (!isSheetOpen(token)) return;
    useLaunchStore.getState().retarget(prefill.sessionId, { targetPath: prefill.targetPath ?? null, worktreePlan: prefill.worktreePlan ?? null });
  } catch {
    // The error from the start already shows; the sheet keeps what it had.
  }
}

/** The sheet `token` names goes, when it is still the one open (else nothing). */
function closeSheet(token: ReturnType<typeof sheetToken>): void {
  if (token === null || !isSheetOpen(token)) return;
  if (useUiStore.getState().pane === "launch") closeOpenPane();
  else useLaunchStore.getState().reset();
}

/**
 * Start: send the sheet's request with the session id it was given. On success the terminal
 * is known at once and the sheet goes; in the foreground the pane opens on the terminal,
 * focused, and the new child is selected (its project expanded); in the background the canvas
 * only shows the child. On a refusal the sheet stays with the reason under Start (and every
 * missing add-dir marked on its row). A reply for a sheet that has since closed or reopened
 * touches no sheet: a success still registers the terminal, a refusal is the notice.
 * Resolves whether a session started.
 */
export async function startLaunch(): Promise<boolean> {
  const sheet = useLaunchStore.getState();
  const token = sheetToken();
  const { projectId, form, sessionId } = sheet;
  if (token === null || projectId === null || form === null || sheet.starting || !canStart(form, sheet.missingDirs, sheet.worktreePlan, sheet.repoTop)) return false;
  sheet.setStarting(true);
  const request = launchRequest(projectId, sessionId, form, { branch: sheet.branch, createWorktree: sheet.worktreePlan !== null });
  let started;
  try {
    started = await sessionLaunch(request, null, null);
  } catch (err) {
    const message = describe(err);
    if (isSheetOpen(token)) useLaunchStore.getState().fail(message, missingAddDirs(message, form.addDirs));
    else notify(message);
    // A worktree may have been made before the start failed (Story 5.3): the sheet re-reads its
    // branch so it shows the new folder and no plan; the form and the error stay.
    if (sheet.worktreePlan !== null && sheet.branch !== null && isSheetOpen(token)) await retarget(token, projectId, sheet.branch);
    return false;
  }
  useTerminalStore.getState().upsert(started.term);
  const current = isSheetOpen(token);
  closeSheet(token);
  if (request.background || !current) return true;
  const project = useWorkspaceStore.getState().snapshot?.workspace.projects.find((p) => p.id === projectId);
  if (project !== undefined && !project.expanded) void setExpanded(projectId, true);
  useUiStore.getState().select({ kind: "session", id: started.session_id });
  await showTerminal(started.term.id);
  return true;
}

/**
 * "Add folder…": pick a folder with the OS dialog ("Add folder for this session") and list it
 * (unless it is already there or the project's own), on the sheet that asked.
 */
export async function pickAddDir(): Promise<boolean> {
  const token = sheetToken();
  if (token === null) return false;
  let picked: string | null;
  try {
    picked = await projectPickFolder(ADD_DIR_PICKER_TITLE);
  } catch (err) {
    if (isSheetOpen(token)) useLaunchStore.getState().fail(describe(err), useLaunchStore.getState().missingDirs);
    else notify(describe(err));
    return false;
  }
  if (picked === null || !isSheetOpen(token)) return false;
  const sheet = useLaunchStore.getState();
  if (sheet.form === null) return false;
  sheet.edit({ addDirs: withAddDir(sheet.form.addDirs, picked, sheet.targetPath ?? sheet.projectPath) });
  return true;
}

/** The remove button of add-dir row `index`. */
export function removeAddDir(index: number): void {
  const sheet = useLaunchStore.getState();
  if (sheet.form !== null) sheet.edit({ addDirs: withoutAddDir(sheet.form.addDirs, index) });
}

/** The id of the selected session's terminal when Switchboard runs it in one; else `null`. */
export function selectedSessionTerminal(): string | null {
  const selection = currentSelection();
  if (selection === null || selection.kind !== "session") return null;
  return sessionTerminal(selection.id)?.id ?? null;
}

/** The `when` of `session.showTerminal`: the selected session has a Switchboard terminal. */
export function canShowSessionTerminal(): boolean {
  return selectedSessionTerminal() !== null;
}

/** `session.showTerminal` ("Show terminal"): open the pane on the selected session's terminal. */
export async function showSelectedSessionTerminal(): Promise<boolean> {
  const id = selectedSessionTerminal();
  return id === null ? false : showTerminal(id);
}

// --- Resume, fork, stop (Story 4.4) ----------------------------------------------------------

/** The selected session child (a session card), or `null`. */
function selectedSessionChild(): ChildNode | null {
  const selection = currentSelection();
  if (selection === null || selection.kind !== "session") return null;
  return useWorkspaceStore.getState().snapshot?.children.find((c) => c.kind === "session" && c.id === selection.id) ?? null;
}

/** Whether a session child has a transcript (Rust's `hasTranscript`: it was discovered from one). */
export function hasTranscript(child: ChildNode | null): boolean {
  return child !== null && child.kind === "session" && child.hasTranscript;
}

/** Session ids a Resume was sent for and has not replied yet. */
const starting = new Set<string>();

/** Session ids a Fork *from* was sent for and has not replied yet. */
const forking = new Set<string>();

/**
 * The notice after a Resume or Fork: what it ran with, since no sheet showed it (the
 * project's latest choices; a flag left out reads `default`). Context edges whose target gave
 * no folder (Story 6.2) come first, so the one-line notice never cuts them off:
 * `resumed without: feat (no worktree) · resumed with model …`.
 */
export function startedNotice(verb: "resumed" | "forked", choices: LaunchChoices, skipped?: readonly SkippedEdge[]): string {
  const used = `${verb} with model ${choices.model}, effort ${choices.effort}, mode ${choices.permission_mode}`;
  const without = skippedNote(`${verb} without`, skipped);
  return without === null ? used : `${without} · ${used}`;
}

/**
 * The `when` of `session.resume`: the selected session has a transcript and is not live (the
 * live map has no entry for it, or it has `exited`), and no terminal of its runs.
 */
export function canResumeSession(): boolean {
  const child = selectedSessionChild();
  if (child === null || !hasTranscript(child)) return false;
  const state = sessionState(child.id);
  return (state === null || state.kind === "exited") && !isTerminalRunning(sessionTerminalId(child.id));
}

/** The `when` of `session.fork`: the selected session has a transcript, live or not. */
export function canForkSession(): boolean {
  return hasTranscript(selectedSessionChild());
}

/**
 * The `when` of `session.stop`: the selected session runs in a Switchboard terminal. A session
 * started elsewhere has no such terminal and is never signalled.
 */
export function canStopSession(): boolean {
  const child = selectedSessionChild();
  return child !== null && isTerminalRunning(sessionTerminalId(child.id));
}

/** A started Resume or Fork: its terminal is known, the node selected, the pane open on it. */
async function showStarted(projectId: string, started: LaunchResult): Promise<void> {
  useTerminalStore.getState().upsert(started.term);
  const project = useWorkspaceStore.getState().snapshot?.workspace.projects.find((p) => p.id === projectId);
  if (project !== undefined && !project.expanded) void setExpanded(projectId, true);
  useUiStore.getState().select({ kind: "session", id: started.session_id });
  await showTerminal(started.term.id);
}

/**
 * `session.resume` ("Resume"): `claude --resume <id>` for the selected historic session, at
 * once (no sheet). The same node turns `starting`, then live; the pane opens on its terminal,
 * focused. An exited terminal of its earlier run is replaced (its view starts afresh). A
 * refusal (it is starting or running, no folder, …) is the notice. Resolves whether it started.
 */
export async function resumeSelectedSession(): Promise<boolean> {
  const child = selectedSessionChild();
  if (child === null) return false;
  if (starting.has(child.id)) {
    notify("that session is already starting");
    return false;
  }
  const termId = sessionTerminalId(child.id);
  const previous = terminalInfo(termId);
  starting.add(child.id);
  // The new run's output counts from 0 again: the old view goes before any of it arrives,
  // and the old info too (an exit of the new run that overtakes the reply then waits for it).
  if (previous !== null) {
    disposeView(termId);
    useTerminalStore.getState().remove([termId]);
  }
  try {
    const started = await sessionResume(child.projectId, child.id, null, null);
    // Its pop-out (Story 4.5) shows the earlier run: once the new one runs, it returns to the pane.
    if (isPoppedOut(termId)) await returnToPane(termId);
    await showStarted(child.projectId, started);
    notify(startedNotice("resumed", started.choices, started.skipped));
    return true;
  } catch (err) {
    notify(describe(err));
    // The earlier run's terminal is still Rust's: its info comes back and its view replays.
    if (previous !== null && terminalInfo(termId) === null) {
      useTerminalStore.getState().upsert(previous);
      void restore(termId);
    }
    return false;
  } finally {
    starting.delete(child.id);
  }
}

/**
 * `session.fork` ("Fork"): a new session forked from the selected one, at once (no sheet). Its
 * node appears with a thin line to the original; the pane opens on it, focused, and it is
 * selected. A refusal is the notice. Resolves whether it started.
 */
export async function forkSelectedSession(): Promise<boolean> {
  const child = selectedSessionChild();
  if (child === null) return false;
  if (forking.has(child.id)) {
    notify("a fork of that session is already starting");
    return false;
  }
  forking.add(child.id);
  try {
    const started = await sessionFork(child.projectId, child.id, null, null);
    await showStarted(child.projectId, started);
    notify(startedNotice("forked", started.choices, started.skipped));
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  } finally {
    forking.delete(child.id);
  }
}

/**
 * `session.stop` ("Stop"): stop the selected session's Switchboard terminal (Ctrl+U and `/exit`
 * at its prompt, else Ctrl+C twice; Rust kills it 5 s later if it still runs; a second Stop kills at
 * once). Its card reads `stopping` until it exits. A refusal is the notice.
 */
export async function stopSelectedSession(): Promise<boolean> {
  const child = selectedSessionChild();
  if (child === null) return false;
  try {
    const info = await sessionStop(child.id);
    // An exit that overtook the reply stands.
    if (terminalInfo(info.id)?.exited === null) useTerminalStore.getState().upsert(info);
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  }
}

// -- Story 9.4: the launch sheet's buttons as commands ----------------------------------------

/** True while the launch sheet shows (its form loaded). */
function launchSheetShows(): boolean {
  return useUiStore.getState().pane === "launch" && useLaunchStore.getState().form !== null;
}

/** The `when` of `launch.start` (the sheet's Start): the sheet shows and nothing blocks its Start. */
export function canStartLaunch(): boolean {
  if (!launchSheetShows()) return false;
  const sheet = useLaunchStore.getState();
  return sheet.form !== null && startBlockedReason(sheet.form, sheet.missingDirs, sheet.starting, sheet.worktreePlan, sheet.repoTop) === null;
}

/** The `when` of `launch.addFolder` (the sheet's "Add folder…"): the sheet shows and is not starting. */
export function canPickAddDir(): boolean {
  return launchSheetShows() && !useLaunchStore.getState().starting;
}
