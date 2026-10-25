// Story 9.4: the pane buttons that became commands. Each is enabled exactly when its button
// would act, and runs what the button ran.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeProject, PendingRequest, RemoveWorktreeCheck, ReviewRequest } from "../ipc";
import { useApprovalsStore } from "../state/approvals";
import { useImportStore } from "../state/import";
import { useLaunchStore } from "../state/launch";
import { useRemoveWorktreeStore } from "../state/removeWorktree";
import { useReviewStore } from "../state/review";
import { useUiStore } from "../state/ui";
import { useWorktreeStore } from "../state/worktree";
import { registerBuiltins } from "./builtins";
import { FORCE_CONFIRM_DELAY_MS } from "./removeWorktree";
import { clearCommands, isCommandEnabled, listCommands, runCommand } from "./registry";
import { INSPECTOR_BUTTON_COMMANDS, inspectorButtons } from "../components/EdgePane";
import { HEADER_BUTTON_COMMANDS, headerButtons } from "../terminal/TerminalPane";
import type { Edge, EdgeLive, TermInfo, WorkspaceSnapshot } from "../ipc";
import { useEdgesLiveStore } from "../state/edgesLive";
import { useTerminalStore } from "../state/terminals";
import { useWorkspaceStore } from "../state/workspace";
import { REVIEW_FILTER_COMMANDS, REVIEW_LAYOUT_COMMANDS, REVIEW_MODE_COMMANDS, reviewModes } from "./review";

