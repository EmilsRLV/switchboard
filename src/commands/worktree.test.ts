import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, Project, WorkspaceSnapshot, WorktreePreview, WorktreeRequest } from "../ipc";
import { useStatusStore } from "../state/status";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { useWorktreeStore } from "../state/worktree";
import { closeOpenPane } from "./panes";
import {
  canNewWorktree,
  canNewWorktreeOnBranch,
  createBlockedReason,
  editWorktree,
  openWorktreeSheet,
  openWorktreeSheetForBranch,
  submitWorktree,
  worktreeRequest,
} from "./worktree";

function project(showBranches = false): Project {
  return { id: "ide", path: "/p/ide", label: "ide", position: { x: 0, y: 0 }, expanded: false, color: null, launchDefaults: null, showBranches };
}

function branchChild(name: string, opts: { head?: boolean; worktree?: string } = {}): ChildNode {
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
    branch: {
      head: opts.head ?? false,
      upstream: null,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
      worktree: opts.worktree === undefined ? null : { path: opts.worktree, missing: false },
    },
  };
}

function snapshot(children: ChildNode[] = [], showBranches = false, revision = 1): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects: [{ ...project(showBranches), expanded: showBranches }],
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

const ROOT = "B:\\r\\.worktrees";

/** Rust's preview as the fake runtime computes it (Rust owns the real one). */
function previewFor(request: WorktreeRequest): WorktreePreview {
  const options = { branches: ["main", "feat"], available: ["feat"], defaultBase: "main" };
  if (request.mode === "new" && request.branch === "") return { ...options, command: null, path: null, error: null };
  if (request.mode === "new" && request.branch === "main") return { ...options, command: null, path: null, error: "branch already exists: main" };
  const path = `${ROOT}\\${request.branch}`;
  const command =
    request.mode === "new" ? `git worktree add -b ${request.branch} ${path} ${request.base ?? "main"}` : `git worktree add ${path} ${request.branch}`;
  return { ...options, command, path, error: null };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A Tauri runtime whose commands answer from `replies` (a function rejects with its throw). */
function runtime(replies: Record<string, (args: Record<string, unknown>) => unknown>) {
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    const reply = replies[cmd];
    if (reply === undefined) throw new Error(`unexpected ${cmd}`);
    return reply(args);
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  return invoke;
}

const preview = (args: Record<string, unknown>) => previewFor(args.request as WorktreeRequest);

describe("the worktree sheet commands", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ snapshot: snapshot([branchChild("main", { head: true }), branchChild("feat")], true), loadError: null });
    useUiStore.setState({ pane: null, selection: { kind: "project", id: "ide" }, notice: null, showAll: [], showAllBranches: [] });
    useStatusStore.setState({ statuses: { ide: { kind: "repo", branch: "main", detached: false, dirty: 0, ahead: 0, behind: 0 } } });
    useWorktreeStore.getState().reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("project.newWorktree is enabled for a repo only; branch.newWorktree for a card without a chip that is not checked out", () => {
    expect(canNewWorktree()).toBe(true);
    useStatusStore.setState({ statuses: { ide: { kind: "not_repo" } } });
    expect(canNewWorktree()).toBe(false);
    useStatusStore.setState({ statuses: {} });
    expect(canNewWorktree()).toBe(false);

    expect(canNewWorktreeOnBranch()).toBe(false);
    useUiStore.getState().select({ kind: "branch", id: "ide:feat" });
    expect(canNewWorktreeOnBranch()).toBe(true);
    useUiStore.getState().select({ kind: "branch", id: "ide:main" });
    expect(canNewWorktreeOnBranch()).toBe(false);
    useWorkspaceStore.setState({ snapshot: snapshot([branchChild("feat", { worktree: "/r/.worktrees/feat" })], true) });
    useUiStore.getState().select({ kind: "branch", id: "ide:feat" });
    expect(canNewWorktreeOnBranch()).toBe(false);
  });

  it("opens in New branch mode with Rust's preview; the base follows Rust's default", async () => {
    const invoke = runtime({ worktree_preview: preview });
    await expect(openWorktreeSheet("ide")).resolves.toBe(true);
    expect(useUiStore.getState().pane).toBe("worktree");
    expect(invoke).toHaveBeenCalledWith("worktree_preview", { projectId: "ide", request: { mode: "new", branch: "", base: null } }, undefined);
    const sheet = useWorktreeStore.getState();
    expect(sheet.form).toEqual({ mode: "new", name: "", base: "main", branch: "" });
    expect(sheet.preview?.command).toBeNull();
    expect(createBlockedReason(sheet)).toBe("Create needs a branch name");
    await expect(openWorktreeSheet("nope")).resolves.toBe(false);
  });

  it("the preview updates as the operator types and is exactly Rust's text", async () => {
    runtime({ worktree_preview: preview });
    await openWorktreeSheet("ide");
    await editWorktree({ name: "auth-refresh" });
    const sheet = useWorktreeStore.getState();
    expect(sheet.preview?.command).toBe(`git worktree add -b auth-refresh ${ROOT}\\auth-refresh main`);
    expect(createBlockedReason(sheet)).toBeNull();
    await editWorktree({ name: "main" });
    expect(useWorktreeStore.getState().preview?.error).toBe("branch already exists: main");
    expect(createBlockedReason(useWorktreeStore.getState())).toBe("Nothing would run: see below");
  });

  it("drops a preview reply that a newer request overtook", async () => {
    const answers: Array<(value: unknown) => void> = [];
    const requests: WorktreeRequest[] = [];
    runtime({
      worktree_preview: (args) =>
        new Promise((resolve) => {
          requests.push(args.request as WorktreeRequest);
          answers.push(resolve);
        }),
    });
    const opening = openWorktreeSheet("ide");
    await flush();
    answers[0]!(previewFor(requests[0]!));
    await opening;
    const first = editWorktree({ name: "a" });
    const second = editWorktree({ name: "ab" });
    await flush();
    answers[2]!(previewFor(requests[2]!));
    await second;
    answers[1]!(previewFor(requests[1]!));
    await first;
    expect(useWorktreeStore.getState().preview?.command).toContain("-b ab ");
  });

  it("switching to Existing branch picks the first free one; branch.newWorktree preselects its branch", async () => {
    runtime({ worktree_preview: preview });
    await openWorktreeSheet("ide");
    await editWorktree({ mode: "existing" });
    expect(useWorktreeStore.getState().form?.branch).toBe("feat");
    expect(useWorktreeStore.getState().preview?.command).toBe(`git worktree add ${ROOT}\\feat feat`);
    expect(worktreeRequest(useWorktreeStore.getState().form!)).toEqual({ mode: "existing", branch: "feat", base: null });

    closeOpenPane();
    expect(useWorktreeStore.getState().form).toBeNull();
    useUiStore.getState().select({ kind: "branch", id: "ide:feat" });
    await expect(openWorktreeSheetForBranch()).resolves.toBe(true);
    expect(useWorktreeStore.getState().form).toMatchObject({ mode: "existing", branch: "feat" });
  });

  it("a submit applies the snapshot, closes the sheet and selects the new branch card", async () => {
    const after = snapshot([branchChild("main", { head: true }), branchChild("feat"), branchChild("auth-refresh", { worktree: `${ROOT}\\auth-refresh` })], true, 5);
    const invoke = runtime({ worktree_preview: preview, worktree_add: () => ({ snapshot: after, branchId: "ide:auth-refresh" }) });
    await openWorktreeSheet("ide");
    await editWorktree({ name: " auth-refresh " });
    await expect(submitWorktree()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("worktree_add", { projectId: "ide", request: { mode: "new", branch: "auth-refresh", base: "main" } }, undefined);
    expect(useWorkspaceStore.getState().snapshot?.revision).toBe(5);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useWorktreeStore.getState().form).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "branch", id: "ide:auth-refresh" });
  });

  it("a new card past the branch group's limit turns its show-all on", async () => {
    const many = Array.from({ length: 12 }, (_, i) => branchChild(`b${i}`));
    runtime({ worktree_preview: preview, worktree_add: () => ({ snapshot: snapshot(many, true, 9), branchId: "ide:b11" }) });
    await openWorktreeSheet("ide");
    await editWorktree({ name: "b11" });
    await submitWorktree();
    expect(useUiStore.getState().showAllBranches).toEqual(["ide"]);
  });

  it("a refusal or git's error stays in the sheet; a blocked form sends nothing", async () => {
    const invoke = runtime({
      worktree_preview: preview,
      worktree_add: () => {
        throw "fatal: 'B:\\r\\.worktrees\\x' already exists";
      },
    });
    await openWorktreeSheet("ide");
    await expect(submitWorktree()).resolves.toBe(false);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "worktree_add")).toHaveLength(0);
    await editWorktree({ name: "x" });
    await expect(submitWorktree()).resolves.toBe(false);
    expect(useUiStore.getState().pane).toBe("worktree");
    expect(useWorktreeStore.getState()).toMatchObject({ error: "fatal: 'B:\\r\\.worktrees\\x' already exists", creating: false });
    await editWorktree({ name: "y" });
    expect(useWorktreeStore.getState().error).toBeNull();
  });

  it("a preview that fails (not a repository) shows the reason and blocks Create", async () => {
    runtime({
      worktree_preview: () => {
        throw "not a git repository";
      },
    });
    await openWorktreeSheet("ide");
    expect(useWorktreeStore.getState().preview?.error).toBe("not a git repository");
    expect(createBlockedReason(useWorktreeStore.getState())).not.toBeNull();
  });

  it("Create waits for the latest edit's preview: Enter right after typing sends nothing", async () => {
    let answer: (value: unknown) => void = () => {};
    let pending: WorktreeRequest | null = null;
    const invoke = runtime({
      worktree_preview: (args) => {
        const request = args.request as WorktreeRequest;
        if (request.branch !== "late") return previewFor(request);
        pending = request;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      worktree_add: () => ({ snapshot: snapshot([], true, 7), branchId: "ide:late" }),
    });
    await openWorktreeSheet("ide");
    await editWorktree({ name: "early" });
    expect(createBlockedReason(useWorktreeStore.getState())).toBeNull();
    const typing = editWorktree({ name: "late" });
    await flush();
    // The shown command is still "early"'s: Create must not run "late" yet.
    expect(useWorktreeStore.getState().preview?.command).toContain("-b early ");
    expect(createBlockedReason(useWorktreeStore.getState())).toBe("checking…");
    await expect(submitWorktree()).resolves.toBe(false);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "worktree_add")).toHaveLength(0);
    answer(previewFor(pending!));
    await typing;
    expect(createBlockedReason(useWorktreeStore.getState())).toBeNull();
    await expect(submitWorktree()).resolves.toBe(true);
  });

  it("a failed preview after a good one clears the shown command and blocks Create", async () => {
    runtime({
      worktree_preview: (args) => {
        const request = args.request as WorktreeRequest;
        if (request.branch === "boom") throw "git unavailable";
        return previewFor(request);
      },
    });
    await openWorktreeSheet("ide");
    await editWorktree({ name: "good" });
    expect(useWorktreeStore.getState().preview?.command).not.toBeNull();
    await editWorktree({ name: "boom" });
    const sheet = useWorktreeStore.getState();
    expect(sheet.preview?.command).toBeNull();
    expect(sheet.preview?.error).toBe("git unavailable");
    expect(sheet.preview?.branches).toEqual(["main", "feat"]);
    expect(createBlockedReason(sheet)).toBe("Nothing would run: see below");
    await expect(submitWorktree()).resolves.toBe(false);
  });

  it("switching to Existing before the options arrive picks the first free branch once they do", async () => {
    let answer: (value: unknown) => void = () => {};
    let first = true;
    const requests: WorktreeRequest[] = [];
    runtime({
      worktree_preview: (args) => {
        requests.push(args.request as WorktreeRequest);
        if (!first) return previewFor(args.request as WorktreeRequest);
        first = false;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    const opening = openWorktreeSheet("ide");
    await flush();
    // No preview yet: switching leaves the branch unpicked.
    const switching = editWorktree({ mode: "existing" });
    expect(useWorktreeStore.getState().form?.branch).toBe("");
    answer(previewFor(requests[0]!));
    await opening;
    await switching;
    await flush();
    const sheet = useWorktreeStore.getState();
    expect(sheet.form).toMatchObject({ mode: "existing", branch: "feat" });
    expect(sheet.preview?.command).toBe(`git worktree add ${ROOT}\\feat feat`);
    expect(requests.at(-1)).toEqual({ mode: "existing", branch: "feat", base: null });
    expect(createBlockedReason(sheet)).toBeNull();
  });
});
