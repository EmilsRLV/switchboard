// The xterm models, one per terminal Rust runs (Story 4.1). A module-level registry, not state.
//
// Story 9.5 (the memory fix, NFR-2): only a terminal on screen has a full view, an xterm opened in
// an element, with fit, WebGL, 5,000 lines of scrollback, the typing probe and the key handler.
// Every terminal also has a "shadow" for as long as it has any model: an xterm `Terminal` never
// opened (no element, no renderer, scrollback 0) at the PTY's size, fed all of the live output,
// shown or not. Exactly one model answers the queries in each chunk (DSR, DA: ConPTY asks for the
// cursor at start and waits), decided when the chunk arrives: the full view once it is live (no
// replay in flight), else the shadow. The decision rides each model's ordered write queue as an
// empty-write marker that sets its `answers` flag, so it holds while xterm (asynchronously) parses
// that chunk, however a show or hide lands in between. Showing a terminal (`showView`) makes its full view in the hidden holder, moves it
// into the pane's host and replays Rust's `term_buffer` ring into it; live output for it waits
// meanwhile and follows, less what the ring covered (every chunk carries the byte offset it ends
// at; each model keeps its own). Hiding it (`hideView`) disposes the full view: the shadow, which
// kept up, answers again, with no replay. `restore` (a reload, resume, return from a pop-out)
// replays into every model the terminal has. A model waiting for a replay that a later one took
// over, or disposed meanwhile, is left alone. Showing and hiding never bump the view version
// (`useHostedView` keys on it); only disposal does.
//
// Story 4.5: a pop-out window runs the same registry for one terminal (`connectTerminals({ only })`)
// with a view of its own, always a full one and no shadow, replayed from `term_buffer`. Whichever
// window owns the PTY's size sends `term_resize`: the pop-out while it is open, else the main pane
// (`syncSize` skips a popped-out terminal in the main window).
//
// The trade-off: a re-shown terminal's history is what the 2 MiB ring holds (capped at
// SCROLLBACK lines), and its scroll position and selection reset to the bottom.
//
// WebGL renders when it can; when it cannot load, or its context is lost, that full view switches
// to xterm's DOM renderer for as long as it lives (the next full view tries WebGL again).

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
import { isTypingKey, TypingProbe, typingSink } from "../perf";
import { terminalKeyAction } from "./keys";
import { buildFont, buildTheme, documentTokens } from "./theme";

/** Lines of scrollback each full view keeps. */
export const SCROLLBACK = 5_000;

export type Renderer = "webgl" | "dom";

export type TermSize = { cols: number; rows: number };

/** A full view (opened, rendered, on screen) or a shadow (never opened; see the header). */
export type ViewKind = "full" | "shadow";

/** A chunk of output and the byte offset it ends at (`null`: unknown, written as it is). */
type Chunk = { data: string; offset: number | null };

/** A chunk waiting in one model's queue, with whether that model answers its queries (decided at arrival). */
type Owned = Chunk & { answers: boolean };

type View = {
  id: string;
  kind: ViewKind;
  term: Terminal;
  /** The full view's fit addon; `null` for a shadow. */
  fit: FitAddon | null;
  /** The element a full view was opened in (moved from the holder into the pane); `null` for a shadow. */
  element: HTMLDivElement | null;
  /** A shadow renders nothing; its value is not used. */
  renderer: Renderer;
  /** The output byte offset this model has written up to; `null` until a chunk says. */
  offset: number | null;
  /**
   * Whether this model answers the queries in what xterm is parsing now (`forward` sends only
   * then). Set by a marker (`term.write("", cb)`) written before each chunk whose owner differs
   * from the last one (see `writeIncoming`), so it flips in parse order, not at arrival. False
   * while a replayed buffer and the backlog after it are parsed: those were answered on arrival.
   */
  answers: boolean;
  /** The value of the last marker written (what `answers` will be once the queue is parsed). */
  marked: boolean;
  /** Live output that waits for this model's replay, in order; `null` when none is on its way. */
  pending: Owned[] | null;
  /** The replay this model waits for (see `replays`); a replay finding another here is stale. */
  replay: number | null;
  /** Disposed: nothing writes into it any more. */
  disposed: boolean;
  /** Story 9.3: times one keystroke at a time, keydown → its echo drawn. */
  probe: TypingProbe;
};

/**
 * A terminal's models (Story 9.5): its shadow, for as long as it has any model (none in a
 * pop-out window, whose full view answers), and its full view while it is shown.
 */
type Slot = {
  shadow: View | null;
  full: View | null;
  /** The size last sent to Rust. */
  sent: TermSize | null;
};