function enabled(): string[] {
  return listCommands({ enabledOnly: true }).map((c) => c.id);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function request(id: string, always: boolean): PendingRequest {
  return { id, caller: "s1", callerName: "api", tool: "link", action: "link ui", detail: "ui -> api", argv: null, always, target: "ui" } as PendingRequest;
}

function review(sessionId: string, seq: number): ReviewRequest {
  return { sessionId, name: sessionId, summary: "look", root: "/p", paths: [], at: "2026-10-25T10:00:00Z", seq, flagged: true };
}

function check(dirty: number): RemoveWorktreeCheck {
  return {
    branch: "feat",
    path: "/w/feat",
    missing: false,
    locked: false,
    dirty,
    command: "git worktree remove /w/feat",
    forceCommand: "git worktree remove --force /w/feat",
    deleteCommand: "git branch -d feat",
    refusal: null,
  };
}

describe("pane commands", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false, activeTerminal: null, openTerminals: [], poppedOut: {} });
  });
  afterEach(() => {
    clearCommands();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("approval.always answers the oldest request that offers it, and only such a one", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    useApprovalsStore.setState({ pending: [request("r1", false)], answering: [] });
    expect(enabled()).toContain("approval.allow");
    expect(enabled()).not.toContain("approval.always");
    expect(runCommand("approval.always")).toBe(false);
    useApprovalsStore.setState({ pending: [request("r1", true), request("r2", true)], answering: [] });
    expect(runCommand("approval.always")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("approval_answer", { id: "r1", answer: "always" }, undefined);
    useApprovalsStore.setState({ pending: [], answering: [] });
  });

  it("review.dismissToast dismisses the oldest toast; the flag stays", () => {
    expect(enabled()).not.toContain("review.dismissToast");
    useReviewStore.setState({ requests: { b: review("b", 7), a: review("a", 3) }, dismissed: {} });
    expect(runCommand("review.dismissToast")).toBe(true);
    expect(useReviewStore.getState().dismissed).toEqual({ a: 3 });
    expect(useReviewStore.getState().requests.a?.flagged).toBe(true);
    expect(runCommand("review.dismissToast")).toBe(true);
    expect(enabled()).not.toContain("review.dismissToast");
    useReviewStore.setState({ requests: {}, dismissed: {} });
  });

  it("the Review pane's layout buttons and ← Commits are commands while the pane is open", () => {
    expect(runCommand("review.layoutUnified")).toBe(false);
    useReviewStore.setState({ target: { kind: "project", projectId: "ide" }, layout: "split", mode: "commits", commit: "abc" } as never);
    useUiStore.setState({ pane: "review" });
    expect(enabled()).toContain("review.layoutUnified");
    expect(enabled()).not.toContain("review.layoutSplit");
    expect(runCommand("review.layoutUnified")).toBe(true);
    expect(useReviewStore.getState().layout).toBe("unified");
    expect(enabled()).toContain("review.layoutSplit");
    expect(runCommand("review.backToCommits")).toBe(true);
    expect(useReviewStore.getState().commit).toBeNull();
    expect(enabled()).not.toContain("review.backToCommits");
    useReviewStore.setState({ target: null, layout: "split", mode: "changes" } as never);
  });

  it("Remove worktree: Remove on a clean worktree; on a dirty one Force remove…, then the discard after its delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    useRemoveWorktreeStore.getState().open("ide", "feat");
    const opened = useRemoveWorktreeStore.getState().opened;
    useRemoveWorktreeStore.getState().applyCheck(opened, check(0));
    expect(enabled()).not.toContain("worktree.remove");
    useUiStore.setState({ pane: "removeWorktree" });
    expect(enabled()).toContain("worktree.remove");
    expect(enabled()).not.toContain("worktree.forceRemove");

    useRemoveWorktreeStore.getState().applyCheck(opened, check(2));
    expect(enabled()).not.toContain("worktree.remove");
    expect(enabled()).toContain("worktree.forceRemove");
    expect(enabled()).not.toContain("worktree.discardAndRemove");
    expect(runCommand("worktree.forceRemove")).toBe(true);
    expect(useRemoveWorktreeStore.getState().forceArmed).toBe(true);
    expect(enabled()).not.toContain("worktree.forceRemove");
    // Not before the delay: a double press never confirms.
    expect(runCommand("worktree.discardAndRemove")).toBe(false);
    vi.setSystemTime(10_000 + FORCE_CONFIRM_DELAY_MS);
    expect(enabled()).toContain("worktree.discardAndRemove");
    // Without a runtime the remove fails into the sheet: what the button did.
    expect(runCommand("worktree.discardAndRemove")).toBe(true);
    await vi.runAllTimersAsync();
    expect(useRemoveWorktreeStore.getState().error).toMatch(/cannot invoke "worktree_remove"/);
    useRemoveWorktreeStore.getState().reset();
  });

  it("New worktree: the mode buttons and Create follow the sheet", () => {
    useWorktreeStore.getState().open({ id: "ide", label: "ide" }, { mode: "new", name: "", base: null, branch: "" });
    expect(enabled()).not.toContain("worktree.modeExisting");
    useUiStore.setState({ pane: "worktree" });
    expect(enabled()).toContain("worktree.modeExisting");
    expect(enabled()).not.toContain("worktree.modeNew");
    // No preview yet: Create is blocked, as its button is.
    expect(enabled()).not.toContain("worktree.create");
    expect(runCommand("worktree.modeExisting")).toBe(true);
    expect(useWorktreeStore.getState().form?.mode).toBe("existing");
    expect(enabled()).toContain("worktree.modeNew");
    useWorktreeStore.getState().reset();
  });

  it("New session: Start only when nothing blocks it; Add folder… while not starting", () => {
    expect(enabled()).not.toContain("launch.start");
    expect(enabled()).not.toContain("launch.addFolder");
    useLaunchStore.setState({
      projectId: "ide",
      form: { name: "ide-1", model: "default", customModel: "", effort: "default", permissionMode: "default", addDirs: [], prompt: "", background: false, useWorktree: false, worktreeName: "" },
      starting: false,
      missingDirs: [],
      worktreePlan: null,
      repoTop: null,
    } as never);
    useUiStore.setState({ pane: "launch" });
    expect(enabled()).toContain("launch.start");
    expect(enabled()).toContain("launch.addFolder");
    useLaunchStore.setState({ starting: true });
    expect(enabled()).not.toContain("launch.start");
    expect(enabled()).not.toContain("launch.addFolder");
    useLaunchStore.setState({ starting: false, form: { ...useLaunchStore.getState().form!, name: "" } });
    expect(enabled()).not.toContain("launch.start");
    useLaunchStore.setState({ projectId: null, form: null } as never);
  });

  it("Import: add selected only with ticked folders that are not on the canvas", () => {
    const project: ClaudeProject = { dir: "-p-x", cwd: "/p/x", exists: true, sessions: 2, on_canvas: false };
    useImportStore.setState({ items: [project], selected: [], adding: false });
    useUiStore.setState({ pane: "import" });
    expect(enabled()).not.toContain("import.addSelected");
    useImportStore.getState().toggle("/p/x");
    expect(enabled()).toContain("import.addSelected");
    useImportStore.setState({ adding: true });
    expect(enabled()).not.toContain("import.addSelected");
    useImportStore.getState().reset();
  });

  it("the popped-out tab's Return to pane and Focus window act on the pane's terminal", async () => {
    const invoke = vi.fn().mockResolvedValue("term-1");
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    useUiStore.setState({ pane: "terminal", activeTerminal: "t1", openTerminals: ["t1"], poppedOut: {} });
    expect(enabled()).not.toContain("terminal.returnToPane");
    useUiStore.setState({ poppedOut: { t1: "term-1" } });
    expect(enabled()).toContain("terminal.returnToPane");
    expect(enabled()).toContain("terminal.focusWindow");
    expect(runCommand("terminal.returnToPane")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("term_return", { id: "t1" }, undefined);
  });

  describe("a routed button shows only while its command is enabled", () => {
    /** Every shown button's command is enabled. */
    function expectAgree(shown: Record<string, boolean>, commands: Record<string, string>): void {
      for (const [button, isShown] of Object.entries(shown)) {
        if (isShown) expect(isCommandEnabled(commands[button]!), `${button} -> ${commands[button]}`).toBe(true);
      }
    }

    it("the edge inspector's Revoke, Retry and Restart with flags", () => {
      const edge: Edge = {
        id: "e1",
        from: { type: "session", id: "s1" },
        to: { type: "project", id: "ide" },
        kind: "context",
        label: null,
        createdAt: "2026-10-25T10:00:00Z",
        agentAllowed: true,
      } as Edge;
      // Drawn ends (an expanded project and its session), or the selection is dropped.
      const snapshot = {
        path: null,
        workspace: {
          version: 1,
          viewport: { x: 0, y: 0, zoom: 1 },
          projects: [{ id: "ide", path: "/p/ide", label: "ide", position: { x: 0, y: 0 }, expanded: true, color: null, launchDefaults: null, showBranches: false }],
          branches: [],
          sessions: [],
          edges: [edge],
          defaults: { model: null, effort: null, permissionMode: null },
        },
        banners: [],
        revision: 1,
        branchErrors: {},
        children: [
          { id: "s1", projectId: "ide", kind: "session", label: "s1", detail: null, position: null, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null },
        ],
      } as unknown as WorkspaceSnapshot;
      useWorkspaceStore.setState({ snapshot });
      useUiStore.setState({ selection: { kind: "edge", id: "e1" }, pane: "edge" });
      expect(useUiStore.getState().selection).toEqual({ kind: "edge", id: "e1" });
      for (const state of ["failed", "applied", "pending"] as const) {
        const live: EdgeLive = { state, detail: null, edgeId: "e1", sessionId: "s1", path: null };
        useEdgesLiveStore.setState({ entries: { e1: live } });
        const shown = inspectorButtons(edge, live);
        expect(shown.revoke && shown.restart).toBe(true);
        expect(shown.retry).toBe(state === "failed");
        expectAgree(shown, INSPECTOR_BUTTON_COMMANDS);
      }
      useWorkspaceStore.setState({ snapshot: null });
      useEdgesLiveStore.setState({ entries: {} });
    });

    it("the terminal pane header's Restart, Close, Pop out and Kill", () => {
      const info = (id: string, kind: "plain" | "session", exited: number | null): TermInfo =>
        ({ id, kind, project_id: "ide", title: id, cwd: "/p", exited, error: null, cols: 80, rows: 24, stopping: false }) as TermInfo;
      for (const term of [info("plain:ide", "plain", null), info("plain:ide", "plain", 0), info("session:s1", "session", 0), info("session:s1", "session", null)]) {
        useTerminalStore.setState({ infos: { [term.id]: term }, pendingExits: {} });
        useUiStore.setState({ pane: "terminal", activeTerminal: term.id, openTerminals: [term.id], poppedOut: {} });
        const shown = headerButtons(term.id, term, "pane", false);
        expect(Object.values(shown).some(Boolean)).toBe(true);
        expectAgree(shown, HEADER_BUTTON_COMMANDS);
      }
      useTerminalStore.setState({ infos: {}, pendingExits: {} });
    });

    it("the Review pane's mode, filter, layout and ← Commits buttons that are not pressed", () => {
      useUiStore.setState({ pane: "review" });
      const target = { kind: "project", projectId: "ide" } as const;
      for (const mode of reviewModes(target)) {
        for (const layout of ["split", "unified"] as const) {
          useReviewStore.setState({ target, mode, layout, commit: mode === "commits" ? "abc" : null } as never);
          for (const other of reviewModes(target).filter((m) => m !== mode)) expect(isCommandEnabled(REVIEW_MODE_COMMANDS[other]), other).toBe(true);
          if (mode === "changes") for (const id of Object.values(REVIEW_FILTER_COMMANDS)) expect(isCommandEnabled(id), id).toBe(true);
          if (mode !== "files") expect(isCommandEnabled(REVIEW_LAYOUT_COMMANDS[layout === "split" ? "unified" : "split"])).toBe(true);
          expect(isCommandEnabled("review.backToCommits")).toBe(mode === "commits");
        }
      }
      useReviewStore.setState({ target: null, mode: "changes", layout: "split", commit: null } as never);
    });
  });
});
