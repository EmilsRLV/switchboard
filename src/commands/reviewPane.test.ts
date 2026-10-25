// Story 8.1: "Review changes" (`r`, the palette, the node menu) and the Review pane's commands.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitLog, WorkspaceSnapshot } from "../ipc";
import { EMPTY_REVIEWS, useReviewStore } from "../state/review";
import { usePaletteStore } from "../state/palette";
import { useStatusStore } from "../state/status";
import { clampReviewWidth, defaultReviewWidth, loadWidth, REVIEW_WIDTH_KEY, saveWidth, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { renderTimeText, diagnosticsRows } from "../components/diagnostics";
import { registerBuiltins } from "./builtins";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { closeOpenPane, openPane } from "./panes";
import { clearCommands, getCommand, listCommands, runCommand } from "./registry";
import { canReviewSelection, canSetReviewMode, needsOwnPoll, openingMode, projectOfTarget, reviewTargetOfSelection, toggleLayoutTitle } from "./review";

function key(k: string): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: () => {} };
}

const child = { detail: null, position: null, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null };

const snapshot: WorkspaceSnapshot = {
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
    {
      ...child,
      id: "p1:feat",
      projectId: "p1",
      kind: "branch",
      label: "feat",
      branch: { head: false, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: { path: "/w/api-feat", missing: false } },
    },
  ],
} as unknown as WorkspaceSnapshot;

const repo = (dirty: number) => ({ kind: "repo" as const, branch: "main", detached: false, dirty, ahead: 0, behind: 0 });

