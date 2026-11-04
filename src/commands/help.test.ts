import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePaletteStore, paletteRows, runPaletteRow } from "../state/palette";
import { useLaunchStore } from "../state/launch";
import { useReviewStore } from "../state/review";
import { useUiStore } from "../state/ui";
import { HELP_PAGES } from "../help/pages";
import { isChecklistCardShown, resetChecklist, useChecklistStore } from "../state/checklist";
import { registerBuiltins } from "./builtins";
import { showEdge } from "./edges";
import { openWebLink, showHelpPage } from "./help";
import { openPane } from "./panes";
import type { LaunchForm } from "./launch";
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
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, notice: null, elsewhereOpen: false, helpPage: null, helpAnchor: null, helpReturn: null, helpLastRead: null, openTerminals: [] });
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
    // Story 10.2: "Help" over the settings pane opens its page, and closing Help brings settings back.
    expect(runCommand("help.open")).toBe(true);
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: "settings", helpReturn: "settings" });
    expect(runCommand("pane.close")).toBe(true);
    expect(useUiStore.getState()).toMatchObject({ pane: "settings", helpReturn: null, helpPage: null });
    expect(runCommand("pane.close")).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("typing help in the palette lists Help and Help: open page…, and Help: contents only with a page shown; F1's carrier is hidden", () => {
    const rows = () =>
      paletteRows(null, listCommands({ enabledOnly: true, visibleOnly: true }), "help").map((row) => row.title);
    expect(rows()).toEqual(["Help", "Help: changelog", "Help: getting started", "Help: open page…", "Help: roadmap", "Help: what you see", "What's new"]);
    showHelpPage("canvas");
    expect(rows()).toEqual(["Help", "Help: changelog", "Help: contents", "Help: getting started", "Help: open page…", "Help: roadmap", "Help: what you see", "What's new"]);
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
    expect(pick.items.map((item) => item.title)).toEqual(HELP_PAGES.map((page) => page.title));
    expect(pick.items).toHaveLength(15);
    runPaletteRow("keyboard");
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: "keyboard", helpAnchor: null });
  });

  it("Story 10.4: Help: changelog and Help: roadmap are listed in the palette, unbound, and open their page", () => {
    for (const [id, title, query, page] of [
      ["help.changelog", "Help: changelog", "changelog", "changelog"],
      ["help.roadmap", "Help: roadmap", "roadmap", "roadmap"],
      // Story 11.5: the What you see page, the same way.
      ["help.legend", "Help: what you see", "what you see", "legend"],
    ] as const) {
      const command = getCommand(id);
      expect(command?.title).toBe(title);
      expect(command?.defaultBinding ?? null).toBeNull();
      expect(command?.hidden ?? false).toBe(false);
      const rows = paletteRows(null, listCommands({ enabledOnly: true, visibleOnly: true }), query).map((row) => row.title);
      expect(rows, query).toContain(title);
      useUiStore.setState({ pane: null, helpPage: null, helpAnchor: null });
      expect(runCommand(id)).toBe(true);
      expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: page, helpAnchor: null });
    }
    // Bindable like any command.
    applyBindingOverrides({ "help.roadmap": "ctrl+alt+r" });
    try {
      expect(getCommand("help.roadmap")?.binding).not.toBeNull();
    } finally {
      applyBindingOverrides({});
    }
  });

  it("Story 10.3: Help: getting started opens its page; Show / Dismiss getting started move the card", () => {
    expect(getCommand("help.gettingStarted")?.title).toBe("Help: getting started");
    expect(runCommand("help.gettingStarted")).toBe(true);
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: "getting-started" });

    resetChecklist();
    // Before state.json answers neither works (show would write the defaults over the file).
    expect(runCommand("checklist.show")).toBe(false);
    expect(runCommand("checklist.dismiss")).toBe(false);
    useChecklistStore.getState().load({ firstRun: false, checklist: { shown: false, dismissed: false, done: [] }, version: "0.1.0", lastSeenVersion: "0.1.0", hints: { hidden: null }, tour: { done: false } });
    expect(getCommand("checklist.show")?.title).toBe("Show getting started");
    expect(getCommand("checklist.dismiss")?.title).toBe("Dismiss getting started");
    expect(runCommand("checklist.dismiss")).toBe(false);
    expect(runCommand("checklist.show")).toBe(true);
    expect(isChecklistCardShown()).toBe(true);
    expect(runCommand("checklist.show")).toBe(false);
    expect(runCommand("checklist.dismiss")).toBe(true);
    expect(isChecklistCardShown()).toBe(false);
    expect(useChecklistStore.getState()).toMatchObject({ shown: true, dismissed: true });
    expect(listCommands({ visibleOnly: true }).some((c) => c.id === "checklist.show")).toBe(true);
    resetChecklist();
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

