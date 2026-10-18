// The terminal commands of Story 4.1: "Plain terminal…" opens (or shows) a project's terminal
// in the terminal pane, `terminal.toggle` hides and reshows the pane from anywhere, and
// `terminal.kill` / `terminal.restart` act on the terminal the pane shows. Rust owns the
// processes; these only call it and keep the store and the pane in step. A failure is the
// notice, never a throw.
//
// Story 4.5: every terminal shown in the pane is a tab (`ui.openTerminals`); `terminal.nextTab`
// / `terminal.prevTab` move between them, a tab's × closes the tab only (an exited session
// terminal closes for good, as its Close does), and `terminal.popOut` moves the active terminal
// into its own window (Rust's), which "Return to pane" or closing the window undoes.

import { termClose, termKill, termOpen, termPopOut, termRestart, termReturn } from "../ipc";
import { isTerminalRestartable, isTerminalRunning, plainTerminalId, terminalInfo, useTerminalStore } from "../state/terminals";
import { isPoppedOut, useUiStore } from "../state/ui";
import { applyPopped, disposeView, fitView, focusView, markRestarting, markSent, poppedSequence, resetView } from "../terminal/registry";
import { notify } from "./navigation";
import { closeOpenPane, openPane } from "./panes";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Two animation frames (the pane rendered and laid out), or at once without a window. */
function afterLayout(): Promise<void> {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame;
  if (typeof raf !== "function") return Promise.resolve();
  return new Promise((resolve) => raf(() => raf(() => resolve())));
}

/** The terminal the pane shows (or would show): the active one, else the last tab, else the newest known. */
export function currentTerminal(): string | null {
  const ui = useUiStore.getState();
  if (ui.activeTerminal !== null) return ui.activeTerminal;
  const last = ui.openTerminals[ui.openTerminals.length - 1];
  if (last !== undefined) return last;
  const ids = Object.keys(useTerminalStore.getState().infos);
  return ids.length === 0 ? null : (ids[ids.length - 1] ?? null);
}

/**
 * `project.terminal` ("Plain terminal…"): show the project's terminal in the pane, opening it
 * first when it does not exist yet; its first size is the pane's fitted size (Rust falls back
 * to 120 × 30). Resolves whether the terminal is showing.
 */
export async function openProjectTerminal(projectId: string): Promise<boolean> {
  const id = plainTerminalId(projectId);
  useUiStore.getState().openTab(id);
  openPane("terminal");
  await afterLayout();
  if (terminalInfo(id) !== null) {
    // Already open: just show and focus it (the pane may have been showing it already).
    focusView(id);
    return true;
  }
  const size = fitView(id);
  try {
    const info = await termOpen(projectId, size?.cols ?? null, size?.rows ?? null);
    useTerminalStore.getState().upsert(info);
    markSent(info.id, size);
    if (info.id !== id) useUiStore.getState().openTab(info.id);
    focusView(info.id);
    return true;
  } catch (err) {
    notify(describe(err));
    // Nothing to show: its tab goes (and the pane, when that was the last).
    if (terminalInfo(id) === null) dropTab(id);
    return false;
  }
}

/** The `when` of `terminal.toggle`: the pane shows, or there is a terminal to show. */
export function canToggleTerminal(): boolean {
  return useUiStore.getState().pane === "terminal" || currentTerminal() !== null;
}

/** `terminal.toggle` (ctrl+`): hide the pane, or show it again with the last terminal focused. */
export function toggleTerminalPane(): void {
  const ui = useUiStore.getState();
  if (ui.pane === "terminal") {
    closeOpenPane();
    return;
  }
  const id = currentTerminal();
  if (id === null) return;
  ui.openTab(id);
  openPane("terminal");
}

/** The `when` of `terminal.kill`: the pane's terminal runs. */
export function canKillTerminal(): boolean {
  return isTerminalRunning(currentTerminal());
}

/** `terminal.kill`: kill the pane's terminal (or `id`'s); it turns `exited` and keeps its output. */
export async function killTerminal(id: string | null = currentTerminal()): Promise<boolean> {
  if (id === null || !isTerminalRunning(id)) return false;
  try {
    await termKill(id);
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  }
}

/** The `when` of `terminal.restart`: the pane's terminal is a plain one that has exited. */
export function canRestartTerminal(): boolean {
  return isTerminalRestartable(currentTerminal());
}

/** `terminal.restart`: respawn the pane's (or `id`'s) exited plain terminal in place, keeping its output. */
export async function restartTerminal(id: string | null = currentTerminal()): Promise<boolean> {
  if (id === null || !isTerminalRestartable(id)) return false;
  try {
    // The old shell may have left the screen in another mode (alternate screen, mouse
    // reporting, colours): the new one starts on a clean view.
    resetView(id);
    markRestarting(id, true);
    const info = await termRestart(id);
    useTerminalStore.getState().upsert(info);
    focusView(id);
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  } finally {
    markRestarting(id, false);
  }
}

