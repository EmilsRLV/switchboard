// Key routing inside a terminal (Story 4.1). While focus is in a terminal, every key belongs
// to the program running there (Claude uses Esc, ctrl+c, ctrl+o, ctrl+r): the global dispatcher
// yields to it. Only the bindings below still reach the dispatcher (the pane toggle, the palette,
// and since Story 4.5 the tab keys ctrl+pageup / ctrl+pagedown), and the terminal ignores them. Copy and paste use the shift variants, so plain ctrl+c / ctrl+v stay the shell's
// (ctrl+v is left to the webview's own paste, which xterm turns into a bracketed paste).
// Story 9.4: the pass-through keys are the effective bindings of their commands (see
// `PASS_THROUGH_COMMANDS`), so a key rebound in `keybindings.json` still works inside a terminal,
// on any keyboard layout (matched on the physical key too: `layoutKey`). The registry refuses a
// pass-through binding without a modifier or on the clipboard keys (`TERMINAL_CLIPBOARD_KEYS`).

import { matchesEvent, parseKeybinding, type Keybinding, type KeyEventLike } from "../commands/keybindings";
import { getCommand } from "../commands/registry";

/** `terminal.toggle`: show or hide the terminal pane from anywhere. */
export const TERMINAL_TOGGLE_KEY = "ctrl+`";
/** The palette's second binding, the one that works inside a terminal. */
export const PALETTE_TERMINAL_KEY = "ctrl+shift+k";
/** `terminal.prevTab` / `terminal.nextTab` (Story 4.5): move between the pane's tabs, from inside a terminal too. */
export const PREV_TAB_KEY = "ctrl+pageup";
export const NEXT_TAB_KEY = "ctrl+pagedown";

/**
 * The commands whose keys reach the dispatcher from inside a terminal, each with its default key.
 * Their effective bindings (`keybindings.json` included) are what passes; a command unbound
 * there passes nothing. Where the command is not registered (a pop-out window has no registry)
 * its default key is used.
 */
export const PASS_THROUGH_COMMANDS: readonly (readonly [id: string, defaultKey: string])[] = [
  ["terminal.toggle", TERMINAL_TOGGLE_KEY],
  ["palette.toggleFromTerminal", PALETTE_TERMINAL_KEY],
  ["terminal.prevTab", PREV_TAB_KEY],
  ["terminal.nextTab", NEXT_TAB_KEY],
];

/** The terminal's own clipboard keys: never a pass-through binding (they would stop copying or pasting). */
export const TERMINAL_CLIPBOARD_KEYS: readonly (readonly [key: string, use: "copy" | "paste"])[] = [
  ["ctrl+shift+c", "copy"],
  ["ctrl+shift+v", "paste"],
  ["ctrl+v", "paste"],
];

// Parsed on first use, not at load: `commands/keybindings` imports this module too.
let parsed: { defaults: Map<string, Keybinding>; copy: Keybinding; paste: Keybinding; nativePaste: Keybinding } | null = null;

function bindings() {
  parsed ??= {
    defaults: new Map(PASS_THROUGH_COMMANDS.map(([id, key]) => [id, parseKeybinding(key)])),
    copy: parseKeybinding(TERMINAL_CLIPBOARD_KEYS[0]![0]),
    paste: parseKeybinding(TERMINAL_CLIPBOARD_KEYS[1]![0]),
    nativePaste: parseKeybinding(TERMINAL_CLIPBOARD_KEYS[2]![0]),
  };
  return parsed;
}

/** `KeyboardEvent.code` of the physical key a binding's key names on a US layout, where a layout may change its character. */
const CODE_OF_KEY: Readonly<Record<string, string>> = {
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** The physical key (`KeyboardEvent.code`) of a binding's key: `k` is `KeyK`, `1` is `Digit1`; `null` for keys whose `key` never varies. */
export function codeOfKey(key: string): string | null {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return CODE_OF_KEY[key] ?? null;
}

/** The pass-through bindings now: each pass-through command's effective binding. */
export function passThroughBindings(): Keybinding[] {
  const { defaults } = bindings();
  return PASS_THROUGH_COMMANDS.flatMap(([id]) => {
    const command = getCommand(id);
    const binding = command === undefined ? (defaults.get(id) ?? null) : command.binding;
    return binding === null ? [] : [binding];
  });
}

/** The slice of a key event the terminal rules read. */
export type TerminalKey = Pick<KeyEventLike, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "code">;

/**
 * The key the pass-through bindings are matched on: on a layout where the physical keys
 * produce other characters (German `^`, Cyrillic `л`), a press with exactly a pass-through
 * binding's modifiers on that binding's physical key (`codeOfKey`: `Backquote` for the default
 * ``ctrl+` ``, `KeyK` for `ctrl+shift+k`, `KeyT` for a rebound `ctrl+shift+t`, `PageUp` /
 * `PageDown` for the tab keys) is that binding's key. Any other key is its `key`.
 */
export function layoutKey(event: TerminalKey): string {
  if (event.metaKey || event.code === undefined) return event.key;
  for (const binding of passThroughBindings()) {
    if (binding.ctrl !== event.ctrlKey || binding.shift !== event.shiftKey || binding.alt !== event.altKey) continue;
    if (codeOfKey(binding.key) === event.code) return binding.key;
  }
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

/** True for the only keys the dispatcher still gets while focus is in a terminal (the pass-through bindings). */
export function terminalKeyAllowed(event: TerminalKey): boolean {
  const e = asEvent(event);
  return passThroughBindings().some((binding) => matchesEvent(binding, e));
}

/** What a key does inside a terminal, before xterm sees it. */
export type TerminalKeyAction = "dispatch" | "copy" | "paste" | "native-paste" | "window" | "terminal";

/**
 * The terminal's own key rule (xterm's custom key handler): the pass-through bindings go
 * to the dispatcher, `ctrl+shift+c` / `ctrl+shift+v` copy and paste, `ctrl+v` is left to the
 * webview's paste event, Alt+F4 is left to the window (it closes it), and everything else is the
 * terminal's.
 */
export function terminalKeyAction(event: TerminalKey): TerminalKeyAction {
  if (terminalKeyAllowed(event)) return "dispatch";
  const e: KeyEventLike = { ...asEvent(event), key: event.key };
  const { copy, paste, nativePaste } = bindings();
  if (matchesEvent(copy, e)) return "copy";
  if (matchesEvent(paste, e)) return "paste";
  if (matchesEvent(nativePaste, e)) return "native-paste";
  // Alt+F4 is the window's (it closes it), in the main window and in a pop-out.
  if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && event.key === "F4") return "window";
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
