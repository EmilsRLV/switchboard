// The xterm views, one per terminal Rust runs (Story 4.1). A module-level registry, not state:
// a `Terminal` is created once per id and never disposed while its terminal exists, so output
// keeps arriving whether the pane shows it or not. Its element sits in the always-mounted
// hidden holder (`TerminalHolder`) and moves into the pane's host when shown, back when hidden,
// so reopening shows everything. A view created after output began (a reload) first writes
// `term_buffer`, then follows `term://data`, dropping what the buffer already covered (every
// chunk carries the byte offset it ends at).
//
// Story 4.5: a pop-out window runs the same registry for one terminal (`connectTerminals({ only })`)
// with a view of its own, replayed from `term_buffer`. Whichever window owns the PTY's size sends
// `term_resize`: the pop-out while it is open, else the main pane (`syncSize` skips a popped-out
// terminal in the main window).
//
// WebGL renders when it can; when it cannot load, or its context is lost, the view switches to
// xterm's DOM renderer for the rest of its life.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  onTermClosed,
  onTermData,
  onTermExit,
  onTermInfo,
  onTermPopped,
  termBuffer,
  termList,
  termPopped,
  termResize,
  termWrite,
} from "../ipc";
import { terminalInfo, useTerminalStore } from "../state/terminals";
import { isPoppedOut, useUiStore } from "../state/ui";
import { terminalKeyAction } from "./keys";
import { buildFont, buildTheme, documentTokens } from "./theme";

/** Lines of scrollback each view keeps. */
export const SCROLLBACK = 10_000;

export type Renderer = "webgl" | "dom";

export type TermSize = { cols: number; rows: number };

type View = {
  id: string;
  term: Terminal;
  fit: FitAddon;
  /** The element xterm was opened in; moved between the holder and the pane. */
  element: HTMLDivElement;
  renderer: Renderer;
  /** The size last sent to Rust. */
  sent: TermSize | null;
  /** The output byte offset this view has written up to; `null` until a chunk says. */
  offset: number | null;
  /**
   * True while a replayed buffer is being parsed: the answers xterm would give to the old
   * queries in it (cursor position, device attributes) must not reach the new shell.
   */
  replaying: boolean;
};

/** A chunk of output and the byte offset it ends at (`null`: unknown, written as it is). */
type Chunk = { data: string; offset: number | null };

const views = new Map<string, View>();
/** Output that arrived while a view could not be made yet (no holder mounted), in order. */
const early = new Map<string, Chunk[]>();
/** Terminals whose buffer is being replayed: their live output waits here, in order. */
const replaying = new Map<string, Chunk[]>();
let holder: HTMLElement | null = null;
/** The one terminal this window follows when it is a pop-out (Story 4.5); `null` in the main window. */
let only: string | null = null;
/** The size the main window's pane last fitted a terminal to: what a returning pop-out gets. */
let paneSize: TermSize | null = null;
/** `term://popped` events seen per terminal: a pop-out / return reply older than one is not applied. */
const poppedEvents = new Map<string, number>();
/** Terminals this window is restarting: their own `term://info` must not reset the view again. */
const restarting = new Set<string>();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function log(what: string, err: unknown): void {
  console.warn(`terminal: ${what}: ${err instanceof Error ? err.message : String(err)}`);
}

/** Register the hidden holder (or `null` when it unmounts). Views waiting for it are made now. */
export function setHolder(element: HTMLElement | null): void {
  holder = element;
  if (element === null) return;
  for (const [id, chunks] of [...early]) {
    early.delete(id);
    for (const chunk of chunks) writeIncoming(id, chunk.data, chunk.offset);
  }
}

/**
 * A counter per id, bumped whenever its view instance is made or disposed (Story 4.4: a resumed
 * session's terminal gets a fresh view under the same id). The pane re-attaches when it changes,
 * not only when the id does, so it never keeps showing a disposed view.
 */
const versions = new Map<string, number>();
const versionListeners = new Set<() => void>();

function bumpVersion(id: string): void {
  versions.set(id, (versions.get(id) ?? 0) + 1);
  for (const listener of versionListeners) listener();
}

/** The current view version of `id` (see `subscribeViews`). */
export function viewVersion(id: string): number {
  return versions.get(id) ?? 0;
}

/** Be told whenever any view is made or disposed; returns the unsubscribe function. */
export function subscribeViews(listener: () => void): () => void {
  versionListeners.add(listener);
  return () => versionListeners.delete(listener);
}

export function hasView(id: string): boolean {
  return views.has(id);
}

