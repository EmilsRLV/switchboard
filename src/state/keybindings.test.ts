import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBuiltins } from "../commands/builtins";
import { formatKeybinding, handleKeydown, type KeyEventLike } from "../commands/keybindings";
import { bindingConflicts, clearCommands, getCommand, listCommands, registerCommand } from "../commands/registry";
import { keybindingsDiagnostics } from "../components/diagnostics";
import type { KeybindingsFile } from "../ipc";
import { terminalKeyAction, terminalKeyAllowed, type TerminalKey } from "../terminal/keys";
import { applyKeybindingsFile, keybindingsStatusText, useKeybindingsStore } from "./keybindings";
import { usePaletteStore } from "./palette";
import { useUiStore } from "./ui";

function file(text: string | null, error: string | null = null, watchError: string | null = null): KeybindingsFile {
  return { path: "/cfg/switchboard/keybindings.json", text, error, watchError };
}

/** The key the palette shows for `id` (what `Palette.tsx` renders), or `null`. */
function shown(id: string): string | null {
  const row = listCommands().find((c) => c.id === id);
  return row?.binding == null ? null : formatKeybinding(row.binding);
}

function key(k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: () => {}, ...mods };
}

function termKey(k: string, mods: Partial<TerminalKey> = {}): TerminalKey {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods };
}

/** An event whose target sits inside a terminal (`[data-terminal]`). */
const IN_TERMINAL = { closest: (selector: string) => (selector === "[data-terminal]" ? {} : null) };

