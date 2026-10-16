import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsSnapshot } from "../ipc";
import { usePaletteStore } from "../state/palette";
import { useSettingsStore } from "../state/settings";
import { builtinCommands, registerBuiltins } from "./builtins";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { clearCommands, getCommand, listCommands, runCommand } from "./registry";

function key(k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key: k,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    preventDefault: () => {},
    ...mods,
  };
}

describe("built-in commands", () => {
  beforeEach(() => {
    clearCommands();
    usePaletteStore.setState({ isOpen: false, query: "", selected: 0 });
    useSettingsStore.setState({ snapshot: null, loadError: null, paneOpen: false, actionBusy: false, actionError: null });
    registerBuiltins();
  });
  afterEach(() => clearCommands());

  it("have unique ids (a duplicate in one build is a failure)", () => {
    const ids = builtinCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("register the eight initial commands with the spec's keybindings", () => {
    expect(listCommands().map((c) => c.id).sort()).toEqual([
      "app.quit",
      "binaries.redetect",
      "palette.close",
      "palette.toggle",
      "settings.closePane",
      "settings.open",
      "settings.reveal",
      "settings.toggle",
    ]);
    expect(getCommand("palette.toggle")?.keybinding).toBe("ctrl+k");
    expect(getCommand("settings.toggle")?.keybinding).toBe("ctrl+,");
    expect(getCommand("settings.open")?.keybinding).toBeUndefined();
    expect(getCommand("app.quit")?.keybinding).toBe("ctrl+q");
    expect(getCommand("palette.close")?.keybinding).toBe("escape");
    expect(getCommand("settings.closePane")?.keybinding).toBe("escape");
  });

  it("the key-only carriers are hidden from the palette, the five actions are not", () => {
    expect(listCommands({ visibleOnly: true }).map((c) => c.id).sort()).toEqual([
      "app.quit",
      "binaries.redetect",
      "palette.toggle",
      "settings.open",
      "settings.reveal",
    ]);
  });

  it("registering twice replaces rather than duplicates", () => {
    registerBuiltins();
    expect(listCommands()).toHaveLength(8);
  });

  it("Open settings only opens: chosen with the pane already open, it stays open", () => {
    runCommand("settings.open");
    expect(useSettingsStore.getState().paneOpen).toBe(true);
    runCommand("settings.open");
    expect(useSettingsStore.getState().paneOpen).toBe(true);
  });

  it("Re-detect binaries is hidden and inert while a detection runs", () => {
    useSettingsStore.setState({ actionBusy: true });
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("binaries.redetect");
    expect(runCommand("binaries.redetect")).toBe(false);
  });

  it("Quit reaches the app_quit wire name (and fails there without a runtime)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runCommand("app.quit")).toBe(true);
    await flush();
    expect(error).toHaveBeenCalledWith(
      'command "app.quit" failed:',
      expect.objectContaining({ message: expect.stringMatching(/cannot invoke "app_quit"/) }),
    );
    error.mockRestore();
  });

  it("ctrl+k toggles the palette; ctrl+, toggles the pane", () => {
    handleKeydown(key("k", { ctrlKey: true }));
    expect(usePaletteStore.getState().isOpen).toBe(true);
    handleKeydown(key("k", { ctrlKey: true }));
    expect(usePaletteStore.getState().isOpen).toBe(false);

    handleKeydown(key(",", { ctrlKey: true }));
    expect(useSettingsStore.getState().paneOpen).toBe(true);
    handleKeydown(key(",", { ctrlKey: true }));
    expect(useSettingsStore.getState().paneOpen).toBe(false);
  });

  it("Esc closes the palette first, then the pane", () => {
    useSettingsStore.getState().openPane();
    usePaletteStore.getState().open();

    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(useSettingsStore.getState().paneOpen).toBe(true);

    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useSettingsStore.getState().paneOpen).toBe(false);

    expect(handleKeydown(key("Escape"))).toBe(false);
  });

  it("Reveal settings file is hidden and inert without a settings path", () => {
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("settings.reveal");
    expect(runCommand("settings.reveal")).toBe(false);

    useSettingsStore.setState({
      snapshot: { ...fixtureSnapshot(), path: "C:\\Users\\me\\AppData\\Roaming\\switchboard\\settings.json" },
    });
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).toContain("settings.reveal");
  });

  it("the palette lists only enabled, visible commands, sorted by title", () => {
    usePaletteStore.getState().open();
    const titles = listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.title);
    expect(titles).toEqual(["Open settings", "Quit", "Re-detect binaries", "Toggle command palette"]);
  });

  it("typing qu leaves Quit; typing set leaves Open settings", () => {
    usePaletteStore.getState().open();
    usePaletteStore.getState().setQuery("qu");
    const rows = listCommands({ enabledOnly: true, visibleOnly: true });
    expect(usePaletteStore.getState().filtered(rows).map((c) => c.id)).toEqual(["app.quit"]);
    usePaletteStore.getState().setQuery("set");
    expect(usePaletteStore.getState().filtered(rows).map((c) => c.id)).toEqual(["settings.open"]);
  });

  it("a settings action failure without a runtime lands in the store as actionError", async () => {
    // vitest runs in node: there is no Tauri runtime, so `settings_reveal` rejects with
    // NoTauriRuntimeError and the command reports it through the store, not a throw.
    useSettingsStore.setState({
      snapshot: { ...fixtureSnapshot(), path: "/home/me/.config/switchboard/settings.json" },
    });
    expect(runCommand("settings.reveal")).toBe(true);
    await flush();
    expect(useSettingsStore.getState().actionError).toMatch(/no Tauri runtime/);

    expect(runCommand("binaries.redetect")).toBe(true);
    await flush();
    expect(useSettingsStore.getState().actionError).toMatch(/no Tauri runtime/);
    expect(useSettingsStore.getState().actionBusy).toBe(false);
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function fixtureSnapshot(): SettingsSnapshot {
  return {
    path: null,
    settings: {
      version: 1,
      claude: { path: null },
      git: { path: null },
      defaults: { model: null, effort: null, permission_mode: "default" },
      worktrees_root: null,
      external_editor: null,
      shell: null,
      theme: "dark",
      poll: { agents_ms: 2000, git_ms: 5000 },
    },
    binaries: {
      claude: { name: "claude", path: null, version: null, status: "missing", configured: false },
      git: { name: "git", path: null, version: null, status: "missing", configured: false },
    },
    banners: [],
  };
}
