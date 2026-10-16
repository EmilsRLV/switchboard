import { beforeEach, describe, expect, it } from "vitest";
import { clampSelection, filterCommands, paletteKeyAction, usePaletteStore } from "./palette";

const commands = [
  { id: "settings.open", title: "Open settings" },
  { id: "app.quit", title: "Quit" },
  { id: "binaries.redetect", title: "Re-detect binaries" },
  { id: "settings.reveal", title: "Reveal settings file" },
];

describe("filterCommands", () => {
  it("returns everything for an empty or blank query", () => {
    expect(filterCommands(commands, "")).toEqual(commands);
    expect(filterCommands(commands, "   ")).toEqual(commands);
  });

  it("matches a case-insensitive substring of the title", () => {
    expect(filterCommands(commands, "SET").map((c) => c.id)).toEqual(["settings.open", "settings.reveal"]);
    expect(filterCommands(commands, "qu").map((c) => c.id)).toEqual(["app.quit"]);
  });

  it("matches a substring of the id too", () => {
    expect(filterCommands(commands, "binaries").map((c) => c.id)).toEqual(["binaries.redetect"]);
    expect(filterCommands(commands, "app.").map((c) => c.id)).toEqual(["app.quit"]);
  });

  it("preserves the input order (the registry already sorted by title)", () => {
    expect(filterCommands(commands, "e").map((c) => c.id)).toEqual([
      "settings.open",
      "binaries.redetect",
      "settings.reveal",
    ]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });
});

describe("clampSelection", () => {
  it("keeps the index inside the list", () => {
    expect(clampSelection(0, 3)).toBe(0);
    expect(clampSelection(2, 3)).toBe(2);
    expect(clampSelection(3, 3)).toBe(2);
    expect(clampSelection(-1, 3)).toBe(0);
  });

  it("is 0 for an empty list", () => {
    expect(clampSelection(5, 0)).toBe(0);
    expect(clampSelection(-5, 0)).toBe(0);
  });
});

describe("paletteKeyAction", () => {
  it("maps the navigation keys of the palette input", () => {
    expect(paletteKeyAction("ArrowUp")).toBe("up");
    expect(paletteKeyAction("ArrowDown")).toBe("down");
    expect(paletteKeyAction("Enter")).toBe("run");
    expect(paletteKeyAction("Tab")).toBe("trap");
  });

  it("leaves typing and Escape to others", () => {
    expect(paletteKeyAction("s")).toBeNull();
    expect(paletteKeyAction(" ")).toBeNull();
    expect(paletteKeyAction("Backspace")).toBeNull();
    expect(paletteKeyAction("Escape")).toBeNull();
  });
});

describe("palette store", () => {
  beforeEach(() => usePaletteStore.setState({ isOpen: false, query: "", selected: 0 }));

  it("starts closed with an empty query and the first row selected", () => {
    const s = usePaletteStore.getState();
    expect(s.isOpen).toBe(false);
    expect(s.query).toBe("");
    expect(s.selected).toBe(0);
  });

  it("open resets the query and selection", () => {
    usePaletteStore.setState({ query: "old", selected: 3 });
    usePaletteStore.getState().open();
    const s = usePaletteStore.getState();
    expect(s.isOpen).toBe(true);
    expect(s.query).toBe("");
    expect(s.selected).toBe(0);
  });

  it("close only hides it", () => {
    usePaletteStore.getState().open();
    usePaletteStore.getState().setQuery("set");
    usePaletteStore.getState().close();
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(usePaletteStore.getState().query).toBe("set");
  });

  it("toggle opens then closes", () => {
    usePaletteStore.getState().toggle();
    expect(usePaletteStore.getState().isOpen).toBe(true);
    usePaletteStore.getState().toggle();
    expect(usePaletteStore.getState().isOpen).toBe(false);
  });

  it("setQuery resets the selection to the first row", () => {
    usePaletteStore.setState({ selected: 2 });
    usePaletteStore.getState().setQuery("re");
    expect(usePaletteStore.getState().query).toBe("re");
    expect(usePaletteStore.getState().selected).toBe(0);
  });

  it("move clamps to the list", () => {
    const s = usePaletteStore.getState();
    s.move(1, 3);
    s.move(1, 3);
    s.move(1, 3);
    expect(usePaletteStore.getState().selected).toBe(2);
    s.move(-1, 3);
    s.move(-1, 3);
    s.move(-1, 3);
    expect(usePaletteStore.getState().selected).toBe(0);
    s.move(1, 0);
    expect(usePaletteStore.getState().selected).toBe(0);
  });

  it("move clamps a stale selection to the shorter list before applying delta", () => {
    usePaletteStore.setState({ selected: 7 });
    usePaletteStore.getState().move(1, 3);
    expect(usePaletteStore.getState().selected).toBe(2);
    usePaletteStore.setState({ selected: 7 });
    usePaletteStore.getState().move(-1, 3);
    expect(usePaletteStore.getState().selected).toBe(1);
  });

  it("filtered applies the current query", () => {
    usePaletteStore.getState().setQuery("set");
    expect(usePaletteStore.getState().filtered(commands).map((c) => c.id)).toEqual([
      "settings.open",
      "settings.reveal",
    ]);
    usePaletteStore.getState().setQuery("");
    expect(usePaletteStore.getState().filtered(commands)).toEqual(commands);
  });
});
