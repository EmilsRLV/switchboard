// The actions behind `project.add`, the canvas drop and the import pane. Rust owns the
// model: every path here ends in `workspace_add_projects`, whose snapshot is applied to the
// workspace store. Ids Rust reports as already present are flashed (a 1.5 s outline) instead
// of adding a second node. Nothing rejects: `runCommand` has no error UI, so failures land in
// a store (the workspace load-error banner, or the import pane's error line).

import { claudeProjectsList, projectPickFolder, workspaceAddProjects, type AddProjectsResult, type Position } from "../ipc";
import { cardTopLeft } from "../canvas/nodes";
import { viewportCentre } from "../state/canvas";
import { importRows, selectedToAdd, useImportStore } from "../state/import";
import { FLASH_MS, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { closeOpenPane } from "./panes";

/** Where the clock comes from, so tests can fake it. */
export type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/** The pending end-of-flash per id, so a re-flash restarts its clock instead of being cut short. */
const flashTimers = new Map<string, unknown>();

/** Highlight `ids` for `FLASH_MS` from now, each id on its own clock. */
export function flashProjects(ids: readonly string[], timers: Timers = globalThis as Timers): void {
  if (ids.length === 0) return;
  useUiStore.getState().flash(ids);
  for (const id of ids) {
    const pending = flashTimers.get(id);
    if (pending !== undefined) timers.clearTimeout(pending);
    flashTimers.set(
      id,
      timers.setTimeout(() => {
        flashTimers.delete(id);
        useUiStore.getState().unflash([id]);
      }, FLASH_MS),
    );
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Default error sink: the workspace banner strip. */
function reportToWorkspace(message: string): void {
  useWorkspaceStore.getState().setLoadError(`project add failed: ${message}`);
}

/** The canvas point at which a card placed "at the centre of the view" is itself centred. */
function centredCardPosition(): Position {
  return cardTopLeft(viewportCentre() ?? { x: 0, y: 0 });
}

/**
 * Add `paths` as project nodes at `position`; apply the snapshot that comes back and flash
 * the nodes that were already there. Resolves with Rust's result, or `null` when the call
 * failed (reported through `onError`, never thrown). Paths that are not folders come back in
 * `skipped` and add nothing: a dropped file is a silent no-op.
 */
export async function addProjectsAt(
  paths: readonly string[],
  position: Position,
  onError: (message: string) => void = reportToWorkspace,
): Promise<AddProjectsResult | null> {
  if (paths.length === 0) return null;
  let result: AddProjectsResult;
  try {
    result = await workspaceAddProjects([...paths], position);
  } catch (err) {
    onError(describe(err));
    return null;
  }
  const store = useWorkspaceStore.getState();
  store.applySnapshot(result.snapshot);
  store.setLoadError(null); // the round trip works again
  flashProjects(result.existing);
  return result;
}

/**
 * The Elsewhere tray's Add folder: put a live session's `cwd` on the canvas, centred on the
 * view. The session moves under it on the next poll; a failure is the `project add failed`
 * banner.
 */
export function addElsewhereFolder(cwd: string): Promise<AddProjectsResult | null> {
  return addProjectsAt([cwd], centredCardPosition());
}

/** A folder (or several) dropped on the canvas at `position`. */
export function dropProjects(paths: readonly string[], position: Position): Promise<AddProjectsResult | null> {
  return addProjectsAt(paths, position);
}

let pickerOpen = false;

/** True while no folder picker is showing: the `when` of `project.add` (one dialog at a time). */
export function isPickerIdle(): boolean {
  return !pickerOpen;
}

/**
 * `project.add`: open the native folder picker and add the chosen folder centred on the
 * view. Cancelling adds nothing. A failure to open the picker is a workspace banner.
 */
export async function addProjectFromPicker(): Promise<void> {
  if (pickerOpen) return;
  pickerOpen = true;
  try {
    const path = await projectPickFolder();
    if (path === null) return;
    await addProjectsAt([path], centredCardPosition());
  } catch (err) {
    reportToWorkspace(`folder picker: ${describe(err)}`);
  } finally {
    pickerOpen = false;
  }
}

/** Fill the import pane: ask Rust for Claude's projects. Failures show in the pane. */
export async function loadImportList(): Promise<void> {
  const store = useImportStore.getState();
  store.begin();
  try {
    const items = await claudeProjectsList();
    useImportStore.getState().setItems(items);
  } catch (err) {
    useImportStore.getState().setError(`could not list Claude projects: ${describe(err)}`);
  }
}

/**
 * The import pane's "Add selected" (also Enter): add the ticked folders that are not on the
 * canvas yet, centred on the view (fanned out by Rust), then close the pane, if it is still
 * the import pane that is showing. With nothing to add this is a no-op; a failure stays in
 * the pane as its error line.
 */
export async function addSelectedImports(): Promise<void> {
  const store = useImportStore.getState();
  if (store.adding) return;
  const rows = importRows(store.items ?? []);
  const cwds = selectedToAdd(rows, store.selected);
  if (cwds.length === 0) return;
  store.setAdding(true);
  const result = await addProjectsAt(cwds, centredCardPosition(), (message) => useImportStore.getState().setError(message));
  if (result === null) return; // setError already ended `adding`
  if (useUiStore.getState().pane === "import") closeOpenPane();
  else useImportStore.getState().setAdding(false);
}
