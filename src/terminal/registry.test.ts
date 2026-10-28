// The view registry under vitest's node environment: xterm, its addons and the IPC layer are
// mocked, and `document` is a stub just big enough for the registry (elements that can be
// appended and removed, a root style that reads empty).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TermInfo } from "../ipc";

/** What the mocked `Terminal` records. */
class FakeTerminal {
  static last: FakeTerminal | null = null;
  /** Every instance made in this test, in order. */
  static all: FakeTerminal[] = [];
  /** How often `open()` ran: only a full view is ever opened (Story 9.5). */
  opened = 0;
  options: Record<string, unknown>;
  cols: number;
  rows: number;
  written: string[] = [];
  /** Writes not yet "parsed", in order (Story 9.5's answer markers too); `flushWrites` or `parse` runs them. */
  queue: { data: string; callback?: () => void }[] = [];
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
    FakeTerminal.all.push(this);
  }
  loadAddon(addon: { activate?: (term: FakeTerminal) => void }) {
    addon.activate?.(this);
  }
  open() {
    this.opened += 1;
  }
  write(data: string, callback?: () => void) {
    // An empty write is the registry's answer marker (Story 9.5): ordered, but no output.
    if (data !== "") this.written.push(data);
    this.queue.push({ data, callback });
  }
  /** Callbacks of writes not yet "parsed". */
  get pendingCallbacks(): (() => void)[] {
    return this.queue.flatMap((op) => (op.callback === undefined ? [] : [op.callback]));
  }
  flushWrites() {
    for (const op of this.queue.splice(0)) op.callback?.();
  }
  /** Parse up to the first queued write of `data`, which makes xterm answer `reply`, in write order. */
  parse(data: string, reply: string) {
    const at = this.queue.findIndex((op) => op.data === data);
    if (at < 0) throw new Error(`not queued: ${JSON.stringify(data)}`);
    const ops = this.queue.splice(0, at + 1);
    const last = ops.pop()!;
    for (const op of ops) op.callback?.();
    this.dataHandler?.(reply);
    last.callback?.();
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
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
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
  hasTauriRuntime: vi.fn(() => true),
  perfTyping: vi.fn(() => Promise.resolve()),
}));

type FakeElement = {
  className: string;
  parentElement: FakeElement | null;
  children: FakeElement[];
  appendChild: (child: FakeElement) => FakeElement;
  remove: () => void;
  /** Listeners added with `addEventListener` (Story 9.3's keydown stamp). */
  listeners: Record<string, ((event: unknown) => void)[]>;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
};

function element(): FakeElement {
  const el: FakeElement = {
    className: "",
    parentElement: null,
    children: [],
    listeners: {},
    addEventListener(type, listener) {
      (el.listeners[type] ??= []).push(listener);
    },
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

/** `actual` holds exactly the instances in `expected`, in order (identity, not deep equality). */
function expectSame<T>(actual: readonly T[], expected: readonly T[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((item, i) => expect(actual[i]).toBe(item));
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
  FakeTerminal.all = [];
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
    expect(registry.viewKind("t")).toBe("shadow");
    expect(FakeTerminal.last?.written).toEqual(["a", "b"]);
  });

  it("makes a hidden terminal's shadow at the PTY's size; showing adds a full view, hiding disposes it and keeps the shadow", async () => {
    const { registry, ipc, useTerminalStore } = await load();
    useTerminalStore.getState().upsert(info({ cols: 132, rows: 43 }));
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    const holder = element();
    registry.setHolder(holder as unknown as HTMLElement);
    registry.ensureView("t");
    const shadow = FakeTerminal.last!;
    expect([shadow.cols, shadow.rows]).toEqual([132, 43]);
    expect(shadow.options.scrollback).toBe(0);
    expect(shadow.opened).toBe(0);
    expect(holder.children).toHaveLength(0);
    expect(registry.viewRenderer("t")).toBeNull();
    const host = element();
    registry.showView("t", host as unknown as HTMLElement);
    const full = FakeTerminal.last!;
    expect(shadow.disposed).toBe(false);
    expect(full).not.toBe(shadow);
    expect(full.opened).toBe(1);
    expect(full.options.scrollback).toBe(5_000);
    expect([full.cols, full.rows]).toEqual([132, 43]);
    expect(host.children).toHaveLength(1);
    expect(registry.viewKind("t")).toBe("full");
    expect(registry.viewRenderer("t")).toBe("dom");
    registry.hideView("t");
    expect(full.disposed).toBe(true);
    expect(host.children).toHaveLength(0);
    expect(holder.children).toHaveLength(0);
    expect(registry.viewKind("t")).toBe("shadow");
    expect(shadow.disposed).toBe(false);
    expectSame(FakeTerminal.all, [shadow, full]);
    registry.showView("t", host as unknown as HTMLElement);
    const again = FakeTerminal.last!;
    registry.disposeView("t");
    expect(shadow.disposed).toBe(true);
    expect(again.disposed).toBe(true);
    expect(registry.hasView("t")).toBe(false);
  });
});

