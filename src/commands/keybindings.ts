// Keybinding strings, their parsed form, and the one keydown dispatcher.
//
// A binding is `ctrl+`/`shift+`/`alt+` prefixes plus one key (`"ctrl+shift+k"`, `"escape"`),
// parsed once when the command is registered and matched against `keydown` events here.
// Nothing outside this module installs a keydown listener: every shortcut is a command.
// While focus is in an editable element (a select included) or the context menu is open,
// bare-key bindings (no modifier) other than escape/enter/arrows are left to the element, so
// typing never triggers a command. While focus
// is inside a terminal (`[data-terminal]`, xterm's helper textarea included) every key is the
// terminal's except the pass-through bindings (`terminal/keys`: ctrl+`, ctrl+shift+k and the tab
// keys ctrl+pageup / ctrl+pagedown), so Esc, ctrl+c, ctrl+o and ctrl+k reach the program running there.

import { useEffect } from "react";
import { isInsideTerminal, layoutKey, terminalKeyAllowed } from "../terminal/keys";
import { isContextMenuOpen } from "../state/ui";
import { listCommands, runCommand } from "./registry";

export type Keybinding = {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** `KeyboardEvent.key`, lower-cased (`"k"`, `","`, `"escape"`, `"arrowdown"`). */
  key: string;
};

/** The slice of `KeyboardEvent` the dispatcher reads; tests build these as plain objects. */
export type KeyEventLike = {
  key: string;
  /** `KeyboardEvent.code` (the physical key); read for the layout-independent terminal keys. */
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  preventDefault: () => void;
  /** `KeyboardEvent.target`; read only to tell whether focus is in an editable element. */
  target?: unknown;
  /** True when a surface (palette, menu) already handled the key; the dispatcher then stays out. */
  defaultPrevented?: boolean;
};

/** Keys a bare binding may still claim while focus is in an editable element. */
const EDITABLE_PASS_KEYS = new Set(["escape", "enter", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

/**
 * True when the event target takes typed keys itself: an `<input>`, `<textarea>`, `<select>`
 * (typing a letter picks an option) or contenteditable element.
 */
export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  return (
    el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable === true
  );
}

const MODIFIERS = new Set(["ctrl", "shift", "alt"]);

/** Aliases accepted in binding strings, mapped to the `KeyboardEvent.key` spelling. */
const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  space: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
};

/**
 * Parse `"ctrl+shift+k"` into a {@link Keybinding}. Case-insensitive; modifiers may come in any
 * order; exactly one non-modifier key is required. Throws on anything else so a typo in a
 * command definition fails at registration, not silently at keypress.
 */
export function parseKeybinding(binding: string): Keybinding {
  // `+` is the separator only; the `+` key itself is not bindable in this form.
  const parts = binding.trim().toLowerCase().split("+");
  const parsed: Keybinding = { ctrl: false, shift: false, alt: false, key: "" };
  for (const part of parts) {
    if (part === "") {
      throw new Error(`invalid keybinding "${binding}": empty part`);
    }
    if (MODIFIERS.has(part)) {
      if (parsed[part as "ctrl" | "shift" | "alt"]) {
        throw new Error(`invalid keybinding "${binding}": repeated modifier "${part}"`);
      }
      parsed[part as "ctrl" | "shift" | "alt"] = true;
    } else if (parsed.key !== "") {
      throw new Error(`invalid keybinding "${binding}": more than one key`);
    } else {
      parsed.key = KEY_ALIASES[part] ?? part;
    }
  }
  if (parsed.key === "") {
    throw new Error(`invalid keybinding "${binding}": no key`);
  }
  return parsed;
}

/** True when the event's key and modifier set match the binding exactly (meta never matches). */
export function matchesEvent(binding: Keybinding, event: KeyEventLike): boolean {
  return (
    !event.metaKey &&
    event.ctrlKey === binding.ctrl &&
    event.shiftKey === binding.shift &&
    event.altKey === binding.alt &&
    event.key.toLowerCase() === binding.key
  );
}

/** The reverse of `KEY_ALIASES` for display (`escape` → `esc`, `arrowup` → `up`). */
const KEY_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(KEY_ALIASES)
    .filter(([alias]) => alias !== "return")
    .map(([alias, key]) => [key, alias]),
);

/** Render a binding for display: `ctrl+shift+k`, `esc`, `ctrl+,`, `ctrl+up`. */
export function formatKeybinding(binding: Keybinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("ctrl");
  if (binding.shift) parts.push("shift");
  if (binding.alt) parts.push("alt");
  parts.push(KEY_DISPLAY[binding.key] ?? binding.key);
  return parts.join("+");
}

/**
 * The dispatcher: resolve the event to the first enabled command whose binding matches, run it
 * and swallow the event. Auto-repeat is ignored (a held `ctrl+k` toggles once). Returns true
 * when a command ran. Commands whose `when` is false are skipped, which is how `escape` is
 * shared: `palette.close` only when the palette is open, `pane.close` only otherwise. Inside a
 * terminal only ``ctrl+` ``, `ctrl+shift+k`, `ctrl+pageup` and `ctrl+pagedown` are dispatched;
 * every other key is left alone.
 */
export function handleKeydown(event: KeyEventLike): boolean {
  if (event.repeat || event.defaultPrevented === true) return false;
  if (isInsideTerminal(event.target) && !terminalKeyAllowed(event)) return false;
  // Bare keys are the element's in an editable target, and the menu's while the context menu is open.
  const editable = isEditableTarget(event.target) || isContextMenuOpen();
  // ctrl+Backquote / ctrl+shift+KeyK / ctrl+PageUp / ctrl+PageDown match their bindings on any keyboard layout.
  const probe: KeyEventLike = { ...pick(event), key: layoutKey(event) };
  for (const command of listCommands({ enabledOnly: true })) {
    const binding = command.binding;
    if (binding === null) continue;
    const bare = !binding.ctrl && !binding.shift && !binding.alt;
    if (editable && bare && !EDITABLE_PASS_KEYS.has(binding.key)) continue;
    if (matchesEvent(binding, probe)) {
      event.preventDefault();
      runCommand(command.id);
      return true;
    }
  }
  return false;
}

/** The fields of a key event the matching reads (a real `KeyboardEvent` does not spread). */
function pick(event: KeyEventLike): KeyEventLike {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
    preventDefault: () => {},
  };
}

/** Install the single window `keydown` listener for the lifetime of the calling component. */
export function useKeybindings(): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      handleKeydown(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
