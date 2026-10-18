// The view registry under vitest's node environment: xterm, its addons and the IPC layer are
// mocked, and `document` is a stub just big enough for the registry (elements that can be
// appended and removed, a root style that reads empty).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TermInfo } from "../ipc";

/** What the mocked `Terminal` records. */
class FakeTerminal {
  static last: FakeTerminal | null = null;
  options: Record<string, unknown>;
  cols: number;
  rows: number;
  written: string[] = [];
  /** Callbacks of writes not yet "parsed"; `flushWrites` runs them. */
  pendingCallbacks: (() => void)[] = [];
  resets = 0;
  focused = 0;
  blurred = 0;
  disposed = false;
  dataHandler: ((data: string) => void) | null = null;
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  unicode = { activeVersion: "6" };
  selection = "";
  pasted: string[] = [];

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.cols = (options.cols as number | undefined) ?? 80;
    this.rows = (options.rows as number | undefined) ?? 24;
    FakeTerminal.last = this;
  }
  loadAddon(addon: { activate?: (term: FakeTerminal) => void }) {
    addon.activate?.(this);
  }
  open() {}
  write(data: string, callback?: () => void) {
    this.written.push(data);
    if (callback !== undefined) this.pendingCallbacks.push(callback);
  }
  flushWrites() {
    this.pendingCallbacks.splice(0).forEach((cb) => cb());
  }
  reset() {
    this.resets += 1;
    this.written.push("<reset>");
  }
  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  focus() {
    this.focused += 1;
  }
  blur() {
    this.blurred += 1;
  }
  dispose() {
    this.disposed = true;
  }
  hasSelection() {
    return this.selection !== "";
  }
  getSelection() {
    return this.selection;
  }
  paste(text: string) {
    this.pasted.push(text);
  }
}

/** The size the mocked fit addon proposes (`undefined`: cannot measure). */
let proposed: { cols: number; rows: number } | undefined;

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    term: FakeTerminal | null = null;
    activate(term: FakeTerminal) {
      this.term = term;
    }
    proposeDimensions() {
      return proposed;
    }
    fit() {
      if (proposed !== undefined) this.term?.resize(proposed.cols, proposed.rows);
    }
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("../ipc", () => ({
  termBuffer: vi.fn(),
  termWrite: vi.fn(() => Promise.resolve()),
  termResize: vi.fn(() => Promise.resolve()),
  termList: vi.fn(() => Promise.resolve([])),
  termOpen: vi.fn(),
  termKill: vi.fn(() => Promise.resolve()),
  termRestart: vi.fn(),
  onTermData: vi.fn(() => Promise.resolve(() => {})),
  onTermExit: vi.fn(() => Promise.resolve(() => {})),
  onTermInfo: vi.fn(() => Promise.resolve(() => {})),
  onTermClosed: vi.fn(() => Promise.resolve(() => {})),
  onTermPopped: vi.fn(() => Promise.resolve(() => {})),
  termPopped: vi.fn(() => Promise.resolve([])),
  termPopOut: vi.fn(),
  termReturn: vi.fn(() => Promise.resolve()),
  workspaceRemoveProject: vi.fn(),
}));

type FakeElement = {
  className: string;
  parentElement: FakeElement | null;
  children: FakeElement[];
  appendChild: (child: FakeElement) => FakeElement;
  remove: () => void;
};

function element(): FakeElement {
  const el: FakeElement = {
    className: "",
    parentElement: null,
    children: [],
    appendChild(child) {
      child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1);
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    remove() {
      el.parentElement?.children.splice(el.parentElement.children.indexOf(el), 1);
      el.parentElement = null;
    },
  };
  return el;
}

