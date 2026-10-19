import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddProjectsResult, ClaudeProject, Project, WorkspaceSnapshot } from "../ipc";
import { useCanvasStore } from "../state/canvas";
import { useImportStore } from "../state/import";
import { FLASH_MS, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { openPane } from "./panes";
import {
  addElsewhereFolder,
  addProjectFromPicker,
  addProjectsAt,
  addSelectedImports,
  dropProjects,
  flashProjects,
  isPickerIdle,
  loadImportList,
} from "./projects";

vi.mock("../ipc", () => ({
  projectPickFolder: vi.fn(),
  workspaceAddProjects: vi.fn(),
  claudeProjectsList: vi.fn(),
}));

const ipc = await import("../ipc");
const projectPickFolder = vi.mocked(ipc.projectPickFolder);
const workspaceAddProjects = vi.mocked(ipc.workspaceAddProjects);
const claudeProjectsList = vi.mocked(ipc.claudeProjectsList);

function project(id: string, path: string): Project {
  return { id, path, label: path.split(/[\\/]/).pop() ?? path, position: { x: 0, y: 0 }, expanded: false, color: null, launchDefaults: null, showBranches: false };
}

let revision = 0;

function snapshot(projects: Project[]): WorkspaceSnapshot {
  revision += 1;
  return {
    path: "C:\\cfg\\switchboard\\workspace.json",
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
    revision,
    branchErrors: {},
    children: [],
  };
}

function result(projects: Project[], added: string[], existing: string[] = [], skipped: string[] = []): AddProjectsResult {
  return { snapshot: snapshot(projects), added, existing, skipped };
}

const canvas = {
  getNodes: () => [],
  getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  setViewport: async () => true,
  fitView: async () => true,
  screenToFlowPosition: (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 }),
};

// Centre of the 400x200 element is client (200, 100); the fake doubles it to canvas
// (400, 200); the card is then centred there by subtracting half its 240x80 size.
const CENTRED_CARD = { x: 400 - 120, y: 200 - 40 };

