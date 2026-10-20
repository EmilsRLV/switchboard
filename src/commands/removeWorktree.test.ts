import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, Project, RemoveWorktreeCheck, WorkspaceSnapshot } from "../ipc";
import { useRemoveWorktreeStore } from "../state/removeWorktree";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { builtinCommands } from "./builtins";
import { closeOpenPane } from "./panes";
import {
  canRemoveWorktree,
  dirtyLine,
  discardLabel,
  discardReady,
  FORCE_CONFIRM_DELAY_MS,
  openRemoveWorktreeSheet,
  plannedCommands,
  removeBlockedReason,
  submitRemoveWorktree,
} from "./removeWorktree";

function project(): Project {
  return { id: "ide", path: "/p/ide", label: "ide", position: { x: 0, y: 0 }, expanded: true, color: null, launchDefaults: null, showBranches: true };
}

const WT = "B:\\r\\.worktrees\\feat";

function branchChild(name: string, worktree: { path: string; missing: boolean } | null): ChildNode {
  return {
    id: `ide:${name}`,
    projectId: "ide",
    kind: "branch",
    label: name,
    detail: null,
    position: null,
    session: null,
    branchId: null,
    forkedFrom: null,
    hasTranscript: false,
    branch: { head: false, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree },
  };
}

function snapshot(children: ChildNode[], revision = 1): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects: [project()],
      branches: [],
      sessions: [],
      edges: [],
      defaults: { model: null, effort: null, permissionMode: null },
    },
    banners: [],
    revision,
    branchErrors: {},
    children,
  };
}

function check(patch: Partial<RemoveWorktreeCheck> = {}): RemoveWorktreeCheck {
  return {
    branch: "feat",
    path: WT,
    missing: false,
    locked: false,
    dirty: 0,
    command: `git worktree remove ${WT}`,
    forceCommand: null,
    deleteCommand: "git branch -d feat",
    refusal: null,
    ...patch,
  };
}

const DIRTY = check({ dirty: 3, forceCommand: `git worktree remove --force ${WT}` });