/** The renderer a view uses, or `null` without a view. */
export function viewRenderer(id: string): Renderer | null {
  return views.get(id)?.renderer ?? null;
}

/**
 * The view of `id`, made (and opened in the holder) when missing, at the PTY's size when Rust
 * told us one; `null` without a holder.
 */
export function ensureView(id: string): View | null {
  const existing = views.get(id);
  if (existing !== undefined) return existing;
  if (holder === null || typeof document === "undefined") return null;
  const view = createView(id, holder);
  views.set(id, view);
  bumpVersion(id);
  return view;
}

function createView(id: string, parent: HTMLElement): View {
  const tokens = documentTokens();
  const info = terminalInfo(id);
  const term = new Terminal({
    scrollback: SCROLLBACK,
    theme: buildTheme(tokens),
    ...buildFont(tokens),
    ...(info !== null ? { cols: info.cols, rows: info.rows } : {}),
    allowProposedApi: true,
    ...(isWindows() ? { windowsPty: { backend: "conpty" as const } } : {}),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  // Links are recognised (underlined on hover) but never open a browser.
  term.loadAddon(new WebLinksAddon(() => {}));
  const element = document.createElement("div");
  element.className = "terminal-view";
  parent.appendChild(element);
  term.open(element);
  const view: View = { id, term, fit, element, renderer: "dom", sent: null, offset: null, replaying: false };
  loadWebgl(view);

  term.attachCustomKeyEventHandler((event) => handleKey(term, event));
  term.onData((data) => {
    // While popped out, only the pop-out's view answers the program (its queries, DSR / DA).
    if (view.replaying || (only === null && isPoppedOut(id))) return;
    termWrite(id, data).catch((err: unknown) => log(`write to ${id}`, err));
  });
  return view;
}

function isWindows(): boolean {
  return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
}

/** Try the WebGL renderer; on failure or a lost context, the DOM renderer for good. */
function loadWebgl(view: View): void {
  if (typeof WebGL2RenderingContext === "undefined") return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      view.renderer = "dom";
      webgl.dispose();
    });
    view.term.loadAddon(webgl);
    view.renderer = "webgl";
  } catch (err) {
    view.renderer = "dom";
    log("WebGL unavailable, using the DOM renderer", err);
  }
}

/** The slice of xterm the key handler uses. */
export type KeyTerminal = Pick<Terminal, "hasSelection" | "getSelection" | "paste">;

/**
 * xterm's custom key handler: `false` keeps xterm out of the key. The two pass-through
 * bindings bubble on to the dispatcher; copy / paste are done here; `ctrl+v` is left to the
 * webview's paste event (xterm's paste path, bracketed).
 */
export function handleKey(term: KeyTerminal, event: KeyboardEvent): boolean {
  const action = terminalKeyAction(event);
  // In a pop-out no dispatcher listens: the pass-through keys are the terminal's there.
  if (action === "terminal" || (action === "dispatch" && only !== null)) return true;
  // Alt+F4 closes the window: neither xterm nor anything here takes it or prevents its default.
  if (action === "window") return false;
  if (event.type === "keydown") {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (action === "copy") {
      event.preventDefault();
      if (term.hasSelection()) {
        clipboard?.writeText(term.getSelection()).catch((err: unknown) => log("copy", err));
      }
    } else if (action === "paste" && typeof clipboard?.readText === "function") {
      // Without the async clipboard the webview's own paste (if any) still goes through xterm.
      event.preventDefault();
      clipboard.readText().then(
        (text) => term.paste(text),
        (err: unknown) => log("paste", err),
      );
    }
  }
  return false;
}

/**
 * Write output into `view`, dropping what it already has: a chunk ending at or before the
 * view's offset is skipped, one straddling it is cut at the offset (in bytes).
 */
function writeChunk(view: View, data: string, offset: number | null): void {
  if (offset !== null && view.offset !== null) {
    if (offset <= view.offset) return;
    const bytes = encoder.encode(data);
    const start = offset - bytes.length;
    if (start < view.offset) data = decoder.decode(bytes.subarray(view.offset - start));
  }
  if (offset !== null) view.offset = offset;
  if (data !== "") view.term.write(data);
}

/** Output for `id`: written to its view (made on demand), queued while it replays. */
export function writeIncoming(id: string, data: string, offset: number | null = null): void {
  const queued = replaying.get(id);
  if (queued !== undefined) {
    queued.push({ data, offset });
    return;
  }
  const view = ensureView(id);
  if (view === null) {
    const chunks = early.get(id) ?? [];
    chunks.push({ data, offset });
    early.set(id, chunks);
    return;
  }
  writeChunk(view, data, offset);
}

