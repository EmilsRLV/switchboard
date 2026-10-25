// Story 9.3: the frontend's measuring points. Always on, memory only, nothing logged.
//
// - Startup: the canvas calls `reportFirstFrame` once its flow is mounted with the workspace in;
//   after the next frame has been painted, `perf_ready` tells Rust, which owns the clock (process
//   start → that call).
// - Typing: each terminal view has a `TypingProbe`. A printable keydown is stamped; once xterm has
//   sent its data to the PTY, the next output for that terminal is taken as the echo; the frame
//   that draws it closes the sample (keydown → PTY write → echo drawn). One keystroke is timed at a
//   time: keys typed while one is in flight are not sampled. Samples go to Rust's last-100 ring
//   (`perf_typing`) in batches, a second after the last one, so every window feeds one ring.

import { hasTauriRuntime, perfReady, perfTyping } from "./ipc";

/** A keystroke whose echo has not been drawn within this long (ms) is given up on. */
export const TYPING_STALE_MS = 1_000;

/** Samples are sent to Rust this long (ms) after the last one was taken. */
export const TYPING_FLUSH_MS = 1_000;

/** The most samples held for sending (Rust keeps the last 100 anyway). */
export const TYPING_BATCH = 100;

/** The slice of a `KeyboardEvent` that decides whether it types a character. */
export type TypingKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey"> & { isComposing?: boolean };

/** Whether a keydown types one character into the terminal (so the shell echoes it). */
export function isTypingKey(event: TypingKeyEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey && event.isComposing !== true;
}

/**
 * One terminal's keystroke timer: `keydown` → `written` → `output` (the echo arrived; write it
 * with a callback) → `drawn` (the frame drew it: the sample). Times are `performance.now()`-based
 * (a keydown's `event.timeStamp` is on the same clock).
 */
export class TypingProbe {
  private keyAt: number | null = null;
  private sent = false;
  private echoing = false;

  /** A typing keydown at `at`; ignored while an earlier one is still in flight (not stale at `now`). */
  keydown(at: number, now: number): void {
    if (this.keyAt !== null && now - this.keyAt < TYPING_STALE_MS) return;
    this.keyAt = at;
    this.sent = false;
    this.echoing = false;
  }

  /** xterm sent the keystroke's data to the PTY. */
  written(): void {
    if (this.keyAt !== null && !this.echoing) this.sent = true;
  }

  /** Output arrived at `now`: whether it is the echo to time (then call `drawn` once it is on screen). */
  output(now: number): boolean {
    if (this.keyAt === null || !this.sent || this.echoing) return false;
    if (now - this.keyAt > TYPING_STALE_MS) {
      this.reset();
      return false;
    }
    this.echoing = true;
    return true;
  }

  /**
   * The frame drawing the echo ran at `now`: the sample (ms), or `null` when nothing was timed or
   * the frame came later than the stale limit (frames held while the window was hidden).
   */
  drawn(now: number): number | null {
    if (this.keyAt === null || !this.echoing) return null;
    const sample = Math.max(0, now - this.keyAt);
    this.reset();
    return sample > TYPING_STALE_MS ? null : sample;
  }

  /**
   * The stamped key never reached the PTY (the view was replaying, or the terminal is popped out
   * and this is the main window): forget it, so a later key's write cannot close a sample timed
   * from this keydown.
   */
  cancel(): void {
    this.reset();
  }

  private reset(): void {
    this.keyAt = null;
    this.sent = false;
    this.echoing = false;
  }
}

/** Timers as the sink uses them (injected in tests). */
export type SinkTimers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: SinkTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Holds samples and sends them in one batch `TYPING_FLUSH_MS` after the last one (at most
 * `TYPING_BATCH`, the newest). A failed send drops its batch: these are diagnostics.
 */
export class TypingSink {
  private pending: number[] = [];
  private timer: unknown = null;

  constructor(
    private readonly send: (samples: number[]) => Promise<void>,
    private readonly timers: SinkTimers = realTimers,
  ) {}

  /** Hold one sample; a non-finite one is dropped (Rust would refuse the whole batch over it). */
  record(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.pending.push(ms);
    if (this.pending.length > TYPING_BATCH) this.pending.splice(0, this.pending.length - TYPING_BATCH);
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => this.flush(), TYPING_FLUSH_MS);
  }

  /** Send what is held now. */
  flush(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (this.pending.length === 0) return;
    const batch = this.pending.filter((ms) => Number.isFinite(ms));
    this.pending = [];
    if (batch.length === 0) return;
    this.send(batch).catch(() => {});
  }

  /** Samples held, not yet sent (tests). */
  held(): readonly number[] {
    return this.pending;
  }
}

/** The app's sink: to Rust inside Tauri, nowhere in a plain browser. */
export const typingSink = new TypingSink((samples) => (hasTauriRuntime() ? perfTyping(samples) : Promise.resolve()));

let reported = false;

/**
 * Tell Rust the canvas has drawn its first frame: after the next animation frame (the canvas is
 * laid out) and a task (that frame painted). Only the first call in this window does anything.
 */
export function reportFirstFrame(
  report: () => Promise<unknown> = perfReady,
  frame: (fn: () => void) => void = (fn) => requestAnimationFrame(fn),
  task: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
): void {
  if (reported) return;
  reported = true;
  frame(() => task(() => void report().catch(() => {})));
}

/** Forget that the first frame was reported (tests only). */
export function resetFirstFrameForTests(): void {
  reported = false;
}