function runtime(replies: Record<string, (args: Record<string, unknown>) => unknown>) {
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    const reply = replies[cmd];
    if (reply === undefined) throw new Error(`unexpected ${cmd}`);
    return reply(args);
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  return invoke;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const removes = (invoke: ReturnType<typeof runtime>) => invoke.mock.calls.filter(([cmd]) => cmd === "worktree_remove");

describe("the remove-worktree sheet", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      snapshot: snapshot([branchChild("main", null), branchChild("feat", { path: WT, missing: false }), branchChild("gone", { path: "B:\\x", missing: true })]),
      loadError: null,
    });
    useUiStore.setState({ pane: null, selection: { kind: "branch", id: "ide:feat" }, notice: null });
    useRemoveWorktreeStore.getState().reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("branch.removeWorktree: order 53, no key, offered on a card with a chip (a missing one too)", () => {
    const command = builtinCommands().find((c) => c.id === "branch.removeWorktree");
    expect(command).toMatchObject({ title: "Remove worktree…", menu: "node", menuOrder: 53 });
    expect(command?.keybinding).toBeUndefined();
    expect(canRemoveWorktree()).toBe(true);
    useUiStore.getState().select({ kind: "branch", id: "ide:gone" });
    expect(canRemoveWorktree()).toBe(true);
    useUiStore.getState().select({ kind: "branch", id: "ide:main" });
    expect(canRemoveWorktree()).toBe(false);
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(canRemoveWorktree()).toBe(false);
  });

  it("opens with Rust's checks and shows exactly Rust's commands; the delete box adds git branch -d", async () => {
    const invoke = runtime({ worktree_remove_preview: () => check() });
    await expect(openRemoveWorktreeSheet()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("worktree_remove_preview", { projectId: "ide", branch: "feat" }, undefined);
    expect(useUiStore.getState().pane).toBe("removeWorktree");
    const sheet = useRemoveWorktreeStore.getState();
    expect(sheet.deleteBranch).toBe(false);
    expect(plannedCommands(sheet)).toEqual([`git worktree remove ${WT}`]);
    expect(removeBlockedReason(sheet)).toBeNull();
    sheet.setDeleteBranch(true);
    expect(plannedCommands(useRemoveWorktreeStore.getState())).toEqual([`git worktree remove ${WT}`, "git branch -d feat"]);
    closeOpenPane();
    expect(useRemoveWorktreeStore.getState().projectId).toBeNull();
  });

  it("clean: one Remove click runs it, the sheet closes, the card keeps its place", async () => {
    const after = snapshot([branchChild("main", null), branchChild("feat", null)], 7);
    const invoke = runtime({
      worktree_remove_preview: () => check(),
      worktree_remove: () => ({ snapshot: after, branchDeleted: false, deleteError: null }),
    });
    await openRemoveWorktreeSheet();
    await expect(submitRemoveWorktree(true)).resolves.toBe(false);
    expect(removes(invoke)).toHaveLength(0);
    await expect(submitRemoveWorktree(false)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("worktree_remove", { projectId: "ide", branch: "feat", force: false, dirty: null, deleteBranch: false }, undefined);
    expect(useWorkspaceStore.getState().snapshot?.revision).toBe(7);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "branch", id: "ide:feat" });
  });

  it("dirty: Remove is replaced by Force remove…, and only the second, explicit click runs --force", async () => {
    const invoke = runtime({
      worktree_remove_preview: () => DIRTY,
      worktree_remove: () => ({ snapshot: snapshot([], 3), branchDeleted: false, deleteError: null }),
    });
    await openRemoveWorktreeSheet();
    expect(dirtyLine(3)).toBe("3 changed files (modified or untracked)");
    expect(dirtyLine(1)).toBe("1 changed file (modified or untracked)");
    expect(discardLabel(3)).toBe("Discard 3 changed files and remove");
    expect(plannedCommands(useRemoveWorktreeStore.getState())).toEqual([`git worktree remove ${WT}`]);
    // Neither a plain Remove nor a force before the first press sends anything.
    await expect(submitRemoveWorktree(false)).resolves.toBe(false);
    await expect(submitRemoveWorktree(true)).resolves.toBe(false);
    expect(removes(invoke)).toHaveLength(0);
    useRemoveWorktreeStore.getState().armForce(1000);
    expect(plannedCommands(useRemoveWorktreeStore.getState())).toEqual([`git worktree remove --force ${WT}`]);
    // A double-click's second click lands within the delay: nothing runs.
    expect(discardReady(useRemoveWorktreeStore.getState(), 1000 + FORCE_CONFIRM_DELAY_MS - 1)).toBe(false);
    await expect(submitRemoveWorktree(true, 1100)).resolves.toBe(false);
    expect(removes(invoke)).toHaveLength(0);
    // A second press of Force remove… does not restart or skip the delay.
    useRemoveWorktreeStore.getState().armForce(5000);
    expect(useRemoveWorktreeStore.getState().forceArmedAt).toBe(1000);
    await expect(submitRemoveWorktree(true, 1000 + FORCE_CONFIRM_DELAY_MS)).resolves.toBe(true);
    // The count the button stated travels with the force.
    expect(invoke).toHaveBeenCalledWith("worktree_remove", { projectId: "ide", branch: "feat", force: true, dirty: 3, deleteBranch: false }, undefined);
  });

  it("a refusal re-reads the checks and keeps the error: a sheet that showed clean now shows dirty", async () => {
    let current = check();
    const invoke = runtime({
      worktree_remove_preview: () => current,
      worktree_remove: () => {
        current = DIRTY;
        throw "3 changed files (modified or untracked)";
      },
    });
    await openRemoveWorktreeSheet();
    await expect(submitRemoveWorktree(false)).resolves.toBe(false);
    const sheet = useRemoveWorktreeStore.getState();
    expect(sheet.error).toBe("3 changed files (modified or untracked)");
    expect(sheet.check?.dirty).toBe(3);
    expect(sheet.removing).toBe(false);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "worktree_remove_preview")).toHaveLength(2);
    // A changed count takes back an armed force.
    useRemoveWorktreeStore.getState().armForce(0);
    useRemoveWorktreeStore.getState().applyCheck(useRemoveWorktreeStore.getState().opened, check({ dirty: 5, forceCommand: "x" }));
    expect(useRemoveWorktreeStore.getState().forceArmed).toBe(false);
  });

  it("a clean worktree cannot be armed for force", async () => {
    runtime({ worktree_remove_preview: () => check() });
    await openRemoveWorktreeSheet();
    useRemoveWorktreeStore.getState().armForce();
    expect(useRemoveWorktreeStore.getState().forceArmed).toBe(false);
  });

  it("locked or a live session: refused, nothing runs", async () => {
    for (const refusal of ["locked", "a session is running in this worktree: spike"]) {
      const invoke = runtime({ worktree_remove_preview: () => check({ locked: refusal === "locked", refusal }) });
      await openRemoveWorktreeSheet();
      const sheet = useRemoveWorktreeStore.getState();
      expect(removeBlockedReason(sheet)).toBe(refusal);
      expect(plannedCommands(sheet)).toEqual([]);
      await expect(submitRemoveWorktree(false)).resolves.toBe(false);
      expect(removes(invoke)).toHaveLength(0);
      closeOpenPane();
    }
  });

  it("missing: Remove runs git worktree remove for that folder", async () => {
    useUiStore.getState().select({ kind: "branch", id: "ide:gone" });
    const invoke = runtime({
      worktree_remove_preview: () => check({ branch: "gone", missing: true, command: "git worktree remove B:/x", deleteCommand: "git branch -d gone" }),
      worktree_remove: () => ({ snapshot: snapshot([], 4), branchDeleted: false, deleteError: null }),
    });
    await openRemoveWorktreeSheet();
    expect(plannedCommands(useRemoveWorktreeStore.getState())).toEqual(["git worktree remove B:/x"]);
    await expect(submitRemoveWorktree(false)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("worktree_remove", { projectId: "ide", branch: "gone", force: false, dirty: null, deleteBranch: false }, undefined);
  });

  it("git's error stays in the sheet; a refused branch delete keeps the sheet with git's message", async () => {
    let reply: () => unknown = () => {
      throw "error: failed to delete 'B:\\r\\.worktrees\\feat': Permission denied";
    };
    runtime({ worktree_remove_preview: () => check(), worktree_remove: () => reply() });
    await openRemoveWorktreeSheet();
    await expect(submitRemoveWorktree(false)).resolves.toBe(false);
    expect(useRemoveWorktreeStore.getState()).toMatchObject({ error: "error: failed to delete 'B:\\r\\.worktrees\\feat': Permission denied", removing: false });
    expect(useUiStore.getState().pane).toBe("removeWorktree");

    reply = () => ({ snapshot: snapshot([], 9), branchDeleted: false, deleteError: "error: the branch 'feat' is not fully merged." });
    useRemoveWorktreeStore.getState().setDeleteBranch(true);
    await expect(submitRemoveWorktree(false)).resolves.toBe(true);
    const sheet = useRemoveWorktreeStore.getState();
    expect(sheet).toMatchObject({ removed: true, error: "error: the branch 'feat' is not fully merged." });
    expect(removeBlockedReason(sheet)).toBe("removed");
    expect(useUiStore.getState().pane).toBe("removeWorktree");
    expect(useWorkspaceStore.getState().snapshot?.revision).toBe(9);
  });

  it("a deleted branch selects its project; a reply for a closed sheet is the notice", async () => {
    let answer: (value: unknown) => void = () => {};
    runtime({
      worktree_remove_preview: () => check(),
      worktree_remove: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    await openRemoveWorktreeSheet();
    useRemoveWorktreeStore.getState().setDeleteBranch(true);
    const pending = submitRemoveWorktree(false);
    await flush();
    answer({ snapshot: snapshot([branchChild("main", null)], 5), branchDeleted: true, deleteError: null });
    await expect(pending).resolves.toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });

    useUiStore.getState().select({ kind: "branch", id: "ide:feat" });
    useWorkspaceStore.setState({ snapshot: snapshot([branchChild("feat", { path: WT, missing: false })]) });
    runtime({
      worktree_remove_preview: () => check(),
      worktree_remove: () =>
        new Promise((_, reject) => {
          answer = reject;
        }),
    });
    await openRemoveWorktreeSheet();
    const late = submitRemoveWorktree(false);
    await flush();
    closeOpenPane();
    answer("fatal: busy");
    await expect(late).resolves.toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "fatal: busy" });
  });

  it("a preview that fails shows the reason and runs nothing", async () => {
    const invoke = runtime({
      worktree_remove_preview: () => {
        throw "this branch has no worktree";
      },
    });
    await openRemoveWorktreeSheet();
    expect(useRemoveWorktreeStore.getState().error).toBe("this branch has no worktree");
    expect(removeBlockedReason(useRemoveWorktreeStore.getState())).toBe("checking…");
    await expect(submitRemoveWorktree(false)).resolves.toBe(false);
    expect(removes(invoke)).toHaveLength(0);
  });
});