/**
 * Replay `id`'s ring buffer into its view from a reset, with the view's answers to old queries
 * suppressed, then the output that arrived meanwhile (queued since the caller marked it
 * replaying), less what the buffer already covered.
 */
export async function restore(id: string): Promise<void> {
  if (!replaying.has(id)) replaying.set(id, []);
  try {
    const buffer = await termBuffer(id);
    const view = ensureView(id);
    if (view !== null) {
      view.term.reset();
      view.replaying = true;
      view.term.write(buffer.data, () => {
        view.replaying = false;
      });
      view.offset = buffer.offset;
    }
  } catch (err) {
    log(`replay ${id}`, err);
  } finally {
    const queued = replaying.get(id) ?? [];
    replaying.delete(id);
    for (const chunk of queued) writeIncoming(id, chunk.data, chunk.offset);
  }
}

/** Move `id`'s view into `host` (the pane) and fit it there. Resolves the fitted size. */
export function showView(id: string, host: HTMLElement): TermSize | null {
  const view = ensureView(id);
  if (view === null) return null;
  if (view.element.parentElement !== host) host.appendChild(view.element);
  return fitView(id);
}

/** Move `id`'s view back into the hidden holder; it keeps receiving output there. */
export function hideView(id: string): void {
  const view = views.get(id);
  if (view === undefined) return;
  view.term.blur();
  if (holder !== null && view.element.parentElement !== holder) holder.appendChild(view.element);
}

