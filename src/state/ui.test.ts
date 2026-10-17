import { beforeEach, describe, expect, it } from "vitest";
import { FLASH_MS, isPaneOpen, useUiStore } from "./ui";

describe("ui store", () => {
  beforeEach(() => {
    useUiStore.setState({ pane: null, flashed: [] });
  });

  it("starts with no pane and nothing flashed", () => {
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().flashed).toEqual([]);
    expect(isPaneOpen()).toBe(false);
  });

  it("openPane opens, closePane closes, and opening another pane replaces the first", () => {
    const s = useUiStore.getState();
    s.openPane("settings");
    expect(useUiStore.getState().pane).toBe("settings");
    expect(isPaneOpen()).toBe(true);
    s.openPane("import");
    expect(useUiStore.getState().pane).toBe("import");
    s.openPane("import");
    expect(useUiStore.getState().pane).toBe("import");
    s.closePane();
    s.closePane();
    expect(useUiStore.getState().pane).toBeNull();
    expect(isPaneOpen()).toBe(false);
  });

  it("togglePane flips its own pane and switches from another", () => {
    const s = useUiStore.getState();
    s.togglePane("settings");
    expect(useUiStore.getState().pane).toBe("settings");
    s.togglePane("settings");
    expect(useUiStore.getState().pane).toBeNull();
    s.openPane("import");
    s.togglePane("settings");
    expect(useUiStore.getState().pane).toBe("settings");
  });

  it("flash adds ids without duplicates and unflash removes only those given", () => {
    const s = useUiStore.getState();
    s.flash(["a", "b"]);
    s.flash(["b", "c"]);
    expect(useUiStore.getState().flashed).toEqual(["a", "b", "c"]);
    s.unflash(["b"]);
    expect(useUiStore.getState().flashed).toEqual(["a", "c"]);
    s.unflash(["zzz"]);
    expect(useUiStore.getState().flashed).toEqual(["a", "c"]);
    s.unflash(["a", "c"]);
    expect(useUiStore.getState().flashed).toEqual([]);
  });

  it("flashed is reference-stable when a call changes nothing", () => {
    const s = useUiStore.getState();
    s.flash(["a"]);
    const before = useUiStore.getState().flashed;
    s.flash([]);
    s.flash(["a"]);
    s.unflash([]);
    s.unflash(["nope"]);
    expect(useUiStore.getState().flashed).toBe(before);
    s.unflash(["a"]);
    const empty = useUiStore.getState().flashed;
    s.flash(["b"]);
    s.unflash(["b"]);
    expect(useUiStore.getState().flashed).toBe(empty);
  });

  it("the flash lasts 1.5 s", () => {
    expect(FLASH_MS).toBe(1500);
  });
});
