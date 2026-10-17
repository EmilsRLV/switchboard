import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, Position, Project, SettingsSnapshot, Viewport, WorkspaceSnapshot } from "../ipc";
import { useCanvasStore, type CanvasInstance } from "../state/canvas";
import { useImportStore } from "../state/import";
import { usePaletteStore } from "../state/palette";
import { useSettingsStore } from "../state/settings";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { chevronCommandId } from "../canvas/nodes";
import { builtinCommands, registerBuiltins } from "./builtins";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { nodeMenuCommands } from "./nodes";
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
    useUiStore.setState({ pane: null, flashed: [], selection: null, contextMenu: null });
    useImportStore.getState().reset();
    useCanvasStore.setState({ instance: null, element: null, dragging: {} });
    registerBuiltins();
  });
  afterEach(() => clearCommands());

  it("have unique ids (a duplicate in one build is a failure)", () => {
    const ids = builtinCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("register the sixteen commands with the spec's keybindings", () => {
    expect(listCommands().map((c) => c.id).sort()).toEqual([
      "app.quit",
      "binaries.redetect",
      "canvas.fitView",
      "contextMenu.close",
      "palette.close",
      "palette.toggle",
      "pane.close",
      "project.add",
      "project.collapse",
      "project.expand",
      "project.import",
      "project.relayout",
      "selection.clear",
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
    expect(getCommand("contextMenu.close")?.keybinding).toBe("escape");
    expect(getCommand("selection.clear")?.keybinding).toBe("escape");
    expect(getCommand("project.expand")?.keybinding).toBeUndefined();
    expect(getCommand("project.collapse")?.keybinding).toBeUndefined();
    expect(getCommand("project.relayout")?.keybinding).toBeUndefined();
  });

  it("the key-only carriers are hidden from the palette, the eleven actions are not", () => {
    expect(listCommands({ visibleOnly: true }).map((c) => c.id).sort()).toEqual([
      "app.quit",
      "binaries.redetect",
      "canvas.fitView",
      "palette.toggle",
      "project.add",
      "project.collapse",
      "project.expand",
      "project.import",
      "project.relayout",
      "settings.open",
      "settings.reveal",
    ]);
  });

  it("exactly the three project commands are tagged for the node menu, and the menu lists none without a selection", () => {
    expect(
      listCommands()
        .filter((c) => c.menu === "node")
        .map((c) => c.id)
        .sort(),
    ).toEqual(["project.collapse", "project.expand", "project.relayout"]);
    expect(nodeMenuCommands()).toEqual([]);
  });

  it("registering twice replaces rather than duplicates", () => {
    registerBuiltins();
    expect(listCommands()).toHaveLength(16);
  });

  it("the project commands are hidden and inert with nothing selected, and with a child selected", () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    for (const id of ["project.expand", "project.collapse", "project.relayout"]) {
      expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain(id);
      expect(runCommand(id)).toBe(false);
    }
    useUiStore.getState().select({ kind: "session", id: "stub-1-ide" });
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("project.relayout");
  });

  it("with a project selected the palette lists exactly one of Expand/Collapse plus Re-layout children", () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    const titles = () => listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.title);
    expect(titles()).toContain("Expand project");
    expect(titles()).not.toContain("Collapse project");
    expect(titles()).toContain("Re-layout children");
    expect(nodeMenuCommands().map((c) => c.title)).toEqual(["Expand project", "Re-layout children"]);

    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], stubs(3)) });
    expect(titles()).toContain("Collapse project");
    expect(titles()).not.toContain("Expand project");
    expect(titles()).toContain("Re-layout children");
    expect(nodeMenuCommands().map((c) => c.title)).toEqual(["Collapse project", "Re-layout children"]);
  });

  it("the chevron's command is the one of the pair that is enabled for the card's state", async () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(runCommand(chevronCommandId(ideProject(false)))).toBe(true);
    expect(runCommand(chevronCommandId(ideProject(true)))).toBe(false);
    await flush();
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], stubs(3)) });
    expect(runCommand(chevronCommandId(ideProject(true)))).toBe(true);
    expect(runCommand(chevronCommandId(ideProject(false)))).toBe(false);
    await flush();
  });

  it("a project without children has neither Expand nor Collapse", () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false), ideProject(true, "other")], stubs(3, "other")) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    const enabled = () => listCommands({ enabledOnly: true }).map((c) => c.id);
    expect(enabled()).not.toContain("project.expand");
    expect(enabled()).not.toContain("project.collapse");
    expect(enabled()).toContain("project.relayout");
    useUiStore.getState().select({ kind: "project", id: "other" });
    expect(enabled()).toContain("project.collapse");
  });

  it("Expand, Collapse and Re-layout reach their wire names for the selected project (and fail there without a runtime)", async () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(runCommand("project.expand")).toBe(true);
    await flush();
    expect(useWorkspaceStore.getState().loadError).toMatch(/expand failed: .*cannot invoke "workspace_set_expanded"/);
    expect(runCommand("project.relayout")).toBe(true);
    await flush();
    expect(useWorkspaceStore.getState().loadError).toMatch(/re-layout failed: .*cannot invoke "workspace_relayout_children"/);
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], stubs(3)) });
    expect(runCommand("project.collapse")).toBe(true);
    await flush();
    expect(useWorkspaceStore.getState().loadError).toMatch(/collapse failed: .*cannot invoke "workspace_set_expanded"/);
  });

  it("Esc closes the menu, then the palette, then the pane, then clears the selection, then nothing", () => {
    useUiStore.getState().select({ kind: "project", id: "ide" });
    useUiStore.getState().openPane("settings");
    usePaletteStore.getState().open();
    useUiStore.getState().openContextMenu({ x: 1, y: 1 });

    const enabledEsc = () =>
      listCommands({ enabledOnly: true })
        .filter((c) => c.keybinding === "escape")
        .map((c) => c.id);
    expect(enabledEsc()).toEqual(["contextMenu.close"]);
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useUiStore.getState().contextMenu).toBeNull();
    expect(usePaletteStore.getState().isOpen).toBe(true);

    expect(enabledEsc()).toEqual(["palette.close"]);
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(useUiStore.getState().pane).toBe("settings");

    expect(enabledEsc()).toEqual(["pane.close"]);
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });

    expect(enabledEsc()).toEqual(["selection.clear"]);
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useUiStore.getState().selection).toBeNull();

    expect(enabledEsc()).toEqual([]);
    expect(handleKeydown(key("Escape"))).toBe(false);
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

function ideProject(expanded: boolean, id = "ide"): Project {
  return { id, path: `/p/${id}`, label: id, position: { x: 0, y: 0 }, expanded, color: null, launchDefaults: null };
}

function stubs(count: number, projectId = "ide"): ChildNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `stub-${i + 1}-${projectId}`,
    projectId,
    kind: "session" as const,
    label: `session ${i + 1}`,
    detail: "stub",
    position: null,
  }));
}

function workspaceWith(projects: Project[], children: ChildNode[]): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects,
      branches: [],
      sessions: [],
      edges: [],
      defaults: { model: null, effort: null, permissionMode: null },
    },
    banners: [],
    revision: 1,
    children,
  };
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
