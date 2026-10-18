// Key routing inside a terminal (Story 4.1). While focus is in a terminal, every key belongs
// to the program running there (Claude uses Esc, ctrl+c, ctrl+o, ctrl+r): the global dispatcher
// yields to it. Only the two bindings below still reach the dispatcher, and the terminal
// ignores them. Copy and paste use the shift variants, so plain ctrl+c / ctrl+v stay the shell's
// (ctrl+v is left to the webview's own paste, which xterm turns into a bracketed paste).

import { matchesEvent, parseKeybinding, type Keybinding, type KeyEventLike } from "../commands/keybindings";

/** `terminal.toggle`: show or hide the terminal pane from anywhere. */
export const TERMINAL_TOGGLE_KEY = "ctrl+`";
/** The palette's second binding, the one that works inside a terminal. */
export const PALETTE_TERMINAL_KEY = "ctrl+shift+k";

// Parsed on first use, not at load: `commands/keybindings` imports this module too.
let parsed: { passThrough: Keybinding[]; copy: Keybinding; paste: Keybinding; nativePaste: Keybinding } | null = null;

function bindings() {
  parsed ??= {
    passThrough: [TERMINAL_TOGGLE_KEY, PALETTE_TERMINAL_KEY].map(parseKeybinding),
    copy: parseKeybinding("ctrl+shift+c"),
    paste: parseKeybinding("ctrl+shift+v"),
    nativePaste: parseKeybinding("ctrl+v"),
  };
  return parsed;
}

/** The slice of a key event the terminal rules read. */
export type TerminalKey = Pick<KeyEventLike, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "code">;

/**
 * The key the two pass-through bindings are matched on: on a layout where the physical keys
 * produce other characters (German `^`, Cyrillic `л`), `ctrl+Backquote` still is ``ctrl+` ``
 * and `ctrl+shift+KeyK` still is `ctrl+shift+k`. Any other key is its `key`.
 */
export function layoutKey(event: TerminalKey): string {
  if (!event.ctrlKey || event.altKey || event.metaKey) return event.key;
  if (!event.shiftKey && event.code === "Backquote") return "`";
  if (event.shiftKey && event.code === "KeyK") return "k";
  return event.key;
}

function asEvent(event: TerminalKey): KeyEventLike {
  return {
    key: layoutKey(event),
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    repeat: false,
    preventDefault: () => {},
  };
}

/** True for the only keys the dispatcher still gets while focus is in a terminal. */
export function terminalKeyAllowed(event: TerminalKey): boolean {
  const e = asEvent(event);
  return bindings().passThrough.some((binding) => matchesEvent(binding, e));
}

/** What a key does inside a terminal, before xterm sees it. */
export type TerminalKeyAction = "dispatch" | "copy" | "paste" | "native-paste" | "terminal";

/**
 * The terminal's own key rule (xterm's custom key handler): the two pass-through bindings go
 * to the dispatcher, `ctrl+shift+c` / `ctrl+shift+v` copy and paste, `ctrl+v` is left to the
 * webview's paste event, and everything else is the terminal's.
 */
export function terminalKeyAction(event: TerminalKey): TerminalKeyAction {
  if (terminalKeyAllowed(event)) return "dispatch";
  const e: KeyEventLike = { ...asEvent(event), key: event.key };
  const { copy, paste, nativePaste } = bindings();
  if (matchesEvent(copy, e)) return "copy";
  if (matchesEvent(paste, e)) return "paste";
  if (matchesEvent(nativePaste, e)) return "native-paste";
  return "terminal";
}

/** The attribute marking a terminal's host element; focus inside it is "in a terminal". */
export const TERMINAL_ATTRIBUTE = "data-terminal";

/**
 * True when `target` (a key event's target) is inside a terminal: an element with
 * `[data-terminal]` or one of its descendants, xterm's helper textarea included.
 */
export function isInsideTerminal(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== "function") return false;
  return (closest as (selector: string) => unknown).call(target, `[${TERMINAL_ATTRIBUTE}]`) != null;
}