const slots = new Map<string, Slot>();
/** Output that arrived while no model could be made yet (no holder mounted), in order. */
const early = new Map<string, Chunk[]>();
/**
 * Terminals whose replay is announced before their models exist (a reload's late terminals):
 * their live output waits here until `restore` hands it to the models it replays into.
 */
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
/** The host each shown terminal is in (`showView` until `hideView`): these get a full view. */
const hosts = new Map<string, HTMLElement>();
/** The last replay started: each one takes the next number, so a model knows which one it waits for. */
let replays = 0;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function log(what: string, err: unknown): void {
  console.warn(`terminal: ${what}: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Register the hidden holder (or `null` when it unmounts). Models waiting for it are made now: a
 * terminal shown before it mounted gets its full view, then held-back output is written.
 */
export function setHolder(element: HTMLElement | null): void {
  holder = element;
  if (element === null) return;
  for (const id of [...hosts.keys()]) {
    if (slots.get(id)?.full != null) continue;
    // Shown before the holder mounted: the pane's effect could not fit it, so it is sized here.
    if (ensureModels(id)?.full != null) syncSize(id);
  }
  for (const [id, chunks] of [...early]) {
    early.delete(id);
    for (const chunk of chunks) writeIncoming(id, chunk.data, chunk.offset);
  }
}

/**
 * A counter per id, bumped whenever its models are disposed for good (Story 4.4: a resumed
 * session's terminal gets a fresh view under the same id). The pane re-attaches when it changes,
 * not only when the id does, so it never keeps showing a disposed view. Story 9.5: making a model
 * and showing / hiding do not bump it (the pane's layout effect would hide what it showed).
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

/** Be told whenever any view is disposed; returns the unsubscribe function. */
export function subscribeViews(listener: () => void): () => void {
  versionListeners.add(listener);
  return () => versionListeners.delete(listener);
}

/** Whether `id` has a model (a full view or a shadow). */
export function hasView(id: string): boolean {
  return slots.has(id);
}

/** The model of `id` that answers: its full view while it has one, else its shadow. */
function answerer(slot: Slot | undefined): View | null {
  return slot?.full ?? slot?.shadow ?? null;
}

/** The kind of `id`'s answering model, or `null` without one. */
export function viewKind(id: string): ViewKind | null {
  return answerer(slots.get(id))?.kind ?? null;
}

/** The renderer `id`'s full view uses, or `null` without one. */
export function viewRenderer(id: string): Renderer | null {
  return slots.get(id)?.full?.renderer ?? null;
}

/** Whether `id` should have a full view now: while shown, and always in its pop-out. */
function wantsFull(id: string): boolean {
  return hosts.has(id) || only === id;
}

/**
 * The models of `id`, made when missing: its shadow (not in a pop-out window) and, while it is
 * shown, its full view, opened in the holder and moved into its host; `null` without a holder.
 */
function ensureModels(id: string): Slot | null {
  if (holder === null || typeof document === "undefined") return null;
  let slot = slots.get(id);
  if (slot === undefined) {
    slot = { shadow: null, full: null, sent: null };
    slots.set(id, slot);
  }
  if (slot.shadow === null && only !== id) slot.shadow = createShadow(id);
  if (slot.full === null && wantsFull(id)) {
    slot.full = createView(id, holder, sizeOf(slot.shadow));
    const host = hosts.get(id);
    if (host !== undefined && slot.full.element !== null) host.appendChild(slot.full.element);
  }
  return slot;
}

/**
 * The answering model of `id` (its full view, else its shadow), made when missing (see
 * `ensureModels`); `null` without a holder.
 */
export function ensureView(id: string): View | null {
  return answerer(ensureModels(id) ?? undefined);
}

function sizeOf(view: View | null): TermSize | undefined {
  return view === null ? undefined : { cols: view.term.cols, rows: view.term.rows };
}

/** The size a new model starts at: `fallback` (its sibling's), else the PTY's when Rust told us one. */
function startSize(id: string, fallback?: TermSize): { cols?: number; rows?: number } {
  if (fallback !== undefined) return { cols: fallback.cols, rows: fallback.rows };
  const info = terminalInfo(id);
  return info !== null ? { cols: info.cols, rows: info.rows } : {};
}

/** Keep `id`'s shadow at the PTY's size. */
function resizeShadow(slot: Slot, size: TermSize): void {
  const shadow = slot.shadow;
  if (shadow !== null && (shadow.term.cols !== size.cols || shadow.term.rows !== size.rows)) shadow.term.resize(size.cols, size.rows);
}

/** Resize each shadow whose terminal's info says another size. */
function fitShadows(infos: Record<string, { cols: number; rows: number }>): void {
  for (const [id, slot] of slots) {
    const info = Object.hasOwn(infos, id) ? infos[id] : undefined;
    if (info !== undefined) resizeShadow(slot, { cols: info.cols, rows: info.rows });
  }
}

/** Forward an answer (or typed data) of `view` to the PTY, unless it must not answer now. */
function forward(view: View, data: string): void {
  // Not this model's chunk (or a replayed one); while popped out, only the pop-out's view answers
  // the program (its queries, DSR / DA).
  if (!view.answers || (only === null && isPoppedOut(view.id))) {
    // Story 9.3: a stamped key that goes nowhere is not timed.
    view.probe.cancel();
    return;
  }
  termWrite(view.id, data).catch((err: unknown) => log(`write to ${view.id}`, err));
  view.probe.written();
}

function model(id: string, kind: ViewKind, term: Terminal, fit: FitAddon | null, element: HTMLDivElement | null): View {
  return { id, kind, term, fit, element, renderer: "dom", offset: null, answers: true, marked: true, pending: null, replay: null, disposed: false, probe: new TypingProbe() };
}

/**
 * A shadow (Story 9.5): an xterm `Terminal` never opened, without scrollback, that parses all of
 * the output at the PTY's size so it can answer the program's queries whenever no full view does.
 */
function createShadow(id: string, fallback?: TermSize): View {
  const term = new Terminal({
    scrollback: 0,
    ...startSize(id, fallback),
    allowProposedApi: true,
    ...(isWindows() ? { windowsPty: { backend: "conpty" as const } } : {}),
  });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  const view = model(id, "shadow", term, null, null);
  term.onData((data) => forward(view, data));
  return view;
}

function createView(id: string, parent: HTMLElement, fallback?: TermSize): View {
  const tokens = documentTokens();
  const term = new Terminal({
    scrollback: SCROLLBACK,
    theme: buildTheme(tokens),
    ...buildFont(tokens),
    ...startSize(id, fallback),
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
  const view = model(id, "full", term, fit, element);
  loadWebgl(view);

  term.attachCustomKeyEventHandler((event) => handleKey(term, event));
  // Story 9.3: stamp typing keys before xterm sees them (capture, on the view's own element).
  element.addEventListener(
    "keydown",
    (event) => {
      if (isTypingKey(event)) view.probe.keydown(event.timeStamp, performance.now());
    },
    true,
  );
  term.onData((data) => forward(view, data));
  return view;
}

/**
 * Dispose a model: its xterm and, for a full view, its element. The WebGL addon's dispose leaves
 * its GL context alive until garbage collection (Story 9.3's trial), so the contexts of the view's
 * canvases are lost explicitly.
 */
function disposeModel(view: View): void {
  view.disposed = true;
  view.pending = null;
  const canvases =
    view.renderer === "webgl" && view.element !== null && typeof view.element.querySelectorAll === "function"
      ? [...view.element.querySelectorAll("canvas")]
      : [];
  view.term.dispose();
  view.element?.remove();
  for (const canvas of canvases) {
    try {
      const gl = canvas.getContext("webgl2");
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Not a WebGL canvas, or already gone: nothing to free.
    }
  }
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
function writeChunk(view: View, data: string, offset: number | null, answers: boolean): void {
  if (offset !== null && view.offset !== null) {
    if (offset <= view.offset) return;
    const bytes = encoder.encode(data);
    const start = offset - bytes.length;
    if (start < view.offset) data = decoder.decode(bytes.subarray(view.offset - start));
  }
  if (offset !== null) view.offset = offset;
  if (data === "") return;
  mark(view, answers);
  if (view.probe.output(performance.now())) {
    // Story 9.3: the echo of a timed keystroke. The write callback runs once it is parsed, when
    // xterm has queued its render frame; a frame requested now runs right after that render.
    view.term.write(data, () =>
      requestAnimationFrame(() => {
        const sample = view.probe.drawn(performance.now());
        if (sample !== null) typingSink.record(sample);
      }),
    );
  } else {
    view.term.write(data);
  }
}

/**
 * Queue a marker in `view`'s write order so that `answers` is `on` while what follows is parsed
 * (xterm runs write callbacks in order, between the writes around them). Only when it changes.
 */
function mark(view: View, on: boolean): void {
  if (view.marked === on) return;
  view.marked = on;
  view.term.write("", () => {
    view.answers = on;
  });
}

/** Output for `view`: written, or queued while its replay is on its way. */
function feed(view: View, data: string, offset: number | null, answers: boolean): void {
  if (view.pending !== null) view.pending.push({ data, offset, answers });
  else writeChunk(view, data, offset, answers);
}

/**
 * The model that answers the queries in a chunk arriving now: the full view once it is live (no
 * replay in flight, so no backlog), or when there is no shadow (a pop-out); else the shadow.
 */
function owner(slot: Slot): View | null {
  const full = slot.full;
  if (full !== null && (full.pending === null || slot.shadow === null)) return full;
  return slot.shadow;
}

/** Output for `id`: written to each of its models (made on demand), queued for one that replays. */
export function writeIncoming(id: string, data: string, offset: number | null = null): void {
  const queued = replaying.get(id);
  if (queued !== undefined) {
    queued.push({ data, offset });
    return;
  }
  const slot = ensureModels(id);
  if (slot === null) {
    const chunks = early.get(id) ?? [];
    chunks.push({ data, offset });
    early.set(id, chunks);
    return;
  }
  // Story 9.5: decided now, at arrival, not when xterm gets to parse it (see `mark`).
  const answerer = owner(slot);
  if (slot.shadow !== null) feed(slot.shadow, data, offset, answerer === slot.shadow);
  if (slot.full !== null) feed(slot.full, data, offset, answerer === slot.full);
}

/**
 * Replay `id`'s ring buffer into `targets`, each from a reset, with its answers to old queries
 * suppressed, then the live output queued for it meanwhile, less what the buffer covered, each
 * chunk answered or not as decided on its arrival. A full view then answers again (it is live). A
 * target disposed meanwhile, or taken over by a later replay, is left alone (the later one drains
 * it). When the buffer cannot be read, a target keeps what it has and follows the queued output.
 */
async function replayInto(id: string, targets: View[], queued: Chunk[] = []): Promise<void> {
  replays += 1;
  const seq = replays;
  // Output that waited before any model existed was answered by nobody: the shadow answers it.
  const queuedOwner = targets.find((target) => target.kind === "shadow") ?? targets[0];
  for (const target of targets) {
    const owned = queued.map((chunk) => ({ ...chunk, answers: target === queuedOwner }));
    target.pending = [...(target.pending ?? []), ...owned];
    target.replay = seq;
  }
  let buffer: { data: string; offset: number } | null = null;
  try {
    buffer = await termBuffer(id);
  } catch (err) {
    log(`replay ${id}`, err);
  }
  for (const target of targets) {
    if (target.disposed || target.replay !== seq) continue;
    target.replay = null;
    if (buffer !== null) {
      target.term.reset();
      mark(target, false);
      target.term.write(buffer.data);
      target.offset = buffer.offset;
    }
    const chunks = target.pending ?? [];
    target.pending = null;
    for (const chunk of chunks) writeChunk(target, chunk.data, chunk.offset, chunk.answers);
    if (target.kind === "full") mark(target, true);
  }
}

/**
 * Replay `id`'s ring buffer into all of its models (made when missing): a reload, a resume, a
 * return from the pop-out. Output that waited for it (see `replaying`) follows, less what the
 * buffer already covered.
 */
export async function restore(id: string): Promise<void> {
  const queued = replaying.get(id) ?? [];
  replaying.delete(id);
  const slot = ensureModels(id);
  if (slot === null) {
    // No holder to make models in: the output waits for it, as it arrived.
    for (const chunk of queued) writeIncoming(id, chunk.data, chunk.offset);
    return;
  }
  const targets = [slot.shadow, slot.full].filter((view): view is View => view !== null);
  await replayInto(id, targets, queued);
}

/**
 * Show `id` in `host` (the pane) and fit it there: its full view, made when missing and replayed
 * from the ring (its shadow, which has followed everything, is left as it is; a terminal with no
 * model yet gets both, fresh). Resolves the fitted size.
 */
export function showView(id: string, host: HTMLElement): TermSize | null {
  hosts.set(id, host);
  const had = slots.get(id);
  const replay = had !== undefined && had.full === null;
  const slot = ensureModels(id);
  const full = slot?.full ?? null;
  if (full === null || full.element === null) return null;
  if (full.element.parentElement !== host) host.appendChild(full.element);
  if (replay) void replayInto(id, [full]);
  return fitView(id);
}

/**
 * `id` is no longer shown: its full view (element, WebGL, scrollback) is disposed and its shadow,
 * which has followed all of the output, answers again. No replay. A pop-out's own terminal keeps
 * its full view, moved back into the hidden holder.
 */
export function hideView(id: string): void {
  hosts.delete(id);
  const slot = slots.get(id);
  const full = slot?.full ?? null;
  if (slot === undefined || full === null) return;
  if (only === id) {
    full.term.blur();
    if (holder !== null && full.element !== null && full.element.parentElement !== holder) holder.appendChild(full.element);
    return;
  }
  slot.full = null;
  disposeModel(full);
  if (slot.shadow === null) {
    // Never left without a model while its PTY lives.
    slot.shadow = createShadow(id, sizeOf(full));
    void replayInto(id, [slot.shadow]);
  }
}

/** Fit `id`'s full view to its container; the resulting size, or `null` when it cannot be measured (or it has none). */
export function fitView(id: string): TermSize | null {
  const full = slots.get(id)?.full ?? null;
  if (full === null || full.fit === null) return null;
  const proposed = full.fit.proposeDimensions();
  if (proposed === undefined || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
  if (proposed.cols < 1 || proposed.rows < 1) return null;
  full.fit.fit();
  return { cols: full.term.cols, rows: full.term.rows };
}

/** Record that Rust's PTY of `id` has `size` (it was opened at it). */
export function markSent(id: string, size: TermSize | null): void {
  const slot = slots.get(id);
  if (slot === undefined || size === null) return;
  slot.sent = size;
  resizeShadow(slot, size);
}

/**
 * Fit `id` and send the size to Rust when it changed and Rust knows the terminal; its shadow
 * follows the PTY's size. In the main window a popped-out terminal is left alone: its pop-out
 * owns the PTY's size.
 */
export function syncSize(id: string): void {
  if (only === null && isPoppedOut(id)) return;
  const size = fitView(id);
  const slot = slots.get(id);
  if (size === null || slot === undefined || terminalInfo(id) === null) return;
  if (only === null) paneSize = size;
  resizeShadow(slot, size);
  if (slot.sent !== null && slot.sent.cols === size.cols && slot.sent.rows === size.rows) return;
  slot.sent = size;
  useTerminalStore.getState().setSize(id, size.cols, size.rows);
  termResize(id, size.cols, size.rows).catch((err: unknown) => log(`resize ${id}`, err));
}

/**
 * Terminal `id` popped out: its pop-out now sizes the PTY, so the size this window last sent is
 * stale, and the refit on its return sends one `term_resize` for the pane's size.
 */
export function forgetSentSize(id: string): void {
  const slot = slots.get(id);
  if (slot !== undefined) slot.sent = null;
}

/** Focus `id`'s full view (a shadow has nothing to focus). */
export function focusView(id: string): void {
  slots.get(id)?.full?.term.focus();
}

/** Clear `id`'s models (screen, modes, scrollback) before its terminal is restarted. */
export function resetView(id: string): void {
  const slot = slots.get(id);
  slot?.shadow?.term.reset();
  slot?.full?.term.reset();
}

/** Dispose `id`'s models: its terminal is gone for good (its project left the canvas), or starts over. */
export function disposeView(id: string): void {
  early.delete(id);
  replaying.delete(id);
  // The pane's re-run on the version bump shows it again (`showView`) when it still should.
  hosts.delete(id);
  const slot = slots.get(id);
  if (slot === undefined) return;
  slots.delete(id);
  // A replay still on its way finds them disposed and writes nothing.
  if (slot.shadow !== null) disposeModel(slot.shadow);
  if (slot.full !== null) disposeModel(slot.full);
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
  const slot = slots.get(id);
  const view = answerer(slot);
  if (slot === undefined || view === null || terminalInfo(id) === null) return;
  const size = paneSize ?? { cols: view.term.cols, rows: view.term.rows };
  for (const model of [slot.shadow, slot.full]) {
    if (model !== null && (model.term.cols !== size.cols || model.term.rows !== size.rows)) model.term.resize(size.cols, size.rows);
  }
  slot.sent = size;
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
  if (only !== null) {
    // The pop-out's layout effect showed its terminal before `only` was set, making a shadow
    // too: its full view answers, so the shadow goes.
    const slot = slots.get(only);
    if (slot?.shadow != null) {
      disposeModel(slot.shadow);
      slot.shadow = null;
    }
  }
  const mine = (id: string) => options.only === undefined || id === options.only;
  let disposed = false;
  const unlisten: (() => void)[] = [];
  const keep = (fn: () => void) => {
    if (disposed) fn();
    else unlisten.push(fn);
  };
  const pending: [string, string, number][] = [];
  let listed = false;
  // A shadow follows its terminal's PTY size as the store learns it (a session's info arrives
  // after its first output, and nothing else sizes a hidden terminal).
  unlisten.push(useTerminalStore.subscribe((state) => fitShadows(state.infos)));
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