describe("view versions (Story 4.4)", () => {
  it("bump when a model is disposed, so the pane re-attaches a resumed session's fresh view; making one does not", async () => {
    const { registry, ipc } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    const seen: number[] = [];
    const stop = registry.subscribeViews(() => seen.push(registry.viewVersion("t")));
    registry.setHolder(element() as unknown as HTMLElement);
    expect(registry.viewVersion("t")).toBe(0);
    registry.ensureView("t");
    const first = FakeTerminal.last;
    expect(registry.viewVersion("t"), "making a model: no change").toBe(0);
    // A resume disposes the old view; the pane then shows a new one under the same id.
    registry.disposeView("t");
    expect(registry.viewVersion("t")).toBe(1);
    const host = element();
    registry.showView("t", host as unknown as HTMLElement);
    expect(FakeTerminal.last).not.toBe(first);
    expect(host.children).toHaveLength(1);
    expect(registry.viewVersion("t")).toBe(1);
    expect(seen).toEqual([1]);
    expect(registry.viewVersion("other")).toBe(0);
    stop();
    registry.disposeView("t");
    expect(seen, "unsubscribed").toHaveLength(1);
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
    term.parse("\x1b[6n", "\x1b[1;1R");
    expect(ipc.termWrite).not.toHaveBeenCalled();
    // A query in live output after the replay is answered.
    registry.writeIncoming("t", "\x1b[c", 7);
    term.parse("\x1b[c", "\x1b[?1;2c");
    expect(ipc.termWrite).toHaveBeenCalledTimes(1);
    expect(ipc.termWrite).toHaveBeenCalledWith("t", "\x1b[?1;2c");
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
    registry.syncSize("t"); // a shadow: nothing to fit
    expect(ipc.termResize).not.toHaveBeenCalled();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    proposed = undefined;
    registry.showView("t", element() as unknown as HTMLElement);
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
    registry.showView("t", element() as unknown as HTMLElement);
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
    registry.showView("t", element() as unknown as HTMLElement);
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
    const host = element() as unknown as HTMLElement;
    proposed = { cols: 90, rows: 25 };
    registry.showView("t", host);
    registry.syncSize("t"); // the pane fitted it: the last pane size
    expect(ipc.termResize).toHaveBeenLastCalledWith("t", 90, 25);
    await flush();
    handlers.popped({ id: "t", label: "term-1" });
    expect(useUiStore.getState().poppedOut).toEqual({ t: "term-1" });
    registry.syncSize("t");
    expect(ipc.termResize).toHaveBeenCalledTimes(1);
    // The pane shows the placeholder: the view goes, a shadow follows.
    registry.hideView("t");
    expect(registry.viewKind("t")).toBe("shadow");
    await flush();
    vi.mocked(ipc.termBuffer).mockClear();
    // The pop-out resized the PTY; the view comes back without the pane showing it.
    ipc.termBuffer.mockResolvedValue({ data: "after", offset: 5 });
    handlers.popped({ id: "t", label: null });
    expect(useUiStore.getState().poppedOut).toEqual({});
    expect(ipc.termResize).toHaveBeenCalledTimes(2);
    expect(ipc.termResize).toHaveBeenLastCalledWith("t", 90, 25);
    await flush();
    expect(ipc.termBuffer).toHaveBeenCalledWith("t");
    const tView = registry.ensureView("t")!.term as unknown as FakeTerminal;
    expect(tView.opened, "returned into the shadow").toBe(0);
    expect([tView.cols, tView.rows]).toEqual([90, 25]);
    expect(tView.written.slice(-2)).toEqual(["<reset>", "after"]);
    // The pane shows it again: its layout effect's own sync changes nothing more.
    registry.showView("t", host);
    registry.syncSize("t");
    expect(ipc.termResize).toHaveBeenCalledTimes(2);
    await flush();
    const replays = vi.mocked(ipc.termBuffer).mock.calls.length;
    // A second null (the reply after the event) does not replay again.
    registry.applyPopped("t", null);
    await flush();
    expect(ipc.termBuffer).toHaveBeenCalledTimes(replays);
    stop();
  });

  it("while popped out the main view sends no input (the pop-out answers the program)", async () => {
    const { registry, ipc, handlers, stop } = await connected();
    const term = registry.ensureView("t")!.term as unknown as FakeTerminal;
    handlers.popped({ id: "t", label: "term-1" });
    registry.writeIncoming("t", "\x1b[6n", 4);
    term.parse("\x1b[6n", "\x1b[1;1R");
    expect(ipc.termWrite).not.toHaveBeenCalled();
    handlers.popped({ id: "t", label: null });
    await flush();
    term.flushWrites();
    registry.writeIncoming("t", "\x1b[c", 7);
    term.parse("\x1b[c", "\x1b[?1;2c");
    expect(ipc.termWrite).toHaveBeenCalledTimes(1);
    expect(ipc.termWrite).toHaveBeenCalledWith("t", "\x1b[?1;2c");
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
    // The pane shows the tab it opened before the PTY exists.
    registry.showView("plain-ide", element() as unknown as HTMLElement);
    proposed = { cols: 111, rows: 33 };
    ipc.termOpen.mockResolvedValue(info({ id: "plain-ide", project_id: "ide", cols: 111, rows: 33 }));
    expect(await openProjectTerminal("ide")).toBe(true);
    expect(ipc.termOpen).toHaveBeenCalledWith("ide", 111, 33);
  });
});

