// Story 8.3: the Review pane's Files mode command and `o` (Open in editor): when they are offered,
// what `o` asks Rust for, and the no-editor notice that opens Settings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../ipc";
import { EMPTY_REVIEWS, useReviewStore } from "../state/review";
import { usePaletteStore } from "../state/palette";
import { useUiStore } from "../state/ui";
import { useSettingsStore } from "../state/settings";
import type { SettingsSnapshot } from "../ipc";
import { useWorkspaceStore } from "../state/workspace";
import { setLineProvider } from "../review/place";
import { registerBuiltins } from "./builtins";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { closeOpenPane } from "./panes";
import { clearCommands, getCommand, listCommands, runCommand } from "./registry";
import { NO_FILE_TO_OPEN, editorPathOfPane, openInEditor, openReviewOf, reviewModes, targetHasFolder } from "./review";

vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  reviewOpenEditor: vi.fn(),
}));

const ipc = await import("../ipc");
const reviewOpenEditor = vi.mocked(ipc.reviewOpenEditor);

function key(k: string, target?: unknown): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: () => {}, target };
}

const child = { detail: null, position: null, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null };
const branch = (label: string, worktree: { path: string; missing: boolean } | null) => ({
  ...child,
  id: `p1:${label}`,
  projectId: "p1",
  kind: "branch",
  label,
  branch: { head: false, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree },
});

const snapshot = {
  path: null,
  workspace: {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    projects: [{ id: "p1", path: "/w/api", label: "api", position: { x: 0, y: 0 }, expanded: true, color: null, launchDefaults: null, showBranches: true }],
    branches: [],
    sessions: [],
    edges: [],
    defaults: { model: null, effort: null, permissionMode: null },
  },
  banners: [],
  revision: 1,
  branchErrors: {},
  children: [
    { ...child, id: "s1", projectId: "p1", kind: "session", label: "fix auth" },
    branch("feat", { path: "/w/api-feat", missing: false }),
    branch("bare", null),
    branch("lost", { path: "/w/gone", missing: true }),
  ],
} as unknown as WorkspaceSnapshot;

