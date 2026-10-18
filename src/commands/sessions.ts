// The session commands of Story 4.2: `project.newSession` (`n`) opens the launch sheet with
// Rust's prefill, Start sends the request, and `session.showTerminal` shows the terminal a
// launched session runs in. Rust owns the launch; these only call it and keep the stores and
// panes in step. A result that arrives after its sheet closed (or another opened) is not applied
// to the sheet showing now; a failure is the sheet's error, or the notice when its sheet is
// gone, never a throw.

import { launchDefaults, projectPickFolder, sessionLaunch } from "../ipc";
import { isSheetOpen, sheetToken, useLaunchStore } from "../state/launch";
import { sessionTerminal, useTerminalStore } from "../state/terminals";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { canStart, formFromPrefill, launchRequest, missingAddDirs, withAddDir, withoutAddDir } from "./launch";
import { notify } from "./navigation";
import { setExpanded } from "./nodes";
import { closeOpenPane, openPane } from "./panes";
import { showTerminal } from "./terminal";

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
export async function openLaunchSheet(projectId: string): Promise<boolean> {
  const project = useWorkspaceStore.getState().snapshot?.workspace.projects.find((p) => p.id === projectId);
  if (project === undefined) return false;
  try {
    const prefill = await launchDefaults(projectId);
    useLaunchStore.getState().open({ id: project.id, path: project.path, label: project.label }, prefill.sessionId, formFromPrefill(prefill));
    openPane("launch");
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
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
  if (token === null || projectId === null || form === null || sheet.starting || !canStart(form, sheet.missingDirs)) return false;
  sheet.setStarting(true);
  const request = launchRequest(projectId, sessionId, form);
  let started;
  try {
    started = await sessionLaunch(request, null, null);
  } catch (err) {
    const message = describe(err);
    if (isSheetOpen(token)) useLaunchStore.getState().fail(message, missingAddDirs(message, form.addDirs));
    else notify(message);
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
  sheet.edit({ addDirs: withAddDir(sheet.form.addDirs, picked, sheet.projectPath) });
  return true;
}

/** The remove button of add-dir row `index`. */
export function removeAddDir(index: number): void {
  const sheet = useLaunchStore.getState();
  if (sheet.form !== null) sheet.edit({ addDirs: withoutAddDir(sheet.form.addDirs, index) });
}

/** The id of the selected session's terminal when Switchboard runs it in one; else `null`. */
export function selectedSessionTerminal(): string | null {
  const selection = useUiStore.getState().selection;
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
