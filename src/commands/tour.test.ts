// The tour's commands and tour-mode dispatch (Story 11.6): `tour.start` in the palette, the hidden
// key carriers guarded by `isTourOn()`, and while the tour is on only the tour's keys and the
// palette's toggle reach a command (the palette's own keys too while it is open over the tour).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltins } from "./builtins";
import { handleKeydown, tourModeAllows, type KeyEventLike } from "./keybindings";
import { clearCommands, getCommand, listCommands, runCommand } from "./registry";
import { runPaletteRow, usePaletteStore } from "../state/palette";
import { resetTour, useTourStore } from "../state/tour";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";

function key(k: string, mods: Partial<Omit<KeyEventLike, "key" | "preventDefault">> = {}): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: vi.fn(), ...mods };
}

const tour = () => useTourStore.getState();

describe("the tour's commands (Story 11.6)", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    resetTour();
    usePaletteStore.setState({ isOpen: false, pick: null, query: "", selected: 0 });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false });
    useWorkspaceStore.setState({
      snapshot: {
        path: null,
        workspace: {
          version: 1,
          viewport: { x: 0, y: 0, zoom: 1 },
          projects: [{ id: "p1", path: "/p/p1", label: "p1", position: { x: 0, y: 0 }, expanded: true, color: null, launchDefaults: null, showBranches: false }],
          branches: [],
          sessions: [],
          edges: [],
          defaults: { model: null, effort: null, permissionMode: null },
        },
        banners: [],
        revision: 1,
        branchErrors: {},
        children: [],
      } as never,
      loadError: null,
    });
  });
  afterEach(() => clearCommands());

  it("Take the tour is in the palette with no default key; the carriers are hidden with the spec's keys", () => {
    const palette = listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.id);
    expect(palette).toContain("tour.start");
    expect(getCommand("tour.start")).toMatchObject({ title: "Take the tour" });
    expect(getCommand("tour.start")?.keybinding).toBeUndefined();
    expect(getCommand("tour.next")).toMatchObject({ keybinding: "arrowright", hidden: true });
    expect(getCommand("tour.next.enter")).toMatchObject({ keybinding: "enter", hidden: true });
    expect(getCommand("tour.back")).toMatchObject({ keybinding: "arrowleft", hidden: true });
    expect(getCommand("tour.skip")).toMatchObject({ keybinding: "escape", hidden: true });
    // Off: the carriers are disabled.
    for (const id of ["tour.next", "tour.next.enter", "tour.back", "tour.skip"]) expect(runCommand(id), id).toBe(false);
  });

  it("the keys drive the tour: → and Enter next, ← back, Esc skips", () => {
    expect(runCommand("tour.start")).toBe(true);
    expect(handleKeydown(key("ArrowRight"))).toBe(true);
    expect(tour().stop).toBe(1);
    expect(handleKeydown(key("Enter"))).toBe(true);
    expect(tour().stop).toBe(2);
    expect(handleKeydown(key("ArrowLeft"))).toBe(true);
    expect(tour().stop).toBe(1);
    expect(handleKeydown(key("Escape"))).toBe(true);
    expect(tour().on).toBe(false);
    expect(tour().done).toBe(true);
  });

  it("other keys are ignored during the tour: n, the arrows' selection moves, Esc's selection clear", () => {
    useUiStore.setState({ selection: { kind: "project", id: "p1" } as never });
    // Off, `n` would open the launch sheet on the selected project.
    expect(getCommand("project.newSession")?.when?.()).toBe(true);
    runCommand("tour.start");
    const n = key("n");
    expect(handleKeydown(n)).toBe(false);
    expect(n.preventDefault).not.toHaveBeenCalled();
    expect(useUiStore.getState().pane).toBeNull();
    expect(handleKeydown(key("ArrowDown"))).toBe(false);
    expect(handleKeydown(key("o", { ctrlKey: true }))).toBe(false);
    expect(handleKeydown(key("F1"))).toBe(false);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "p1" });
    handleKeydown(key("ArrowRight"));
    expect(tour().stop).toBe(1);
    expect(useUiStore.getState().selection).toEqual({ kind: "project", id: "p1" });
  });

  it("ctrl+k opens the palette over the tour; its keys are the palette's; Esc closes it and the tour is unchanged", () => {
    runCommand("tour.start");
    handleKeydown(key("ArrowRight"));
    expect(handleKeydown(key("k", { ctrlKey: true }))).toBe(true);
    expect(usePaletteStore.getState().isOpen).toBe(true);
    // Typing in the palette's input: ← moves the caret, never the tour.
    expect(handleKeydown(key("ArrowLeft", { target: { tagName: "INPUT" } }))).toBe(false);
    expect(handleKeydown(key("Escape", { target: { tagName: "INPUT" } }))).toBe(true);
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(tour()).toMatchObject({ on: true, stop: 1, done: false });
  });

  it("tour-mode filter: tour.*, the palette's toggle, and with the palette open its own commands", () => {
    expect(tourModeAllows("tour.next", false)).toBe(true);
    expect(tourModeAllows("tour.start", true)).toBe(true);
    expect(tourModeAllows("palette.toggle", false)).toBe(true);
    expect(tourModeAllows("palette.toggleFromTerminal", false)).toBe(true);
    expect(tourModeAllows("palette.close", false)).toBe(false);
    expect(tourModeAllows("palette.close", true)).toBe(true);
    for (const id of ["selection.activate", "selection.move.right", "contextMenu.close", "pane.close", "project.newSession", "help.toggle"]) {
      expect(tourModeAllows(id, false), id).toBe(false);
      expect(tourModeAllows(id, true), id).toBe(false);
    }
  });

  it("a non-tour command picked from the palette over the tour ends the tour first (as Skip), then runs", () => {
    runCommand("tour.start");
    runCommand("tour.next");
    usePaletteStore.getState().open();
    runPaletteRow("settings.open");
    expect(tour()).toMatchObject({ on: false, done: true });
    expect(useUiStore.getState().pane).toBe("settings");
    expect(usePaletteStore.getState().isOpen).toBe(false);
    // A tour command from the palette leaves it on.
    useUiStore.setState({ pane: null });
    runCommand("tour.start");
    usePaletteStore.getState().open();
    runPaletteRow("tour.start");
    expect(tour().on).toBe(true);
  });

  it("tour.start closes the context menu and the open pane first", () => {
    useUiStore.setState({ contextMenu: { target: { kind: "project", id: "p1" }, at: { x: 1, y: 1 } } as never, pane: "settings" });
    runCommand("tour.start");
    expect(useUiStore.getState().contextMenu).toBeNull();
    expect(useUiStore.getState().pane).toBeNull();
    expect(tour().on).toBe(true);
  });

  it("the two Next carriers have distinct titles (the Keyboard page's table)", () => {
    expect(getCommand("tour.next")?.title).toBe("Tour: next");
    expect(getCommand("tour.next.enter")?.title).toBe("Tour: next (enter)");
  });

  it("tour.start runs from stop 1, also while on", () => {
    runCommand("tour.start");
    runCommand("tour.next");
    runCommand("tour.next");
    runCommand("tour.start");
    expect(tour()).toMatchObject({ on: true, stop: 0 });
  });
});