describe("Files mode and Open in editor (Story 8.3)", () => {
  beforeEach(() => {
    clearCommands();
    reviewOpenEditor.mockReset();
    reviewOpenEditor.mockResolvedValue(undefined);
    useWorkspaceStore.setState({ snapshot, loadError: null });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false, notice: null });
    usePaletteStore.setState({ isOpen: false, query: "", selected: 0 });
    useSettingsStore.setState({ snapshot: null });
    useReviewStore.setState({ filesOpen: new Set(), requests: EMPTY_REVIEWS, target: null, requestId: null, selected: null, filter: "all", mode: "changes", base: null, commit: null, commitList: null, layout: "split", order: [], refreshSeq: 0, lastRenderMs: null });
    registerBuiltins();
  });
  afterEach(() => {
    closeOpenPane();
    clearCommands();
  });

  it("Files is offered wherever the pane has a folder", () => {
    expect(reviewModes({ kind: "project", projectId: "p1" })).toEqual(["changes", "base", "commits", "files"]);
    expect(reviewModes({ kind: "session", sessionId: "s1" })).toEqual(["changes", "files"]);
    expect(targetHasFolder({ kind: "branch", projectId: "p1", branch: "feat" })).toBe(true);
    expect(targetHasFolder({ kind: "branch", projectId: "p1", branch: "bare" })).toBe(false);
    expect(targetHasFolder({ kind: "branch", projectId: "p1", branch: "lost" })).toBe(false);
    expect(reviewModes({ kind: "branch", projectId: "p1", branch: "bare" })).toEqual(["changes", "base", "commits"]);

    expect(getCommand("review.modeFiles")?.when?.()).toBe(false);
    openReviewOf({ kind: "branch", projectId: "p1", branch: "bare" });
    expect(getCommand("review.modeFiles")?.when?.()).toBe(false);
    openReviewOf({ kind: "session", sessionId: "s1" });
    expect(runCommand("review.modeFiles")).toBe(true);
    expect(useReviewStore.getState().mode).toBe("files");
    expect(getCommand("review.modeFiles")?.when?.(), "not the one showing").toBe(false);
  });

  it("a branch without a usable worktree never shows Files, even reopened while Files shows", () => {
    openReviewOf({ kind: "branch", projectId: "p1", branch: "feat" });
    runCommand("review.modeFiles");
    expect(useReviewStore.getState().mode).toBe("files");
    // Its worktree goes: opening it again leaves Files.
    const children = snapshot.children.map((c) => (c.id === "p1:feat" ? { ...c, branch: { ...c.branch!, worktree: null } } : c));
    useWorkspaceStore.setState({ snapshot: { ...snapshot, children } as WorkspaceSnapshot });
    openReviewOf({ kind: "branch", projectId: "p1", branch: "feat" });
    expect(useReviewStore.getState().mode).toBe("base");
    // The store refuses Files for a target without a folder.
    useReviewStore.getState().setMode("files", false);
    expect(useReviewStore.getState().mode).toBe("base");
  });

  it("entering Files keeps a Changes file and opens the folders above it; a mark row or another mode's selection is dropped", () => {
    openReviewOf({ kind: "project", projectId: "p1" });
    useReviewStore.getState().select("src/auth/token.ts");
    runCommand("review.modeFiles");
    expect(useReviewStore.getState().selected).toBe("src/auth/token.ts");
    expect([...useReviewStore.getState().filesOpen].sort()).toEqual(["src", "src/auth"]);
    useReviewStore.getState().setMode("changes");
    useReviewStore.getState().select("req:src/gone.ts");
    runCommand("review.modeFiles");
    expect(useReviewStore.getState().selected).toBeNull();
    useReviewStore.getState().setMode("base");
    useReviewStore.getState().select("web/x.ts");
    runCommand("review.modeFiles");
    expect(useReviewStore.getState().selected, "vs base paths are the project folder's").toBeNull();
  });

  it("the open folders are the target's: a new target starts closed", () => {
    openReviewOf({ kind: "project", projectId: "p1" });
    useReviewStore.getState().toggleFolder("src");
    expect([...useReviewStore.getState().filesOpen]).toEqual(["src"]);
    useReviewStore.getState().setMode("base");
    expect([...useReviewStore.getState().filesOpen], "kept across modes").toEqual(["src"]);
    openReviewOf({ kind: "session", sessionId: "s1" });
    expect(useReviewStore.getState().filesOpen.size).toBe(0);
  });

  it("`o` runs only while the Review pane is open, never from a text field or under the menu; the palette lists it", () => {
    expect(getCommand("review.openEditor")?.keybinding).toBe("o");
    expect(handleKeydown(key("o"))).toBe(false);
    openReviewOf({ kind: "project", projectId: "p1" });
    useReviewStore.getState().select("src/a.ts");
    expect(handleKeydown(key("o", { tagName: "INPUT" }))).toBe(false);
    expect(handleKeydown(key("o", { tagName: "SELECT" }))).toBe(false);
    useUiStore.setState({ contextMenu: { x: 1, y: 1, menu: "node" } });
    expect(handleKeydown(key("o"))).toBe(false);
    useUiStore.setState({ contextMenu: null });
    usePaletteStore.setState({ isOpen: true });
    expect(listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.id)).toContain("review.openEditor");
    usePaletteStore.setState({ isOpen: false });
    expect(reviewOpenEditor).not.toHaveBeenCalled();
    // From the diff view (CodeMirror is not editable, so the key reaches the dispatcher).
    expect(handleKeydown(key("o", { tagName: "DIV", isContentEditable: false }))).toBe(true);
    expect(reviewOpenEditor).toHaveBeenCalledOnce();
  });

  it("asks Rust for the target, the mode, the selected path and the view's line (else line 1)", async () => {
    openReviewOf({ kind: "branch", projectId: "p1", branch: "feat" });
    useReviewStore.getState().setMode("base");
    useReviewStore.getState().select("src/a.ts");
    await expect(openInEditor()).resolves.toBe(true);
    expect(reviewOpenEditor).toHaveBeenLastCalledWith({ kind: "branch", projectId: "p1", branch: "feat" }, "base", "src/a.ts", 1);
    const unregister = setLineProvider(() => 42);
    await openInEditor();
    expect(reviewOpenEditor).toHaveBeenLastCalledWith({ kind: "branch", projectId: "p1", branch: "feat" }, "base", "src/a.ts", 42);
    unregister();
    useReviewStore.getState().setMode("files");
    useReviewStore.getState().select("README.md");
    await openInEditor();
    expect(reviewOpenEditor).toHaveBeenLastCalledWith({ kind: "branch", projectId: "p1", branch: "feat" }, "files", "README.md", 1);
  });

  it("with no file to open, it says so and asks nothing", async () => {
    openReviewOf({ kind: "project", projectId: "p1" });
    await expect(openInEditor()).resolves.toBe(false);
    expect(useUiStore.getState().notice?.text).toBe(NO_FILE_TO_OPEN);
    // The commit list, and a requested path's mark row, are not files.
    useReviewStore.getState().setMode("commits");
    useReviewStore.setState({ selected: "src/a.ts" });
    expect(editorPathOfPane()).toBeNull();
    useReviewStore.getState().setMode("changes");
    useReviewStore.getState().select("req:src/gone.ts");
    expect(editorPathOfPane()).toBeNull();
    expect(reviewOpenEditor).not.toHaveBeenCalled();
  });

  it("no editor set wins over `no file selected`: the notice, and Settings opens, without asking Rust", async () => {
    useSettingsStore.setState({ snapshot: { settings: { external_editor: " " } } as unknown as SettingsSnapshot });
    openReviewOf({ kind: "project", projectId: "p1" });
    await expect(openInEditor()).resolves.toBe(false);
    expect(useUiStore.getState().notice?.text).toBe(ipc.NO_EDITOR_SET);
    expect(useUiStore.getState().pane).toBe("settings");
    expect(reviewOpenEditor).not.toHaveBeenCalled();
  });

  it("no editor set: the notice, and Settings opens; any other refusal is only the notice", async () => {
    openReviewOf({ kind: "project", projectId: "p1" });
    useReviewStore.getState().select("a.ts");
    reviewOpenEditor.mockRejectedValueOnce(ipc.NO_EDITOR_SET);
    await expect(openInEditor()).resolves.toBe(false);
    expect(useUiStore.getState().notice?.text).toBe("No external editor set: add external_editor to settings");
    expect(useUiStore.getState().pane).toBe("settings");

    openReviewOf({ kind: "project", projectId: "p1" });
    useReviewStore.getState().select("gone.ts");
    reviewOpenEditor.mockRejectedValueOnce("not on disk: gone.ts");
    await openInEditor();
    expect(useUiStore.getState().notice?.text).toBe("not on disk: gone.ts");
    expect(useUiStore.getState().pane).toBe("review");
  });
});