/** Fit `id`'s view to its container; the resulting size, or `null` when it cannot be measured. */
export function fitView(id: string): TermSize | null {
  const view = views.get(id);
  if (view === undefined) return null;
  const proposed = view.fit.proposeDimensions();
  if (proposed === undefined || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
  if (proposed.cols < 1 || proposed.rows < 1) return null;
  view.fit.fit();
  return { cols: view.term.cols, rows: view.term.rows };
}

/** Record that Rust's PTY of `id` has `size` (it was opened at it). */
export function markSent(id: string, size: TermSize | null): void {
  const view = views.get(id);
  if (view !== undefined && size !== null) view.sent = size;
}

/**
 * Fit `id` and send the size to Rust when it changed and Rust knows the terminal. In the main
 * window a popped-out terminal is left alone: its pop-out owns the PTY's size.
 */
export function syncSize(id: string): void {
  if (only === null && isPoppedOut(id)) return;
  const size = fitView(id);
  const view = views.get(id);
  if (size === null || view === undefined || terminalInfo(id) === null) return;
  if (only === null) paneSize = size;
  if (view.sent !== null && view.sent.cols === size.cols && view.sent.rows === size.rows) return;
  view.sent = size;
  useTerminalStore.getState().setSize(id, size.cols, size.rows);
  termResize(id, size.cols, size.rows).catch((err: unknown) => log(`resize ${id}`, err));
}

/**
 * Terminal `id` popped out: its pop-out now sizes the PTY, so the size this view last sent is
 * stale, and the refit on its return sends one `term_resize` for the pane's size.
 */
export function forgetSentSize(id: string): void {
  const view = views.get(id);
  if (view !== undefined) view.sent = null;
}

export function focusView(id: string): void {
  views.get(id)?.term.focus();
}

/** Clear `id`'s view (screen, modes, scrollback) before its terminal is restarted. */
export function resetView(id: string): void {
  views.get(id)?.term.reset();
}

/** Dispose `id`'s view: its terminal is gone for good (its project left the canvas). */
export function disposeView(id: string): void {
  early.delete(id);
  replaying.delete(id);
  const view = views.get(id);
  if (view === undefined) return;
  views.delete(id);
  view.term.dispose();
  view.element.remove();
  bumpVersion(id);
}

/**
 * Terminal `id` popped out (`label`) or returned (`null`): the ui store, and the stale size.
 * A return in the main window brings the view back correct and sized (see {@link returned}).
 */
export function applyPopped(id: string, label: string | null): void {
  const was = isPoppedOut(id);
  useUiStore.getState().setPopped(id, label);
  if (label !== null) forgetSentSize(id);
  else if (was && only === null) returned(id);
}

/** A `term://popped` event: applied, and counted (see {@link poppedSequence}). */
export function applyPoppedEvent(id: string, label: string | null): void {
  poppedEvents.set(id, poppedSequence(id) + 1);
  applyPopped(id, label);
}

/** How many `term://popped` events this window has seen for `id`. */
export function poppedSequence(id: string): number {
  return poppedEvents.get(id) ?? 0;
}

/**
 * Terminal `id` is back from its pop-out: the PTY gets the pane's size (the last one the pane
 * fitted, else the view's own) at once, whether or not its tab shows, and the view starts over
 * from the buffer, which the PTY's output at the pop-out's size had made stale.
 */
function returned(id: string): void {
  const view = views.get(id);
  if (view === undefined || terminalInfo(id) === null) return;
  const size = paneSize ?? { cols: view.term.cols, rows: view.term.rows };
  if (view.term.cols !== size.cols || view.term.rows !== size.rows) view.term.resize(size.cols, size.rows);
  view.sent = size;
  useTerminalStore.getState().setSize(id, size.cols, size.rows);
  termResize(id, size.cols, size.rows).catch((err: unknown) => log(`resize ${id}`, err));
  void restore(id);
}

/** This window restarts `id` (`true`) or is done (`false`): its own `term://info` resets nothing. */
export function markRestarting(id: string, on: boolean): void {
  if (on) restarting.add(id);
  else restarting.delete(id);
}

export type ConnectOptions = {
  /** Follow this one terminal only: the pop-out window's (Story 4.5). */
  only?: string;
  /** Terminal `id` was closed (`term://closed`); the main window drops its tab, view and info. */
  onClosed?: (id: string) => void;
};

/**
 * Follow `term://data`, `term://exit`, `term://info` and `term://closed` (and, in the main
 * window, `term://popped`), then pick up the terminals Rust already runs (after a webview
 * reload, or in a new pop-out): their infos go to the store and each view replays its buffer.
 * Output arriving while that list is on its way waits. With `only`, every event of another
 * terminal is ignored. Returns the unsubscribe function; after it ran, nothing that was still on
 * its way acts any more (React StrictMode mounts twice).
 */
export function connectTerminals(options: ConnectOptions = {}): () => void {
  only = options.only ?? null;
  const mine = (id: string) => options.only === undefined || id === options.only;
  let disposed = false;
  const unlisten: (() => void)[] = [];
  const keep = (fn: () => void) => {
    if (disposed) fn();
    else unlisten.push(fn);
  };
  const pending: [string, string, number][] = [];
  let listed = false;
  void Promise.all([
    onTermData(({ id, data, offset }) => {
      if (disposed || !mine(id)) return;
      if (listed) writeIncoming(id, data, offset);
      else pending.push([id, data, offset]);
    }).then(keep),
    onTermExit(({ id, code }) => {
      if (!disposed && mine(id)) useTerminalStore.getState().markExited(id, code);
    }).then(keep),
    onTermInfo((info) => {
      if (disposed || !mine(info.id)) return;
      const previous = terminalInfo(info.id);
      if (previous === null) return;
      // Restarted in another window: this view starts clean too, as the restarting one did.
      if (previous.exited !== null && info.exited === null && !restarting.has(info.id)) resetView(info.id);
      useTerminalStore.getState().upsert(info);
    }).then(keep),
    onTermClosed(({ id }) => {
      if (!disposed && mine(id)) options.onClosed?.(id);
    }).then(keep),
    ...(options.only === undefined
      ? [
          onTermPopped(({ id, label }) => {
            if (!disposed) applyPoppedEvent(id, label);
          }).then(keep),
        ]
      : []),
  ])
    .then(() => (disposed ? null : termList()))
    .then(
      (all) => {
        if (disposed || all === null) return;
        const infos = all.filter((info) => mine(info.id));
        const store = useTerminalStore.getState();
        // A pop-out's view is new to this window even when it was made already: it replays too.
        const late = infos.filter((info) => !hasView(info.id) || info.id === options.only);
        for (const info of infos) store.upsert(info);
        // Output for these waits until their buffer is written.
        for (const info of late) replaying.set(info.id, []);
        listed = true;
        for (const [id, data, offset] of pending.splice(0)) writeIncoming(id, data, offset);
        for (const info of late) void restore(info.id);
        // A reloaded main window learns which terminals are in their own window.
        if (options.only === undefined) {
          termPopped().then(
            (popped) => {
              if (disposed) return;
              for (const { id, label } of popped) applyPopped(id, label);
            },
            (err: unknown) => log("popped", err),
          );
        }
      },
      (err: unknown) => {
        if (disposed) return;
        listed = true;
        for (const [id, data, offset] of pending.splice(0)) writeIncoming(id, data, offset);
        log("list", err);
      },
    );
  return () => {
    disposed = true;
    unlisten.splice(0).forEach((fn) => fn());
  };
}

/** The terminal this window follows when it is a pop-out, else `null` (the main window). */
export function popOutTerminal(): string | null {
  return only;
}