describe("typing latency (Story 9.3)", () => {
  it("times a typed key from its keydown to the frame that draws its echo, and batches the sample to Rust", async () => {
    vi.useFakeTimers();
    try {
      const frames: (() => void)[] = [];
      vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
      let now = 1_000;
      vi.stubGlobal("performance", { now: () => now });
      const { registry, ipc } = await load();
      const holder = element();
      registry.setHolder(holder as unknown as HTMLElement);
      const host = element();
      registry.showView("t", host as unknown as HTMLElement);
      const term = FakeTerminal.last!;
      const view = host.children[0]!;
      const keydown = (key: string, timeStamp: number, mods: Partial<KeyboardEvent> = {}) =>
        view.listeners.keydown!.forEach((fn) => fn({ ...keyEvent(key, mods), timeStamp }));

      // A modifier chord is not typing: its output is written plainly.
      keydown("c", 990, { ctrlKey: true });
      term.dataHandler!("");
      registry.writeIncoming("t", "^C");
      expect(term.pendingCallbacks).toHaveLength(0);

      keydown("a", 1_000);
      now = 1_002;
      term.dataHandler!("a");
      expect(ipc.termWrite).toHaveBeenLastCalledWith("t", "a");
      now = 1_006;
      registry.writeIncoming("t", "a");
      // Output after the echo is not timed again.
      registry.writeIncoming("t", "b");
      expect(term.pendingCallbacks).toHaveLength(1);
      term.flushWrites();
      expect(frames).toHaveLength(1);
      now = 1_009;
      frames.shift()!();
      expect(ipc.perfTyping).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(ipc.perfTyping).toHaveBeenCalledWith([9]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time a key whose data went nowhere (popped out, main window), nor close it with a later key", async () => {
    vi.useFakeTimers();
    try {
      const frames: (() => void)[] = [];
      vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
      let now = 1_000;
      vi.stubGlobal("performance", { now: () => now });
      const { registry, ipc, useUiStore } = await load();
      const holder = element();
      registry.setHolder(holder as unknown as HTMLElement);
      const host = element();
      registry.showView("t", host as unknown as HTMLElement);
      const term = FakeTerminal.last!;
      const view = host.children[0]!;
      const keydown = (key: string, timeStamp: number) => view.listeners.keydown!.forEach((fn) => fn({ ...keyEvent(key), timeStamp }));

      useUiStore.setState({ poppedOut: { t: "term-1" } });
      keydown("a", 1_000);
      term.dataHandler!("a");
      expect(ipc.termWrite).not.toHaveBeenCalled();
      useUiStore.setState({ poppedOut: {} });

      // Back in the pane: the next key is timed from its own keydown, not the dropped one's.
      now = 1_200;
      keydown("b", 1_200);
      term.dataHandler!("b");
      now = 1_203;
      registry.writeIncoming("t", "b");
      term.flushWrites();
      now = 1_205;
      frames.shift()!();
      vi.advanceTimersByTime(1_000);
      expect(ipc.perfTyping).toHaveBeenCalledWith([5]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("full views only while shown (Story 9.5)", () => {
  type Buffer = { data: string; offset: number };
  type Ipc = Awaited<ReturnType<typeof load>>["ipc"];

  /** `term_buffer` replies held until the test gives them, in call order. */
  function heldBuffers(ipc: Ipc) {
    const answers: ((buffer: Buffer) => void)[] = [];
    const failures: ((err: unknown) => void)[] = [];
    ipc.termBuffer.mockImplementation(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          answers.push(resolve);
          failures.push(reject);
        }),
    );
    return { answers, failures };
  }

  const live = () => FakeTerminal.all.filter((t) => !t.disposed);
  const host = () => element() as unknown as HTMLElement;

  it("with 10 terminals and one shown, exactly one xterm is ever opened; every terminal has a scrollback-0 shadow", async () => {
    const { registry, ipc } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    registry.setHolder(element() as unknown as HTMLElement);
    for (let i = 0; i < 10; i += 1) registry.writeIncoming(`t${i}`, "x", 1);
    registry.showView("t3", host());
    await flush();
    expect(FakeTerminal.all.filter((t) => t.opened > 0)).toHaveLength(1);
    const opened = live().filter((t) => t.opened > 0);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.options.scrollback).toBe(5_000);
    const shadows = live().filter((t) => t.opened === 0);
    expect(shadows).toHaveLength(10);
    for (const shadow of shadows) expect(shadow.options.scrollback).toBe(0);
    expect(registry.viewKind("t3")).toBe("full");
  });

  it("show: a full view replays the ring with answers suppressed, then follows live output; the shadow keeps up, silent", async () => {
    const { registry, ipc } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "hello\x1b[6n", 9);
    const shadow = FakeTerminal.last!;
    const { answers } = heldBuffers(ipc);
    registry.showView("t", host());
    const full = FakeTerminal.last!;
    expect(shadow.disposed).toBe(false);
    expect(full.opened).toBe(1);
    // Live output during the replay waits for the full view; what the ring covers is dropped.
    registry.writeIncoming("t", "o\x1b[6n", 9);
    registry.writeIncoming("t", "more", 13);
    expect(full.written).toEqual([]);
    // The shadow takes it at once, de-duplicated by its own offset.
    expect(shadow.written).toEqual(["hello\x1b[6n", "more"]);
    answers[0]!({ data: "hello\x1b[6n", offset: 9 });
    await flush();
    expect(full.written).toEqual(["<reset>", "hello\x1b[6n", "more"]);
    expect(shadow.written, "a show leaves the shadow alone").toEqual(["hello\x1b[6n", "more"]);
    full.parse("hello\x1b[6n", "\x1b[1;6R");
    expect(ipc.termWrite).not.toHaveBeenCalled();
    full.flushWrites();
    // Live now: typing goes out.
    full.dataHandler!("x");
    expect(ipc.termWrite).toHaveBeenCalledTimes(1);
    expect(ipc.termWrite).toHaveBeenCalledWith("t", "x");
  });

  it("plainly shown, the full view answers a query once and the shadow is silent; after hide the shadow answers once", async () => {
    const { registry, ipc } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "x", 1);
    const shadow = FakeTerminal.last!;
    registry.showView("t", host());
    await flush();
    const full = FakeTerminal.last!;
    full.flushWrites();
    registry.writeIncoming("t", "\x1b[6n", 5);
    // Both parse the query; only the full view's answer goes out.
    shadow.parse("\x1b[6n", "\x1b[1;2R");
    expect(ipc.termWrite).not.toHaveBeenCalled();
    full.parse("\x1b[6n", "\x1b[1;2R");
    expect(ipc.termWrite).toHaveBeenCalledTimes(1);
    registry.hideView("t");
    registry.writeIncoming("t", "\x1b[c", 8);
    shadow.parse("\x1b[c", "\x1b[?1;2c");
    expect(ipc.termWrite).toHaveBeenCalledTimes(2);
    expect(ipc.termWrite).toHaveBeenLastCalledWith("t", "\x1b[?1;2c");
  });

  it("a query arriving between showView and the term_buffer reply is answered exactly once", async () => {
    const { registry, ipc } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "ab", 2);
    const shadow = FakeTerminal.last!;
    const { answers } = heldBuffers(ipc);
    registry.showView("t", host());
    const full = FakeTerminal.last!;
    registry.writeIncoming("t", "\x1b[6n", 6);
    answers[0]!({ data: "ab\x1b[6n", offset: 6 });
    await flush();
    // The shadow owned it on arrival; the full view parses it inside its replayed buffer.
    shadow.parse("\x1b[6n", "\x1b[1;3R");
    full.parse("ab\x1b[6n", "\x1b[1;3R");
    full.flushWrites();
    shadow.flushWrites();
    expect(ipc.termWrite).toHaveBeenCalledTimes(1);
    expect(ipc.termWrite).toHaveBeenCalledWith("t", "\x1b[1;3R");
  });

  it("a query arriving before showView but parsed after it is answered exactly once (ConPTY's start-up DSR)", async () => {
    const { registry, ipc } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    // Arrives while hidden; xterm has not parsed it yet when the pane shows the terminal.
    registry.writeIncoming("t", "\x1b[6n", 4);
    const shadow = FakeTerminal.last!;
    const { answers } = heldBuffers(ipc);
    registry.showView("t", host());
    const full = FakeTerminal.last!;
    answers[0]!({ data: "\x1b[6n", offset: 4 });
    await flush();
    shadow.parse("\x1b[6n", "\x1b[1;1R");
    full.parse("\x1b[6n", "\x1b[1;1R");
    expect(ipc.termWrite).toHaveBeenCalledTimes(1);
    expect(ipc.termWrite).toHaveBeenCalledWith("t", "\x1b[1;1R");
  });

  it("while popped out (main window) neither model answers", async () => {
    const { registry, ipc, useUiStore } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "x", 1);
    const shadow = FakeTerminal.last!;
    registry.showView("t", host());
    await flush();
    const full = FakeTerminal.last!;
    full.flushWrites();
    useUiStore.setState({ poppedOut: { t: "term-1" } });
    registry.writeIncoming("t", "\x1b[6n", 5);
    shadow.parse("\x1b[6n", "\x1b[1;2R");
    full.parse("\x1b[6n", "\x1b[1;2R");
    registry.hideView("t");
    registry.writeIncoming("t", "\x1b[c", 8);
    shadow.parse("\x1b[c", "\x1b[?1;2c");
    expect(ipc.termWrite).not.toHaveBeenCalled();
  });

  it("show: a failed term_buffer leaves the view empty, following live output, and is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { registry, ipc } = await load();
      registry.setHolder(element() as unknown as HTMLElement);
      registry.writeIncoming("t", "old", 3);
      const { failures } = heldBuffers(ipc);
      registry.showView("t", host());
      const full = FakeTerminal.last!;
      registry.writeIncoming("t", "new", 6);
      failures[0]!(new Error("gone"));
      await flush();
      expect(full.written).toEqual(["new"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("replay t"));
      registry.writeIncoming("t", "!", 7);
      expect(full.written).toEqual(["new", "!"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("hide: the full view (element and all) is disposed with no term_buffer call; the shadow kept the screen and follows on", async () => {
    const { registry, ipc } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    const holder = element();
    registry.setHolder(holder as unknown as HTMLElement);
    registry.writeIncoming("t", "ab", 2);
    const shadow = FakeTerminal.last!;
    const pane = element();
    registry.showView("t", pane as unknown as HTMLElement);
    await flush();
    const full = FakeTerminal.last!;
    registry.writeIncoming("t", "c", 3);
    ipc.termBuffer.mockClear();
    registry.hideView("t");
    expect(ipc.termBuffer).not.toHaveBeenCalled();
    expect(full.disposed).toBe(true);
    expect(pane.children).toHaveLength(0);
    expect(holder.children).toHaveLength(0);
    expect(registry.viewKind("t")).toBe("shadow");
    // The same shadow throughout: everything it was fed, in order, never reset.
    registry.writeIncoming("t", "cd", 4); // straddles its offset
    expect(shadow.written).toEqual(["ab", "c", "d"]);
    expect(shadow.resets).toBe(0);
    expectSame(live(), [shadow]);
    // Shown again: one replay, into the new full view only.
    registry.showView("t", pane as unknown as HTMLElement);
    await flush();
    expect(ipc.termBuffer).toHaveBeenCalledTimes(1);
    expect(shadow.resets).toBe(0);
  });

  it("a hidden terminal's shadow answers a query exactly once; never while replaying or popped out (main window)", async () => {
    const { registry, ipc, useUiStore } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    ipc.termBuffer.mockResolvedValue({ data: "\x1b[6n", offset: 4 });
    await registry.restore("t");
    const shadow = FakeTerminal.last!;
    expect(registry.viewKind("t")).toBe("shadow");
    shadow.parse("\x1b[6n", "\x1b[1;1R"); // the replayed query's answer
    expect(ipc.termWrite).not.toHaveBeenCalled();
    registry.writeIncoming("t", "q\x1b[6n", 9);
    shadow.parse("q\x1b[6n", "\x1b[2;1R");
    expect(ipc.termWrite).toHaveBeenCalledTimes(1);
    expect(ipc.termWrite).toHaveBeenCalledWith("t", "\x1b[2;1R");
    useUiStore.setState({ poppedOut: { t: "term-1" } });
    registry.writeIncoming("t", "\x1b[c", 12);
    shadow.parse("\x1b[c", "\x1b[?1;2c");
    expect(ipc.termWrite).toHaveBeenCalledTimes(1);
  });

  it("restore (reload, resume, return) replays into both models while shown, each de-duplicating by its own offset", async () => {
    const { registry, ipc } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "a", 1);
    const shadow = FakeTerminal.last!;
    registry.showView("t", host());
    await flush();
    const full = FakeTerminal.last!;
    const { answers } = heldBuffers(ipc);
    const replay = registry.restore("t");
    registry.writeIncoming("t", "bc", 3);
    registry.writeIncoming("t", "d", 4);
    expect(shadow.written.slice(-1)).toEqual(["a"]);
    answers[0]!({ data: "abc", offset: 3 });
    await replay;
    for (const t of [shadow, full]) expect(t.written.slice(-3)).toEqual(["<reset>", "abc", "d"]);
  });

  it("start hidden: a session launched while another terminal shows gets a shadow at the PTY's size that answers", async () => {
    const { registry, ipc, useTerminalStore } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    // No holder yet: its output waits, as before.
    registry.writeIncoming("s", "\x1b[6n", 4);
    expect(registry.hasView("s")).toBe(false);
    registry.setHolder(element() as unknown as HTMLElement);
    registry.showView("a", host());
    expect(registry.viewKind("s")).toBe("shadow");
    useTerminalStore.getState().upsert(info({ id: "u", cols: 120, rows: 40 }));
    registry.writeIncoming("u", "\x1b[6n", 4);
    const shadow = FakeTerminal.last!;
    expect(registry.viewKind("u")).toBe("shadow");
    expect([shadow.cols, shadow.rows]).toEqual([120, 40]);
    expect(shadow.opened).toBe(0);
    shadow.dataHandler!("\x1b[1;1R");
    expect(ipc.termWrite).toHaveBeenCalledTimes(1);
    expect(ipc.termWrite).toHaveBeenCalledWith("u", "\x1b[1;1R");
  });

  it("the shadow follows the PTY size the pane sends", async () => {
    const { registry, useTerminalStore } = await load();
    useTerminalStore.getState().upsert(info({ cols: 100, rows: 30 }));
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "x", 1);
    const shadow = FakeTerminal.last!;
    proposed = { cols: 90, rows: 25 };
    registry.showView("t", host());
    registry.syncSize("t");
    expect([shadow.cols, shadow.rows]).toEqual([90, 25]);
  });

  it("rapid toggles: show, hide and show before a replay ends leave the right models, consistent offsets, no stale writes", async () => {
    const { registry, ipc } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "ab", 2);
    const shadow = FakeTerminal.last!;
    const { answers } = heldBuffers(ipc);
    const pane = host();
    registry.showView("t", pane);
    const a = FakeTerminal.last!;
    registry.hideView("t");
    registry.showView("t", pane);
    const c = FakeTerminal.last!;
    expect(new Set([shadow, a, c]).size).toBe(3);
    expect(answers, "one replay per show, none for the hide").toHaveLength(2);
    registry.writeIncoming("t", "c", 3);
    registry.writeIncoming("t", "d", 4);
    answers[0]!({ data: "STALE-A", offset: 2 });
    await flush();
    expect(c.written, "a stale replay neither writes nor drains").toEqual([]);
    answers[1]!({ data: "abc", offset: 3 });
    await flush();
    expect(c.written).toEqual(["<reset>", "abc", "d"]);
    expect(a.written).toEqual([]);
    expect(shadow.written).toEqual(["ab", "c", "d"]);
    expectSame(live(), [shadow, c]);
    expect(c.opened).toBe(1);
    expect(registry.viewKind("t")).toBe("full");
    registry.writeIncoming("t", "d", 4);
    registry.writeIncoming("t", "e", 5);
    expect(c.written).toEqual(["<reset>", "abc", "d", "e"]);
    expect(shadow.written).toEqual(["ab", "c", "d", "e"]);
  });

  it("show and hide never bump the view version", async () => {
    const { registry, ipc } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "x", 1);
    const listener = vi.fn();
    const stop = registry.subscribeViews(listener);
    const pane = host();
    registry.showView("t", pane);
    registry.hideView("t");
    registry.showView("t", pane);
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(registry.viewVersion("t")).toBe(0);
    stop();
  });

  it("restart resets both models; resume on a hidden terminal: a replay overtaken by disposal writes nothing", async () => {
    const { registry, ipc } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "x", 1);
    const shadow = FakeTerminal.last!;
    const pane = host();
    registry.showView("t", pane);
    await flush();
    const full = FakeTerminal.last!;
    const before = [shadow.resets, full.resets];
    registry.resetView("t");
    expect([shadow.resets, full.resets]).toEqual([before[0]! + 1, before[1]! + 1]);
    registry.hideView("t");
    registry.resetView("t");
    expect(shadow.resets).toBe(before[0]! + 2);
    const { answers } = heldBuffers(ipc);
    const replay = registry.restore("t");
    registry.disposeView("t");
    expect(shadow.disposed).toBe(true);
    answers[0]!({ data: "old run", offset: 7 });
    await replay;
    expect(registry.hasView("t")).toBe(false);
    expect(FakeTerminal.all.some((t) => t.written.includes("old run"))).toBe(false);
    // The new run's output makes a fresh shadow.
    registry.writeIncoming("t", "new", 3);
    expect(registry.viewKind("t")).toBe("shadow");
    expect(FakeTerminal.last!.written).toEqual(["new"]);
  });

  it("a pop-out window's terminal has only its full view; hiding moves it to the holder", async () => {
    const { registry, ipc } = await load();
    ipc.termList.mockResolvedValue([info({ id: "t" })]);
    ipc.termBuffer.mockResolvedValue({ data: "hi", offset: 2 });
    const holder = element();
    registry.setHolder(holder as unknown as HTMLElement);
    const stop = registry.connectTerminals({ only: "t" });
    await flush();
    expect(registry.viewKind("t")).toBe("full");
    const view = FakeTerminal.last!;
    expect(view.written).toEqual(["<reset>", "hi"]);
    const pane = element();
    registry.showView("t", pane as unknown as HTMLElement);
    expect(pane.children).toHaveLength(1);
    registry.hideView("t");
    expect(view.disposed).toBe(false);
    expect(holder.children).toHaveLength(1);
    expectSame(FakeTerminal.all, [view]);
    stop();
  });

  it("a terminal shown before the holder mounts gets its full view and is sized when the holder comes", async () => {
    const { registry, ipc, useTerminalStore } = await load();
    useTerminalStore.getState().upsert(info());
    proposed = { cols: 90, rows: 25 };
    const pane = element();
    expect(registry.showView("t", pane as unknown as HTMLElement)).toBeNull();
    expect(registry.hasView("t")).toBe(false);
    registry.setHolder(element() as unknown as HTMLElement);
    expect(registry.viewKind("t")).toBe("full");
    expect(pane.children).toHaveLength(1);
    expect(ipc.termResize).toHaveBeenCalledTimes(1);
    expect(ipc.termResize).toHaveBeenCalledWith("t", 90, 25);
  });

  it("a shadow made before its info arrived takes the PTY size the store learns; not after disconnecting", async () => {
    const { registry, useTerminalStore } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    const stop = registry.connectTerminals();
    registry.writeIncoming("s", "x", 1);
    const shadow = FakeTerminal.last!;
    expect([shadow.cols, shadow.rows]).toEqual([80, 24]);
    useTerminalStore.getState().upsert(info({ id: "s", cols: 120, rows: 40 }));
    expect([shadow.cols, shadow.rows]).toEqual([120, 40]);
    stop();
    useTerminalStore.getState().setSize("s", 100, 30);
    expect([shadow.cols, shadow.rows]).toEqual([120, 40]);
  });

  it("a pop-out shown before connecting drops the shadow its show made; replays go into the full view only", async () => {
    const { registry, ipc } = await load();
    ipc.termList.mockResolvedValue([info({ id: "t" })]);
    ipc.termBuffer.mockResolvedValue({ data: "hi", offset: 2 });
    registry.setHolder(element() as unknown as HTMLElement);
    // The window's layout effect runs before its connect effect.
    registry.showView("t", host());
    expect(FakeTerminal.all).toHaveLength(2);
    const [shadow, full] = FakeTerminal.all as [FakeTerminal, FakeTerminal];
    expect(shadow.opened).toBe(0);
    const stop = registry.connectTerminals({ only: "t" });
    expect(shadow.disposed).toBe(true);
    await flush();
    expectSame(live(), [full]);
    expect(full.written).toEqual(["<reset>", "hi"]);
    expect(shadow.written).toEqual([]);
    stop();
  });

  it("disposeView forgets the host: a late write makes a shadow, not a full view in the stale host", async () => {
    const { registry, ipc } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    registry.setHolder(element() as unknown as HTMLElement);
    const pane = element();
    registry.showView("t", pane as unknown as HTMLElement);
    registry.disposeView("t");
    expect(pane.children).toHaveLength(0);
    registry.writeIncoming("t", "late", 4);
    expect(registry.viewKind("t")).toBe("shadow");
    expect(pane.children).toHaveLength(0);
    expect(FakeTerminal.last!.opened).toBe(0);
  });

  it("focusView on a terminal with only a shadow does nothing", async () => {
    const { registry } = await load();
    registry.setHolder(element() as unknown as HTMLElement);
    registry.writeIncoming("t", "x", 1);
    registry.focusView("t");
    expect(FakeTerminal.last!.focused).toBe(0);
  });

  it("hiding in the main window a terminal whose slot has no shadow makes one and replays the ring into it", async () => {
    const { registry, ipc } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    registry.setHolder(element() as unknown as HTMLElement);
    registry.showView("t", host());
    // A window that was a pop-out (its shadow dropped) and then connects as the main window.
    registry.connectTerminals({ only: "t" })();
    registry.connectTerminals()();
    const full = FakeTerminal.last!;
    expect(live()).toHaveLength(1);
    ipc.termBuffer.mockResolvedValue({ data: "abc", offset: 3 });
    registry.hideView("t");
    expect(full.disposed).toBe(true);
    const shadow = FakeTerminal.last!;
    expect(shadow).not.toBe(full);
    expect(shadow.opened).toBe(0);
    await flush();
    expect(shadow.written).toEqual(["<reset>", "abc"]);
    expect(registry.viewKind("t")).toBe("shadow");
  });

  it("a WebGL full view loses its canvases' GL contexts when hidden and when disposed", async () => {
    vi.stubGlobal("WebGL2RenderingContext", class {});
    const loseContext = vi.fn();
    const canvas = () => ({ getContext: (kind: string) => (kind === "webgl2" ? { getExtension: () => ({ loseContext }) } : null) });
    vi.stubGlobal("document", {
      createElement: () => Object.assign(element(), { querySelectorAll: () => [canvas(), canvas()] }),
      documentElement: {},
    });
    const { registry, ipc } = await load();
    ipc.termBuffer.mockResolvedValue({ data: "", offset: 0 });
    registry.setHolder(element() as unknown as HTMLElement);
    const pane = host();
    registry.showView("t", pane);
    expect(registry.viewRenderer("t")).toBe("webgl");
    registry.hideView("t");
    expect(loseContext).toHaveBeenCalledTimes(2);
    registry.showView("t", pane);
    registry.disposeView("t");
    expect(loseContext).toHaveBeenCalledTimes(4);
  });
});
