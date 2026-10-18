// The terminal commands of Story 4.1: "Plain terminal…" opens (or shows) a project's terminal
// in the terminal pane, `terminal.toggle` hides and reshows the pane from anywhere, and
// `terminal.kill` / `terminal.restart` act on the terminal the pane shows. Rust owns the
// processes; these only call it and keep the store and the pane in step. A failure is the
// notice, never a throw.

import { termClose, termKill, termOpen, termRestart } from "../ipc";
import { isTerminalRestartable, isTerminalRunning, plainTerminalId, terminalInfo, useTerminalStore } from "../state/terminals";
import { useUiStore } from "../state/ui";
import { disposeView, fitView, focusView, markSent, resetView } from "../terminal/registry";
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

/** The terminal the pane shows (or would show): the active one, else the newest known. */
export function currentTerminal(): string | null {
  const active = useUiStore.getState().activeTerminal;
  if (active !== null) return active;
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
  const ui = useUiStore.getState();
  ui.setActiveTerminal(id);
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
    if (info.id !== id) useUiStore.getState().setActiveTerminal(info.id);
    focusView(info.id);
    return true;
  } catch (err) {
    notify(describe(err));
    // Nothing to show: put the pane away again.
    if (useUiStore.getState().activeTerminal === id && terminalInfo(id) === null) {
      useUiStore.getState().setActiveTerminal(null);
      if (useUiStore.getState().pane === "terminal") closeOpenPane();
    }
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
  ui.setActiveTerminal(id);
  openPane("terminal");
}

/** The `when` of `terminal.kill`: the pane's terminal runs. */
export function canKillTerminal(): boolean {
  return isTerminalRunning(currentTerminal());
}

/** `terminal.kill`: kill the pane's terminal; it turns `exited` and keeps its output. */
export async function killTerminal(): Promise<boolean> {
  const id = currentTerminal();
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

/** `terminal.restart`: respawn the pane's exited plain terminal in place, keeping its output. */
export async function restartTerminal(): Promise<boolean> {
  const id = currentTerminal();
  if (id === null || !isTerminalRestartable(id)) return false;
  try {
    // The old shell may have left the screen in another mode (alternate screen, mouse
    // reporting, colours): the new one starts on a clean view.
    resetView(id);
    const info = await termRestart(id);
    useTerminalStore.getState().upsert(info);
    focusView(id);
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  }
}

/**
 * Show terminal `id` in the pane, focused once the pane has laid out (`session.showTerminal`,
 * and a session launched in the foreground). Resolves whether it is showing.
 */
export async function showTerminal(id: string): Promise<boolean> {
  if (terminalInfo(id) === null) return false;
  useUiStore.getState().setActiveTerminal(id);
  openPane("terminal");
  await afterLayout();
  focusView(id);
  return true;
}

/** The `when` of `terminal.close`: the pane's terminal is a session terminal that has exited. */
export function canCloseTerminal(): boolean {
  const info = terminalInfo(currentTerminal());
  return info !== null && info.kind === "session" && info.exited !== null;
}

/**
 * `terminal.close` (the pane's "Close" on an exited session terminal): Rust forgets it, its
 * view and info go, and the pane is put away. Resolves whether it closed; a failure is the notice.
 */
export async function closeTerminal(): Promise<boolean> {
  const id = currentTerminal();
  if (id === null || !canCloseTerminal()) return false;
  try {
    await termClose(id);
  } catch (err) {
    notify(describe(err));
    return false;
  }
  useTerminalStore.getState().remove([id]);
  disposeView(id);
  const ui = useUiStore.getState();
  if (ui.activeTerminal === id) {
    if (ui.pane === "terminal") closeOpenPane();
    ui.setActiveTerminal(null);
  }
  return true;
}

/**
 * A project left the canvas: Rust killed and forgot its terminals; drop their infos and views,
 * and put the pane away when it showed one of them.
 */
export function forgetProjectTerminals(projectId: string): void {
  const store = useTerminalStore.getState();
  const ids = Object.values(store.infos)
    .filter((info) => info.project_id === projectId)
    .map((info) => info.id);
  if (ids.length === 0) return;
  store.remove(ids);
  for (const id of ids) disposeView(id);
  const ui = useUiStore.getState();
  if (ui.activeTerminal !== null && ids.includes(ui.activeTerminal)) {
    if (ui.pane === "terminal") closeOpenPane();
    ui.setActiveTerminal(null);
  }
}
