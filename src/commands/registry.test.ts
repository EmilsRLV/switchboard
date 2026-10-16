import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCommands,
  getCommand,
  isEnabled,
  listCommands,
  registerCommand,
  registerCommands,
  runCommand,
  unregisterCommand,
  type Command,
} from "./registry";

function command(overrides: Partial<Command> & Pick<Command, "id">): Command {
  return { title: overrides.id, run: () => {}, ...overrides };
}

describe("command registry", () => {
  beforeEach(() => clearCommands());
  afterEach(() => vi.restoreAllMocks());

  it("starts empty", () => {
    expect(listCommands()).toEqual([]);
    expect(getCommand("nope")).toBeUndefined();
  });

  it("registers a command and parses its keybinding once", () => {
    registerCommand(command({ id: "a.one", title: "One", keybinding: "Ctrl+Shift+K" }));
    const stored = getCommand("a.one");
    expect(stored?.title).toBe("One");
    expect(stored?.binding).toEqual({ ctrl: true, shift: true, alt: false, key: "k" });
  });

  it("a command without a keybinding has a null binding", () => {
    registerCommand(command({ id: "a.one" }));
    expect(getCommand("a.one")?.binding).toBeNull();
  });

  it("an invalid keybinding throws at registration and registers nothing", () => {
    expect(() => registerCommand(command({ id: "a.bad", keybinding: "ctrl+" }))).toThrow(/invalid keybinding/);
    expect(getCommand("a.bad")).toBeUndefined();
  });

  it("re-registering an id replaces the earlier command (idempotent per id)", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerCommand(command({ id: "a.one", title: "First", run: first }));
    registerCommand(command({ id: "a.one", title: "Second", run: second }));
    expect(listCommands()).toHaveLength(1);
    expect(getCommand("a.one")?.title).toBe("Second");
    runCommand("a.one");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("the returned unregister removes only its own registration", () => {
    const unregisterFirst = registerCommand(command({ id: "a.one", title: "First" }));
    registerCommand(command({ id: "a.one", title: "Second" }));
    unregisterFirst();
    expect(getCommand("a.one")?.title).toBe("Second");
    const unregisterSecond = registerCommand(command({ id: "a.one", title: "Third" }));
    unregisterSecond();
    expect(getCommand("a.one")).toBeUndefined();
  });

  it("unregisterCommand reports whether something was removed", () => {
    registerCommand(command({ id: "a.one" }));
    expect(unregisterCommand("a.one")).toBe(true);
    expect(unregisterCommand("a.one")).toBe(false);
  });

  it("registerCommands rejects duplicate ids in one batch before registering any", () => {
    expect(() =>
      registerCommands([command({ id: "a.one" }), command({ id: "a.two" }), command({ id: "a.one" })]),
    ).toThrow('duplicate command id "a.one"');
    expect(listCommands()).toEqual([]);
  });

  it("registerCommands with a bad keybinding anywhere in the batch registers nothing", () => {
    expect(() =>
      registerCommands([command({ id: "a.one" }), command({ id: "a.two" }), command({ id: "a.bad", keybinding: "ctrl+" })]),
    ).toThrow(/invalid keybinding/);
    expect(listCommands()).toEqual([]);
  });

  it("listCommands({ visibleOnly }) drops hidden commands but the default list keeps them", () => {
    registerCommand(command({ id: "a.hidden", title: "Hidden", hidden: true }));
    registerCommand(command({ id: "a.shown", title: "Shown" }));
    expect(listCommands({ visibleOnly: true }).map((c) => c.id)).toEqual(["a.shown"]);
    expect(listCommands().map((c) => c.id)).toEqual(["a.hidden", "a.shown"]);
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).toEqual(["a.hidden", "a.shown"]);
  });

  it("registerCommands registers the batch and returns one unregister for all of it", () => {
    const unregister = registerCommands([command({ id: "a.one" }), command({ id: "a.two" })]);
    expect(listCommands()).toHaveLength(2);
    unregister();
    expect(listCommands()).toEqual([]);
  });

  it("listCommands orders by title, then id", () => {
    registerCommand(command({ id: "z", title: "Beta" }));
    registerCommand(command({ id: "a", title: "Beta" }));
    registerCommand(command({ id: "m", title: "alpha" }));
    expect(listCommands().map((c) => c.id)).toEqual(["m", "a", "z"]);
  });

  it("listCommands({ enabledOnly }) hides commands whose when is false", () => {
    let enabled = false;
    registerCommand(command({ id: "a.gated", title: "Gated", when: () => enabled }));
    registerCommand(command({ id: "a.free", title: "Free" }));
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).toEqual(["a.free"]);
    expect(listCommands().map((c) => c.id)).toEqual(["a.free", "a.gated"]);
    enabled = true;
    expect(listCommands({ enabledOnly: true }).map((c) => c.id)).toEqual(["a.free", "a.gated"]);
  });

  it("isEnabled treats a missing when as enabled", () => {
    expect(isEnabled({})).toBe(true);
    expect(isEnabled({ when: () => false })).toBe(false);
  });

  it("runCommand runs an enabled command and reports true", () => {
    const run = vi.fn();
    registerCommand(command({ id: "a.one", run }));
    expect(runCommand("a.one")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("runCommand ignores a disabled command and reports false", () => {
    const run = vi.fn();
    registerCommand(command({ id: "a.one", when: () => false, run }));
    expect(runCommand("a.one")).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("runCommand reports false for an unknown id", () => {
    expect(runCommand("a.missing")).toBe(false);
  });

  it("runCommand logs a thrown error instead of propagating it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerCommand(
      command({
        id: "a.throws",
        run: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(runCommand("a.throws")).toBe(true);
    expect(error).toHaveBeenCalledWith('command "a.throws" failed:', expect.any(Error));
  });

  it("runCommand logs a rejected promise instead of leaving it unhandled", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerCommand(command({ id: "a.rejects", run: () => Promise.reject(new Error("async boom")) }));
    expect(runCommand("a.rejects")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith('command "a.rejects" failed:', expect.any(Error));
  });
});
