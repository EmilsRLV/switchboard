import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSession, SessionState, WorkspaceSnapshot } from "../ipc";
import {
  FLASH_MS,
  NOTICE_MS,
  TERMINAL_MIN_WIDTH,
  TERMINAL_WIDTH_KEY,
  clampTerminalWidth,
  clampToArea,
  defaultTerminalWidth,
  loadTerminalWidth,
  saveTerminalWidth,
  hasSelection,
  isContextMenuOpen,
  isElsewhereOpen,
  isPaneOpen,
  sameTarget,
  selectedProject,
  stepTab,
  terminalOfTarget,
  useUiStore,
  withTab,
  withoutTab,
  isPoppedOut,
  currentPane,
  currentSelection,
  withPane,
  withSelection,
} from "./ui";
import { useTerminalStore } from "./terminals";
import { EMPTY_LIVE, isAcknowledging, unmarkAcknowledging, useLiveStore } from "./live";
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
    expect(useUiStore.getState().contextMenu).toEqual({ x: 300, y: 120, menu: "node" });
    expect(isContextMenuOpen()).toBe(true);
    s.openContextMenu({ x: 10, y: 10 });
    expect(useUiStore.getState().contextMenu).toEqual({ x: 10, y: 10, menu: "node" });
    s.openContextMenu({ x: 20, y: 30 }, "canvas");
    expect(useUiStore.getState().contextMenu).toEqual({ x: 20, y: 30, menu: "canvas" });
    expect(isContextMenuOpen()).toBe(true);
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
    const ide = { id: "ide", path: "/p/ide", label: "ide", position: { x: 0, y: 0 }, expanded: true, color: null, launchDefaults: null, showBranches: false };
    const snapshot: WorkspaceSnapshot = {
      path: null,
      workspace: { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, projects: [ide], branches: [], sessions: [], edges: [], defaults: { model: null, effort: null, permissionMode: null } },
      banners: [],
      revision: 1,
      branchErrors: {},
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

describe("showAll", () => {
  beforeEach(() => {
    useUiStore.setState({ showAll: [] });
  });

  it("toggleShowAll keeps one list per group: the branch group never touches the sessions' list", () => {
    useUiStore.setState({ showAll: [], showAllBranches: [] });
    useUiStore.getState().toggleShowAll("a", "branches");
    expect(useUiStore.getState().showAllBranches).toEqual(["a"]);
    expect(useUiStore.getState().showAll).toEqual([]);
    useUiStore.getState().toggleShowAll("a");
    expect(useUiStore.getState().showAll).toEqual(["a"]);
    useUiStore.getState().toggleShowAll("a", "branches");
    expect(useUiStore.getState().showAllBranches).toEqual([]);
    expect(useUiStore.getState().showAll).toEqual(["a"]);
  });

  it("a more row's group is part of its identity and survives selection", () => {
    useUiStore.getState().select({ kind: "more", id: "a", group: "branches" });
    expect(useUiStore.getState().selection).toEqual({ kind: "more", id: "a", group: "branches" });
    expect(sameTarget({ kind: "more", id: "a" }, { kind: "more", id: "a", group: "branches" })).toBe(false);
    expect(sameTarget({ kind: "more", id: "a" }, { kind: "more", id: "a", group: "sessions" })).toBe(true);
    useUiStore.getState().clearSelection();
  });

  it("toggleShowAll adds and removes a project id, reference-stable for the others, empty after the last", () => {
    const empty = useUiStore.getState().showAll;
    expect(empty).toEqual([]);
    useUiStore.getState().toggleShowAll("a");
    useUiStore.getState().toggleShowAll("b");
    expect(useUiStore.getState().showAll).toEqual(["a", "b"]);
    useUiStore.getState().toggleShowAll("a");
    expect(useUiStore.getState().showAll).toEqual(["b"]);
    useUiStore.getState().toggleShowAll("b");
    const cleared = useUiStore.getState().showAll;
    expect(cleared).toEqual([]);
    useUiStore.getState().toggleShowAll("c");
    useUiStore.getState().toggleShowAll("c");
    expect(useUiStore.getState().showAll).toBe(cleared);
  });

  it("a more row can be selected like a node", () => {
    useUiStore.getState().select({ kind: "more", id: "a" });
    expect(useUiStore.getState().selection).toEqual({ kind: "more", id: "a" });
    const held = useUiStore.getState().selection;
    useUiStore.getState().select({ kind: "more", id: "a" });
    expect(useUiStore.getState().selection).toBe(held);
    useUiStore.getState().select({ kind: "project", id: "a" });
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "a" });
  });
});

