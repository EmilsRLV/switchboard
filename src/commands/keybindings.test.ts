import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatKeybinding,
  handleKeydown,
  isEditableTarget,
  matchesEvent,
  parseKeybinding,
  type KeyEventLike,
} from "./keybindings";
import { clearCommands, registerCommand } from "./registry";

/** A synthetic keydown; modifiers default to none. */
function key(k: string, mods: Partial<Omit<KeyEventLike, "key" | "preventDefault">> = {}): KeyEventLike {
  return {
    key: k,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    preventDefault: vi.fn(),
    ...mods,
  };
}

describe("parseKeybinding", () => {
  it("parses modifiers in any order and lower-cases the key", () => {
    expect(parseKeybinding("ctrl+shift+K")).toEqual({ ctrl: true, shift: true, alt: false, key: "k" });
    expect(parseKeybinding("Shift+Alt+Ctrl+p")).toEqual({ ctrl: true, shift: true, alt: true, key: "p" });
    expect(parseKeybinding("ctrl+,")).toEqual({ ctrl: true, shift: false, alt: false, key: "," });
  });

  it("accepts a bare key", () => {
    expect(parseKeybinding("escape")).toEqual({ ctrl: false, shift: false, alt: false, key: "escape" });
    expect(parseKeybinding("F1")).toEqual({ ctrl: false, shift: false, alt: false, key: "f1" });
  });

  it("maps aliases to KeyboardEvent.key spellings", () => {
    expect(parseKeybinding("esc").key).toBe("escape");
    expect(parseKeybinding("ctrl+up").key).toBe("arrowup");
    expect(parseKeybinding("space").key).toBe(" ");
    expect(parseKeybinding("return").key).toBe("enter");
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseKeybinding("  ctrl+k ")).toEqual(parseKeybinding("ctrl+k"));
  });

  it("rejects malformed bindings", () => {
    expect(() => parseKeybinding("")).toThrow(/no key|empty part/);
    expect(() => parseKeybinding("ctrl+")).toThrow(/invalid keybinding/);
    expect(() => parseKeybinding("ctrl")).toThrow(/no key/);
    expect(() => parseKeybinding("ctrl+ctrl+k")).toThrow(/repeated modifier/);
    expect(() => parseKeybinding("k+j")).toThrow(/more than one key/);
    expect(() => parseKeybinding("ctrl++k")).toThrow(/empty part/);
  });
});