function info(overrides: Partial<TermInfo> = {}): TermInfo {
  return { id: "t", kind: "plain", project_id: "p", title: "p", cwd: "/p", exited: null, error: null, cols: 100, rows: 30, stopping: false, ...overrides };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Fresh registry, store and mocks per test (the registry keeps module state). */
async function load() {
  vi.resetModules();
  const registry = await import("./registry");
  const ipc = await import("../ipc");
  const { useTerminalStore } = await import("../state/terminals");
  const { useUiStore } = await import("../state/ui");
  useTerminalStore.setState({ infos: {}, pendingExits: {} });
  // Mock implementations outlive `resetModules`: the ones a test may change start over.
  vi.mocked(ipc).termPopped.mockResolvedValue([]);
  vi.mocked(ipc).termList.mockResolvedValue([]);
  return { registry, ipc: vi.mocked(ipc), useTerminalStore, useUiStore };
}

function keyEvent(key: string, mods: Partial<KeyboardEvent> = {}) {
  const event = {
    type: "keydown",
    key,
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    ...mods,
  };
  return event as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  proposed = undefined;
  FakeTerminal.last = null;
  vi.stubGlobal("document", { createElement: () => element(), documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("views and the hidden holder", () => {
  it("queues output until the holder mounts, then writes it in order", async () => {
    const { registry } = await load();
    registry.writeIncoming("t", "a", 1);
    registry.writeIncoming("t", "b", 2);
    expect(registry.hasView("t")).toBe(false);
    registry.setHolder(element() as unknown as HTMLElement);
    expect(registry.hasView("t")).toBe(true);
    expect(FakeTerminal.last?.written).toEqual(["a", "b"]);
  });

  it("makes a hidden view at the PTY's size and moves it between holder and pane", async () => {
    const { registry, useTerminalStore } = await load();
    useTerminalStore.getState().upsert(info({ cols: 132, rows: 43 }));
    const holder = element();
    registry.setHolder(holder as unknown as HTMLElement);
    registry.ensureView("t");
    const term = FakeTerminal.last!;
    expect([term.cols, term.rows]).toEqual([132, 43]);
    expect(term.options.scrollback).toBe(10_000);
    const host = element();
    registry.showView("t", host as unknown as HTMLElement);
    expect(host.children).toHaveLength(1);
    registry.hideView("t");
    expect(host.children).toHaveLength(0);
    expect(holder.children).toHaveLength(1);
    expect(term.blurred).toBe(1);
    registry.disposeView("t");
    expect(term.disposed).toBe(true);
    expect(registry.hasView("t")).toBe(false);
  });
});

describe("view versions (Story 4.4)", () => {
  it("bump when a view is made or disposed, so the pane re-attaches a resumed session's fresh view", async () => {
    const { registry } = await load();
    const seen: number[] = [];
    const stop = registry.subscribeViews(() => seen.push(registry.viewVersion("t")));
    registry.setHolder(element() as unknown as HTMLElement);
    expect(registry.viewVersion("t")).toBe(0);
    registry.ensureView("t");
    const first = FakeTerminal.last;
    expect(registry.viewVersion("t")).toBe(1);
    registry.ensureView("t");
    expect(registry.viewVersion("t"), "the same view: no change").toBe(1);
    // A resume disposes the old view; the pane then shows a new one under the same id.
    registry.disposeView("t");
    const host = element();
    registry.showView("t", host as unknown as HTMLElement);
    expect(FakeTerminal.last).not.toBe(first);
    expect(host.children).toHaveLength(1);
    expect(registry.viewVersion("t")).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
    expect(registry.viewVersion("other")).toBe(0);
    stop();
    registry.disposeView("t");
    expect(seen, "unsubscribed").toHaveLength(3);
  });
});

describe("offsets", () => {
  it("drops output a view already has and cuts a chunk that straddles its offset", async () => {
    const { registry } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "abc", 3);
    registry.writeIncoming("t", "bc", 3);
    registry.writeIncoming("t", "cdé", 7); // c (3) d (4) é (5..7): starts at 3, view is at 3
    registry.writeIncoming("t", "éf", 8); // starts at 5, view at 7: only "f"
    expect(FakeTerminal.last?.written).toEqual(["abc", "cdé", "f"]);
  });
});

describe("replay", () => {
  it("resets, writes the buffer, then only the live output the buffer did not cover", async () => {
    const { registry, ipc } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    let answer: (value: { data: string; offset: number }) => void = () => {};
    ipc.termBuffer.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const replay = registry.restore("t");
    // Live output while the buffer is on its way: queued.
    registry.writeIncoming("t", "old", 3);
    registry.writeIncoming("t", "new", 6);
    expect(FakeTerminal.last?.written ?? []).toEqual([]);
    answer({ data: "old", offset: 3 });
    await replay;
    expect(FakeTerminal.last?.written).toEqual(["<reset>", "old", "new"]);
  });

  it("does not send the view's answers to queries in the replayed buffer", async () => {
    const { registry, ipc } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    ipc.termBuffer.mockResolvedValue({ data: "\x1b[6n", offset: 4 });
    await registry.restore("t");
    const term = FakeTerminal.last!;
    term.dataHandler?.("\x1b[1;1R");
    expect(ipc.termWrite).not.toHaveBeenCalled();
    term.flushWrites();
    term.dataHandler?.("x");
    expect(ipc.termWrite).toHaveBeenCalledWith("t", "x");
  });
});

describe("handleKey", () => {
  it("returns true only for the terminal's own keys and does copy and paste itself", async () => {
    const { registry } = await load();
    const clipboard = { writeText: vi.fn(() => Promise.resolve()), readText: vi.fn(() => Promise.resolve("pasted")) };
    vi.stubGlobal("navigator", { clipboard, userAgent: "" });
    const term = { hasSelection: () => true, getSelection: () => "sel", paste: vi.fn() };

    expect(registry.handleKey(term, keyEvent("c", { ctrlKey: true }))).toBe(true);
    expect(registry.handleKey(term, keyEvent("Escape"))).toBe(true);

    const toggle = keyEvent("`", { ctrlKey: true });
    expect(registry.handleKey(term, toggle)).toBe(false);
    expect(toggle.preventDefault).not.toHaveBeenCalled();
    expect(registry.handleKey(term, keyEvent("K", { ctrlKey: true, shiftKey: true }))).toBe(false);

    const copy = keyEvent("C", { ctrlKey: true, shiftKey: true });
    expect(registry.handleKey(term, copy)).toBe(false);
    expect(copy.preventDefault).toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledWith("sel");

    const paste = keyEvent("V", { ctrlKey: true, shiftKey: true });
    expect(registry.handleKey(term, paste)).toBe(false);
    expect(paste.preventDefault).toHaveBeenCalled();
    await flush();
    expect(term.paste).toHaveBeenCalledWith("pasted");

    // ctrl+v: left to the webview's paste event.
    const native = keyEvent("v", { ctrlKey: true });
    expect(registry.handleKey(term, native)).toBe(false);
    expect(native.preventDefault).not.toHaveBeenCalled();
    expect(term.paste).toHaveBeenCalledTimes(1);

    // Alt+F4 closes the window: xterm stays out and nothing prevents the default (Story 4.5).
    const close = keyEvent("F4", { altKey: true });
    expect(registry.handleKey(term, close)).toBe(false);
    expect(close.preventDefault).not.toHaveBeenCalled();
  });

  it("in a pop-out, the app's pass-through keys are the terminal's (no dispatcher there); Alt+F4 still closes", async () => {
    const { registry } = await load();
    const stop = registry.connectTerminals({ only: "t" });
    const term = { hasSelection: () => false, getSelection: () => "", paste: vi.fn() };
    for (const k of [keyEvent("PageUp", { ctrlKey: true }), keyEvent("PageDown", { ctrlKey: true }), keyEvent("`", { ctrlKey: true }), keyEvent("K", { ctrlKey: true, shiftKey: true })]) {
      expect(registry.handleKey(term, k), k.key).toBe(true);
    }
    const close = keyEvent("F4", { altKey: true });
    expect(registry.handleKey(term, close)).toBe(false);
    expect(close.preventDefault).not.toHaveBeenCalled();
    stop();
  });
});

describe("syncSize", () => {
  it("sends the fitted size only for a known terminal and only when it changed", async () => {
    const { registry, ipc, useTerminalStore } = await load();
    registry.syncSize("t"); // no view
    registry.setHolder(element() as unknown as HTMLElement);
    registry.ensureView("t");
    proposed = { cols: 90, rows: 25 };
    registry.syncSize("t"); // Rust does not know it yet
    expect(ipc.termResize).not.toHaveBeenCalled();
    useTerminalStore.getState().upsert(info());
    registry.syncSize("t");
    registry.syncSize("t");
    expect(ipc.termResize).toHaveBeenCalledTimes(1);
    expect(ipc.termResize).toHaveBeenCalledWith("t", 90, 25);
    expect(useTerminalStore.getState().infos.t).toMatchObject({ cols: 90, rows: 25 });
    proposed = undefined; // cannot measure: nothing sent
    registry.syncSize("t");
    expect(ipc.termResize).toHaveBeenCalledTimes(1);
  });
});

describe("pop-outs (Story 4.5)", () => {
  it("the main window sends no size for a popped-out terminal, and one for the pane on its return", async () => {
    const { registry, ipc, useTerminalStore } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    registry.ensureView("t");
    useTerminalStore.getState().upsert(info());
    proposed = { cols: 90, rows: 25 };
    registry.syncSize("t");
    expect(ipc.termResize).toHaveBeenCalledTimes(1);
    registry.applyPopped("t", "term-1");
    proposed = { cols: 70, rows: 20 };
    registry.syncSize("t");
    expect(ipc.termResize).toHaveBeenCalledTimes(1);
    // Back in the pane at the size it had before: the pop-out resized the PTY, so it is sent again.
    registry.applyPopped("t", null);
    proposed = { cols: 90, rows: 25 };
    registry.syncSize("t");
    expect(ipc.termResize).toHaveBeenCalledTimes(2);
    expect(ipc.termResize).toHaveBeenLastCalledWith("t", 90, 25);
    registry.syncSize("t");
    expect(ipc.termResize).toHaveBeenCalledTimes(2);
  });

  it("a pop-out follows its own terminal only and replays its buffer into a view it made already", async () => {
    const { registry, ipc, useTerminalStore } = await load();
    let onData: (data: { id: string; data: string; offset: number }) => void = () => {};
    ipc.onTermData.mockImplementation((cb) => {
      onData = cb;
      return Promise.resolve(() => {});
    });
    ipc.termList.mockResolvedValue([info({ id: "t" }), info({ id: "other" })]);
    ipc.termBuffer.mockResolvedValue({ data: "hello", offset: 5 });
    registry.setHolder(element() as unknown as HTMLElement);
    // The window shows its terminal before the list arrives.
    registry.ensureView("t");
    const term = FakeTerminal.last!;
    const stop = registry.connectTerminals({ only: "t" });
    await flush();
    onData({ id: "other", data: "nope", offset: 4 });
    onData({ id: "t", data: "lo!", offset: 6 });
    await flush();
    expect(Object.keys(useTerminalStore.getState().infos)).toEqual(["t"]);
    expect(registry.hasView("other")).toBe(false);
    expect(term.written).toEqual(["<reset>", "hello", "!"]);
    expect(registry.popOutTerminal()).toBe("t");
    // A pop-out never listens for pop-outs.
    expect(ipc.onTermPopped).not.toHaveBeenCalled();
    expect(ipc.termPopped).not.toHaveBeenCalled();
    stop();
  });

  it("a reloaded main window picks up which terminals are popped out", async () => {
    const { registry, ipc, useUiStore } = await load();
    ipc.termList.mockResolvedValue([]);
    ipc.termPopped.mockResolvedValue([{ id: "t", label: "term-3" }]);
    const stop = registry.connectTerminals();
    await flush();
    expect(useUiStore.getState().poppedOut).toEqual({ t: "term-3" });
    expect(registry.popOutTerminal()).toBeNull();
    stop();
  });
});

describe("pop-out events in the main window (Story 4.5)", () => {
  type Handlers = {
    popped: (p: { id: string; label: string | null }) => void;
    info: (i: TermInfo) => void;
    closed: (c: { id: string }) => void;
    exit: (e: { id: string; code: number | null }) => void;
  };

  async function connected(options: { only?: string; onClosed?: (id: string) => void } = {}) {
    const loaded = await load();
    const { ipc } = loaded;
    const handlers = {} as Handlers;
    ipc.onTermPopped.mockImplementation((cb) => {
      handlers.popped = cb;
      return Promise.resolve(() => {});
    });
    ipc.onTermInfo.mockImplementation((cb) => {
      handlers.info = cb;
      return Promise.resolve(() => {});
    });
    ipc.onTermClosed.mockImplementation((cb) => {
      handlers.closed = cb;
      return Promise.resolve(() => {});
    });
    ipc.onTermExit.mockImplementation((cb) => {
      handlers.exit = cb;
      return Promise.resolve(() => {});
    });
    ipc.termList.mockResolvedValue([info({ id: "t" }), info({ id: "u" })]);
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    loaded.registry.setHolder(element() as unknown as HTMLElement);
    const stop = loaded.registry.connectTerminals(options);
    await flush();
    vi.mocked(ipc.termBuffer).mockClear();
    return { ...loaded, handlers, stop };
  }

  it("popped, then back: no size while out, the pane's size (even with the tab hidden) and a fresh replay on return", async () => {
    const { registry, ipc, handlers, useUiStore, stop } = await connected();
    proposed = { cols: 90, rows: 25 };
    registry.syncSize("t"); // the pane fitted it: the last pane size
    expect(ipc.termResize).toHaveBeenLastCalledWith("t", 90, 25);
    handlers.popped({ id: "t", label: "term-1" });
    expect(useUiStore.getState().poppedOut).toEqual({ t: "term-1" });
    registry.syncSize("t");
    expect(ipc.termResize).toHaveBeenCalledTimes(1);
    // The pop-out resized the PTY; the view comes back without the pane showing it.
    ipc.termBuffer.mockResolvedValue({ data: "after", offset: 5 });
    handlers.popped({ id: "t", label: null });
    expect(useUiStore.getState().poppedOut).toEqual({});
    expect(ipc.termResize).toHaveBeenCalledTimes(2);
    expect(ipc.termResize).toHaveBeenLastCalledWith("t", 90, 25);
    await flush();
    expect(ipc.termBuffer).toHaveBeenCalledWith("t");
    const tView = registry.ensureView("t")!.term as unknown as FakeTerminal;
    expect(tView.written.slice(-2)).toEqual(["<reset>", "after"]);
    // The layout effect's own sync on return changes nothing more.
    registry.syncSize("t");
    expect(ipc.termResize).toHaveBeenCalledTimes(2);
    // A second null (the reply after the event) does not replay again.
    registry.applyPopped("t", null);
    await flush();
    expect(ipc.termBuffer).toHaveBeenCalledTimes(1);
    stop();
  });

  it("while popped out the main view sends no input (the pop-out answers the program)", async () => {
    const { registry, ipc, handlers, stop } = await connected();
    const term = registry.ensureView("t")!.term as unknown as FakeTerminal;
    handlers.popped({ id: "t", label: "term-1" });
    term.dataHandler?.("\x1b[1;1R");
    expect(ipc.termWrite).not.toHaveBeenCalled();
    handlers.popped({ id: "t", label: null });
    await flush();
    term.flushWrites();
    term.dataHandler?.("x");
    expect(ipc.termWrite).toHaveBeenCalledWith("t", "x");
    stop();
  });

  it("term://info resets a view restarted elsewhere (not one this window restarts); term://closed forgets", async () => {
    const onClosed = vi.fn();
    const { registry, handlers, useTerminalStore, stop } = await connected({ onClosed });
    const term = registry.ensureView("t")!.term as unknown as FakeTerminal;
    const base = term.resets; // the replay on connect
    handlers.exit({ id: "t", code: 0 });
    handlers.info(info({ id: "t" }));
    expect(term.resets).toBe(base + 1);
    expect(useTerminalStore.getState().infos.t?.exited).toBeNull();
    handlers.exit({ id: "t", code: 0 });
    registry.markRestarting("t", true);
    handlers.info(info({ id: "t" }));
    expect(term.resets).toBe(base + 1);
    registry.markRestarting("t", false);
    // A running info for a running terminal resets nothing; an unknown terminal is ignored.
    handlers.info(info({ id: "t", title: "renamed" }));
    expect(term.resets).toBe(base + 1);
    expect(useTerminalStore.getState().infos.t?.title).toBe("renamed");
    handlers.info(info({ id: "nope" }));
    expect(useTerminalStore.getState().infos.nope).toBeUndefined();
    handlers.closed({ id: "u" });
    expect(onClosed).toHaveBeenCalledWith("u");
    stop();
  });

  it("a pop-out ignores info and closed for other terminals", async () => {
    const onClosed = vi.fn();
    const { handlers, useTerminalStore, stop } = await connected({ only: "t", onClosed });
    expect(Object.keys(useTerminalStore.getState().infos)).toEqual(["t"]);
    handlers.info(info({ id: "u", title: "other" }));
    expect(useTerminalStore.getState().infos.u).toBeUndefined();
    handlers.closed({ id: "u" });
    expect(onClosed).not.toHaveBeenCalled();
    handlers.closed({ id: "t" });
    expect(onClosed).toHaveBeenCalledWith("t");
    stop();
  });
});

describe("openProjectTerminal", () => {
  it("opens the PTY at the pane's fitted size", async () => {
    const { registry, ipc } = await load();
    const { openProjectTerminal } = await import("../commands/terminal");
    registry.setHolder(element() as unknown as HTMLElement);
    registry.ensureView("plain-ide");
    proposed = { cols: 111, rows: 33 };
    ipc.termOpen.mockResolvedValue(info({ id: "plain-ide", project_id: "ide", cols: 111, rows: 33 }));
    expect(await openProjectTerminal("ide")).toBe(true);
    expect(ipc.termOpen).toHaveBeenCalledWith("ide", 111, 33);
  });
});