/**
 * Show terminal `id` in the pane, focused once the pane has laid out (`session.showTerminal`,
 * and a session launched in the foreground). Resolves whether it is showing.
 */
export async function showTerminal(id: string): Promise<boolean> {
  if (terminalInfo(id) === null) return false;
  useUiStore.getState().openTab(id);
  openPane("terminal");
  await afterLayout();
  focusView(id);
  return true;
}

/** True when terminal `id` is a session terminal that has exited (it can be closed for good). */
export function isClosableTerminal(id: string | null): boolean {
  const info = terminalInfo(id);
  return info !== null && info.kind === "session" && info.exited !== null;
}

/** The `when` of `terminal.close`: the pane's terminal is a session terminal that has exited. */
export function canCloseTerminal(): boolean {
  return isClosableTerminal(currentTerminal());
}

/**
 * `terminal.close` (the pane's "Close" on an exited session terminal; `id` for a tab's × or a
 * pop-out): Rust forgets it (and closes its pop-out), its view, info and tab go, and the pane is
 * put away when no tab is left. Resolves whether it closed; a failure is the notice.
 */
export async function closeTerminal(id: string | null = currentTerminal()): Promise<boolean> {
  if (id === null || !isClosableTerminal(id)) return false;
  try {
    await termClose(id);
  } catch (err) {
    notify(describe(err));
    return false;
  }
  forgetTerminal(id);
  return true;
}

/**
 * Terminal `id` is gone (closed here or in another window, `term://closed`; its project left
 * the canvas): its info, view and tab go. Idempotent.
 */
export function forgetTerminal(id: string): void {
  if (terminalInfo(id) !== null) useTerminalStore.getState().remove([id]);
  disposeView(id);
  applyPopped(id, null);
  dropTab(id);
}

/** Remove `id`'s tab (and stop showing it); with no tab left, the terminal pane is put away. */
function dropTab(id: string): void {
  const ui = useUiStore.getState();
  ui.closeTab(id);
  if (useUiStore.getState().activeTerminal === id) ui.setActiveTerminal(null);
  const after = useUiStore.getState();
  if (after.openTerminals.length === 0 && after.pane === "terminal") closeOpenPane();
}

/**
 * A tab's ×: the tab goes and its process keeps running (the node or the palette brings it
 * back). An exited session terminal is closed for good, as its header's Close does.
 */
export async function closeTerminalTab(id: string): Promise<void> {
  // Closing for good: the tab goes only once Rust closed it (a refusal is the notice, the tab stays).
  if (isClosableTerminal(id)) {
    await closeTerminal(id);
    return;
  }
  dropTab(id);
}

/** A click on tab `id`: show it in the pane, focused. */
export function activateTab(id: string): void {
  useUiStore.getState().openTab(id);
}

/** The `when` of `terminal.nextTab` / `terminal.prevTab`: the pane shows and has two tabs or more. */
export function canSwitchTab(): boolean {
  const ui = useUiStore.getState();
  return ui.pane === "terminal" && ui.openTerminals.length > 1;
}

/** `terminal.nextTab` (ctrl+pagedown, +1) / `terminal.prevTab` (ctrl+pageup, -1), wrapping around. */
export function switchTab(delta: number): void {
  if (canSwitchTab()) useUiStore.getState().nextTab(delta);
}

/** The `when` of `terminal.popOut`: the pane is open on a known terminal that is not popped out already. */
export function canPopOut(): boolean {
  const ui = useUiStore.getState();
  const id = ui.activeTerminal;
  return ui.pane === "terminal" && id !== null && terminalInfo(id) !== null && !isPoppedOut(id);
}

/**
 * `terminal.popOut` ("Pop out terminal"): move the active terminal (or `id`) into its own OS
 * window, or focus the one it is already in ("Focus window"). Resolves whether it is in one; a
 * window that could not be made is the notice, and the tab stays as it was.
 */
export async function popOutTerminal(id: string | null = useUiStore.getState().activeTerminal): Promise<boolean> {
  if (id === null || terminalInfo(id) === null) return false;
  const seen = poppedSequence(id);
  try {
    const label = await termPopOut(id);
    // A `term://popped` that arrived meanwhile is newer than this reply: it stands.
    if (poppedSequence(id) === seen) applyPopped(id, label);
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  }
}

/** "Return to pane": close `id`'s pop-out window; the tab shows the live view again. */
export async function returnToPane(id: string): Promise<boolean> {
  const seen = poppedSequence(id);
  try {
    await termReturn(id);
  } catch (err) {
    notify(describe(err));
    return false;
  }
  if (poppedSequence(id) === seen) applyPopped(id, null);
  return true;
}

/**
 * A project left the canvas: Rust killed and forgot its terminals (and closed their pop-outs);
 * drop their infos, views and tabs, and put the pane away when no tab is left.
 */
export function forgetProjectTerminals(projectId: string): void {
  const ids = Object.values(useTerminalStore.getState().infos)
    .filter((info) => info.project_id === projectId)
    .map((info) => info.id);
  for (const id of ids) forgetTerminal(id);
}