describe("matchesEvent", () => {
  const ctrlK = parseKeybinding("ctrl+k");

  it("matches the key with exactly the bound modifiers", () => {
    expect(matchesEvent(ctrlK, key("k", { ctrlKey: true }))).toBe(true);
    expect(matchesEvent(ctrlK, key("K", { ctrlKey: true }))).toBe(true);
  });

  it("does not match with missing or extra modifiers", () => {
    expect(matchesEvent(ctrlK, key("k"))).toBe(false);
    expect(matchesEvent(ctrlK, key("k", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchesEvent(ctrlK, key("k", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(matchesEvent(ctrlK, key("k", { ctrlKey: true, metaKey: true }))).toBe(false);
  });

  it("does not match a different key", () => {
    expect(matchesEvent(ctrlK, key("j", { ctrlKey: true }))).toBe(false);
  });

  it("matches Escape case-insensitively and with no modifiers only", () => {
    const esc = parseKeybinding("escape");
    expect(matchesEvent(esc, key("Escape"))).toBe(true);
    expect(matchesEvent(esc, key("Escape", { ctrlKey: true }))).toBe(false);
  });
});

describe("formatKeybinding", () => {
  it("renders modifiers in ctrl, shift, alt order", () => {
    expect(formatKeybinding(parseKeybinding("alt+shift+ctrl+k"))).toBe("ctrl+shift+alt+k");
    expect(formatKeybinding(parseKeybinding("ctrl+,"))).toBe("ctrl+,");
    expect(formatKeybinding(parseKeybinding("escape"))).toBe("esc");
    expect(formatKeybinding(parseKeybinding("space"))).toBe("space");
  });

  it("renders arrow keys by their short alias", () => {
    expect(formatKeybinding(parseKeybinding("ctrl+up"))).toBe("ctrl+up");
    expect(formatKeybinding(parseKeybinding("ArrowDown"))).toBe("down");
    expect(formatKeybinding(parseKeybinding("enter"))).toBe("enter");
  });
});

describe("isEditableTarget", () => {
  it("recognises inputs, textareas and contenteditable elements", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("is false for other elements, null and a missing target", () => {
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: false })).toBe(false);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe("handleKeydown (the dispatcher)", () => {
  beforeEach(() => clearCommands());
  afterEach(() => vi.restoreAllMocks());

  it("runs the enabled command bound to the event and swallows the event", () => {
    const run = vi.fn();
    registerCommand({ id: "a.k", title: "K", keybinding: "ctrl+k", run });
    const event = key("k", { ctrlKey: true });
    expect(handleKeydown(event)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves an unbound event alone", () => {
    registerCommand({ id: "a.k", title: "K", keybinding: "ctrl+k", run: vi.fn() });
    const event = key("j", { ctrlKey: true });
    expect(handleKeydown(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores auto-repeat so a held key fires once", () => {
    const run = vi.fn();
    registerCommand({ id: "a.k", title: "K", keybinding: "ctrl+k", run });
    expect(handleKeydown(key("k", { ctrlKey: true }))).toBe(true);
    expect(handleKeydown(key("k", { ctrlKey: true, repeat: true }))).toBe(false);
    expect(handleKeydown(key("k", { ctrlKey: true, repeat: true }))).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("skips a bound command whose when is false and does not swallow the event", () => {
    const run = vi.fn();
    registerCommand({ id: "a.k", title: "K", keybinding: "ctrl+k", when: () => false, run });
    const event = key("k", { ctrlKey: true });
    expect(handleKeydown(event)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("resolves a shared key by when: the palette's Escape wins over the pane's", () => {
    const state = { paletteOpen: true, paneOpen: true };
    const closePalette = vi.fn(() => {
      state.paletteOpen = false;
    });
    const closePane = vi.fn(() => {
      state.paneOpen = false;
    });
    registerCommand({
      id: "settings.closePane",
      title: "Close settings",
      keybinding: "escape",
      when: () => state.paneOpen && !state.paletteOpen,
      run: closePane,
    });
    registerCommand({
      id: "palette.close",
      title: "Close command palette",
      keybinding: "escape",
      when: () => state.paletteOpen,
      run: closePalette,
    });

    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(closePalette).toHaveBeenCalledOnce();
    expect(closePane).not.toHaveBeenCalled();

    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(closePane).toHaveBeenCalledOnce();

    // Nothing left to close: Escape falls through.
    expect(handleKeydown(key("Escape"))).toBe(false);
  });

  it("leaves bare letter bindings to an editable target but still runs them elsewhere", () => {
    const run = vi.fn();
    registerCommand({ id: "a.bare", title: "Bare", keybinding: "s", run });
    const typing = key("s", { target: { tagName: "INPUT" } });
    expect(handleKeydown(typing)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(typing.preventDefault).not.toHaveBeenCalled();

    expect(handleKeydown(key("s", { target: { tagName: "BUTTON" } }))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("still runs escape, enter, arrows and modified bindings from an editable target", () => {
    const esc = vi.fn();
    const ctrlK = vi.fn();
    const down = vi.fn();
    registerCommand({ id: "a.esc", title: "Esc", keybinding: "escape", run: esc });
    registerCommand({ id: "a.k", title: "K", keybinding: "ctrl+k", run: ctrlK });
    registerCommand({ id: "a.down", title: "Down", keybinding: "down", run: down });
    const input = { tagName: "INPUT" };
    expect(handleKeydown(key("Escape", { target: input }))).toBe(true);
    expect(handleKeydown(key("k", { ctrlKey: true, target: input }))).toBe(true);
    expect(handleKeydown(key("ArrowDown", { target: input }))).toBe(true);
    expect(esc).toHaveBeenCalledOnce();
    expect(ctrlK).toHaveBeenCalledOnce();
    expect(down).toHaveBeenCalledOnce();
  });

  it("runs at most one command per event", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerCommand({ id: "a", title: "A", keybinding: "ctrl+k", run: a });
    registerCommand({ id: "b", title: "B", keybinding: "ctrl+k", run: b });
    handleKeydown(key("k", { ctrlKey: true }));
    expect(a.mock.calls.length + b.mock.calls.length).toBe(1);
  });
});

describe("handleKeydown inside a terminal", () => {
  beforeEach(() => clearCommands());
  afterEach(() => clearCommands());

  /** A target whose `closest('[data-terminal]')` finds a terminal host (xterm's textarea). */
  const inTerminal = { tagName: "TEXTAREA", closest: (selector: string) => (selector === "[data-terminal]" ? {} : null) };
  const outside = { tagName: "BUTTON", closest: () => null };

  it("yields every key to the terminal except ctrl+` and ctrl+shift+k", () => {
    const ran: string[] = [];
    for (const [id, keybinding] of [
      ["pane.close", "escape"],
      ["project.add", "ctrl+o"],
      ["palette.toggle", "ctrl+k"],
      ["copy", "ctrl+c"],
      ["history", "ctrl+r"],
      ["terminal.toggle", "ctrl+`"],
      ["palette.terminal", "ctrl+shift+k"],
    ] as const) {
      registerCommand({ id, title: id, keybinding, run: () => void ran.push(id) });
    }
    const escape = key("Escape", { target: inTerminal });
    expect(handleKeydown(escape)).toBe(false);
    expect(escape.preventDefault).not.toHaveBeenCalled();
    expect(handleKeydown(key("o", { ctrlKey: true, target: inTerminal }))).toBe(false);
    expect(handleKeydown(key("k", { ctrlKey: true, target: inTerminal }))).toBe(false);
    expect(handleKeydown(key("c", { ctrlKey: true, target: inTerminal }))).toBe(false);
    expect(handleKeydown(key("r", { ctrlKey: true, target: inTerminal }))).toBe(false);
    expect(ran).toEqual([]);

    expect(handleKeydown(key("`", { ctrlKey: true, target: inTerminal }))).toBe(true);
    expect(handleKeydown(key("K", { ctrlKey: true, shiftKey: true, target: inTerminal }))).toBe(true);
    expect(ran).toEqual(["terminal.toggle", "palette.terminal"]);

    // Outside a terminal the usual rules apply: Esc closes, ctrl+k toggles the palette.
    expect(handleKeydown(key("Escape", { target: outside }))).toBe(true);
    expect(handleKeydown(key("k", { ctrlKey: true, target: outside }))).toBe(true);
    expect(ran).toEqual(["terminal.toggle", "palette.terminal", "pane.close", "palette.toggle"]);
  });
});

describe("handleKeydown on another keyboard layout", () => {
  beforeEach(() => clearCommands());
  afterEach(() => clearCommands());

  it("runs ctrl+` and ctrl+shift+k by physical key, in and out of a terminal", () => {
    const ran: string[] = [];
    registerCommand({ id: "terminal.toggle", title: "t", keybinding: "ctrl+`", run: () => void ran.push("toggle") });
    registerCommand({ id: "palette", title: "p", keybinding: "ctrl+shift+k", run: () => void ran.push("palette") });
    const inTerminal = { closest: () => ({}) };
    const german = key("^", { ctrlKey: true, code: "Backquote", target: inTerminal });
    expect(handleKeydown(german)).toBe(true);
    expect(german.preventDefault).toHaveBeenCalledOnce();
    expect(handleKeydown(key("Л", { ctrlKey: true, shiftKey: true, code: "KeyK" }))).toBe(true);
    expect(ran).toEqual(["toggle", "palette"]);
  });
});
