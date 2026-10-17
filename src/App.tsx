import { useEffect } from "react";
import {
  hasTauriRuntime,
  onProjectsStatus,
  onSettingsChanged,
  onWorkspaceChanged,
  projectsStatusGet,
  settingsGet,
  workspaceGet,
} from "./ipc";
import { mirror } from "./ipc/mirror";
import { registerBuiltins } from "./commands/builtins";
import { useKeybindings } from "./commands/keybindings";
import { useSettingsStore } from "./state/settings";
import { useStatusStore } from "./state/status";
import { useUiStore } from "./state/ui";
import { useWorkspaceStore } from "./state/workspace";
import { Canvas } from "./canvas/Canvas";
import { Banners } from "./components/Banners";
import { ContextMenu } from "./components/ContextMenu";
import { ImportPane } from "./components/ImportPane";
import { Palette } from "./components/Palette";
import { SettingsPane } from "./components/SettingsPane";
import "./components/shell.css";

// Commands exist for the life of the module, not of a component: registered once here.
registerBuiltins();

/**
 * The shell: banner strip on top, the canvas filling the rest, one pane (settings or import)
 * on the right when open, the command palette over everything when open, the node context
 * menu at the pointer when open. Every key goes through the command registry's dispatcher
 * (`useKeybindings`).
 */
export default function App() {
  const pane = useUiStore((s) => s.pane);
  const applySettings = useSettingsStore((s) => s.applySnapshot);
  const setSettingsLoadError = useSettingsStore((s) => s.setLoadError);
  const applyWorkspace = useWorkspaceStore((s) => s.applySnapshot);
  const setWorkspaceLoadError = useWorkspaceStore((s) => s.setLoadError);
  const applyStatuses = useStatusStore((s) => s.applyStatuses);
  const setStatusLoadError = useStatusStore((s) => s.setLoadError);

  // Rust is the source of truth for all three; `mirror` subscribes, then reads.
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

  useKeybindings();

  return (
    <div className="shell">
      <Banners />
      <div className="shell-body">
        <Canvas />
        {pane === "settings" && <SettingsPane />}
        {pane === "import" && <ImportPane />}
        <Palette />
        <ContextMenu />
      </div>
    </div>
  );
}
