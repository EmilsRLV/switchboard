import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, TermInfo, WorkspaceSnapshot } from "../ipc";
import { usePaletteStore } from "../state/palette";
import {
  isTerminalRestartable,
  plainTerminalId,
  sessionIdOfTerminal,
  sessionTerminalId,
  stoppingSessionIds,
  terminalStateText,
  useTerminalStore,
} from "../state/terminals";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { registerBuiltins } from "./builtins";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { clearCommands, listCommands, runCommand } from "./registry";
import {
  closeTerminalTab,
  forgetProjectTerminals,
  forgetTerminal,
  openProjectTerminal,
  popOutTerminal,
  returnToPane,
  showTerminal,
} from "./terminal";
import { applyPoppedEvent } from "../terminal/registry";

function info(overrides: Partial<TermInfo> = {}): TermInfo {
  return { id: "plain-ide", kind: "plain", project_id: "ide", title: "ide", cwd: "/p/ide", exited: null, error: null, cols: 80, rows: 24, stopping: false, ...overrides };
}

function project(id: string): Project {
  return { id, path: `/p/${id}`, label: id, position: { x: 0, y: 0 }, expanded: false, color: null, launchDefaults: null, showBranches: false };
}

function workspace(projects: Project[]): WorkspaceSnapshot {
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
    children: [],
  };
}

