import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePaletteStore, paletteRows, runPaletteRow } from "../state/palette";
import { useUiStore } from "../state/ui";
import { registerBuiltins } from "./builtins";
import { openWebLink, showHelpPage } from "./help";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { applyBindingOverrides, clearCommands, getCommand, listCommands, runCommand, subscribeBindings } from "./registry";

function key(k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: () => {}, ...mods };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("help commands (Story 10.1)", () => {
  beforeEach(() => {
    clearCommands();
    usePaletteStore.setState({ isOpen: false, pick: null, query: "", selected: 0 });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, notice: null, elsewhereOpen: false, helpPage: null, helpAnchor: null });
    registerBuiltins();
  });
  afterEach(() => {
    clearCommands();
    vi.unstubAllGlobals();
  });

  it("F1 toggles the Help pane on Contents, from the canvas, a field and the palette", () => {
    expect(handleKeydown(key("F1"))).toBe(true);
    expect(useUiStore.getState().pane).toBe("help");
    expect(useUiStore.getState().helpPage).toBeNull();
    expect(handleKeydown(key("F1"))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();

    // F1 is never typed text: it works with focus in an input or the Review editor (contenteditable).
    expect(handleKeydown(key("F1", { target: { tagName: "INPUT" } }))).toBe(true);
    expect(useUiStore.getState().pane).toBe("help");
    expect(handleKeydown(key("F1", { target: { tagName: "DIV", isContentEditable: true } }))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();

    usePaletteStore.getState().open();
    expect(handleKeydown(key("F1", { target: { tagName: "INPUT" } }))).toBe(true);
    expect(useUiStore.getState().pane).toBe("help");
  });

  it("F1 inside a terminal is the terminal's; ctrl+shift+k then Help opens the pane", () => {
    const inTerminal = { tagName: "TEXTAREA", closest: (selector: string) => (selector === "[data-terminal]" ? {} : null) };
    expect(handleKeydown(key("F1", { target: inTerminal }))).toBe(false);
    expect(useUiStore.getState().pane).toBeNull();
    expect(handleKeydown(key("K", { ctrlKey: true, shiftKey: true, code: "KeyK", target: inTerminal }))).toBe(true);
    expect(usePaletteStore.getState().isOpen).toBe(true);
    runPaletteRow("help.open");
    expect(useUiStore.getState().pane).toBe("help");
    expect(usePaletteStore.getState().isOpen).toBe(false);
  });

  it("Esc and Close run pane.close; opening another pane closes Help, and Help comes back on Contents", () => {
    showHelpPage("keyboard", "the-command-palette");
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: "keyboard", helpAnchor: "the-command-palette" });
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().helpPage).toBeNull();

    showHelpPage("canvas");
    expect(runCommand("settings.open")).toBe(true);
    expect(useUiStore.getState().pane).toBe("settings");
    expect(useUiStore.getState().helpPage).toBeNull();
    expect(runCommand("help.open")).toBe(true);
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: null });
    expect(runCommand("pane.close")).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("typing help in the palette lists Help and Help: open page…, and Help: contents only with a page shown; F1's carrier is hidden", () => {
    const rows = () =>
      paletteRows(null, listCommands({ enabledOnly: true, visibleOnly: true }), "help").map((row) => row.title);
    expect(rows()).toEqual(["Help", "Help: open page…"]);
    showHelpPage("canvas");
    expect(rows()).toEqual(["Help", "Help: contents", "Help: open page…"]);
    expect(getCommand("help.toggle")).toMatchObject({ hidden: true, keybinding: "f1" });
    for (const id of ["help.open", "help.page", "help.contents"]) expect(getCommand(id)?.keybinding, id).toBeUndefined();

    expect(runCommand("help.contents")).toBe(true);
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: null });
    expect(runCommand("help.contents")).toBe(false);
  });

  it("Help: open page… is a pick list of the guide pages; picking one shows it", async () => {
    expect(runCommand("help.page")).toBe(true);
    await flush();
    await vi.waitFor(() => expect(usePaletteStore.getState().pick).not.toBeNull());
    const pick = usePaletteStore.getState().pick!;
    expect(pick.items.map((item) => item.title)).toEqual(["Canvas & navigation", "Keyboard & palette"]);
    runPaletteRow("keyboard");
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: "keyboard", helpAnchor: null });
  });

  it("every help action is bindable: a rebound F1 moves the key, an unbound one removes it", () => {
    let changed = 0;
    const stop = subscribeBindings(() => changed++);
    applyBindingOverrides({ "help.toggle": "ctrl+h", "help.page": "ctrl+shift+h" });
    expect(changed).toBe(1);
    expect(handleKeydown(key("F1"))).toBe(false);
    expect(handleKeydown(key("h", { ctrlKey: true }))).toBe(true);
    expect(useUiStore.getState().pane).toBe("help");
    expect(getCommand("help.page")?.binding).toMatchObject({ ctrl: true, shift: true, key: "h" });
    applyBindingOverrides({ "help.toggle": null });
    expect(getCommand("help.toggle")?.binding).toBeNull();
    stop();
  });

  it("a web link goes to open_url; a refusal or failure is the notice", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await openWebLink("https://example.com");
    expect(invoke).toHaveBeenCalledWith("open_url", { url: "https://example.com" }, undefined);
    expect(useUiStore.getState().notice).toBeNull();
    invoke.mockRejectedValueOnce("not an http(s) link: javascript:alert(1)");
    await openWebLink("javascript:alert(1)");
    expect(useUiStore.getState().notice?.text).toBe("not an http(s) link: javascript:alert(1)");
  });
});
