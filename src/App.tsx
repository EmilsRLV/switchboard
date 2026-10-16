import { useEffect } from "react";
import { hasTauriRuntime, onSettingsChanged, onWorkspaceChanged, settingsGet, workspaceGet } from "./ipc";
import { mirror } from "./ipc/mirror";
import { registerBuiltins } from "./commands/builtins";
import { useKeybindings } from "./commands/keybindings";
import { useSettingsStore } from "./state/settings";
import { useWorkspaceStore } from "./state/workspace";
import { Canvas } from "./canvas/Canvas";
import { Banners } from "./components/Banners";
import { Palette } from "./components/Palette";
import { SettingsPane } from "./components/SettingsPane";
import "./components/shell.css";

// Commands exist for the life of the module, not of a component: registered once here.
registerBuiltins();

/**
 * The shell: banner strip on top, the canvas filling the rest, settings pane on the right
 * when open, the command palette over everything when open. Every key goes through the
 * command registry's dispatcher (`useKeybindings`).
 */
export default function App() {
  const paneOpen = useSettingsStore((s) => s.paneOpen);
  const applySettings = useSettingsStore((s) => s.applySnapshot);
  const setSettingsLoadError = useSettingsStore((s) => s.setLoadError);
  const applyWorkspace = useWorkspaceStore((s) => s.applySnapshot);
  const setWorkspaceLoadError = useWorkspaceStore((s) => s.setLoadError);

  // Rust is the source of truth for both; `mirror` subscribes, then reads.
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

  useKeybindings();

  return (
    <div className="shell">
      <Banners />
      <div className="shell-body">
        <Canvas />
        {paneOpen && <SettingsPane />}
        <Palette />
      </div>
    </div>
  );
}
