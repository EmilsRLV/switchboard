// The built-in commands. Everything the shell can do is here; `App` registers them once at
// startup. Escape is shared by four commands whose `when`s are mutually exclusive, which is
// what gives Esc its precedence: the context menu first, then the palette, then whichever
// pane is open (`pane.close`, which both panes' Close buttons run too), then the selection.
// Key-only carriers (the Escape commands, the `ctrl+,` toggle) are `hidden`: the dispatcher
// sees them, the palette does not. The project commands act on the selected project and are
// tagged `menu: "node"`, which is what the right-click menu lists.

import { appQuit } from "../ipc";
import { isCanvasReady, useCanvasStore } from "../state/canvas";
import { usePaletteStore } from "../state/palette";
import { useSettingsStore } from "../state/settings";
import { hasSelection, isContextMenuOpen, isPaneOpen, selectedProject, useUiStore } from "../state/ui";
import { projectHasChildren } from "../state/workspace";
import { relayoutChildren, setExpanded } from "./nodes";
import { closeOpenPane, openPane, togglePane } from "./panes";
import { addProjectFromPicker, isPickerIdle } from "./projects";
import { registerCommands, type Command } from "./registry";
import { hasSettingsPath, redetectBinaries, revealSettingsFile } from "./settings";

function isPaletteOpen(): boolean {
  return usePaletteStore.getState().isOpen;
}

export function builtinCommands(): Command[] {
  return [
    {
      id: "palette.toggle",
      title: "Toggle command palette",
      keybinding: "ctrl+k",
      run: () => usePaletteStore.getState().toggle(),
    },
    {
      id: "contextMenu.close",
      title: "Close context menu",
      keybinding: "escape",
      hidden: true,
      when: isContextMenuOpen,
      run: () => useUiStore.getState().closeContextMenu(),
    },
    {
      id: "palette.close",
      title: "Close command palette",
      keybinding: "escape",
      hidden: true,
      when: () => isPaletteOpen() && !isContextMenuOpen(),
      run: () => usePaletteStore.getState().close(),
    },
    {
      id: "settings.open",
      title: "Open settings",
      run: () => openPane("settings"),
    },
    {
      id: "settings.toggle",
      title: "Toggle settings",
      keybinding: "ctrl+,",
      hidden: true,
      run: () => togglePane("settings"),
    },
    {
      id: "pane.close",
      title: "Close pane",
      keybinding: "escape",
      hidden: true,
      when: () => isPaneOpen() && !isPaletteOpen() && !isContextMenuOpen(),
      run: closeOpenPane,
    },
    {
      id: "selection.clear",
      title: "Clear selection",
      keybinding: "escape",
      hidden: true,
      when: () => hasSelection() && !isPaneOpen() && !isPaletteOpen() && !isContextMenuOpen(),
      run: () => useUiStore.getState().clearSelection(),
    },
    {
      id: "settings.reveal",
      title: "Reveal settings file",
      when: hasSettingsPath,
      run: revealSettingsFile,
    },
    {
      id: "binaries.redetect",
      title: "Re-detect binaries",
      when: () => !useSettingsStore.getState().actionBusy,
      run: redetectBinaries,
    },
    {
      id: "canvas.fitView",
      title: "Fit view",
      keybinding: "ctrl+0",
      when: isCanvasReady,
      run: async () => {
        await useCanvasStore.getState().fitView();
      },
    },
    {
      id: "project.add",
      title: "Add project folder…",
      keybinding: "ctrl+o",
      when: () => isCanvasReady() && isPickerIdle(),
      run: addProjectFromPicker,
    },
    {
      id: "project.import",
      title: "Import from Claude…",
      when: isCanvasReady,
      run: () => openPane("import"),
    },
    {
      id: "project.expand",
      title: "Expand project",
      menu: "node",
      when: () => {
        const project = selectedProject();
        return project !== null && !project.expanded && projectHasChildren(project.id);
      },
      run: async () => {
        const project = selectedProject();
        if (project !== null) await setExpanded(project.id, true);
      },
    },
    {
      id: "project.collapse",
      title: "Collapse project",
      menu: "node",
      when: () => {
        const project = selectedProject();
        return project !== null && project.expanded && projectHasChildren(project.id);
      },
      run: async () => {
        const project = selectedProject();
        if (project !== null) await setExpanded(project.id, false);
      },
    },
    {
      id: "project.relayout",
      title: "Re-layout children",
      menu: "node",
      when: () => selectedProject() !== null,
      run: async () => {
        const project = selectedProject();
        if (project !== null) await relayoutChildren(project.id);
      },
    },
    {
      id: "app.quit",
      title: "Quit",
      keybinding: "ctrl+q",
      run: appQuit,
    },
  ];
}

/** Register the built-in commands; idempotent (re-registering replaces by id). */
export function registerBuiltins(): () => void {
  return registerCommands(builtinCommands());
}
