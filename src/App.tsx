import { useEffect } from "react";
import {
  hasTauriRuntime,
  liveSessionsGet,
  onLiveSessions,
  onNotifyReveal,
  onProjectsStatus,
  onSettingsChanged,
  onWorkspaceChanged,
  projectsStatusGet,
  settingsGet,
  workspaceGet,
} from "./ipc";
import { mirror } from "./ipc/mirror";
import { revealToastSession } from "./commands/attention";
import { registerBuiltins } from "./commands/builtins";
import { useKeybindings } from "./commands/keybindings";
import { forgetTerminal } from "./commands/terminal";
import { useLiveStore } from "./state/live";
import { useSettingsStore } from "./state/settings";
import { useStatusStore } from "./state/status";
import { useUiStore } from "./state/ui";
import { useWorkspaceStore } from "./state/workspace";
import { Canvas } from "./canvas/Canvas";
import { Banners } from "./components/Banners";
import { ContextMenu } from "./components/ContextMenu";
import { ElsewhereTray } from "./components/ElsewhereTray";
import { ImportPane } from "./components/ImportPane";
import { LaunchPane } from "./components/LaunchPane";
import { WorktreePane } from "./components/WorktreePane";
import { Notice } from "./components/Notice";
import { Palette } from "./components/Palette";
import { SettingsPane } from "./components/SettingsPane";
import { connectTerminals } from "./terminal/registry";
import { TerminalHolder, TerminalPane } from "./terminal/TerminalPane";
import "./components/shell.css";

// Commands exist for the life of the module, not of a component: registered once here.
registerBuiltins();

/**
 * The shell: banner strip on top, the canvas filling the rest with the transient notice laid
 * over its top edge and the Elsewhere tray at its bottom-left, one pane (settings, import, terminal, the launch sheet or the worktree sheet) on the right when open,
 * the hidden holder that keeps every terminal's view alive while the terminal pane is not showing it, the command
 * palette over everything when open, the node context menu at the pointer when open. Every
 * key goes through the command registry's dispatcher (`useKeybindings`).
 */
export default function App() {
  const pane = useUiStore((s) => s.pane);
  const applySettings = useSettingsStore((s) => s.applySnapshot);
  const setSettingsLoadError = useSettingsStore((s) => s.setLoadError);
  const applyWorkspace = useWorkspaceStore((s) => s.applySnapshot);
  const setWorkspaceLoadError = useWorkspaceStore((s) => s.setLoadError);
  const applyStatuses = useStatusStore((s) => s.applyStatuses);
  const setStatusLoadError = useStatusStore((s) => s.setLoadError);
  const applyLive = useLiveStore((s) => s.applySnapshot);
  const setLiveLoadError = useLiveStore((s) => s.setLoadError);

  // Rust is the source of truth for all four; `mirror` subscribes, then reads.
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onSettingsChanged,
      get: settingsGet,
      apply: applySettings,
      hasSnapshot: () => useSettingsStore.getState().snapshot !== null,
      fail: (message) => setSettingsLoadError(`settings load failed: ${message}`),
    });
  }, [applySettings, setSettingsLoadError]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onWorkspaceChanged,
      get: workspaceGet,
      apply: applyWorkspace,
      hasSnapshot: () => useWorkspaceStore.getState().snapshot !== null,
      fail: (message) => setWorkspaceLoadError(`workspace load failed: ${message}`),
    });
  }, [applyWorkspace, setWorkspaceLoadError]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onProjectsStatus,
      get: projectsStatusGet,
      apply: applyStatuses,
      hasSnapshot: () => useStatusStore.getState().received,
      // Cards then stay at "…"; the workspace itself is fine, so no banner.
      fail: (message) => setStatusLoadError(`status load failed: ${message}`),
    });
  }, [applyStatuses, setStatusLoadError]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onLiveSessions,
      get: liveSessionsGet,
      apply: applyLive,
      hasSnapshot: () => useLiveStore.getState().received,
      fail: (message) => setLiveLoadError(`live sessions load failed: ${message}`),
    });
  }, [applyLive, setLiveLoadError]);

  // A click on an OS toast: Rust has focused the window; reveal and select its session
  // (Story 3.3).
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onNotifyReveal((request) => {
      void revealToastSession(request);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Terminal output and exits stream in for every terminal, shown or not (Story 4.1).
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    // A terminal closed in a pop-out window (Story 4.5) leaves the pane too.
    return connectTerminals({ onClosed: forgetTerminal });
  }, []);

  useKeybindings();

  return (
    <div className="shell">
      <Banners />
      <div className="shell-body">
        <Canvas />
        <ElsewhereTray />
        <Notice />
        {pane === "settings" && <SettingsPane />}
        {pane === "import" && <ImportPane />}
        {pane === "launch" && <LaunchPane />}
        {pane === "worktree" && <WorktreePane />}
        {pane === "terminal" && <TerminalPane />}
        <TerminalHolder />
        <Palette />
        <ContextMenu />
      </div>
    </div>
  );
}
