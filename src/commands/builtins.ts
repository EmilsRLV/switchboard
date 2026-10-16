// The first commands. Everything the shell can do is here; `App` registers them once at
// startup. Escape is shared by two commands whose `when`s are mutually exclusive, which is
// what gives Esc its precedence: palette first, then the pane. Key-only carriers (the two
// Escape commands, the `ctrl+,` toggle) are `hidden`: the dispatcher sees them, the palette
// does not.

import { appQuit } from "../ipc";
import { usePaletteStore } from "../state/palette";
import { useSettingsStore } from "../state/settings";
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
      run: () => useSettingsStore.getState().openPane(),
    },
    {
      id: "settings.toggle",
      title: "Toggle settings",
      keybinding: "ctrl+,",
      hidden: true,
      run: () => useSettingsStore.getState().togglePane(),
    },
    {
      id: "settings.closePane",
      title: "Close settings",
      keybinding: "escape",
      hidden: true,
      when: () => useSettingsStore.getState().paneOpen && !usePaletteStore.getState().isOpen,
      run: () => useSettingsStore.getState().closePane(),
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