describe("project actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    revision = 0;
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
    useUiStore.setState({ pane: null, flashed: [] });
    useImportStore.getState().reset();
    useCanvasStore.setState({ instance: canvas, element: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }) } });
  });
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("flashProjects highlights the ids for 1.5 s", () => {
    flashProjects(["a", "b"]);
    expect(useUiStore.getState().flashed).toEqual(["a", "b"]);
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(useUiStore.getState().flashed).toEqual(["a", "b"]);
    vi.advanceTimersByTime(1);
    expect(useUiStore.getState().flashed).toEqual([]);
    flashProjects([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a re-flash restarts that id's clock without cutting the others short", () => {
    flashProjects(["a"]);
    vi.advanceTimersByTime(1000);
    flashProjects(["a", "b"]); // `a` again, `b` new
    vi.advanceTimersByTime(500); // the first clock for `a` would have ended here
    expect(useUiStore.getState().flashed).toEqual(["a", "b"]);
    vi.advanceTimersByTime(FLASH_MS - 500 - 1);
    expect(useUiStore.getState().flashed).toEqual(["a", "b"]);
    vi.advanceTimersByTime(1);
    expect(useUiStore.getState().flashed).toEqual([]);
    // The superseded timer was cleared, not left to fire.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("addProjectsAt sends the paths and position, applies the snapshot and flashes the duplicates", async () => {
    const p = project("p1", "B:\\projects\\ide");
    workspaceAddProjects.mockResolvedValueOnce(result([p], ["p1"]));
    const r = await addProjectsAt(["B:\\projects\\ide"], { x: 5, y: 6 });
    expect(workspaceAddProjects).toHaveBeenCalledWith(["B:\\projects\\ide"], { x: 5, y: 6 });
    expect(r?.added).toEqual(["p1"]);
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects).toEqual([p]);
    expect(useUiStore.getState().flashed).toEqual([]);

    workspaceAddProjects.mockResolvedValueOnce(result([p], [], ["p1"]));
    await addProjectsAt(["b:\\PROJECTS\\ide"], { x: 0, y: 0 });
    expect(useUiStore.getState().flashed).toEqual(["p1"]);
    vi.advanceTimersByTime(FLASH_MS);
    expect(useUiStore.getState().flashed).toEqual([]);
  });

  it("addProjectsAt with no paths calls nothing", async () => {
    await expect(addProjectsAt([], { x: 0, y: 0 })).resolves.toBeNull();
    expect(workspaceAddProjects).not.toHaveBeenCalled();
  });

  it("addProjectsAt reports a failure as a workspace banner by default, or through the given sink", async () => {
    workspaceAddProjects.mockRejectedValueOnce(new Error("disk full"));
    await expect(addProjectsAt(["B:\\x"], { x: 0, y: 0 })).resolves.toBeNull();
    expect(useWorkspaceStore.getState().loadError).toBe("project add failed: disk full");

    const sink = vi.fn();
    workspaceAddProjects.mockRejectedValueOnce("position is not finite");
    await addProjectsAt(["B:\\x"], { x: 0, y: 0 }, sink);
    expect(sink).toHaveBeenCalledWith("position is not finite");
  });

  it("addElsewhereFolder adds the session's cwd centred on the view; a failure is the project add banner", async () => {
    const other = project("other", "C:\\work\\other");
    workspaceAddProjects.mockResolvedValueOnce(result([other], ["other"]));
    await expect(addElsewhereFolder("C:\\work\\other")).resolves.not.toBeNull();
    expect(workspaceAddProjects).toHaveBeenCalledWith(["C:\\work\\other"], CENTRED_CARD);
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects).toEqual([other]);
    workspaceAddProjects.mockRejectedValueOnce("not a directory");
    await expect(addElsewhereFolder("C:\\gone")).resolves.toBeNull();
    expect(useWorkspaceStore.getState().loadError).toBe("project add failed: not a directory");
  });

  it("a success clears an earlier load error", async () => {
    useWorkspaceStore.setState({ loadError: "project add failed: earlier" });
    workspaceAddProjects.mockResolvedValueOnce(result([], []));
    await addProjectsAt(["B:\\x"], { x: 0, y: 0 });
    expect(useWorkspaceStore.getState().loadError).toBeNull();
  });

  it("dropProjects is a plain add: a dropped file comes back skipped and adds nothing, quietly", async () => {
    workspaceAddProjects.mockResolvedValueOnce(result([], [], [], ["C:\\file.txt"]));
    const r = await dropProjects(["C:\\file.txt"], { x: 1, y: 1 });
    expect(workspaceAddProjects).toHaveBeenCalledWith(["C:\\file.txt"], { x: 1, y: 1 });
    expect(r?.skipped).toEqual(["C:\\file.txt"]);
    expect(useWorkspaceStore.getState().loadError).toBeNull();

    workspaceAddProjects.mockRejectedValueOnce(new Error("boom"));
    await dropProjects(["C:\\dir"], { x: 1, y: 1 });
    expect(useWorkspaceStore.getState().loadError).toBe("project add failed: boom");

    const p = project("p1", "C:\\dir");
    workspaceAddProjects.mockResolvedValueOnce(result([p], ["p1"], [], ["C:\\file.txt"]));
    const mixed = await dropProjects(["C:\\dir", "C:\\file.txt"], { x: 1, y: 1 });
    expect(mixed?.skipped).toEqual(["C:\\file.txt"]);
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects).toEqual([p]);
  });

  it("addProjectFromPicker adds the chosen folder centred on the view and is busy meanwhile", async () => {
    let choose!: (path: string | null) => void;
    projectPickFolder.mockReturnValueOnce(new Promise<string | null>((r) => (choose = r)));
    const p = project("p1", "B:\\projects\\guild-auth");
    workspaceAddProjects.mockResolvedValueOnce(result([p], ["p1"]));

    const done = addProjectFromPicker();
    expect(isPickerIdle()).toBe(false);
    await addProjectFromPicker(); // a second call while the dialog is up does nothing
    expect(projectPickFolder).toHaveBeenCalledTimes(1);
    choose("B:\\projects\\guild-auth");
    await done;
    expect(isPickerIdle()).toBe(true);
    expect(workspaceAddProjects).toHaveBeenCalledWith(["B:\\projects\\guild-auth"], CENTRED_CARD);
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects).toEqual([p]);
  });

  it("addProjectFromPicker adds nothing when cancelled, and banners a picker failure", async () => {
    projectPickFolder.mockResolvedValueOnce(null);
    await addProjectFromPicker();
    expect(workspaceAddProjects).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().loadError).toBeNull();

    projectPickFolder.mockRejectedValueOnce(new Error("no dialog"));
    await addProjectFromPicker();
    expect(useWorkspaceStore.getState().loadError).toBe("project add failed: folder picker: no dialog");
    expect(isPickerIdle()).toBe(true);
  });

  it("addProjectFromPicker falls back to a card centred on the origin without a canvas", async () => {
    useCanvasStore.setState({ instance: null, element: null });
    projectPickFolder.mockResolvedValueOnce("B:\\x");
    workspaceAddProjects.mockResolvedValueOnce(result([], []));
    await addProjectFromPicker();
    expect(workspaceAddProjects).toHaveBeenCalledWith(["B:\\x"], { x: -120, y: -40 });
  });

  const items: ClaudeProject[] = [
    { dir: "B--projects-ide", cwd: "B:\\projects\\ide", exists: true, sessions: 12, on_canvas: true },
    { dir: "B--projects-guild-auth", cwd: "B:\\projects\\guild-auth", exists: true, sessions: 3, on_canvas: false },
    { dir: "B--projects-platform", cwd: "B:\\projects\\platform", exists: true, sessions: 1, on_canvas: false },
    { dir: "C--gone", cwd: "C:\\gone", exists: false, sessions: 1, on_canvas: false },
  ];

  it("loadImportList fills the import store, or records why it could not", async () => {
    claudeProjectsList.mockResolvedValueOnce(items);
    const pending = loadImportList();
    expect(useImportStore.getState().loading).toBe(true);
    await pending;
    expect(useImportStore.getState().items).toEqual(items);
    expect(useImportStore.getState().loading).toBe(false);

    claudeProjectsList.mockRejectedValueOnce(new Error("nope"));
    await loadImportList();
    expect(useImportStore.getState().error).toBe("could not list Claude projects: nope");
    expect(useImportStore.getState().loading).toBe(false);
  });

  it("addSelectedImports adds the ticked folders not yet on the canvas, centred, then closes the pane", async () => {
    useWorkspaceStore.getState().applySnapshot(snapshot([project("p1", "B:\\projects\\ide")]));
    useUiStore.getState().openPane("import");
    const store = useImportStore.getState();
    store.setItems(items);
    store.toggle("B:\\projects\\ide"); // on canvas: ignored
    store.toggle("B:\\projects\\guild-auth");
    store.toggle("B:\\projects\\platform");
    const added = [project("p1", "B:\\projects\\ide"), project("p2", "B:\\projects\\guild-auth"), project("p3", "B:\\projects\\platform")];
    workspaceAddProjects.mockResolvedValueOnce(result(added, ["p2", "p3"]));

    const pending = addSelectedImports();
    expect(useImportStore.getState().adding).toBe(true);
    await pending;

    expect(workspaceAddProjects).toHaveBeenCalledWith(["B:\\projects\\guild-auth", "B:\\projects\\platform"], CENTRED_CARD);
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects).toHaveLength(3);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useImportStore.getState().items).toBeNull();
    expect(useImportStore.getState().selected).toEqual([]);
    expect(useImportStore.getState().adding).toBe(false);
  });

  it("ctrl+, during an in-flight import add leaves the settings pane open afterwards", async () => {
    useUiStore.getState().openPane("import");
    useImportStore.getState().setItems(items);
    useImportStore.getState().toggle("B:\\projects\\platform");
    let finish!: (r: AddProjectsResult) => void;
    workspaceAddProjects.mockReturnValueOnce(new Promise<AddProjectsResult>((r) => (finish = r)));

    const pending = addSelectedImports();
    openPane("settings"); // what `settings.toggle` does mid-flight
    expect(useUiStore.getState().pane).toBe("settings");
    finish(result([project("p3", "B:\\projects\\platform")], ["p3"]));
    await pending;

    expect(useUiStore.getState().pane).toBe("settings");
    expect(useImportStore.getState().adding).toBe(false);
  });

  it("addSelectedImports with nothing to add is a no-op, and a failure stays in the pane", async () => {
    useUiStore.getState().openPane("import");
    useImportStore.getState().setItems(items);
    await addSelectedImports();
    expect(workspaceAddProjects).not.toHaveBeenCalled();
    expect(useUiStore.getState().pane).toBe("import");

    useImportStore.getState().toggle("B:\\projects\\platform");
    workspaceAddProjects.mockRejectedValueOnce(new Error("disk full"));
    await addSelectedImports();
    expect(useImportStore.getState().error).toBe("disk full");
    expect(useImportStore.getState().adding).toBe(false);
    expect(useUiStore.getState().pane).toBe("import");
    expect(useImportStore.getState().items).toEqual(items);

    // A second confirm while one is in flight does nothing.
    let finish!: (r: AddProjectsResult) => void;
    workspaceAddProjects.mockReturnValueOnce(new Promise<AddProjectsResult>((r) => (finish = r)));
    const first = addSelectedImports();
    await addSelectedImports();
    expect(workspaceAddProjects).toHaveBeenCalledTimes(2);
    finish(result([project("p3", "B:\\projects\\platform")], ["p3"]));
    await first;
    expect(useUiStore.getState().pane).toBeNull();
  });
});