describe("Review changes (Story 8.1)", () => {
  beforeEach(() => {
    clearCommands();
    useWorkspaceStore.setState({ snapshot, loadError: null });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false });
    usePaletteStore.setState({ isOpen: false, query: "", selected: 0 });
    useReviewStore.setState({ requests: EMPTY_REVIEWS, target: null, requestId: null, selected: null, filter: "all", mode: "changes", base: null, commit: null, commitList: null, layout: "split", order: [], refreshSeq: 0, lastRenderMs: null });
    useStatusStore.setState({ statuses: {}, received: true });
    registerBuiltins();
  });
  afterEach(() => {
    closeOpenPane();
    clearCommands();
  });

  it("is `r`, in the palette and last in the node menu", () => {
    const command = getCommand("review.changes");
    expect(command?.keybinding).toBe("r");
    expect(command?.title).toBe("Review changes");
    expect(command?.menu).toBe("node");
    expect(command?.menuOrder).toBe(60);
  });

  it("reviews the selected project, branch or session; nothing else", () => {
    expect(canReviewSelection()).toBe(false);
    expect(handleKeydown(key("r"))).toBe(false);
    useUiStore.getState().select({ kind: "project", id: "p1" });
    expect(reviewTargetOfSelection()).toEqual({ kind: "project", projectId: "p1" });
    useUiStore.getState().select({ kind: "branch", id: "p1:feat" });
    expect(reviewTargetOfSelection()).toEqual({ kind: "branch", projectId: "p1", branch: "feat" });
    useUiStore.getState().select({ kind: "session", id: "s1" });
    expect(reviewTargetOfSelection()).toEqual({ kind: "session", sessionId: "s1" });
    useUiStore.getState().select({ kind: "project", id: "gone" });
    expect(reviewTargetOfSelection()).toBeNull();
  });

  it("`r` opens the pane on the selected node at the All filter; not while a pane is open", () => {
    useUiStore.getState().select({ kind: "branch", id: "p1:feat" });
    expect(handleKeydown(key("r"))).toBe(true);
    expect(useUiStore.getState().pane).toBe("review");
    const store = useReviewStore.getState();
    expect(store.target).toEqual({ kind: "branch", projectId: "p1", branch: "feat" });
    expect(store.requestId).toBeNull();
    expect(store.filter).toBe("all");
    // A pane is open: `r` is not the canvas's; the palette still lists it.
    openPane("settings");
    useUiStore.getState().select({ kind: "project", id: "p1" });
    expect(handleKeydown(key("r"))).toBe(false);
    usePaletteStore.setState({ isOpen: true });
    expect(listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.id)).toContain("review.changes");
    expect(runCommand("review.changes")).toBe(true);
    expect(useUiStore.getState().pane).toBe("review");
    expect(useReviewStore.getState().target).toEqual({ kind: "project", projectId: "p1" });
    // Closing forgets the target.
    closeOpenPane();
    expect(useReviewStore.getState().target).toBeNull();
  });

  it("the pane's commands set the filter and layout, step through the files and refresh", () => {
    for (const id of ["review.refresh", "review.filterStaged", "review.toggleLayout", "review.nextFile"]) {
      expect(getCommand(id)?.when?.(), id).toBe(false);
    }
    useUiStore.getState().select({ kind: "project", id: "p1" });
    runCommand("review.changes");
    expect(runCommand("review.filterStaged")).toBe(true);
    expect(useReviewStore.getState().filter).toBe("staged");
    runCommand("review.filterUnstaged");
    expect(useReviewStore.getState().filter).toBe("unstaged");
    runCommand("review.filterAll");
    expect(useReviewStore.getState().filter).toBe("all");
    expect(toggleLayoutTitle()).toBe("Review: unified view");
    runCommand("review.toggleLayout");
    expect(useReviewStore.getState().layout).toBe("unified");
    expect(toggleLayoutTitle()).toBe("Review: side-by-side view");
    useReviewStore.getState().setOrder(["README.md", "src/a.ts", "src/b.ts"]);
    useReviewStore.getState().select("README.md");
    expect(getCommand("review.nextFile")?.keybinding).toBe("j");
    expect(getCommand("review.prevFile")?.keybinding).toBe("k");
    expect(handleKeydown(key("j"))).toBe(true);
    expect(useReviewStore.getState().selected).toBe("src/a.ts");
    runCommand("review.nextFile");
    runCommand("review.nextFile");
    expect(useReviewStore.getState().selected).toBe("src/b.ts");
    runCommand("review.prevFile");
    expect(useReviewStore.getState().selected).toBe("src/a.ts");
    const seq = useReviewStore.getState().refreshSeq;
    runCommand("review.refresh");
    expect(useReviewStore.getState().refreshSeq).toBe(seq + 1);
  });

  it("a target outside its project's folder is re-read every poll.git_ms while the pane is open", () => {
    vi.useFakeTimers();
    try {
      expect(needsOwnPoll({ kind: "project", projectId: "p1" }, "/w/api")).toBe(false);
      expect(needsOwnPoll({ kind: "session", sessionId: "s1" }, "/w/api")).toBe(false);
      expect(needsOwnPoll({ kind: "session", sessionId: "s1" }, "/w/api-feat")).toBe(true);
      expect(needsOwnPoll({ kind: "branch", projectId: "p1", branch: "feat" }, null)).toBe(false);
      useUiStore.getState().select({ kind: "branch", id: "p1:feat" });
      runCommand("review.changes");
      const seq = useReviewStore.getState().refreshSeq;
      vi.advanceTimersByTime(6000);
      expect(useReviewStore.getState().refreshSeq, "no root yet: no poll").toBe(seq);
      useReviewStore.getState().setRoot("/w/api-feat");
      vi.advanceTimersByTime(5000);
      expect(useReviewStore.getState().refreshSeq).toBe(seq + 1);
      closeOpenPane();
      vi.advanceTimersByTime(20_000);
      expect(useReviewStore.getState().refreshSeq).toBe(seq + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a status change of the target's project reads the list again; another project's does not", () => {
    useStatusStore.getState().applyStatuses({ p1: repo(1), p2: repo(0) });
    useUiStore.getState().select({ kind: "session", id: "s1" });
    runCommand("review.changes");
    expect(projectOfTarget({ kind: "session", sessionId: "s1" })).toBe("p1");
    const seq = useReviewStore.getState().refreshSeq;
    useStatusStore.getState().applyStatuses({ p1: repo(1), p2: repo(4) });
    expect(useReviewStore.getState().refreshSeq).toBe(seq);
    useStatusStore.getState().applyStatuses({ p1: repo(2), p2: repo(4) });
    expect(useReviewStore.getState().refreshSeq).toBe(seq + 1);
    // Closed: nothing.
    closeOpenPane();
    useStatusStore.getState().applyStatuses({ p1: repo(3), p2: repo(4) });
    expect(useReviewStore.getState().refreshSeq).toBe(seq + 1);
  });

  it("Diagnostics shows the last diff's render time", () => {
    const base = { endpoint: null, endpoint_error: null, hook_events: 0, refused: 0, session_mismatches: 0, poll_overrides: 0, mcp_refused: 0, mcp_refusals: [] };
    expect(diagnosticsRows(base).map((r) => r.label)).not.toContain("last diff render");
    expect(diagnosticsRows(base, null).at(-1)).toEqual({ label: "last diff render", value: "none yet", attention: false });
    useReviewStore.getState().setRenderMs(41.6);
    expect(diagnosticsRows(base, useReviewStore.getState().lastRenderMs).at(-1)?.value).toBe("42 ms");
    expect(renderTimeText(180)).toBe("180 ms");
  });

  it("the pane is wide: min(1100px, 85vw) by default, dragged between 360 px and 90vw, remembered", () => {
    expect(defaultReviewWidth(1920)).toBe(1100);
    expect(defaultReviewWidth(1000)).toBe(850);
    expect(clampReviewWidth(Number.NaN, 1000)).toBe(850);
    expect(clampReviewWidth(100, 1000)).toBe(360);
    expect(clampReviewWidth(5000, 1000)).toBe(900);
    const stored = new Map<string, string>();
    const storage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
    saveWidth(REVIEW_WIDTH_KEY, 812.4, storage);
    expect(loadWidth(REVIEW_WIDTH_KEY, storage)).toBe(812);
  });
  it("Story 8.2: a project or branch offers Changes, vs base and Commits; a session Changes only", () => {
    for (const id of ["review.modeChanges", "review.modeBase", "review.modeCommits"]) expect(getCommand(id)?.when?.(), id).toBe(false);
    expect(getCommand("review.modeBase")?.title).toBe("Review: vs base");
    expect(getCommand("review.modeCommits")?.title).toBe("Review: commits");
    expect(getCommand("review.modeChanges")?.title).toBe("Review: changes");
    useUiStore.getState().select({ kind: "session", id: "s1" });
    runCommand("review.changes");
    expect(canSetReviewMode("changes")).toBe(true);
    expect(canSetReviewMode("base")).toBe(false);
    expect(runCommand("review.modeCommits")).toBe(false);
    useReviewStore.getState().setMode("commits");
    expect(useReviewStore.getState().mode, "a session has Changes only").toBe("changes");
    closeOpenPane();
    useUiStore.getState().select({ kind: "branch", id: "p1:feat" });
    runCommand("review.changes");
    useReviewStore.getState().select("a.ts");
    expect(runCommand("review.modeBase")).toBe(true);
    expect(useReviewStore.getState()).toMatchObject({ mode: "base", selected: null, base: null });
    runCommand("review.modeCommits");
    expect(useReviewStore.getState().mode).toBe("commits");
    runCommand("review.modeChanges");
    expect(useReviewStore.getState().mode).toBe("changes");
  });

  it("Story 8.2: the base and the commit; a new target starts over at Changes", () => {
    useUiStore.getState().select({ kind: "project", id: "p1" });
    runCommand("review.changes");
    const store = () => useReviewStore.getState();
    store().setMode("commits");
    const log: CommitLog = { root: "/w/api", branch: "main", base: "feat", defaultBase: "feat", bases: ["feat", "main"], error: null, commits: [], more: 0 };
    store().setCommitList(log);
    store().selectCommit("a".repeat(40));
    store().select("x.ts");
    expect(store()).toMatchObject({ commit: "a".repeat(40), selected: "x.ts" });
    store().selectCommit(null);
    expect(store()).toMatchObject({ commit: null, selected: null });
    store().selectCommit("b".repeat(40));
    store().setBase("feat");
    expect(store()).toMatchObject({ base: "feat", commit: null, commitList: null });
    store().setBase(null);
    expect(store().base).toBe(null);
    // Same target: the mode stays (Refresh); another target starts at Changes with the default base.
    store().setBase("feat");
    store().openTarget({ kind: "project", projectId: "p1" }, null);
    expect(store()).toMatchObject({ mode: "commits", base: "feat" });
    store().openTarget({ kind: "branch", projectId: "p1", branch: "feat" }, null);
    expect(store()).toMatchObject({ mode: "changes", base: null, commit: null, commitList: null });
  });

  it("Story 8.2: vs base and Commits never poll; Refresh still reads them again", () => {
    vi.useFakeTimers();
    try {
      useStatusStore.getState().applyStatuses({ p1: repo(1) });
      useUiStore.getState().select({ kind: "branch", id: "p1:feat" });
      runCommand("review.changes");
      useReviewStore.getState().setRoot("/w/api-feat");
      runCommand("review.modeBase");
      const seq = useReviewStore.getState().refreshSeq;
      vi.advanceTimersByTime(20_000);
      useStatusStore.getState().applyStatuses({ p1: repo(5) });
      expect(useReviewStore.getState().refreshSeq, "no poll outside Changes").toBe(seq);
      runCommand("review.refresh");
      expect(useReviewStore.getState().refreshSeq).toBe(seq + 1);
      runCommand("review.modeChanges");
      vi.advanceTimersByTime(5000);
      expect(useReviewStore.getState().refreshSeq, "Changes polls again").toBe(seq + 2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("Story 8.2: the filter is offered in Changes only; a mode command is not offered for the mode showing", () => {
    useUiStore.getState().select({ kind: "project", id: "p1" });
    runCommand("review.changes");
    expect(getCommand("review.filterStaged")?.when?.()).toBe(true);
    expect(getCommand("review.modeChanges")?.when?.(), "already showing").toBe(false);
    runCommand("review.modeBase");
    for (const id of ["review.filterAll", "review.filterStaged", "review.filterUnstaged", "review.modeBase"]) expect(getCommand(id)?.when?.(), id).toBe(false);
    expect(getCommand("review.modeChanges")?.when?.()).toBe(true);
    expect(getCommand("review.modeCommits")?.when?.()).toBe(true);
  });

  it("Story 8.2: a branch without a worktree opens in vs base; one with a worktree in Changes", () => {
    const bare = {
      ...child,
      id: "p1:bare",
      projectId: "p1",
      kind: "branch",
      label: "bare",
      branch: { head: false, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: null },
    };
    useWorkspaceStore.setState({ snapshot: { ...snapshot, children: [...snapshot.children, bare] } as unknown as WorkspaceSnapshot });
    useUiStore.getState().select({ kind: "branch", id: "p1:bare" });
    runCommand("review.changes");
    expect(useReviewStore.getState()).toMatchObject({ target: { kind: "branch", projectId: "p1", branch: "bare" }, mode: "base" });
    closeOpenPane();
    useUiStore.getState().select({ kind: "branch", id: "p1:feat" });
    runCommand("review.changes");
    expect(useReviewStore.getState().mode).toBe("changes");
    expect(openingMode({ kind: "project", projectId: "p1" })).toBe("changes");
  });

  it("Story 8.2: a shown commit the re-read list no longer has goes back to the list", () => {
    useUiStore.getState().select({ kind: "project", id: "p1" });
    runCommand("review.changes");
    runCommand("review.modeCommits");
    const commit = (sha: string) => ({ sha: sha.repeat(40), short: sha.repeat(7), subject: sha, author: "A", at: 1, parents: [] });
    const log = (shas: string[]): CommitLog => ({ root: "/w/api", branch: "main", base: "feat", defaultBase: "feat", bases: ["feat", "main"], error: null, commits: shas.map(commit), more: 0 });
    const store = () => useReviewStore.getState();
    store().setCommitList(log(["a", "b"]));
    store().selectCommit("b".repeat(40));
    store().select("x.ts");
    store().setCommitList(log(["a", "b", "c"]));
    expect(store()).toMatchObject({ commit: "b".repeat(40), selected: "x.ts" });
    store().setCommitList(log(["a", "c"]));
    expect(store()).toMatchObject({ commit: null, selected: null });
  });
});
