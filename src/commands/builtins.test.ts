import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, LiveSession, LiveSnapshot, Position, Project, SessionState, SettingsSnapshot, Viewport, WorkspaceSnapshot } from "../ipc";
import { useCanvasStore, type CanvasInstance } from "../state/canvas";
import { useImportStore } from "../state/import";
import { useLaunchStore } from "../state/launch";
import { useTerminalStore } from "../state/terminals";
import { EMPTY_LIVE, unmarkAcknowledging, useLiveStore } from "../state/live";
import { usePaletteStore } from "../state/palette";
import { useSettingsStore } from "../state/settings";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { chevronCommandId } from "../canvas/nodes";
import { builtinCommands, registerBuiltins } from "./builtins";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { menuGroup, nodeMenuCommands } from "./nodes";
import { copySelectedBranchName } from "./navigation";
import { useStatusStore } from "../state/status";
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
    useUiStore.setState({ pane: null, flashed: [], selection: null, contextMenu: null, notice: null, showAll: [], showAllBranches: [], elsewhereOpen: false, activeTerminal: null, openTerminals: [], poppedOut: {} });
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
    useImportStore.getState().reset();
    useCanvasStore.setState({ instance: null, element: null, dragging: {} });
    useTerminalStore.setState({ infos: {}, pendingExits: {} });
    registerBuiltins();
  });
  afterEach(() => {
    clearCommands();
    vi.useRealTimers();
  });

  it("have unique ids (a duplicate in one build is a failure)", () => {
    const ids = builtinCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("register the sixty-one commands with the spec's keybindings", () => {
    expect(listCommands().map((c) => c.id).sort()).toEqual([
      "agentActions.allowAll",
      "agentActions.ask",
      "app.quit",
      "approval.allow",
      "approval.deny",
      "attention.next",
      "binaries.redetect",
      "branch.copyName",
      "branch.newSession",
      "branch.newWorktree",
      "branch.removeWorktree",
      "canvas.fitView",
      "contextMenu.close",
      "edge.delete",
      "edge.inspect",
      "edge.link",
      "edge.restartWithFlags",
      "edge.retry",
      "edge.revokeAgentPolicy",
      "edge.select",
      "elsewhere.close",
      "elsewhere.toggle",
      "palette.close",
      "palette.toggle",
      "palette.toggleFromTerminal",
      "pane.close",
      "project.add",
      "project.collapse",
      "project.expand",
      "project.import",
      "project.newSession",
      "project.newWorktree",
      "project.openEditor",
      "project.openFolder",
      "project.relayout",
      "project.remove",
      "project.revealClaudeDir",
      "project.terminal",
      "project.toggleBranches",
      "project.toggleShowAll",
      "selection.activate",
      "selection.clear",
      "selection.move.down",
      "selection.move.left",
      "selection.move.right",
      "selection.move.up",
      "session.attach",
      "session.fork",
      "session.resume",
      "session.showTerminal",
      "session.stop",
      "settings.open",
      "settings.reveal",
      "settings.toggle",
      "terminal.close",
      "terminal.kill",
      "terminal.nextTab",
      "terminal.popOut",
      "terminal.prevTab",
      "terminal.restart",
      "terminal.toggle",
    ]);
    expect(getCommand("elsewhere.close")?.keybinding).toBe("escape");
    expect(getCommand("elsewhere.toggle")?.keybinding).toBeUndefined();
    expect(getCommand("session.attach")?.keybinding).toBeUndefined();
    expect(getCommand("selection.move.left")?.keybinding).toBe("arrowleft");
    expect(getCommand("selection.move.right")?.keybinding).toBe("arrowright");
    expect(getCommand("selection.move.up")?.keybinding).toBe("arrowup");
    expect(getCommand("selection.move.down")?.keybinding).toBe("arrowdown");
    expect(getCommand("selection.activate")?.keybinding).toBe("enter");
    for (const id of [
      "project.terminal",
      "project.openEditor",
      "project.openFolder",
      "project.revealClaudeDir",
      "project.remove",
      "session.showTerminal",
      "session.resume",
      "session.fork",
      "session.stop",
      "project.newWorktree",
      "branch.newWorktree",
      "branch.removeWorktree",
    ]) {
      expect(getCommand(id)?.keybinding, id).toBeUndefined();
    }
    // `n` opens the launch sheet (Story 4.2); `/` stays unbound. Story 6.1: `e` links, Delete
    // deletes the selected edge (and does nothing otherwise).
    expect(getCommand("project.newSession")?.keybinding).toBe("n");
    // `n` on a branch card too (Story 5.3): the two `when`s never both hold.
    expect(getCommand("branch.newSession")?.keybinding).toBe("n");
    expect(getCommand("edge.link")?.keybinding).toBe("e");
    expect(getCommand("edge.link")?.title).toBe("Link to…");
    expect(getCommand("edge.delete")?.keybinding).toBe("delete");
    expect(getCommand("edge.inspect")?.keybinding).toBeUndefined();
    expect(listCommands().map((c) => c.keybinding)).not.toContain("/");
    expect(getCommand("palette.toggle")?.keybinding).toBe("ctrl+k");
    expect(getCommand("palette.toggleFromTerminal")?.keybinding).toBe("ctrl+shift+k");
    expect(getCommand("palette.toggleFromTerminal")?.hidden).toBe(true);
    expect(getCommand("terminal.toggle")?.keybinding).toBe("ctrl+`");
    expect(getCommand("terminal.kill")?.keybinding).toBeUndefined();
    expect(getCommand("terminal.restart")?.keybinding).toBeUndefined();
    // Story 4.5: the tab keys; pop out is a palette command and a header button, no key.
    expect(getCommand("terminal.nextTab")?.keybinding).toBe("ctrl+pagedown");
    expect(getCommand("terminal.prevTab")?.keybinding).toBe("ctrl+pageup");
    expect(getCommand("terminal.popOut")?.keybinding).toBeUndefined();
    expect(getCommand("terminal.popOut")?.title).toBe("Pop out terminal");
    expect(getCommand("settings.toggle")?.keybinding).toBe("ctrl+,");
    expect(getCommand("settings.open")?.keybinding).toBeUndefined();
    expect(getCommand("app.quit")?.keybinding).toBe("ctrl+q");
    expect(getCommand("canvas.fitView")?.keybinding).toBe("ctrl+0");
    expect(getCommand("project.add")?.keybinding).toBe("ctrl+o");
    expect(getCommand("attention.next")?.keybinding).toBe("ctrl+j");
    expect(getCommand("attention.next")?.title).toBe("Go to session that needs you");
    expect(getCommand("project.import")?.keybinding).toBeUndefined();
    expect(getCommand("palette.close")?.keybinding).toBe("escape");
    expect(getCommand("pane.close")?.keybinding).toBe("escape");
    expect(getCommand("contextMenu.close")?.keybinding).toBe("escape");
    expect(getCommand("selection.clear")?.keybinding).toBe("escape");
    expect(getCommand("project.expand")?.keybinding).toBeUndefined();
    expect(getCommand("project.collapse")?.keybinding).toBeUndefined();
    expect(getCommand("project.relayout")?.keybinding).toBeUndefined();
  });

  it("the key-only carriers are hidden from the palette, the forty-nine actions are not", () => {
    expect(listCommands({ visibleOnly: true }).map((c) => c.id).sort()).toEqual([
      "agentActions.allowAll",
      "agentActions.ask",
      "app.quit",
      "approval.allow",
      "approval.deny",
      "attention.next",
      "binaries.redetect",
      "branch.copyName",
      "branch.newSession",
      "branch.newWorktree",
      "branch.removeWorktree",
      "canvas.fitView",
      "edge.delete",
      "edge.inspect",
      "edge.link",
      "edge.restartWithFlags",
      "edge.retry",
      "edge.revokeAgentPolicy",
      "edge.select",
      "elsewhere.toggle",
      "palette.toggle",
      "project.add",
      "project.collapse",
      "project.expand",
      "project.import",
      "project.newSession",
      "project.newWorktree",
      "project.openEditor",
      "project.openFolder",
      "project.relayout",
      "project.remove",
      "project.revealClaudeDir",
      "project.terminal",
      "project.toggleBranches",
      "project.toggleShowAll",
      "session.attach",
      "session.fork",
      "session.resume",
      "session.showTerminal",
      "session.stop",
      "settings.open",
      "settings.reveal",
      "terminal.close",
      "terminal.kill",
      "terminal.nextTab",
      "terminal.popOut",
      "terminal.prevTab",
      "terminal.restart",
      "terminal.toggle",
    ]);
  });

  it("exactly the twelve project commands, the five session commands, the four branch commands, Link to… and Select edge… are tagged for the node menu, and the menu lists none without a selection", () => {
    expect(
      listCommands()
        .filter((c) => c.menu === "node")
        .map((c) => c.id)
        .sort(),
    ).toEqual([
      "branch.copyName",
      "branch.newSession",
      "branch.newWorktree",
      "branch.removeWorktree",
      "edge.link",
      "edge.select",
      "project.collapse",
      "project.expand",
      "project.newSession",
      "project.newWorktree",
      "project.openEditor",
      "project.openFolder",
      "project.relayout",
      "project.remove",
      "project.revealClaudeDir",
      "project.terminal",
      "project.toggleBranches",
      "project.toggleShowAll",
      "session.attach",
      "session.fork",
      "session.resume",
      "session.showTerminal",
      "session.stop",
    ]);
    expect(nodeMenuCommands()).toEqual([]);
  });

  it("registering twice replaces rather than duplicates", () => {
    registerBuiltins();
    expect(listCommands()).toHaveLength(61);
  });

  const PROJECT_ACTIONS = [
    "project.newSession",
    "project.terminal",
    "project.openEditor",
    "project.openFolder",
    "project.revealClaudeDir",
    "project.relayout",
    "project.remove",
  ];

  it("the project commands are hidden and inert with nothing selected, and with a child selected", () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    for (const id of ["project.expand", "project.collapse", ...PROJECT_ACTIONS]) {
      expect(listCommands({ enabledOnly: true }).map((c) => c.id), id).not.toContain(id);
      expect(runCommand(id), id).toBe(false);
    }
    useUiStore.getState().select({ kind: "session", id: "stub-1-ide" });
    for (const id of PROJECT_ACTIONS) {
      expect(listCommands({ enabledOnly: true }).map((c) => c.id), id).not.toContain(id);
    }
    // A historic session's menu holds only Link to… (Story 6.1).
    expect(nodeMenuCommands().map((c) => c.id)).toEqual(["edge.link"]);
  });

  it("with a project selected the palette lists the six actions by title, Re-layout and exactly one of Expand/Collapse", () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    const titles = () => listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.title);
    expect(titles()).toEqual([
      "Agent actions: allow all",
      "Expand project",
      "Link to…",
      "New session…",
      "Open in external editor",
      "Open in file manager",
      "Open settings",
      "Plain terminal…",
      "Quit",
      "Re-detect binaries",
      "Re-layout children",
      "Remove from canvas",
      "Reveal Claude project dir",
      "Toggle command palette",
    ]);
    expect(nodeMenuCommands().map((c) => c.title)).toEqual([
      "New session…",
      "Plain terminal…",
      "Link to…",
      "Open in external editor",
      "Open in file manager",
      "Reveal Claude project dir",
      "Expand project",
      "Re-layout children",
      "Remove from canvas",
    ]);

    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], stubs(3)) });
    expect(titles()).toContain("Collapse project");
    expect(titles()).not.toContain("Expand project");
    expect(nodeMenuCommands().map((c) => c.title)).toEqual([
      "New session…",
      "Plain terminal…",
      "Link to…",
      "Open in external editor",
      "Open in file manager",
      "Reveal Claude project dir",
      "Collapse project",
      "Re-layout children",
      "Remove from canvas",
    ]);
  });

  it("Show all sessions is offered only for a selected expanded project with more than ten children, and toggles it", () => {
    const enabled = () => listCommands({ enabledOnly: true }).map((c) => c.id);
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], stubs(11)) });
    expect(enabled()).not.toContain("project.toggleShowAll");
    expect(runCommand("project.toggleShowAll")).toBe(false);

    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(enabled()).toContain("project.toggleShowAll");
    expect(nodeMenuCommands().map((c) => [c.title, c.menuOrder])).toContainEqual(["Show all sessions", 32]);
    expect(runCommand("project.toggleShowAll")).toBe(true);
    expect(useUiStore.getState().showAll).toEqual(["ide"]);
    expect(runCommand("project.toggleShowAll")).toBe(true);
    expect(useUiStore.getState().showAll).toEqual([]);

    // Collapsed, or ten or fewer: not offered. Dragged children still count toward the total.
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(11)) });
    expect(enabled()).not.toContain("project.toggleShowAll");
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], stubs(10)) });
    expect(enabled()).not.toContain("project.toggleShowAll");
    const dragged = stubs(11).map((c, i) => (i === 0 ? { ...c, position: { x: 400, y: 0 } } : c));
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], dragged) });
    expect(enabled()).toContain("project.toggleShowAll");
    // A child selected: not offered either.
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], stubs(11)) });
    useUiStore.getState().select({ kind: "session", id: "stub-1-ide" });
    expect(enabled()).not.toContain("project.toggleShowAll");
  });

  it("Show all sessions counts sessions only and toggles the session group only, with branches present", () => {
    const enabled = () => listCommands({ enabledOnly: true }).map((c) => c.id);
    const branchKids = (count: number): ChildNode[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `ide:b${i}`,
        projectId: "ide",
        kind: "branch" as const,
        label: `b${i}`,
        detail: null,
        position: null,
        session: null,
        branchId: null,
        forkedFrom: null,
        hasTranscript: false,
        branch: { head: false, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: null },
      }));
    const project = { ...ideProject(true), showBranches: true };
    useUiStore.getState().select({ kind: "project", id: "ide" });
    // 5 sessions and 10 branches (15 children): neither group passes ten, not offered.
    useWorkspaceStore.setState({ snapshot: workspaceWith([project], [...stubs(5), ...branchKids(10)]) });
    expect(enabled()).not.toContain("project.toggleShowAll");
    // 11 sessions and 12 branches: offered, and it toggles the sessions only.
    useWorkspaceStore.setState({ snapshot: workspaceWith([project], [...stubs(11), ...branchKids(12)]) });
    expect(enabled()).toContain("project.toggleShowAll");
    expect(runCommand("project.toggleShowAll")).toBe(true);
    expect(useUiStore.getState().showAll).toEqual(["ide"]);
    expect(useUiStore.getState().showAllBranches).toEqual([]);
  });

  it("the menu's fixed order has a separator wherever the tens digit of menuOrder changes", () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    const items = nodeMenuCommands();
    expect(items.map((c) => c.menuOrder)).toEqual([10, 11, 13, 20, 21, 22, 30, 31, 40]);
    const separatorBefore = items.map((item, index) => {
      const previous = items[index - 1];
      return previous !== undefined && menuGroup(previous) !== menuGroup(item);
    });
    expect(separatorBefore).toEqual([false, false, false, true, false, false, true, false, true]);
    // The palette keeps its title order regardless.
    const titles = listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });

  it("n on a project opens the launch sheet with Rust's prefill; on a session or branch it does nothing", async () => {
    const prefill = { name: "ide-3f2a", model: "opus", effort: "high", permissionMode: "plan" };
    const invoke = vi.fn().mockResolvedValue(prefill);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], stubs(3)) });

    useUiStore.getState().select({ kind: "session", id: "stub-1-ide" });
    expect(handleKeydown(key("n"))).toBe(false);
    expect(invoke).not.toHaveBeenCalled();

    useUiStore.getState().select({ kind: "project", id: "ide" });
    // A bare key typed on a select is the select's; with the context menu open it is the menu's.
    expect(handleKeydown(key("n", { target: { tagName: "SELECT" } }))).toBe(false);
    useUiStore.getState().openContextMenu({ x: 1, y: 1 });
    expect(handleKeydown(key("n"))).toBe(false);
    useUiStore.getState().closeContextMenu();
    expect(invoke).not.toHaveBeenCalled();
    expect(handleKeydown(key("n"))).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("launch_defaults", { projectId: "ide" }, undefined);
    expect(useUiStore.getState().pane).toBe("launch");
    const sheet = useLaunchStore.getState();
    expect(sheet.projectId).toBe("ide");
    expect(sheet.form).toMatchObject({ name: "ide-3f2a", model: "opus", effort: "high", permissionMode: "plan", addDirs: [], prompt: "", background: false });
    // Open: `n` (typed on one of the sheet's selects) does not reset it.
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("project.newSession");
    // Esc closes it and the form goes.
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useLaunchStore.getState().form).toBeNull();
    vi.unstubAllGlobals();
  });

  it("New session… without a runtime is a notice and no sheet", async () => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(runCommand("project.newSession")).toBe(true);
    await flush();
    expect(useUiStore.getState().notice?.text).toMatch(/cannot invoke "launch_defaults"/);
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("Show terminal is offered for a session Switchboard runs, and Attach then is not", async () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], stubs(3)) });
    useLiveStore.getState().applySnapshot(liveSnapshot({ "stub-1-ide": { kind: "starting" }, "stub-2-ide": { kind: "busy" } }));
    const enabled = () => listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.id);
    useTerminalStore.getState().upsert({
      id: "session:stub-1-ide",
      kind: "session",
      project_id: "ide",
      title: "ide-stub",
      cwd: "/p/ide",
      exited: null,
      error: null,
      cols: 80,
      rows: 24,
      stopping: false,
    });
    useUiStore.getState().select({ kind: "session", id: "stub-1-ide" });
    expect(enabled()).toContain("session.showTerminal");
    expect(enabled()).not.toContain("session.attach");
    // It runs in a Switchboard terminal: Stop too (no transcript yet: no Resume or Fork).
    expect(nodeMenuCommands().map((c) => [c.title, c.menuOrder])).toEqual([
      ["Show terminal", 9],
      ["Stop", 12],
      ["Link to…", 13],
    ]);
    expect(runCommand("session.showTerminal")).toBe(true);
    await flush();
    expect(useUiStore.getState().pane).toBe("terminal");
    expect(useUiStore.getState().activeTerminal).toBe("session:stub-1-ide");

    useUiStore.getState().select({ kind: "session", id: "stub-2-ide" });
    expect(enabled()).not.toContain("session.showTerminal");
    expect(enabled()).toContain("session.attach");
    useTerminalStore.getState().remove(["session:stub-1-ide"]);
    useUiStore.setState({ pane: null, activeTerminal: null });
  });

  it("the three open actions reach their wire names and a failure is a notice, not a banner", async () => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    for (const [id, wire] of [
      ["project.openEditor", "project_open_editor"],
      ["project.openFolder", "project_open_folder"],
      ["project.revealClaudeDir", "project_reveal_claude_dir"],
    ] as const) {
      expect(runCommand(id)).toBe(true);
      await flush();
      // No Tauri runtime in vitest: the cause names the wire name.
      expect(useUiStore.getState().notice?.text, id).toMatch(new RegExp(`no Tauri runtime: cannot invoke "${wire}"`));
      expect(useWorkspaceStore.getState().loadError).toBeNull();
    }
    vi.advanceTimersByTime(3000);
    expect(useUiStore.getState().notice).toBeNull();
  });

  it("Remove from canvas reaches its wire name and a failure is the workspace.load banner", async () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(runCommand("project.remove")).toBe(true);
    await flush();
    expect(useWorkspaceStore.getState().loadError).toMatch(/remove failed: .*cannot invoke "workspace_remove_project"/);
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });
    expect(useUiStore.getState().notice).toBeNull();
  });

  it("the arrows move the selection through the dispatcher and are inert while the palette, a pane or the menu is open", () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true), ideProject(false, "projects")], stubs(3)) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    useWorkspaceStore.setState({
      snapshot: workspaceWith([{ ...ideProject(true), position: { x: 80, y: 80 } }, { ...ideProject(false, "projects"), position: { x: 480, y: 80 } }], stubs(3)),
    });

    expect(handleKeydown(key("ArrowRight"))).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "projects" });
    expect(handleKeydown(key("ArrowLeft"))).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });
    expect(handleKeydown(key("ArrowDown"))).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "stub-1-ide" });
    expect(handleKeydown(key("ArrowUp"))).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });

    const enabledArrows = () =>
      listCommands({ enabledOnly: true })
        .filter((c) => c.id.startsWith("selection.move."))
        .map((c) => c.id);
    expect(enabledArrows()).toHaveLength(4);
    usePaletteStore.getState().open();
    expect(enabledArrows()).toEqual([]);
    expect(handleKeydown(key("ArrowRight"))).toBe(false);
    usePaletteStore.getState().close();

    useUiStore.getState().openPane("import");
    expect(enabledArrows()).toEqual([]);
    expect(handleKeydown(key("ArrowRight"))).toBe(false);
    useUiStore.getState().closePane();

    useUiStore.getState().openContextMenu({ x: 1, y: 1 });
    expect(enabledArrows()).toEqual([]);
    expect(handleKeydown(key("ArrowRight"))).toBe(false);
    expect(handleKeydown(key("Enter"))).toBe(false);
    useUiStore.getState().closeContextMenu();
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "ide" });

    // Arrows pass through editable targets too (the surfaces' `when`s are what keep them off).
    expect(handleKeydown(key("ArrowRight", { target: { tagName: "INPUT" } }))).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "projects" });
  });

  it("an Enter the context menu already handled (preventDefault + close) does not reach selection.activate; Escape still does", async () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    useUiStore.getState().openContextMenu({ x: 1, y: 1 });
    // What ContextMenu's onKeyDown does with Enter: preventDefault, run, close (synchronously).
    const enter = { ...key("Enter"), defaultPrevented: false };
    enter.preventDefault = () => {
      enter.defaultPrevented = true;
    };
    enter.preventDefault();
    useUiStore.getState().closeContextMenu();
    expect(handleKeydown(enter)).toBe(false);
    await flush();
    expect(useWorkspaceStore.getState().loadError).toBeNull();

    // Escape is not preventDefault-ed by the surfaces and still reaches the dispatcher.
    useUiStore.getState().openContextMenu({ x: 1, y: 1 });
    expect(handleKeydown({ ...key("Escape"), defaultPrevented: false })).toBe(true);
    expect(useUiStore.getState().contextMenu).toBeNull();
  });

  it("Enter toggles the selected project with children, is inert for a childless one and without a selection", async () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false), ideProject(false, "projects")], stubs(3)) });
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("selection.activate");
    expect(handleKeydown(key("Enter"))).toBe(false);

    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(handleKeydown(key("Enter"))).toBe(true);
    await flush();
    expect(useWorkspaceStore.getState().loadError).toMatch(/expand failed: .*cannot invoke "workspace_set_expanded"/);
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true), ideProject(false, "projects")], stubs(3)), loadError: null });
    expect(handleKeydown(key("Enter"))).toBe(true);
    await flush();
    expect(useWorkspaceStore.getState().loadError).toMatch(/collapse failed: .*cannot invoke "workspace_set_expanded"/);

    // Childless: the key is still the selection's (consumed), but nothing is sent.
    useWorkspaceStore.setState({ loadError: null });
    useUiStore.getState().select({ kind: "project", id: "projects" });
    expect(handleKeydown(key("Enter"))).toBe(true);
    await flush();
    expect(useWorkspaceStore.getState().loadError).toBeNull();
    useUiStore.getState().select({ kind: "session", id: "stub-1-ide" });
    expect(handleKeydown(key("Enter"))).toBe(true);
    await flush();
    expect(useWorkspaceStore.getState().loadError).toBeNull();
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
  // -- live sessions (Story 3.2) ---------------------------------------------------------

  function liveSnapshot(states: Record<string, SessionState>, elsewhere = 0): LiveSnapshot {
    const sessions: Record<string, LiveSession> = {};
    for (const [id, state] of Object.entries(states)) {
      sessions[id] = { state, source: "poll", pid: 1, kind: "interactive", name: id, project_id: "ide", cwd: "/p/ide", started_at: 1, attention_since: null, last_line: null, detail: null };
    }
    const rows = Array.from({ length: elsewhere }, (_, i) => ({
      session_id: `e${i}`,
      state: { kind: "idle" } as SessionState,
      name: `e${i}`,
      cwd: `/work/other${i}`,
      started_at: 1,
    }));
    return { sessions, elsewhere: rows, banner: null };
  }

  it("ctrl+j goes to the session that has needed you longest, and is disabled when none does", async () => {
    const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "workspace_set_expanded") {
        const current = useWorkspaceStore.getState().snapshot!;
        return { ...current, revision: current.revision + 1, workspace: { ...current.workspace, projects: [ideProject(args.expanded as boolean)] } };
      }
      // session_acknowledge: the session turns idle; the reply is the new snapshot.
      const snap = useLiveStore.getState().snapshot;
      const id = args.sessionId as string;
      return { ...snap, sessions: { ...snap.sessions, [id]: { ...snap.sessions[id]!, state: { kind: "idle" }, source: "ack", attention_since: null } } };
    });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(2)) });
    useLiveStore.getState().applySnapshot(liveSnapshot({ "stub-1-ide": { kind: "busy" } }));
    expect(getCommand("attention.next")?.when?.()).toBe(false);
    expect(handleKeydown(key("j", { ctrlKey: true }))).toBe(false);

    const snap = liveSnapshot({ "stub-1-ide": { kind: "finished" }, "stub-2-ide": { kind: "finished" } });
    snap.sessions["stub-1-ide"]!.attention_since = 20;
    snap.sessions["stub-2-ide"]!.attention_since = 10;
    useLiveStore.getState().applySnapshot(snap);
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).toContain("attention.next");
    expect(handleKeydown(key("j", { ctrlKey: true }))).toBe(true);
    await flush();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "stub-2-ide" });
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects[0]?.expanded).toBe(true);
    expect(handleKeydown(key("j", { ctrlKey: true }))).toBe(true);
    await flush();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "stub-1-ide" });
    vi.unstubAllGlobals();
    unmarkAcknowledging("stub-1-ide");
    unmarkAcknowledging("stub-2-ide");
  });

  it("Attach in terminal is offered for a selected live session only, in the palette and the menu, and shows the Epic 4 notice", () => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(true)], stubs(3)) });
    useLiveStore.getState().applySnapshot(
      liveSnapshot({ "stub-1-ide": { kind: "busy" }, "stub-2-ide": { kind: "exited" }, "stub-3-ide": { kind: "other", raw: "compacting" } }),
    );
    const enabled = () => listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.id);

    expect(enabled()).not.toContain("session.attach");
    useUiStore.getState().select({ kind: "session", id: "stub-1-ide" });
    expect(enabled()).toContain("session.attach");
    expect(nodeMenuCommands().map((c) => [c.title, c.menuOrder])).toEqual([
      ["Attach in terminal", 10],
      ["Link to…", 13],
    ]);
    expect(runCommand("session.attach")).toBe(true);
    expect(useUiStore.getState().notice).toEqual({ text: "Attach arrives in Epic 4 (claude attach stub-1-ide)" });
    vi.advanceTimersByTime(3000);
    expect(useUiStore.getState().notice).toBeNull();

    // An unrecognised status is live too.
    useUiStore.getState().select({ kind: "session", id: "stub-3-ide" });
    expect(enabled()).toContain("session.attach");

    // Exited, historic (never seen by the poll) and project selections: nothing.
    for (const target of [
      { kind: "session", id: "stub-2-ide" },
      { kind: "session", id: "never-polled" },
      { kind: "project", id: "ide" },
    ] as const) {
      useUiStore.getState().select(target);
      expect(enabled(), target.id).not.toContain("session.attach");
      expect(runCommand("session.attach"), target.id).toBe(false);
    }
    useUiStore.getState().select({ kind: "session", id: "stub-2-ide" });
    expect(nodeMenuCommands().map((c) => c.id)).toEqual(["edge.link"]);
  });

  it("Toggle Elsewhere sessions is offered only while the tray has rows and opens and closes the list", () => {
    const enabled = () => listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.id);
    expect(enabled()).not.toContain("elsewhere.toggle");
    expect(runCommand("elsewhere.toggle")).toBe(false);
    useLiveStore.getState().applySnapshot(liveSnapshot({}, 2));
    expect(enabled()).toContain("elsewhere.toggle");
    expect(runCommand("elsewhere.toggle")).toBe(true);
    expect(useUiStore.getState().elsewhereOpen).toBe(true);
    expect(runCommand("elsewhere.toggle")).toBe(true);
    expect(useUiStore.getState().elsewhereOpen).toBe(false);
  });

  it("Esc closes the menu, then the tray, then the palette, the pane and the selection; arrows wait while the tray is open", () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], stubs(3)) });
    useLiveStore.getState().applySnapshot(liveSnapshot({}, 1));
    useUiStore.getState().select({ kind: "project", id: "ide" });
    useUiStore.getState().openPane("settings");
    usePaletteStore.getState().open();
    useUiStore.getState().toggleElsewhere();
    useUiStore.getState().openContextMenu({ x: 1, y: 1 });
    const enabledEsc = () =>
      listCommands({ enabledOnly: true })
        .filter((c) => c.keybinding === "escape")
        .map((c) => c.id);

    expect(enabledEsc()).toEqual(["contextMenu.close"]);
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(enabledEsc()).toEqual(["elsewhere.close"]);
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useUiStore.getState().elsewhereOpen).toBe(false);
    expect(usePaletteStore.getState().isOpen).toBe(true);
    expect(enabledEsc()).toEqual(["palette.close"]);
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(enabledEsc()).toEqual(["pane.close"]);
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(enabledEsc()).toEqual(["selection.clear"]);

    // The tray alone: Esc closes it before the selection; arrows and Enter are inert meanwhile.
    useUiStore.getState().toggleElsewhere();
    expect(enabledEsc()).toEqual(["elsewhere.close"]);
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("selection.move.left");
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("selection.activate");
    // A tray whose last row left is closed, whatever the flag says.
    useLiveStore.getState().applySnapshot(liveSnapshot({}, 0));
    expect(enabledEsc()).toEqual(["selection.clear"]);
  });

  // -- branches (Story 5.1) --------------------------------------------------------------

  it("project.toggleBranches is a node-menu and palette command for a git project only, titled by its state", async () => {
    const statuses = useStatusStore.getState();
    useStatusStore.setState({ statuses: { ide: { kind: "not_repo" } } });
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], []) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("project.toggleBranches");
    expect(runCommand("project.toggleBranches")).toBe(false);

    useStatusStore.setState({ statuses: { ide: { kind: "repo", branch: "main", detached: false, dirty: 0, ahead: 0, behind: 0 } } });
    const listed = () => listCommands({ enabledOnly: true, visibleOnly: true }).find((c) => c.id === "project.toggleBranches");
    expect(listed()?.title).toBe("Show branches");
    expect(nodeMenuCommands().map((c) => c.id)).toContain("project.toggleBranches");
    expect(getCommand("project.toggleBranches")?.menuOrder).toBe(33);

    const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      expect(cmd).toBe("project_set_show_branches");
      const current = useWorkspaceStore.getState().snapshot!;
      const project = { ...ideProject(true), showBranches: args.show as boolean };
      return { ...current, revision: current.revision + 1, workspace: { ...current.workspace, projects: [project] } };
    });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    expect(runCommand("project.toggleBranches")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("project_set_show_branches", { projectId: "ide", show: true }, undefined);
    expect(useWorkspaceStore.getState().snapshot?.workspace.projects[0]?.showBranches).toBe(true);
    expect(listed()?.title).toBe("Hide branches");

    // Branches on and the folder no longer a repo: still offered, so it can be turned off.
    useStatusStore.setState({ statuses: { ide: { kind: "not_repo" } } });
    expect(listed()?.title).toBe("Hide branches");

    // Off: the branch group's show-all goes; the sessions' stays.
    useUiStore.getState().toggleShowAll("ide", "branches");
    useUiStore.getState().toggleShowAll("ide");
    expect(runCommand("project.toggleBranches")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenLastCalledWith("project_set_show_branches", { projectId: "ide", show: false }, undefined);
    expect(useUiStore.getState().showAllBranches).toEqual([]);
    expect(useUiStore.getState().showAll).toEqual(["ide"]);
    // Off and not a repo: no command.
    expect(listed()).toBeUndefined();
    vi.unstubAllGlobals();
    useStatusStore.setState(statuses);
  });

  it("project.newWorktree is a node-menu and palette command for a git project (order 12), with no key", () => {
    const statuses = useStatusStore.getState();
    useWorkspaceStore.setState({ snapshot: workspaceWith([ideProject(false)], []) });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    useStatusStore.setState({ statuses: { ide: { kind: "not_repo" } } });
    expect(nodeMenuCommands().map((c) => c.id)).not.toContain("project.newWorktree");
    useStatusStore.setState({ statuses: { ide: { kind: "repo", branch: "main", detached: false, dirty: 0, ahead: 0, behind: 0 } } });
    expect(nodeMenuCommands().map((c) => [c.title, c.menuOrder])).toContainEqual(["New worktree…", 12]);
    expect(listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.id)).toContain("project.newWorktree");
    expect(getCommand("project.newWorktree")?.keybinding).toBeUndefined();
    expect(getCommand("branch.newWorktree")?.menuOrder).toBe(51);
    expect(getCommand("branch.newWorktree")?.title).toBe("New worktree…");
    useStatusStore.setState(statuses);
  });

  it("branch.copyName is the branch card's first menu entry and copies its name", async () => {
    const branch: ChildNode = {
      id: "ide:feature/x",
      projectId: "ide",
      kind: "branch",
      label: "feature/x",
      detail: null,
      position: null,
      session: null,
      branchId: null,
      forkedFrom: null,
      hasTranscript: false,
      branch: { head: false, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: null },
    };
    useWorkspaceStore.setState({ snapshot: workspaceWith([{ ...ideProject(true), showBranches: true }], [branch]) });
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).not.toContain("branch.copyName");
    useUiStore.getState().select({ kind: "branch", id: "ide:feature/x" });
    expect(nodeMenuCommands().map((c) => c.id)).toEqual(["branch.copyName", "branch.newWorktree", "branch.newSession"]);

    const writeText = vi.fn(async () => {});
    await expect(copySelectedBranchName({ writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("feature/x");

    vi.useFakeTimers();
    await expect(copySelectedBranchName({ writeText: async () => Promise.reject(new Error("denied")) })).resolves.toBe(false);
    expect(useUiStore.getState().notice?.text).toBe("could not copy: denied");
    await expect(copySelectedBranchName(null)).resolves.toBe(false);
  });

  it("branch.newSession is `n` on a branch card unless its worktree is missing, and opens the sheet aimed at it", async () => {
    const card = (name: string, head: boolean, worktree: { path: string; missing: boolean } | null): ChildNode => ({
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
      branch: { head, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree },
    });
    const cards = [
      card("main", true, null),
      card("feat", false, { path: "/p/ide/.worktrees/feat", missing: false }),
      card("free", false, null),
      card("lost", false, { path: "/p/ide/.worktrees/lost", missing: true }),
    ];
    useWorkspaceStore.setState({ snapshot: workspaceWith([{ ...ideProject(true), showBranches: true }], cards) });
    const enabled = () => listCommands({ enabledOnly: true }).map((c) => c.id);
    for (const [name, on] of [["main", true], ["feat", true], ["free", true], ["lost", false]] as const) {
      useUiStore.getState().select({ kind: "branch", id: `ide:${name}` });
      expect(enabled().includes("branch.newSession"), name).toBe(on);
      expect(enabled(), name).not.toContain("project.newSession");
    }
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(enabled()).not.toContain("branch.newSession");

    const invoke = vi.fn().mockResolvedValue({
      sessionId: "3f2a-id",
      name: "ide-3f2a",
      model: "default",
      effort: "default",
      permissionMode: "default",
      branch: "feat",
      targetPath: "/p/ide/.worktrees/feat",
      worktreePlan: null,
      repoTop: null,
    });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    useUiStore.getState().select({ kind: "branch", id: "ide:feat" });
    expect(handleKeydown(key("n"))).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("launch_defaults", { projectId: "ide", branch: "feat" }, undefined);
    expect(useUiStore.getState().pane).toBe("launch");
    expect(useLaunchStore.getState()).toMatchObject({ projectId: "ide", branch: "feat", targetPath: "/p/ide/.worktrees/feat", worktreePlan: null });
    // Open: `n` typed in the sheet does not reset it.
    expect(enabled()).not.toContain("branch.newSession");
    vi.unstubAllGlobals();
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function ideProject(expanded: boolean, id = "ide"): Project {
  return { id, path: `/p/${id}`, label: id, position: { x: 0, y: 0 }, expanded, color: null, launchDefaults: null, showBranches: false };
}

function stubs(count: number, projectId = "ide"): ChildNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `stub-${i + 1}-${projectId}`,
    projectId,
    kind: "session" as const,
    label: `session ${i + 1}`,
    detail: "stub",
    position: null,
    session: null,
    branchId: null, forkedFrom: null, hasTranscript: false, branch: null,
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
    branchErrors: {},
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
      notifications: { finished: true, waiting: true },
      peers: { nudge: true },
    },
    binaries: {
      claude: { name: "claude", path: null, version: null, status: "missing", configured: false },
      git: { name: "git", path: null, version: null, status: "missing", configured: false },
    },
    banners: [],
  };
}