describe("F1 from where you are and the return to the pane (Story 10.2)", () => {
  const form: LaunchForm = {
    name: "typed name",
    model: "",
    customModel: "",
    effort: "",
    permissionMode: "",
    addDirs: [],
    prompt: "",
    background: false,
    useWorktree: false,
    worktreeName: "typed-name",
    worktreeNameEdited: false,
  };

  beforeEach(() => {
    clearCommands();
    usePaletteStore.setState({ isOpen: false, pick: null, query: "", selected: 0 });
    useUiStore.setState({
      pane: null,
      selection: null,
      contextMenu: null,
      notice: null,
      elsewhereOpen: false,
      helpPage: null,
      helpAnchor: null,
      helpReturn: null,
      helpLastRead: null,
      openTerminals: [],
    });
    useLaunchStore.getState().reset();
    registerBuiltins();
  });
  afterEach(() => {
    clearCommands();
    useLaunchStore.getState().reset();
  });

  /** The launch sheet open with a typed form, as `sessions.ts` leaves it. */
  function openTypedLaunchSheet(): void {
    useLaunchStore.setState({ projectId: "p1", projectLabel: "demo", form });
    useUiStore.getState().openPane("launch");
  }

  it("F1 over the launch sheet opens Sessions & launch sheet; Esc, Close or F1 bring the sheet back as typed", () => {
    for (const close of [() => handleKeydown(key("Escape")), () => runCommand("pane.close"), () => handleKeydown(key("F1"))]) {
      openTypedLaunchSheet();
      expect(handleKeydown(key("F1"))).toBe(true);
      expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: "sessions", helpReturn: "launch" });
      expect(useLaunchStore.getState()).toMatchObject({ projectId: "p1", form });
      expect(close()).toBe(true);
      expect(useUiStore.getState()).toMatchObject({ pane: "launch", helpReturn: null, helpPage: null });
      expect(useLaunchStore.getState()).toMatchObject({ projectId: "p1", form });
    }
  });

  it("each pane opens its page, worked out before Help replaces it", () => {
    const rows = [
      ["terminal", "terminals"],
      ["edge", "edges"],
      ["review", "review"],
      ["import", "projects"],
      ["settings", "settings"],
      ["worktree", "branches"],
      ["removeWorktree", "branches"],
    ] as const;
    for (const [pane, page] of rows) {
      useUiStore.setState({ pane, helpReturn: null });
      expect(runCommand("help.open"), pane).toBe(true);
      expect(useUiStore.getState(), pane).toMatchObject({ pane: "help", helpPage: page, helpReturn: pane });
    }
  });

  it("with no pane the selection picks the page; with nothing, the page last read, else Contents", () => {
    useUiStore.setState({ selection: { kind: "project", id: "p" } });
    handleKeydown(key("F1"));
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: "projects", helpReturn: null });
    handleKeydown(key("F1"));
    expect(useUiStore.getState().pane).toBeNull();

    useUiStore.setState({ selection: null, helpLastRead: null });
    runCommand("help.open");
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: null });
    showHelpPage("review");
    runCommand("pane.close");
    runCommand("help.open");
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: "review" });
  });

  it("Help to canvas: Help opened with no pane closes to the canvas", () => {
    runCommand("help.open");
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(useUiStore.getState()).toMatchObject({ pane: null, helpReturn: null });
  });

  it("Leave elsewhere: another pane opened from Help resets the remembered pane; the remembered pane itself keeps its state", () => {
    openTypedLaunchSheet();
    handleKeydown(key("F1"));
    expect(runCommand("settings.open")).toBe(true);
    expect(useUiStore.getState()).toMatchObject({ pane: "settings", helpReturn: null, helpPage: null });
    expect(useLaunchStore.getState()).toMatchObject({ projectId: null, form: null });

    const closeTarget = vi.spyOn(useReviewStore.getState(), "closeTarget");
    useUiStore.setState({ pane: "review" });
    runCommand("help.open");
    expect(useUiStore.getState().helpReturn).toBe("review");
    expect(closeTarget).not.toHaveBeenCalled();
    expect(useUiStore.getState().pane).toBe("help");
    expect(runCommand("settings.toggle")).toBe(true);
    expect(useUiStore.getState().pane).toBe("settings");
    expect(closeTarget).toHaveBeenCalledTimes(1);
    closeTarget.mockRestore();
  });

  it("the edge inspector comes back only while an edge is still selected", () => {
    useUiStore.setState({ pane: "edge", selection: { kind: "edge", id: "e1" } });
    handleKeydown(key("F1"));
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: "edges", helpReturn: "edge" });
    handleKeydown(key("Escape"));
    expect(useUiStore.getState().pane).toBe("edge");

    handleKeydown(key("F1"));
    useUiStore.getState().clearSelection();
    expect(useUiStore.getState().pane).toBe("help");
    handleKeydown(key("Escape"));
    expect(useUiStore.getState()).toMatchObject({ pane: null, helpReturn: null });
  });

  it("the terminal pane comes back only while it still has a tab", () => {
    useUiStore.setState({ pane: "terminal", openTerminals: ["t1"] });
    handleKeydown(key("F1"));
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: "terminals" });
    useUiStore.setState({ openTerminals: [] });
    runCommand("pane.close");
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("an edge clicked while Help covers a sheet is only selected: the sheet's form survives and comes back", () => {
    openTypedLaunchSheet();
    handleKeydown(key("F1"));
    showEdge("e1");
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpReturn: "launch", selection: { kind: "edge", id: "e1" } });
    expect(useLaunchStore.getState()).toMatchObject({ projectId: "p1", form });
    handleKeydown(key("Escape"));
    expect(useUiStore.getState().pane).toBe("launch");
    expect(useLaunchStore.getState()).toMatchObject({ projectId: "p1", form });
  });

  it("a sheet whose submit finished while Help covered it does not come back: Help closes to the canvas", () => {
    openTypedLaunchSheet();
    handleKeydown(key("F1"));
    useLaunchStore.getState().reset();
    handleKeydown(key("Escape"));
    expect(useUiStore.getState()).toMatchObject({ pane: null, helpReturn: null });
  });

  it("opening the covered pane itself from Help keeps its state", () => {
    openTypedLaunchSheet();
    handleKeydown(key("F1"));
    const next: LaunchForm = { ...form, name: "another name" };
    useLaunchStore.setState({ form: next });
    openPane("launch");
    expect(useUiStore.getState()).toMatchObject({ pane: "launch", helpReturn: null, helpPage: null });
    expect(useLaunchStore.getState()).toMatchObject({ projectId: "p1", form: next });
  });
});
