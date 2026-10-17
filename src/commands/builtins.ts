// The built-in commands. Everything the shell can do is here; `App` registers them once at
// startup. Escape is shared by two commands whose `when`s are mutually exclusive, which is
// what gives Esc its precedence: palette first, then whichever pane is open (`pane.close`,
// which both panes' Close buttons run too). Key-only carriers (the two Escape commands, the
// `ctrl+,` toggle) are `hidden`: the dispatcher sees them, the palette does not.

import { appQuit } from "../ipc";
import { isCanvasReady, useCanvasStore } from "../state/canvas";
import { usePaletteStore } from "../state/palette";
import { useSettingsStore } from "../state/settings";
import { isPaneOpen } from "../state/ui";
import { closeOpenPane, openPane, togglePane } from "./panes";
import { addProjectFromPicker, isPickerIdle } from "./projects";
import { registerCommands, type Command } from "./registry";
import { hasSettingsPath, redetectBinaries, revealSettingsFile } from "./settings";

export function builtinCommands(): Command[] {
  return [
    {
      id: "palette.toggle",
      title: "Toggle command palette",
      keybinding: "ctrl+k",
      run: () => usePaletteStore.getState().toggle(),
    },
    {
      id: "palette.close",
      title: "Close command palette",
      keybinding: "escape",
      hidden: true,
      when: () => usePaletteStore.getState().isOpen,
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
      when: () => isPaneOpen() && !usePaletteStore.getState().isOpen,
      run: closeOpenPane,
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