describe("keybindings.json", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    usePaletteStore.setState({ isOpen: false, query: "", selected: 0 });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false });
    useKeybindingsStore.setState({ loaded: false, status: "none", errors: [], warnings: [], conflicts: [] });
  });
  afterEach(() => clearCommands());

  it("no file: the defaults, status none, nothing listed", () => {
    expect(applyKeybindingsFile(file(null))).toEqual({ status: "none", errors: [], warnings: [], conflicts: [] });
    expect(shown("palette.toggle")).toBe("ctrl+k");
    expect(shown("terminal.toggle")).toBe("ctrl+`");
    expect(shown("review.refresh")).toBeNull();
    // The defaults' shared keys (Esc, n) are told apart by their `when`s: never a conflict.
    expect(bindingConflicts()).toEqual([]);
    expect(keybindingsDiagnostics({ status: "none", errors: [], warnings: [], conflicts: [] })).toEqual({
      row: { label: "keybindings.json", value: "none", attention: false },
      lines: [],
    });
  });

  it("an override binds the key, the palette shows it, and the key runs the command", () => {
    expect(applyKeybindingsFile(file('{"settings.open": "ctrl+shift+o"}'))).toEqual({ status: "ok", errors: [], warnings: [], conflicts: [] });
    expect(shown("settings.open")).toBe("ctrl+shift+o");
    expect(getCommand("settings.open")?.bindingSource).toBe("override");
    expect(handleKeydown(key("O", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(useUiStore.getState().pane).toBe("settings");
  });

  it('{"review.refresh": "ctrl+shift+r"}: the palette shows it', () => {
    applyKeybindingsFile(file('{"review.refresh":"ctrl+shift+r"}'));
    expect(shown("review.refresh")).toBe("ctrl+shift+r");
  });

  it("null unbinds: no key, none in the palette", () => {
    applyKeybindingsFile(file('{"app.quit": null, "terminal.kill": null}'));
    expect(shown("app.quit")).toBeNull();
    expect(shown("terminal.kill")).toBeNull();
    expect(getCommand("app.quit")?.bindingSource).toBe("override");
    expect(getCommand("app.quit")?.keybinding).toBe("ctrl+q");
    expect(handleKeydown(key("q", { ctrlKey: true }))).toBe(false);
  });

  it("an unknown id is an error and the other entries still apply", () => {
    const result = applyKeybindingsFile(file('{"nope": "x", "settings.open": "ctrl+shift+o"}'));
    expect(result).toEqual({ status: "errors", errors: ["unknown command nope"], warnings: [], conflicts: [] });
    expect(shown("settings.open")).toBe("ctrl+shift+o");
    expect(keybindingsStatusText(result.status, result.errors.length)).toBe("1 error");
  });

  it("a bad key is an error and the command keeps its default", () => {
    const result = applyKeybindingsFile(file('{"palette.toggle": "ctrl+", "app.quit": 5, "canvas.fitView": "ctrl+shift"}'));
    expect(result.errors).toEqual([
      'bad key "ctrl+" for palette.toggle',
      "bad key 5 for app.quit",
      'bad key "ctrl+shift" for canvas.fitView',
    ]);
    expect(keybindingsStatusText(result.status, result.errors.length)).toBe("3 errors");
    expect(shown("palette.toggle")).toBe("ctrl+k");
    expect(shown("app.quit")).toBe("ctrl+q");
  });

  it("a conflict made by the file is listed: review.refresh on ctrl+k", () => {
    const result = applyKeybindingsFile(file('{"review.refresh": "ctrl+k"}'));
    expect(result).toEqual({ status: "ok", errors: [], warnings: [], conflicts: ["ctrl+k: palette.toggle, review.refresh"] });
    expect(keybindingsDiagnostics(result).row).toEqual({ label: "keybindings.json", value: "ok, 1 conflict", attention: true });
    expect(keybindingsDiagnostics(result).lines).toEqual(["ctrl+k: palette.toggle, review.refresh"]);
    // An override naming the default key is no override: no conflict from it.
    expect(applyKeybindingsFile(file('{"project.newSession": "n"}')).conflicts).toEqual([]);
    // Moving a command onto a key shared by default commands names them all.
    expect(applyKeybindingsFile(file('{"settings.open": "n"}')).conflicts).toEqual(["n: branch.newSession, project.newSession, settings.open"]);
  });

  it("errors and conflicts are both listed, errors first", () => {
    const result = applyKeybindingsFile(file('{"nope": "x", "review.refresh": "ctrl+k"}'));
    expect(keybindingsDiagnostics(result)).toEqual({
      row: { label: "keybindings.json", value: "1 error, 1 conflict", attention: true },
      lines: ["unknown command nope", "ctrl+k: palette.toggle, review.refresh"],
    });
  });

  it("live reload: each new text replaces the last; invalid JSON is an error and keeps the previous overrides", () => {
    const store = useKeybindingsStore.getState();
    store.apply(file('{"settings.open": "ctrl+shift+o"}'));
    expect(useKeybindingsStore.getState()).toMatchObject({ loaded: true, status: "ok", errors: [] });
    expect(shown("settings.open")).toBe("ctrl+shift+o");

    store.apply(file('{"settings.open": "ctrl+shift+o",'));
    expect(useKeybindingsStore.getState().status).toBe("errors");
    expect(useKeybindingsStore.getState().errors[0]).toMatch(/^invalid JSON: /);
    expect(shown("settings.open")).toBe("ctrl+shift+o");

    store.apply(file("[1, 2]"));
    expect(useKeybindingsStore.getState().errors).toEqual(['keybindings.json must be an object: { "<command id>": "<key>" | null }']);
    expect(shown("settings.open")).toBe("ctrl+shift+o");

    // Unreadable: the error, the previous overrides kept.
    store.apply(file(null, "cannot read keybindings.json: access denied"));
    expect(useKeybindingsStore.getState().errors).toEqual(["cannot read keybindings.json: access denied"]);
    expect(shown("settings.open")).toBe("ctrl+shift+o");

    store.apply(file('{"settings.open": "ctrl+alt+o"}'));
    expect(shown("settings.open")).toBe("ctrl+alt+o");
    expect(useKeybindingsStore.getState().status).toBe("ok");

    // The file deleted: back to the defaults.
    store.apply(file(null));
    expect(shown("settings.open")).toBeNull();
    expect(useKeybindingsStore.getState().status).toBe("none");
    // An empty file is an empty object.
    store.apply(file("  \n"));
    expect(useKeybindingsStore.getState().status).toBe("ok");
  });

  it("a pass-through command needs a modifier and may not take the terminal's clipboard keys", () => {
    const result = applyKeybindingsFile(
      file('{"terminal.toggle": "t", "terminal.nextTab": "ctrl+shift+c", "terminal.prevTab": "ctrl+v", "palette.toggleFromTerminal": "ctrl+shift+v"}'),
    );
    expect(result.errors).toEqual([
      "terminal.toggle needs ctrl, alt or shift",
      "ctrl+shift+c is the terminal's copy",
      "ctrl+v is the terminal's paste",
      "ctrl+shift+v is the terminal's paste",
    ]);
    // Refused: the defaults stay, so copy and paste stay the terminal's.
    expect(shown("terminal.toggle")).toBe("ctrl+`");
    expect(terminalKeyAction(termKey("C", { ctrlKey: true, shiftKey: true }))).toBe("copy");
    expect(terminalKeyAction(termKey("v", { ctrlKey: true }))).toBe("native-paste");
    // Shift alone is a modifier.
    expect(applyKeybindingsFile(file('{"terminal.toggle": "shift+f12"}')).errors).toEqual([]);
  });

  it("another command moved onto a clipboard or pass-through key is a conflict", () => {
    expect(applyKeybindingsFile(file('{"review.refresh": "ctrl+shift+c"}')).conflicts).toEqual(["ctrl+shift+c: review.refresh, terminal copy"]);
    expect(applyKeybindingsFile(file('{"review.refresh": "ctrl+v"}')).conflicts).toEqual(["ctrl+v: review.refresh, terminal paste"]);
    expect(applyKeybindingsFile(file('{"review.refresh": "ctrl+`"}')).conflicts).toEqual(["ctrl+`: review.refresh, terminal.toggle"]);
    // Keys read as the file writes them.
    expect(applyKeybindingsFile(file('{"review.refresh": "esc"}')).conflicts).toEqual([
      "escape: contextMenu.close, elsewhere.close, palette.close, pane.close, review.refresh, selection.clear, tour.skip",
    ]);
  });

  it("unbinding a palette key or a key-only command is a warning; Rust's watch failure too", () => {
    const result = applyKeybindingsFile(file('{"palette.toggle": null, "pane.close": null, "app.quit": null}', null, "config directory does not exist"));
    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([
      "live reload unavailable: config directory does not exist",
      "palette.toggle unbound: the palette loses that key",
      "pane.close unbound: a key-only command, now out of reach",
    ]);
    expect(keybindingsDiagnostics(result).lines).toEqual(result.warnings);
  });

  it("an entry for a command not registered yet waits, then applies when it registers", () => {
    const store = useKeybindingsStore.getState();
    store.apply(file('{"later.cmd": "ctrl+shift+l"}'));
    expect(useKeybindingsStore.getState().errors).toEqual(["unknown command later.cmd"]);
    const unregister = registerCommand({ id: "later.cmd", title: "Later", run: () => {} });
    expect(shown("later.cmd")).toBe("ctrl+shift+l");
    expect(useKeybindingsStore.getState()).toMatchObject({ status: "ok", errors: [] });
    unregister();
    expect(useKeybindingsStore.getState().errors).toEqual(["unknown command later.cmd"]);
  });

  it("a rebound pass-through letter passes through on a non-Latin layout (matched on its physical key)", () => {
    applyKeybindingsFile(file('{"terminal.toggle": "ctrl+shift+t"}'));
    // Cyrillic: the T key reports `Е`.
    expect(terminalKeyAllowed(termKey("Е", { ctrlKey: true, shiftKey: true, code: "KeyT" }))).toBe(true);
    useUiStore.setState({ pane: "terminal" });
    expect(handleKeydown(key("Е", { ctrlKey: true, shiftKey: true, code: "KeyT", target: IN_TERMINAL }))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
    // Another modifier set on that key is not it.
    expect(terminalKeyAllowed(termKey("е", { ctrlKey: true, code: "KeyT" }))).toBe(false);
  });

  it("a fetch failure is listed as an error", () => {
    useKeybindingsStore.getState().setLoadError("no Tauri runtime");
    expect(useKeybindingsStore.getState()).toMatchObject({ loaded: true, status: "errors", errors: ["cannot load keybindings.json: no Tauri runtime"] });
  });

  it("the terminal toggle rebound to ctrl+shift+t passes through a focused terminal; ctrl+` no longer does", () => {
    expect(terminalKeyAllowed(termKey("`", { ctrlKey: true }))).toBe(true);
    applyKeybindingsFile(file('{"terminal.toggle": "ctrl+shift+t"}'));
    expect(terminalKeyAllowed(termKey("T", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(terminalKeyAction(termKey("T", { ctrlKey: true, shiftKey: true }))).toBe("dispatch");
    expect(terminalKeyAllowed(termKey("`", { ctrlKey: true, code: "Backquote" }))).toBe(false);
    expect(terminalKeyAction(termKey("`", { ctrlKey: true, code: "Backquote" }))).toBe("terminal");
    // The other pass-through keys are unchanged.
    expect(terminalKeyAllowed(termKey("K", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(terminalKeyAllowed(termKey("PageDown", { ctrlKey: true }))).toBe(true);

    // The dispatcher, focus in a terminal: the new key reaches terminal.toggle (its `when` holds
    // while the pane shows).
    useUiStore.setState({ pane: "terminal" });
    expect(handleKeydown(key("T", { ctrlKey: true, shiftKey: true, target: IN_TERMINAL }))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
    expect(handleKeydown(key("`", { ctrlKey: true, code: "Backquote", target: IN_TERMINAL }))).toBe(false);
  });

  it("a pass-through command unbound passes nothing; the palette's second key can be moved", () => {
    applyKeybindingsFile(file('{"terminal.nextTab": null, "palette.toggleFromTerminal": "ctrl+shift+p"}'));
    expect(terminalKeyAllowed(termKey("PageDown", { ctrlKey: true, code: "PageDown" }))).toBe(false);
    expect(terminalKeyAllowed(termKey("PageUp", { ctrlKey: true, code: "PageUp" }))).toBe(true);
    expect(terminalKeyAllowed(termKey("K", { ctrlKey: true, shiftKey: true, code: "KeyK" }))).toBe(false);
    expect(terminalKeyAllowed(termKey("P", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(handleKeydown(key("P", { ctrlKey: true, shiftKey: true, target: IN_TERMINAL }))).toBe(true);
    expect(usePaletteStore.getState().isOpen).toBe(true);
  });
});
