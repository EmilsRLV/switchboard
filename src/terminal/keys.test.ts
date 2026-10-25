import { describe, expect, it } from "vitest";
import { isInsideTerminal, layoutKey, terminalKeyAction, terminalKeyAllowed, type TerminalKey } from "./keys";

function key(k: string, mods: Partial<TerminalKey> = {}): TerminalKey {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods };
}

describe("terminalKeyAllowed", () => {
  it("lets only ctrl+`, ctrl+shift+k and the tab keys through to the dispatcher", () => {
    expect(terminalKeyAllowed(key("`", { ctrlKey: true }))).toBe(true);
    expect(terminalKeyAllowed(key("K", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(terminalKeyAllowed(key("PageUp", { ctrlKey: true }))).toBe(true);
    expect(terminalKeyAllowed(key("PageDown", { ctrlKey: true }))).toBe(true);
    for (const k of [
      key("Escape"),
      key("k", { ctrlKey: true }),
      key("o", { ctrlKey: true }),
      key("c", { ctrlKey: true }),
      key("r", { ctrlKey: true }),
      key("`"),
      key("`", { ctrlKey: true, altKey: true }),
      key("`", { ctrlKey: true, metaKey: true }),
      key("q", { ctrlKey: true }),
      key("PageUp"),
      key("PageDown", { shiftKey: true }),
      key("PageUp", { ctrlKey: true, shiftKey: true }),
      key("PageDown", { ctrlKey: true, altKey: true }),
    ]) {
      expect(terminalKeyAllowed(k), JSON.stringify(k)).toBe(false);
    }
  });
});

describe("terminalKeyAction", () => {
  it("routes copy, paste and the webview's paste; the rest is the terminal's", () => {
    expect(terminalKeyAction(key("`", { ctrlKey: true }))).toBe("dispatch");
    expect(terminalKeyAction(key("K", { ctrlKey: true, shiftKey: true }))).toBe("dispatch");
    expect(terminalKeyAction(key("C", { ctrlKey: true, shiftKey: true }))).toBe("copy");
    expect(terminalKeyAction(key("V", { ctrlKey: true, shiftKey: true }))).toBe("paste");
    expect(terminalKeyAction(key("v", { ctrlKey: true }))).toBe("native-paste");
    expect(terminalKeyAction(key("c", { ctrlKey: true }))).toBe("terminal");
    expect(terminalKeyAction(key("Escape"))).toBe("terminal");
    expect(terminalKeyAction(key("o", { ctrlKey: true }))).toBe("terminal");
  });
});

describe("isInsideTerminal", () => {
  it("asks the target for its closest [data-terminal] ancestor", () => {
    const seen: string[] = [];
    const inside = {
      closest: (selector: string) => {
        seen.push(selector);
        return {};
      },
    };
    expect(isInsideTerminal(inside)).toBe(true);
    expect(seen).toEqual(["[data-terminal]"]);
    expect(isInsideTerminal({ closest: () => null })).toBe(false);
  });

  it("is false for anything that is not an element", () => {
    expect(isInsideTerminal(null)).toBe(false);
    expect(isInsideTerminal(undefined)).toBe(false);
    expect(isInsideTerminal(window_like())).toBe(false);
    expect(isInsideTerminal("textarea")).toBe(false);
  });
});

/** A window as an event target: no `closest`. */
function window_like(): object {
  return { addEventListener: () => {} };
}

describe("layout-independent terminal keys", () => {
  it("ctrl+Backquote and ctrl+shift+KeyK match whatever character the layout produces", () => {
    expect(terminalKeyAllowed(key("^", { ctrlKey: true, code: "Backquote" }))).toBe(true);
    expect(terminalKeyAllowed(key("Л", { ctrlKey: true, shiftKey: true, code: "KeyK" }))).toBe(true);
    expect(terminalKeyAction(key("^", { ctrlKey: true, code: "Backquote" }))).toBe("dispatch");
    // Other modifiers, or other physical keys, do not.
    expect(terminalKeyAllowed(key("^", { ctrlKey: true, altKey: true, code: "Backquote" }))).toBe(false);
    expect(terminalKeyAllowed(key("л", { ctrlKey: true, code: "KeyK" }))).toBe(false);
    expect(layoutKey(key("x", { ctrlKey: true, code: "KeyX" }))).toBe("x");
  });
});

describe("Alt+F4 (Story 4.5)", () => {
  it("is the window's, not the terminal's", () => {
    expect(terminalKeyAction(key("F4", { altKey: true }))).toBe("window");
    expect(terminalKeyAllowed(key("F4", { altKey: true }))).toBe(false);
    expect(terminalKeyAction(key("F4"))).toBe("terminal");
    expect(terminalKeyAction(key("F4", { altKey: true, ctrlKey: true }))).toBe("terminal");
    expect(terminalKeyAction(key("F4", { altKey: true, shiftKey: true }))).toBe("terminal");
  });
});

describe("the tab keys (Story 4.5)", () => {
  it("ctrl+PageUp / ctrl+PageDown match on event.code too and go to the dispatcher", () => {
    expect(terminalKeyAllowed(key("Unidentified", { ctrlKey: true, code: "PageUp" }))).toBe(true);
    expect(terminalKeyAllowed(key("Unidentified", { ctrlKey: true, code: "PageDown" }))).toBe(true);
    expect(terminalKeyAction(key("PageDown", { ctrlKey: true, code: "PageDown" }))).toBe("dispatch");
    expect(layoutKey(key("x", { ctrlKey: true, code: "PageUp" }))).toBe("pageup");
    expect(layoutKey(key("PageUp", { ctrlKey: true, shiftKey: true, code: "PageUp" }))).toBe("PageUp");
    expect(terminalKeyAllowed(key("PageUp", { ctrlKey: true, shiftKey: true, code: "PageUp" }))).toBe(false);
  });
});
