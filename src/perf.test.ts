import { describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  hasTauriRuntime: vi.fn(() => false),
  perfReady: vi.fn(() => Promise.resolve(0)),
  perfTyping: vi.fn(() => Promise.resolve()),
}));

import {
  TYPING_BATCH,
  TYPING_FLUSH_MS,
  TYPING_STALE_MS,
  TypingProbe,
  TypingSink,
  isTypingKey,
  reportFirstFrame,
  resetFirstFrameForTests,
  type SinkTimers,
} from "./perf";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("isTypingKey", () => {
  it("is a single character without ctrl, alt or meta, outside composition", () => {
    expect(isTypingKey(key("a"))).toBe(true);
    expect(isTypingKey(key("A"))).toBe(true);
    expect(isTypingKey(key(" "))).toBe(true);
    expect(isTypingKey(key("Enter"))).toBe(false);
    expect(isTypingKey(key("ArrowUp"))).toBe(false);
    expect(isTypingKey(key("c", { ctrlKey: true }))).toBe(false);
    expect(isTypingKey(key("x", { altKey: true }))).toBe(false);
    expect(isTypingKey(key("v", { metaKey: true }))).toBe(false);
    expect(isTypingKey(key("a", { isComposing: true }))).toBe(false);
  });
});

describe("TypingProbe", () => {
  it("times keydown → write → echo → drawn frame", () => {
    const probe = new TypingProbe();
    probe.keydown(100, 100);
    probe.written();
    expect(probe.output(104)).toBe(true);
    expect(probe.output(105), "only the first output is the echo").toBe(false);
    expect(probe.drawn(111)).toBe(11);
    expect(probe.drawn(120), "one sample per keystroke").toBeNull();
  });

  it("takes no output before the key was written to the PTY", () => {
    const probe = new TypingProbe();
    probe.keydown(100, 100);
    expect(probe.output(101)).toBe(false);
    probe.written();
    expect(probe.output(102)).toBe(true);
    expect(probe.drawn(103)).toBe(3);
  });

  it("ignores output with no key in flight", () => {
    const probe = new TypingProbe();
    probe.written();
    expect(probe.output(10)).toBe(false);
    expect(probe.drawn(11)).toBeNull();
  });

  it("times one key at a time; a later key waits until the first is done or stale", () => {
    const probe = new TypingProbe();
    probe.keydown(100, 100);
    probe.keydown(105, 105);
    probe.written();
    expect(probe.output(108)).toBe(true);
    expect(probe.drawn(110), "measured from the first key").toBe(10);

    probe.keydown(200, 200);
    // Never echoed: a key typed after it went stale takes over.
    probe.keydown(200 + TYPING_STALE_MS, 200 + TYPING_STALE_MS);
    probe.written();
    expect(probe.output(205 + TYPING_STALE_MS)).toBe(true);
    expect(probe.drawn(207 + TYPING_STALE_MS)).toBe(7);
  });

  it("gives up on a frame that comes too late (frames held while the window was hidden)", () => {
    const probe = new TypingProbe();
    probe.keydown(0, 0);
    probe.written();
    expect(probe.output(5)).toBe(true);
    expect(probe.drawn(TYPING_STALE_MS + 1)).toBeNull();
    // Reset: the next key is timed afresh.
    probe.keydown(5_000, 5_000);
    probe.written();
    expect(probe.output(5_002)).toBe(true);
    expect(probe.drawn(5_004)).toBe(4);
  });

  it("forgets a cancelled key, so a later key's write cannot close a sample from it", () => {
    const probe = new TypingProbe();
    probe.keydown(100, 100);
    probe.cancel();
    probe.written();
    expect(probe.output(300)).toBe(false);
    // A new key right after is timed from its own keydown.
    probe.keydown(400, 400);
    probe.written();
    expect(probe.output(403)).toBe(true);
    expect(probe.drawn(405)).toBe(5);
  });

  it("gives up on an echo that comes too late", () => {
    const probe = new TypingProbe();
    probe.keydown(0, 0);
    probe.written();
    expect(probe.output(TYPING_STALE_MS + 1)).toBe(false);
    expect(probe.drawn(TYPING_STALE_MS + 2)).toBeNull();
  });
});

/** Manual timers: `fire` runs the one armed callback. */
function manualTimers() {
  let armed: (() => void) | null = null;
  let delay = -1;
  const timers: SinkTimers = {
    set: (fn, ms) => {
      armed = fn;
      delay = ms;
      return fn;
    },
    clear: (handle) => {
      if (handle === armed) armed = null;
    },
  };
  return {
    timers,
    delay: () => delay,
    armed: () => armed !== null,
    fire: () => {
      const fn = armed;
      armed = null;
      fn?.();
    },
  };
}

describe("TypingSink", () => {
  it("sends the held samples in one batch a while after the last one", () => {
    const sent: number[][] = [];
    const t = manualTimers();
    const sink = new TypingSink((s) => {
      sent.push(s);
      return Promise.resolve();
    }, t.timers);
    sink.record(5);
    sink.record(7);
    expect(t.delay()).toBe(TYPING_FLUSH_MS);
    expect(sent).toEqual([]);
    t.fire();
    expect(sent).toEqual([[5, 7]]);
    expect(sink.held()).toEqual([]);
    // Nothing held: a flush sends nothing.
    sink.flush();
    expect(sent).toHaveLength(1);
  });

  it("flushes on demand and cancels the pending timer", () => {
    const sent: number[][] = [];
    const t = manualTimers();
    const sink = new TypingSink((s) => {
      sent.push(s);
      return Promise.resolve();
    }, t.timers);
    sink.record(3);
    sink.flush();
    expect(sent).toEqual([[3]]);
    expect(t.armed()).toBe(false);
  });

  it("drops non-finite samples, and sends nothing when only those were held", () => {
    const sent: number[][] = [];
    const t = manualTimers();
    const sink = new TypingSink((s) => {
      sent.push(s);
      return Promise.resolve();
    }, t.timers);
    sink.record(Number.NaN);
    sink.record(Number.POSITIVE_INFINITY);
    sink.flush();
    expect(sent).toEqual([]);
    sink.record(4);
    sink.record(Number.NaN);
    sink.record(6);
    sink.flush();
    expect(sent).toEqual([[4, 6]]);
  });

  it("holds at most a batch, keeping the newest, and drops a batch whose send failed", async () => {
    const t = manualTimers();
    const send = vi.fn(() => Promise.reject(new Error("no ipc")));
    const sink = new TypingSink(send, t.timers);
    for (let i = 0; i < TYPING_BATCH + 10; i += 1) sink.record(i);
    expect(sink.held()).toHaveLength(TYPING_BATCH);
    expect(sink.held()[0]).toBe(10);
    sink.flush();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(sink.held()).toEqual([]);
  });
});

describe("reportFirstFrame", () => {
  it("reports once, after a frame and then a task", () => {
    resetFirstFrameForTests();
    const order: string[] = [];
    const frames: (() => void)[] = [];
    const tasks: (() => void)[] = [];
    const report = vi.fn(() => {
      order.push("report");
      return Promise.resolve(0);
    });
    reportFirstFrame(report, (fn) => frames.push(fn), (fn) => tasks.push(fn));
    reportFirstFrame(report, (fn) => frames.push(fn), (fn) => tasks.push(fn));
    expect(frames).toHaveLength(1);
    expect(report).not.toHaveBeenCalled();
    frames[0]!();
    expect(report).not.toHaveBeenCalled();
    tasks[0]!();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
