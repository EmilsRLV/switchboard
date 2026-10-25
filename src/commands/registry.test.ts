import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBindingOverrides,
  bindingConflicts,
  clearBindingOverrides,
  clearCommands,
  getCommand,
  isEnabled,
  listCommands,
  registerCommand,
  registerCommands,
  runCommand,
  runCommandAsync,
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

  it("runCommandAsync resolves once the run settles, and false when the command cannot run", async () => {
    let finish: () => void = () => {};
    const done = vi.fn();
    registerCommand(command({ id: "a.slow", run: () => new Promise<void>((resolve) => (finish = resolve)) }));
    const pending = runCommandAsync("a.slow").then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(done).toHaveBeenCalledWith(true);
    expect(await runCommandAsync("a.missing")).toBe(false);
    registerCommand(command({ id: "a.off", when: () => false }));
    expect(await runCommandAsync("a.off")).toBe(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerCommand(command({ id: "a.rejects", run: () => Promise.reject(new Error("no")) }));
    expect(await runCommandAsync("a.rejects")).toBe(true);
    expect(error).toHaveBeenCalledWith('command "a.rejects" failed:', expect.any(Error));
  });

  describe("binding overrides (Story 9.4)", () => {
    it("an override replaces the effective binding and keeps the default; clearing restores it", () => {
      registerCommand(command({ id: "a.one", keybinding: "ctrl+k" }));
      expect(getCommand("a.one")).toMatchObject({ bindingSource: "default", binding: { ctrl: true, key: "k" } });
      expect(applyBindingOverrides({ "a.one": "Alt+X" })).toEqual([]);
      expect(getCommand("a.one")).toMatchObject({
        keybinding: "ctrl+k",
        defaultBinding: { ctrl: true, shift: false, alt: false, key: "k" },
        binding: { ctrl: false, shift: false, alt: true, key: "x" },
        bindingSource: "override",
      });
      clearBindingOverrides();
      expect(getCommand("a.one")).toMatchObject({ bindingSource: "default", binding: { ctrl: true, key: "k" } });
    });

    it("null unbinds; unknown ids and bad keys are errors and skipped; each apply replaces the last", () => {
      registerCommands([command({ id: "a.one", keybinding: "ctrl+k" }), command({ id: "a.two" })]);
      expect(applyBindingOverrides({ "a.one": null, nope: "x", "a.two": "ctrl+", "a.three": null })).toEqual([
        "unknown command nope",
        'bad key "ctrl+" for a.two',
        "unknown command a.three",
      ]);
      expect(getCommand("a.one")?.binding).toBeNull();
      expect(getCommand("a.two")?.binding).toBeNull();
      expect(applyBindingOverrides({ "a.two": ["x"] })).toEqual(['bad key ["x"] for a.two']);
      expect(getCommand("a.one")?.binding).toMatchObject({ key: "k" });
    });

    it("a command registered after the overrides gets its override; unregistering still removes it", () => {
      registerCommand(command({ id: "a.one" }));
      applyBindingOverrides({ "a.one": "f2" });
      const unregister = registerCommand(command({ id: "a.one", title: "again" }));
      expect(getCommand("a.one")).toMatchObject({ title: "again", binding: { key: "f2" }, bindingSource: "override" });
      applyBindingOverrides({ "a.one": "f3" });
      unregister();
      expect(getCommand("a.one")).toBeUndefined();
    });

    it("conflicts are keys shared after the overrides where one binding came from the file", () => {
      registerCommands([
        command({ id: "a.esc1", keybinding: "escape" }),
        command({ id: "a.esc2", keybinding: "escape" }),
        command({ id: "b.k", keybinding: "ctrl+k" }),
        command({ id: "c.none" }),
      ]);
      expect(bindingConflicts()).toEqual([]);
      applyBindingOverrides({ "c.none": "ctrl+k", "a.esc1": "esc" });
      expect(bindingConflicts()).toEqual(["ctrl+k: b.k, c.none"]);
      applyBindingOverrides({ "c.none": "esc" });
      expect(bindingConflicts()).toEqual(["escape: a.esc1, a.esc2, c.none"]);
    });
  });
});