describe("Elsewhere tray flag", () => {
  const row = { session_id: "s", state: { kind: "idle" as const }, name: "n", cwd: "/w", started_at: 1 };

  it("is open only with rows, and resets when the last row leaves so a later row shows the chip alone", () => {
    useLiveStore.getState().applySnapshot({ sessions: {}, elsewhere: [row], banner: null });
    useUiStore.setState({ elsewhereOpen: false });
    useUiStore.getState().toggleElsewhere();
    expect(isElsewhereOpen()).toBe(true);
    useLiveStore.getState().applySnapshot({ sessions: {}, elsewhere: [], banner: null });
    expect(useUiStore.getState().elsewhereOpen).toBe(false);
    useLiveStore.getState().applySnapshot({ sessions: {}, elsewhere: [row], banner: null });
    expect(isElsewhereOpen()).toBe(false);
  });
});

describe("acknowledgement on selection (Story 3.3)", () => {
  const live = (state: SessionState): LiveSession => ({
    state,
    source: "poll",
    pid: 1,
    kind: "interactive",
    name: "s1",
    project_id: "ide",
    cwd: "/p/ide",
    started_at: 1,
    attention_since: state.kind === "finished" ? 1 : null,
    last_line: null,
    detail: null,
  });

  beforeEach(() => {
    useUiStore.setState({ selection: null, elsewhereOpen: false });
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
    unmarkAcknowledging("s1");
    unmarkAcknowledging("s2");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selecting a session in finished or waiting asks Rust to acknowledge it, once", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    useLiveStore.getState().applySnapshot({
      sessions: { s1: live({ kind: "finished" }), s2: { ...live({ kind: "waiting" }), attention_since: 7 }, s3: live({ kind: "busy" }) },
      elsewhere: [],
      banner: null,
    });
    useUiStore.getState().select({ kind: "project", id: "ide" });
    useUiStore.getState().select({ kind: "session", id: "s3" });
    expect(invoke).not.toHaveBeenCalled();
    useUiStore.getState().select({ kind: "session", id: "s1" });
    expect(invoke).toHaveBeenCalledWith("session_acknowledge", { sessionId: "s1", attentionSince: 1 }, undefined);
    expect(isAcknowledging("s1")).toBe(true);
    useUiStore.getState().select({ kind: "session", id: "s2" });
    useUiStore.getState().select({ kind: "session", id: "s1" });
    expect(invoke.mock.calls.filter(([, args]) => (args as { sessionId: string }).sessionId === "s1")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("session_acknowledge", { sessionId: "s2", attentionSince: 7 }, undefined);
  });

  it("the reply is applied for the acknowledged session only, and never over a newer turn", async () => {
    const finished = live({ kind: "finished" });
    const idle = { ...live({ kind: "idle" }), source: "ack" as const };
    const reply = { sessions: { s1: idle, s2: live({ kind: "busy" }) }, elsewhere: [], banner: null };
    let resolve: (value: unknown) => void = () => {};
    const invoke = vi.fn(() => new Promise((r) => (resolve = r)));
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    useLiveStore.getState().applySnapshot({ sessions: { s1: finished, s2: live({ kind: "idle" }) }, elsewhere: [], banner: null });
    useUiStore.getState().select({ kind: "session", id: "s1" });
    resolve(reply);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(useLiveStore.getState().snapshot.sessions.s1).toEqual(idle);
    expect(useLiveStore.getState().snapshot.sessions.s2?.state, "other sessions are not taken from the reply").toEqual({ kind: "idle" });

    // A newer turn arrived before the reply: the reply does not roll it back.
    useUiStore.getState().clearSelection();
    useLiveStore.getState().applySnapshot({ sessions: { s1: finished }, elsewhere: [], banner: null });
    useUiStore.getState().select({ kind: "session", id: "s1" });
    useLiveStore.getState().applySnapshot({ sessions: { s1: { ...finished, attention_since: 9 } }, elsewhere: [], banner: null });
    resolve(reply);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(useLiveStore.getState().snapshot.sessions.s1?.attention_since).toBe(9);
  });

  it("opening the Elsewhere tray acknowledges every listed session that needs attention", () => {
    const invoke = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const row = (id: string, state: SessionState) => ({ session_id: id, state, name: id, cwd: "/w", started_at: 1 });
    useLiveStore.getState().applySnapshot({
      sessions: { s1: { ...live({ kind: "finished" }), project_id: null }, s2: { ...live({ kind: "busy" }), project_id: null } },
      elsewhere: [row("s1", { kind: "finished" }), row("s2", { kind: "busy" })],
      banner: null,
    });
    useUiStore.getState().toggleElsewhere();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("session_acknowledge", { sessionId: "s1", attentionSince: 1 }, undefined);
  });

  it("a failed acknowledgement (no runtime) is forgotten so a later selection retries", async () => {
    vi.stubGlobal("window", {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useLiveStore.getState().applySnapshot({ sessions: { s1: live({ kind: "finished" }) }, elsewhere: [], banner: null });
    useUiStore.getState().select({ kind: "session", id: "s1" });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(isAcknowledging("s1")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("terminal pane state", () => {
  beforeEach(() => {
    useUiStore.setState({ pane: null, activeTerminal: null, terminalWidth: null });
  });

  it("the terminal is a pane like the others: opening it replaces settings or import", () => {
    const s = useUiStore.getState();
    s.openPane("settings");
    s.openPane("terminal");
    expect(useUiStore.getState().pane).toBe("terminal");
    s.togglePane("terminal");
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("remembers the active terminal and the dragged width", () => {
    const s = useUiStore.getState();
    s.setActiveTerminal("plain-p1");
    expect(useUiStore.getState().activeTerminal).toBe("plain-p1");
    s.setActiveTerminal("plain-p1");
    expect(useUiStore.getState().activeTerminal).toBe("plain-p1");
    s.setTerminalWidth(600);
    expect(useUiStore.getState().terminalWidth).toBe(600);
    s.setTerminalWidth(null);
    expect(useUiStore.getState().terminalWidth).toBeNull();
  });

  it("the default width is min(720px, 70vw)", () => {
    expect(defaultTerminalWidth(1920)).toBe(720);
    expect(defaultTerminalWidth(1000)).toBe(700);
    expect(defaultTerminalWidth(800)).toBe(560);
  });

  it("a dragged width stays between 360 px and 90vw", () => {
    expect(clampTerminalWidth(100, 1600)).toBe(TERMINAL_MIN_WIDTH);
    expect(clampTerminalWidth(900.4, 1600)).toBe(900);
    expect(clampTerminalWidth(1590, 1600)).toBe(1440);
    // Too narrow a window for both: 90vw wins.
    expect(clampTerminalWidth(100, 300)).toBe(270);
    expect(clampTerminalWidth(Number.NaN, 1000)).toBe(700);
  });

  it("the width is stored with try/catch: unreadable or throwing storage is no width", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadTerminalWidth(storage)).toBeNull();
    saveTerminalWidth(612.6, storage);
    expect(store.get(TERMINAL_WIDTH_KEY)).toBe("613");
    expect(loadTerminalWidth(storage)).toBe(613);
    store.set(TERMINAL_WIDTH_KEY, "wide");
    expect(loadTerminalWidth(storage)).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadTerminalWidth(throwing)).toBeNull();
    expect(() => saveTerminalWidth(500, throwing)).not.toThrow();
    expect(loadTerminalWidth(null)).toBeNull();
  });
});

describe("terminal tabs (Story 4.5)", () => {
  beforeEach(() => {
    useUiStore.setState({ pane: null, selection: null, activeTerminal: null, openTerminals: [], poppedOut: {}, focusOnShow: true });
    useTerminalStore.setState({ infos: {}, pendingExits: {} });
  });

  it("withTab adds at the end once; withoutTab hands the active place to a neighbour", () => {
    const tabs = ["a", "b"];
    expect(withTab(tabs, "c")).toEqual(["a", "b", "c"]);
    expect(withTab(tabs, "a")).toBe(tabs);
    expect(withoutTab(["a", "b", "c"], "b", "b")).toEqual({ tabs: ["a", "c"], active: "c" });
    expect(withoutTab(["a", "b", "c"], "c", "c")).toEqual({ tabs: ["a", "b"], active: "b" });
    expect(withoutTab(["a", "b", "c"], "a", "c")).toEqual({ tabs: ["a", "b"], active: "a" });
    expect(withoutTab(["a"], "a", "a")).toEqual({ tabs: [], active: null });
    expect(withoutTab(tabs, "a", "x").tabs).toBe(tabs);
  });

  it("stepTab moves either way and wraps around", () => {
    expect(stepTab(["a", "b", "c"], "a", 1)).toBe("b");
    expect(stepTab(["a", "b", "c"], "a", -1)).toBe("c");
    expect(stepTab(["a", "b", "c"], "c", 1)).toBe("a");
    expect(stepTab(["a", "b", "c"], "x", 1)).toBe("a");
    expect(stepTab([], "a", 1)).toBeNull();
  });

  it("opening adds a tab at the end and activates it; closing and stepping follow the rules", () => {
    const ui = useUiStore.getState();
    ui.openTab("A");
    ui.openTab("B");
    expect(useUiStore.getState().openTerminals).toEqual(["A", "B"]);
    expect(useUiStore.getState().activeTerminal).toBe("B");
    ui.openTab("A");
    expect(useUiStore.getState().openTerminals).toEqual(["A", "B"]);
    expect(useUiStore.getState().activeTerminal).toBe("A");
    ui.nextTab(1);
    expect(useUiStore.getState().activeTerminal).toBe("B");
    ui.nextTab(1);
    expect(useUiStore.getState().activeTerminal).toBe("A");
    ui.setActiveTerminal("C");
    expect(useUiStore.getState().openTerminals).toEqual(["A", "B", "C"]);
    ui.closeTab("C");
    expect(useUiStore.getState().activeTerminal).toBe("B");
    ui.setActiveTerminal(null);
    expect(useUiStore.getState().activeTerminal).toBeNull();
    expect(useUiStore.getState().openTerminals).toEqual(["A", "B"]);
  });

  it("records pop-outs by terminal", () => {
    const ui = useUiStore.getState();
    ui.setPopped("A", "term-1");
    expect(isPoppedOut("A")).toBe(true);
    expect(useUiStore.getState().poppedOut).toEqual({ A: "term-1" });
    const before = useUiStore.getState().poppedOut;
    ui.setPopped("A", "term-1");
    expect(useUiStore.getState().poppedOut).toBe(before);
    ui.setPopped("A", null);
    expect(isPoppedOut("A")).toBe(false);
    expect(isPoppedOut(null)).toBe(false);
  });

  const term = (id: string, kind: "plain" | "session", project = "ide") => ({
    id,
    kind,
    project_id: project,
    title: id,
    cwd: "/p",
    exited: null,
    error: null,
    cols: 80,
    rows: 24,
    stopping: false,
  });

  it("selecting a node with a terminal switches the open pane to its tab, without taking focus", () => {
    useTerminalStore.getState().upsert(term("session:s1", "session"));
    useTerminalStore.getState().upsert(term("plain-ide", "plain"));
    expect(terminalOfTarget({ kind: "session", id: "s1" })).toBe("session:s1");
    expect(terminalOfTarget({ kind: "project", id: "ide" })).toBe("plain-ide");
    expect(terminalOfTarget({ kind: "project", id: "other" })).toBeNull();
    expect(terminalOfTarget({ kind: "session", id: "s2" })).toBeNull();

    // Pane closed: selecting changes nothing.
    useUiStore.getState().select({ kind: "session", id: "s1" });
    expect(useUiStore.getState().openTerminals).toEqual([]);
    expect(useUiStore.getState().activeTerminal).toBeNull();

    useUiStore.setState({ pane: "terminal", selection: null });
    useUiStore.getState().select({ kind: "session", id: "s1" });
    expect(useUiStore.getState().openTerminals).toEqual(["session:s1"]);
    expect(useUiStore.getState().activeTerminal).toBe("session:s1");
    expect(useUiStore.getState().focusOnShow).toBe(false);
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(useUiStore.getState().openTerminals).toEqual(["session:s1", "plain-ide"]);
    expect(useUiStore.getState().activeTerminal).toBe("plain-ide");
    // A node without a terminal leaves the pane as it is.
    useUiStore.getState().select({ kind: "session", id: "s2" });
    expect(useUiStore.getState().activeTerminal).toBe("plain-ide");
    // A tab click focuses again.
    useUiStore.getState().openTab("session:s1");
    expect(useUiStore.getState().focusOnShow).toBe(true);
  });
});

describe("the evaluation overrides (Story 11.2)", () => {
  beforeEach(() => {
    useUiStore.setState({ pane: "terminal", selection: { kind: "project", id: "a" } });
  });
  afterEach(() => {
    useUiStore.setState({ pane: null, selection: null });
  });

  it("withSelection shows the override inside fn, nests, and restores it after", () => {
    expect(currentSelection()).toEqual({ kind: "project", id: "a" });
    const seen = withSelection({ kind: "session", id: "s" }, () => {
      const inner = withSelection(null, () => [currentSelection(), hasSelection()]);
      return [currentSelection(), ...inner];
    });
    expect(seen).toEqual([{ kind: "session", id: "s" }, null, false]);
    expect(currentSelection()).toEqual({ kind: "project", id: "a" });
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "a" });
  });

  it("selectedProject reads the override", () => {
    useWorkspaceStore.setState({ snapshot: { workspace: { projects: [{ id: "a" }, { id: "b" }] } } as unknown as WorkspaceSnapshot });
    expect(withSelection({ kind: "project", id: "b" }, () => selectedProject()?.id)).toBe("b");
    expect(withSelection({ kind: "session", id: "s" }, () => selectedProject())).toBeNull();
    useWorkspaceStore.setState({ snapshot: null });
  });

  it("withPane shows the pane override to currentPane and isPaneOpen, and restores it", () => {
    expect(withPane(null, () => [currentPane(), isPaneOpen()])).toEqual([null, false]);
    expect(withPane("launch", () => currentPane())).toBe("launch");
    expect(currentPane()).toBe("terminal");
    expect(isPaneOpen()).toBe(true);
  });

  it("both are restored on a throw", () => {
    expect(() =>
      withSelection({ kind: "branch", id: "b" }, () =>
        withPane(null, () => {
          throw new Error("boom");
        }),
      ),
    ).toThrow("boom");
    expect(currentSelection()).toEqual({ kind: "project", id: "a" });
    expect(currentPane()).toBe("terminal");
  });

  it("never writes the store or notifies a subscriber", () => {
    const listener = vi.fn();
    const unsubscribe = useUiStore.subscribe(listener);
    const before = useUiStore.getState();
    withSelection({ kind: "session", id: "s" }, () => withPane(null, () => currentSelection()));
    expect(listener).not.toHaveBeenCalled();
    expect(useUiStore.getState()).toBe(before);
    unsubscribe();
  });
});
