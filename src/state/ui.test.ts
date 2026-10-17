import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "../ipc";
import {
  FLASH_MS,
  NOTICE_MS,
  clampToArea,
  hasSelection,
  isContextMenuOpen,
  isPaneOpen,
  sameTarget,
  selectedProject,
  useUiStore,
} from "./ui";
import { useWorkspaceStore } from "./workspace";

describe("ui store", () => {
  beforeEach(() => {
    useUiStore.setState({ pane: null, flashed: [], selection: null, contextMenu: null, notice: null });
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
  });

  it("starts with no pane, nothing flashed, no selection, no menu and no notice", () => {
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().flashed).toEqual([]);
    expect(useUiStore.getState().selection).toBeNull();
    expect(useUiStore.getState().contextMenu).toBeNull();
    expect(useUiStore.getState().notice).toBeNull();
    expect(isPaneOpen()).toBe(false);
    expect(hasSelection()).toBe(false);
    expect(isContextMenuOpen()).toBe(false);
  });

  it("openPane opens, closePane closes, and opening another pane replaces the first", () => {
    const s = useUiStore.getState();
    s.openPane("settings");
    expect(useUiStore.getState().pane).toBe("settings");
    expect(isPaneOpen()).toBe(true);
    s.openPane("import");
    expect(useUiStore.getState().pane).toBe("import");
    s.openPane("import");
    expect(useUiStore.getState().pane).toBe("import");
    s.closePane();
    s.closePane();
    expect(useUiStore.getState().pane).toBeNull();
    expect(isPaneOpen()).toBe(false);
  });

  it("togglePane flips its own pane and switches from another", () => {
    const s = useUiStore.getState();
    s.togglePane("settings");
    expect(useUiStore.getState().pane).toBe("settings");
    s.togglePane("settings");
    expect(useUiStore.getState().pane).toBeNull();
    s.openPane("import");
    s.togglePane("settings");
    expect(useUiStore.getState().pane).toBe("settings");
  });

  it("flash adds ids without duplicates and unflash removes only those given", () => {
    const s = useUiStore.getState();
    s.flash(["a", "b"]);
    s.flash(["b", "c"]);
    expect(useUiStore.getState().flashed).toEqual(["a", "b", "c"]);
    s.unflash(["b"]);
    expect(useUiStore.getState().flashed).toEqual(["a", "c"]);
    s.unflash(["zzz"]);
    expect(useUiStore.getState().flashed).toEqual(["a", "c"]);
    s.unflash(["a", "c"]);
    expect(useUiStore.getState().flashed).toEqual([]);
  });

  it("flashed is reference-stable when a call changes nothing", () => {
    const s = useUiStore.getState();
    s.flash(["a"]);
    const before = useUiStore.getState().flashed;
    s.flash([]);
    s.flash(["a"]);
    s.unflash([]);
    s.unflash(["nope"]);
    expect(useUiStore.getState().flashed).toBe(before);
    s.unflash(["a"]);
    const empty = useUiStore.getState().flashed;
    s.flash(["b"]);
    s.unflash(["b"]);
    expect(useUiStore.getState().flashed).toBe(empty);
  });

  it("the flash lasts 1.5 s", () => {
    expect(FLASH_MS).toBe(1500);
  });

  it("select holds one node, replaces it, stays reference-stable for the same node, and clears", () => {
    const s = useUiStore.getState();
    s.select({ kind: "project", id: "a" });
    const first = useUiStore.getState().selection;
    expect(first).toEqual({ kind: "project", id: "a" });
    expect(hasSelection()).toBe(true);
    s.select({ kind: "project", id: "a" });
    expect(useUiStore.getState().selection).toBe(first);
    s.select({ kind: "session", id: "a" });
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "a" });
    expect(useUiStore.getState().selection).not.toBe(first);
    s.clearSelection();
    expect(useUiStore.getState().selection).toBeNull();
    expect(hasSelection()).toBe(false);
    s.clearSelection();
    expect(useUiStore.getState().selection).toBeNull();
  });

  it("sameTarget compares by kind and id", () => {
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget({ kind: "project", id: "a" }, { kind: "project", id: "a" })).toBe(true);
    expect(sameTarget({ kind: "project", id: "a" }, { kind: "session", id: "a" })).toBe(false);
    expect(sameTarget({ kind: "project", id: "a" }, null)).toBe(false);
  });

  it("openContextMenu stores the anchor, closeContextMenu clears it", () => {
    const s = useUiStore.getState();
    s.openContextMenu({ x: 300, y: 120 });
    expect(useUiStore.getState().contextMenu).toEqual({ x: 300, y: 120 });
    expect(isContextMenuOpen()).toBe(true);
    s.openContextMenu({ x: 10, y: 10 });
    expect(useUiStore.getState().contextMenu).toEqual({ x: 10, y: 10 });
    s.closeContextMenu();
    expect(useUiStore.getState().contextMenu).toBeNull();
    expect(isContextMenuOpen()).toBe(false);
  });

  it("showNotice holds one notice, the newest wins, clearNotice clears and is a no-op when clear", () => {
    const s = useUiStore.getState();
    s.showNotice("New session arrives in Epic 4");
    expect(useUiStore.getState().notice).toEqual({ text: "New session arrives in Epic 4" });
    s.showNotice("Plain terminal arrives in Epic 4");
    expect(useUiStore.getState().notice).toEqual({ text: "Plain terminal arrives in Epic 4" });
    s.clearNotice();
    expect(useUiStore.getState().notice).toBeNull();
    s.clearNotice();
    expect(useUiStore.getState().notice).toBeNull();
  });

  it("a notice lasts 3 s", () => {
    expect(NOTICE_MS).toBe(3000);
  });

  it("selectedProject is the selected project from the snapshot, or null for nothing, a child or a gone project", () => {
    expect(selectedProject()).toBeNull();
    const ide = { id: "ide", path: "/p/ide", label: "ide", position: { x: 0, y: 0 }, expanded: true, color: null, launchDefaults: null };
    const snapshot: WorkspaceSnapshot = {
      path: null,
      workspace: { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, projects: [ide], branches: [], sessions: [], edges: [], defaults: { model: null, effort: null, permissionMode: null } },
      banners: [],
      revision: 1,
      children: [],
    };
    useWorkspaceStore.getState().applySnapshot(snapshot);
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(selectedProject()).toBe(ide);
    useUiStore.getState().select({ kind: "session", id: "ide" });
    expect(selectedProject()).toBeNull();
    useUiStore.getState().select({ kind: "project", id: "gone" });
    expect(selectedProject()).toBeNull();
    useUiStore.getState().select({ kind: "project", id: "ide" });
    useWorkspaceStore.getState().applySnapshot(null);
    expect(selectedProject()).toBeNull();
  });

  it("clampToArea keeps a box inside the area, shifting it left and up, never past the origin", () => {
    const size = { width: 180, height: 90 };
    const within = { width: 1280, height: 800 };
    expect(clampToArea({ x: 300, y: 120 }, size, within)).toEqual({ x: 300, y: 120 });
    expect(clampToArea({ x: 1200, y: 120 }, size, within)).toEqual({ x: 1100, y: 120 });
    expect(clampToArea({ x: 300, y: 780 }, size, within)).toEqual({ x: 300, y: 710 });
    expect(clampToArea({ x: 1270, y: 795 }, size, within)).toEqual({ x: 1100, y: 710 });
    expect(clampToArea({ x: -5, y: -5 }, size, within)).toEqual({ x: 0, y: 0 });
    expect(clampToArea({ x: 10, y: 10 }, { width: 2000, height: 1000 }, within)).toEqual({ x: 0, y: 0 });
  });
});