function key(k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: () => {}, ...mods };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** A Tauri runtime whose `invoke` answers the term commands. */
function runtime(answers: Record<string, unknown>) {
  const invoke = vi.fn((cmd: string) => {
    const answer = answers[cmd];
    return answer instanceof Error ? Promise.reject(answer.message) : Promise.resolve(answer);
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  return invoke;
}

const enabled = () => listCommands({ enabledOnly: true }).map((c) => c.id);

describe("terminal commands", () => {
  beforeEach(() => {
    clearCommands();
    useWorkspaceStore.setState({ snapshot: workspace([project("ide")]), loadError: null });
    useUiStore.setState({
      pane: null,
      selection: { kind: "project", id: "ide" },
      contextMenu: null,
      notice: null,
      elsewhereOpen: false,
      activeTerminal: null,
      openTerminals: [],
      poppedOut: {},
    });
    usePaletteStore.setState({ isOpen: false, query: "", selected: 0 });
    useTerminalStore.setState({ infos: {}, pendingExits: {} });
    registerBuiltins();
  });
  afterEach(() => {
    clearCommands();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("Plain terminal… opens the project's terminal in the pane, and again only shows it", async () => {
    const invoke = runtime({ term_open: info() });
    expect(runCommand("project.terminal")).toBe(true);
    expect(useUiStore.getState().pane).toBe("terminal");
    expect(useUiStore.getState().activeTerminal).toBe("plain-ide");
    await flush();
    // No pane could be measured here: Rust picks 120 x 30.
    expect(invoke).toHaveBeenCalledWith("term_open", { kind: "plain", projectId: "ide", cols: null, rows: null }, undefined);
    expect(useTerminalStore.getState().infos["plain-ide"]).toEqual(info());

    useUiStore.getState().openPane("settings");
    expect(await openProjectTerminal("ide")).toBe(true);
    expect(useUiStore.getState().pane).toBe("terminal");
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "term_open")).toHaveLength(1);
  });

  it("a terminal that cannot open is a notice and the pane goes away", async () => {
    vi.useFakeTimers();
    runtime({ term_open: new Error("unknown project") });
    expect(await openProjectTerminal("ide")).toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "unknown project" });
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().activeTerminal).toBeNull();
  });

  it("ctrl+` hides the pane and shows it again with the same terminal, from anywhere", async () => {
    expect(enabled()).not.toContain("terminal.toggle");
    runtime({ term_open: info() });
    await openProjectTerminal("ide");
    expect(enabled()).toContain("terminal.toggle");
    const inTerminal = { closest: () => ({}) };
    expect(handleKeydown(key("`", { ctrlKey: true, target: inTerminal }))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
    expect(handleKeydown(key("`", { ctrlKey: true }))).toBe(true);
    expect(useUiStore.getState().pane).toBe("terminal");
    expect(useUiStore.getState().activeTerminal).toBe("plain-ide");
    // Esc inside the terminal is the shell's; ctrl+shift+k opens the palette.
    expect(handleKeydown(key("Escape", { target: inTerminal }))).toBe(false);
    expect(useUiStore.getState().pane).toBe("terminal");
    expect(handleKeydown(key("K", { ctrlKey: true, shiftKey: true, target: inTerminal }))).toBe(true);
    expect(usePaletteStore.getState().isOpen).toBe(true);
    usePaletteStore.getState().close();
    // Outside the terminal Esc still closes the pane.
    expect(handleKeydown(key("Escape", { target: { closest: () => null } }))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("Kill is offered while the terminal runs, Restart once it exited", async () => {
    const invoke = runtime({ term_open: info(), term_kill: undefined, term_restart: info() });
    await openProjectTerminal("ide");
    expect(enabled()).toContain("terminal.kill");
    expect(enabled()).not.toContain("terminal.restart");
    expect(runCommand("terminal.kill")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("term_kill", { id: "plain-ide" }, undefined);

    // `term://exit` arrives.
    useTerminalStore.getState().markExited("plain-ide", 1);
    expect(enabled()).not.toContain("terminal.kill");
    expect(enabled()).toContain("terminal.restart");
    expect(runCommand("terminal.restart")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("term_restart", { id: "plain-ide" }, undefined);
    expect(useTerminalStore.getState().infos["plain-ide"]?.exited).toBeNull();
  });

  it("an exited session terminal offers no Restart (resume arrives in Story 4.4), but Kill while it runs", () => {
    const session = info({ id: "session:s1", kind: "session", title: "ide-3f2a" });
    useTerminalStore.getState().upsert(session);
    useUiStore.getState().setActiveTerminal("session:s1");
    expect(enabled()).toContain("terminal.kill");
    useTerminalStore.getState().markExited("session:s1", 0);
    expect(enabled()).not.toContain("terminal.restart");
    expect(runCommand("terminal.restart")).toBe(false);
    expect(isTerminalRestartable("session:s1")).toBe(false);
    expect(terminalStateText(useTerminalStore.getState().infos["session:s1"]!)).toBe("exited 0");
  });

  it("Close is offered for an exited session terminal only, and forgets it in Rust and here", async () => {
    const invoke = runtime({ term_close: undefined });
    useTerminalStore.getState().upsert(info({ id: "session:s1", kind: "session", title: "ide-3f2a" }));
    useUiStore.setState({ pane: "terminal", activeTerminal: "session:s1" });
    expect(enabled()).not.toContain("terminal.close");
    expect(runCommand("terminal.close")).toBe(false);
    useTerminalStore.getState().markExited("session:s1", 0);
    expect(enabled()).toContain("terminal.close");
    expect(runCommand("terminal.close")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("term_close", { id: "session:s1" }, undefined);
    expect(useTerminalStore.getState().infos["session:s1"]).toBeUndefined();
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().activeTerminal).toBeNull();

    // A plain terminal that exited restarts instead.
    useTerminalStore.getState().upsert(info({ exited: 1 }));
    useUiStore.getState().setActiveTerminal("plain-ide");
    expect(enabled()).not.toContain("terminal.close");
    expect(enabled()).toContain("terminal.restart");
  });

  it("a refused Close is the notice and keeps the terminal", async () => {
    runtime({ term_close: new Error("terminal is still running") });
    useTerminalStore.getState().upsert(info({ id: "session:s1", kind: "session", exited: 0 }));
    useUiStore.getState().setActiveTerminal("session:s1");
    expect(runCommand("terminal.close")).toBe(true);
    await flush();
    expect(useUiStore.getState().notice).toEqual({ text: "terminal is still running" });
    expect(useTerminalStore.getState().infos["session:s1"]).toBeDefined();
  });
});

describe("terminal tabs and pop-out (Story 4.5)", () => {
  const A = () => info({ id: "session:a", kind: "session", title: "ide-aaaa" });
  const B = () => info({ id: "session:b", kind: "session", title: "ide-bbbb" });

  beforeEach(() => {
    clearCommands();
    useWorkspaceStore.setState({ snapshot: workspace([project("ide")]), loadError: null });
    useUiStore.setState({
      pane: null,
      selection: null,
      contextMenu: null,
      notice: null,
      elsewhereOpen: false,
      activeTerminal: null,
      openTerminals: [],
      poppedOut: {},
    });
    usePaletteStore.setState({ isOpen: false, query: "", selected: 0 });
    useTerminalStore.setState({ infos: {}, pendingExits: {} });
    useTerminalStore.getState().upsert(A());
    useTerminalStore.getState().upsert(B());
    registerBuiltins();
  });
  afterEach(() => {
    clearCommands();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("two sessions shown are two tabs, the last active; the tab keys move between them from inside a terminal", async () => {
    await showTerminal("session:a");
    await showTerminal("session:b");
    expect(useUiStore.getState().openTerminals).toEqual(["session:a", "session:b"]);
    expect(useUiStore.getState().activeTerminal).toBe("session:b");
    const inTerminal = { closest: () => ({}) };
    expect(handleKeydown(key("PageUp", { ctrlKey: true, code: "PageUp", target: inTerminal }))).toBe(true);
    expect(useUiStore.getState().activeTerminal).toBe("session:a");
    expect(handleKeydown(key("PageDown", { ctrlKey: true, code: "PageDown", target: inTerminal }))).toBe(true);
    expect(useUiStore.getState().activeTerminal).toBe("session:b");
    // With the pane hidden the tab keys are not taken.
    useUiStore.getState().closePane();
    expect(enabled()).not.toContain("terminal.nextTab");
    expect(handleKeydown(key("PageDown", { ctrlKey: true }))).toBe(false);
  });

  it("× on a running terminal drops the tab only; Show terminal brings it back", async () => {
    const invoke = runtime({});
    await showTerminal("session:a");
    await showTerminal("session:b");
    await closeTerminalTab("session:b");
    expect(useUiStore.getState().openTerminals).toEqual(["session:a"]);
    expect(useUiStore.getState().activeTerminal).toBe("session:a");
    expect(useUiStore.getState().pane).toBe("terminal");
    expect(invoke).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().infos["session:b"]).toBeDefined();
    await showTerminal("session:b");
    expect(useUiStore.getState().openTerminals).toEqual(["session:a", "session:b"]);
    // The last tab going puts the pane away.
    await closeTerminalTab("session:a");
    await closeTerminalTab("session:b");
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().activeTerminal).toBeNull();
  });

  it("× on an exited session terminal closes it, as Close does", async () => {
    const invoke = runtime({ term_close: undefined });
    await showTerminal("session:a");
    await showTerminal("session:b");
    useTerminalStore.getState().markExited("session:a", 0);
    await closeTerminalTab("session:a");
    expect(invoke).toHaveBeenCalledWith("term_close", { id: "session:a" }, undefined);
    expect(useTerminalStore.getState().infos["session:a"]).toBeUndefined();
    expect(useUiStore.getState().openTerminals).toEqual(["session:b"]);
    expect(useUiStore.getState().activeTerminal).toBe("session:b");
  });

  it("Pop out is offered for the active terminal until it is popped; a failure is the notice and the tab stays", async () => {
    vi.useFakeTimers();
    const invoke = runtime({ term_pop_out: new Error("could not open the terminal window: no display") });
    expect(enabled()).not.toContain("terminal.popOut");
    await showTerminal("session:b");
    expect(enabled()).toContain("terminal.popOut");
    expect(await popOutTerminal()).toBe(false);
    expect(useUiStore.getState().notice).toEqual({ text: "could not open the terminal window: no display" });
    expect(useUiStore.getState().poppedOut).toEqual({});
    expect(useUiStore.getState().activeTerminal).toBe("session:b");

    invoke.mockImplementation(() => Promise.resolve("term-1"));
    expect(runCommand("terminal.popOut")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("term_pop_out", { id: "session:b" }, undefined);
    expect(useUiStore.getState().poppedOut).toEqual({ "session:b": "term-1" });
    expect(useUiStore.getState().openTerminals).toEqual(["session:b"]);
    expect(enabled()).not.toContain("terminal.popOut");

    invoke.mockImplementation(() => Promise.resolve(undefined));
    expect(await returnToPane("session:b")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("term_return", { id: "session:b" }, undefined);
    expect(useUiStore.getState().poppedOut).toEqual({});
    expect(enabled()).toContain("terminal.popOut");
  });

  it("Pop out is offered only while the pane is open on the terminal", async () => {
    await showTerminal("session:b");
    expect(enabled()).toContain("terminal.popOut");
    useUiStore.getState().closePane();
    expect(enabled()).not.toContain("terminal.popOut");
  });

  it("a pop-out reply older than a term://popped event does not overwrite it", async () => {
    const invoke = runtime({});
    await showTerminal("session:b");
    let answer: (label: string) => void = () => {};
    invoke.mockImplementation(() => new Promise((resolve) => (answer = resolve as (label: string) => void)));
    const pending = popOutTerminal();
    // The window opened and was closed again before the reply arrived.
    applyPoppedEvent("session:b", "term-1");
    applyPoppedEvent("session:b", null);
    answer("term-1");
    expect(await pending).toBe(true);
    expect(useUiStore.getState().poppedOut).toEqual({});
  });

  it("× on an exited session tab whose close is refused keeps the tab and shows the notice", async () => {
    vi.useFakeTimers();
    runtime({ term_close: new Error("terminal is still running") });
    await showTerminal("session:a");
    useTerminalStore.getState().markExited("session:a", 0);
    await closeTerminalTab("session:a");
    expect(useUiStore.getState().notice).toEqual({ text: "terminal is still running" });
    expect(useUiStore.getState().openTerminals).toEqual(["session:a"]);
    expect(useTerminalStore.getState().infos["session:a"]).toBeDefined();
  });

  it("a terminal closed in another window leaves its tab, info and pop-out record", async () => {
    await showTerminal("session:a");
    await showTerminal("session:b");
    useUiStore.getState().setPopped("session:b", "term-1");
    forgetTerminal("session:b");
    expect(useTerminalStore.getState().infos["session:b"]).toBeUndefined();
    expect(useUiStore.getState().openTerminals).toEqual(["session:a"]);
    expect(useUiStore.getState().activeTerminal).toBe("session:a");
    expect(useUiStore.getState().poppedOut).toEqual({});
    // Idempotent.
    forgetTerminal("session:b");
    expect(useUiStore.getState().openTerminals).toEqual(["session:a"]);
  });
});

describe("forgetProjectTerminals", () => {
  it("drops the project's terminals and puts the pane away when it showed one", () => {
    useTerminalStore.setState({ infos: { "plain-ide": info(), "plain-x": info({ id: "plain-x", project_id: "x" }) }, pendingExits: {} });
    useUiStore.setState({ pane: "terminal", activeTerminal: "plain-ide", openTerminals: ["plain-ide"], poppedOut: {} });
    forgetProjectTerminals("ide");
    expect(Object.keys(useTerminalStore.getState().infos)).toEqual(["plain-x"]);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().activeTerminal).toBeNull();
  });
});

describe("terminals store", () => {
  beforeEach(() => useTerminalStore.setState({ infos: {}, pendingExits: {} }));

  it("an exit that overtook the open reply is applied when the info arrives", () => {
    const store = useTerminalStore.getState();
    store.markExited("plain-ide", 2);
    expect(useTerminalStore.getState().infos["plain-ide"]).toBeUndefined();
    store.upsert(info());
    expect(useTerminalStore.getState().infos["plain-ide"]?.exited).toBe(2);
    expect(useTerminalStore.getState().pendingExits).toEqual({});
    // Applied once: a later running info (a restart) stays running.
    store.upsert(info());
    expect(useTerminalStore.getState().infos["plain-ide"]?.exited).toBeNull();
  });

  it("removes terminals and records a new size", () => {
    const store = useTerminalStore.getState();
    store.upsert(info());
    store.setSize("plain-ide", 100, 40);
    expect(useTerminalStore.getState().infos["plain-ide"]).toMatchObject({ cols: 100, rows: 40 });
    store.remove(["plain-ide"]);
    expect(useTerminalStore.getState().infos).toEqual({});
  });

  it("upserts, replaces and marks exits; an unknown id changes nothing", () => {
    const store = useTerminalStore.getState();
    store.upsert(info());
    store.markExited("plain-ide", 0);
    expect(useTerminalStore.getState().infos["plain-ide"]?.exited).toBe(0);
    const before = useTerminalStore.getState().infos;
    store.markExited("nope", 0);
    expect(useTerminalStore.getState().infos).toBe(before);
    useTerminalStore.setState({ pendingExits: {} });
    store.markExited("plain-ide", null);
    expect(useTerminalStore.getState().infos["plain-ide"]?.exited).toBe(-1);
    store.replaceAll([info({ id: "plain-x", project_id: "x" })]);
    expect(Object.keys(useTerminalStore.getState().infos)).toEqual(["plain-x"]);
  });

  it("the header state reads running, exited N or why the shell could not start", () => {
    expect(terminalStateText(info())).toBe("running");
    expect(terminalStateText(info({ exited: 0 }))).toBe("exited 0");
    // The sessions being stopped, by session id: running session terminals with `stopping`.
    const infos = Object.fromEntries(
      [
        info({ id: "session:a", kind: "session", stopping: true }),
        info({ id: "session:b", kind: "session", stopping: true, exited: 0 }),
        info({ id: "session:c", kind: "session" }),
        info({ id: "plain-ide", stopping: true }),
        info({ id: "session:d", kind: "session", stopping: true }),
      ].map((i) => [i.id, i]),
    );
    expect(stoppingSessionIds(infos)).toEqual(["a", "d"]);
    expect(stoppingSessionIds({})).toEqual([]);
    expect(sessionIdOfTerminal(sessionTerminalId("s:1"))).toBe("s:1");
    expect(sessionIdOfTerminal("plain-ide")).toBeNull();
    expect(sessionIdOfTerminal("session:")).toBeNull();
    // A Stop under way (Story 4.4) reads `stopping` until the child exits.
    expect(terminalStateText(info({ stopping: true }))).toBe("stopping");
    expect(terminalStateText(info({ stopping: true, exited: 0 }))).toBe("exited 0");
    expect(terminalStateText(info({ exited: -1, error: "could not start zsh: not found on PATH" }))).toBe(
      "could not start zsh: not found on PATH",
    );
  });

  it("mirrors Rust's plain and session terminal ids", () => {
    expect(plainTerminalId("ide")).toBe("plain-ide");
    expect(sessionTerminalId("3f2a")).toBe("session:3f2a");
  });
});
