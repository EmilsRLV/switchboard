import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Position, SettingsSnapshot, Viewport } from "../ipc";
import { useCanvasStore, type CanvasInstance } from "../state/canvas";
import { useImportStore } from "../state/import";
import { usePaletteStore } from "../state/palette";
import { useSettingsStore } from "../state/settings";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
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
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
    usePaletteStore.setState({ isOpen: false, query: "", selected: 0 });
    useSettingsStore.setState({ snapshot: null, loadError: null, actionBusy: false, actionError: null });
    useUiStore.setState({ pane: null, flashed: [] });
    useImportStore.getState().reset();
    useCanvasStore.setState({ instance: null, element: null });
    registerBuiltins();
  });
  afterEach(() => clearCommands());

  it("have unique ids (a duplicate in one build is a failure)", () => {
    const ids = builtinCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("register the eleven commands with the spec's keybindings", () => {
    expect(listCommands().map((c) => c.id).sort()).toEqual([
      "app.quit",
      "binaries.redetect",
      "canvas.fitView",
      "palette.close",
      "palette.toggle",
      "pane.close",
      "project.add",
      "project.import",
      "settings.open",
      "settings.reveal",
      "settings.toggle",
    ]);
    expect(getCommand("palette.toggle")?.keybinding).toBe("ctrl+k");
    expect(getCommand("settings.toggle")?.keybinding).toBe("ctrl+,");
    expect(getCommand("settings.open")?.keybinding).toBeUndefined();
    expect(getCommand("app.quit")?.keybinding).toBe("ctrl+q");
    expect(getCommand("canvas.fitView")?.keybinding).toBe("ctrl+0");
    expect(getCommand("project.add")?.keybinding).toBe("ctrl+o");
    expect(getCommand("project.import")?.keybinding).toBeUndefined();
    expect(getCommand("palette.close")?.keybinding).toBe("escape");
    expect(getCommand("pane.close")?.keybinding).toBe("escape");
  });

  it("the key-only carriers are hidden from the palette, the eight actions are not", () => {
    expect(listCommands({ visibleOnly: true }).map((c) => c.id).sort()).toEqual([
      "app.quit",
      "binaries.redetect",
      "canvas.fitView",
      "palette.toggle",
      "project.add",
      "project.import",
      "settings.open",
      "settings.reveal",
    ]);
  });

  it("registering twice replaces rather than duplicates", () => {
    registerBuiltins();
    expect(listCommands()).toHaveLength(11);
  });

  it("Fit view, Add project folder and Import from Claude are hidden and inert until the canvas has mounted", () => {
    const enabled = listCommands({ enabledOnly: true }).map((c) => c.id);
    expect(enabled).not.toContain("canvas.fitView");
    expect(enabled).not.toContain("project.add");
    expect(enabled).not.toContain("project.import");
    expect(runCommand("canvas.fitView")).toBe(false);
    expect(runCommand("project.add")).toBe(false);
    expect(runCommand("project.import")).toBe(false);
    expect(handleKeydown(key("0", { ctrlKey: true }))).toBe(false);
    expect(handleKeydown(key("o", { ctrlKey: true }))).toBe(false);

    useCanvasStore.getState().setInstance(fakeCanvas());
    const ready = listCommands({ enabledOnly: true }).map((c) => c.id);
    expect(ready).toContain("project.add");
    expect(ready).toContain("project.import");
  });

  it("Fit view on an empty canvas goes home to {0,0,1}, from the palette and from ctrl+0", async () => {
    const instance = fakeCanvas();
    useCanvasStore.getState().setInstance(instance);
    expect(listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.title)).toContain("Fit view");

    expect(runCommand("canvas.fitView")).toBe(true);
    await flush();
    expect(instance.setViewport).toHaveBeenCalledWith({ x: 0, y: 0, zoom: 1 });
    expect(instance.fitView).not.toHaveBeenCalled();

    expect(handleKeydown(key("0", { ctrlKey: true }))).toBe(true);
    await flush();
    expect(instance.setViewport).toHaveBeenCalledTimes(2);
  });

  it("Open settings only opens: chosen with the pane already open, it stays open", () => {
    runCommand("settings.open");
    expect(useUiStore.getState().pane).toBe("settings");
    runCommand("settings.open");
    expect(useUiStore.getState().pane).toBe("settings");
  });

  it("Import from Claude opens the import pane and starts loading its list", async () => {
    useCanvasStore.getState().setInstance(fakeCanvas());
    expect(runCommand("project.import")).toBe(true);
    expect(useUiStore.getState().pane).toBe("import");
    expect(useImportStore.getState().loading).toBe(true);
    await flush();
    // No Tauri runtime in vitest: the list call fails and the pane shows why.
    expect(useImportStore.getState().loading).toBe(false);
    expect(useImportStore.getState().error).toMatch(/no Tauri runtime/);
  });

  it("Close pane (the import pane's Close button) is enabled while it shows, and forgets its state", () => {
    useCanvasStore.getState().setInstance(fakeCanvas());
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("pane.close");
    runCommand("project.import");
    useImportStore.getState().toggle("B:\\x");
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).toContain("pane.close");
    expect(runCommand("pane.close")).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useImportStore.getState().selected).toEqual([]);
    expect(useImportStore.getState().items).toBeNull();
  });

  it("Add project folder reaches the picker (and fails there without a runtime) once at a time", async () => {
    useCanvasStore.getState().setInstance(fakeCanvas());
    expect(runCommand("project.add")).toBe(true);
    // While the picker is open the command is disabled: a second ctrl+o opens no second dialog.
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("project.add");
    await flush();
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).toContain("project.add");
    expect(useWorkspaceStore.getState().loadError).toMatch(/folder picker: .*no Tauri runtime/);
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

  it("ctrl+k toggles the palette; ctrl+, toggles the settings pane", () => {
    handleKeydown(key("k", { ctrlKey: true }));
    expect(usePaletteStore.getState().isOpen).toBe(true);
    handleKeydown(key("k", { ctrlKey: true }));
    expect(usePaletteStore.getState().isOpen).toBe(false);

    handleKeydown(key(",", { ctrlKey: true }));
    expect(useUiStore.getState().pane).toBe("settings");
    handleKeydown(key(",", { ctrlKey: true }));
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("ctrl+, from the import pane switches to settings rather than stacking", () => {
    useCanvasStore.getState().setInstance(fakeCanvas());
    runCommand("project.import");
    handleKeydown(key(",", { ctrlKey: true }));
    expect(useUiStore.getState().pane).toBe("settings");
    expect(useImportStore.getState().items).toBeNull();
  });

  it("Esc closes the palette first, then the open pane (settings or import)", () => {
    useUiStore.getState().openPane("settings");
    usePaletteStore.getState().open();

    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(useUiStore.getState().pane).toBe("settings");

    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();

    expect(handleKeydown(key("Escape"))).toBe(false);

    useUiStore.getState().openPane("import");
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("closing the settings pane drops a stale action error", () => {
    useUiStore.getState().openPane("settings");
    useSettingsStore.getState().setActionError("reveal failed");
    expect(runCommand("pane.close")).toBe(true);
    expect(useSettingsStore.getState().actionError).toBeNull();
    expect(useUiStore.getState().pane).toBeNull();
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

    useCanvasStore.getState().setInstance(fakeCanvas());
    expect(listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.title)).toEqual([
      "Add project folder…",
      "Fit view",
      "Import from Claude…",
      "Open settings",
      "Quit",
      "Re-detect binaries",
      "Toggle command palette",
    ]);
  });

  it("typing qu leaves Quit; typing set leaves Open settings", () => {
    usePaletteStore.getState().open();
    usePaletteStore.getState().setQuery("qu");
    const rows = listCommands({ enabledOnly: true, visibleOnly: true });
    expect(usePaletteStore.getState().filtered(rows).map((c) => c.id)).toEqual(["app.quit"]);
    usePaletteStore.getState().setQuery("set");
    expect(usePaletteStore.getState().filtered(rows).map((c) => c.id)).toEqual(["settings.open"]);
  });

  it("a settings action failure without a runtime lands in the store as actionError and opens the pane", async () => {
    // vitest runs in node: there is no Tauri runtime, so `settings_reveal` rejects with
    // NoTauriRuntimeError and the command reports it through the store, not a throw.
    useSettingsStore.setState({
      snapshot: { ...fixtureSnapshot(), path: "/home/me/.config/switchboard/settings.json" },
    });
    expect(runCommand("settings.reveal")).toBe(true);
    await flush();
    expect(useSettingsStore.getState().actionError).toMatch(/no Tauri runtime/);
    expect(useUiStore.getState().pane).toBe("settings");

    expect(runCommand("binaries.redetect")).toBe(true);
    await flush();
    expect(useSettingsStore.getState().actionError).toMatch(/no Tauri runtime/);
    expect(useSettingsStore.getState().actionBusy).toBe(false);
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function fakeCanvas(): CanvasInstance & { setViewport: ReturnType<typeof vi.fn>; fitView: ReturnType<typeof vi.fn> } {
  let viewport: Viewport = { x: -120, y: 40, zoom: 1.5 };
  return {
    getNodes: () => [],
    getViewport: () => viewport,
    setViewport: vi.fn(async (next: Viewport) => {
      viewport = next;
      return true;
    }),
    fitView: vi.fn(async () => true),
    screenToFlowPosition: (client: Position) => client,
  };
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
