import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const whatsNewSeen = vi.fn();
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, hasTauriRuntime: () => true, whatsNewSeen: (...args: unknown[]) => whatsNewSeen(...args) };
});

import type { AppStateSnapshot } from "../ipc";
import { usePaletteStore, paletteRows, runPaletteRow } from "../state/palette";
import { useUiStore } from "../state/ui";
import { resetWhatsNew, useWhatsNewStore } from "../state/whatsNew";
import { registerBuiltins } from "./builtins";
import { CHANGELOG_PAGE, showHelpPage } from "./help";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { clearCommands, getCommand, listCommands, runCommand } from "./registry";

function snapshot(lastSeenVersion: string | null, version = "0.2.0", firstRun = false): AppStateSnapshot {
  return { firstRun, checklist: { shown: false, dismissed: false, done: [] }, version, lastSeenVersion, hints: { hidden: null }, tour: { done: false } };
}

function key(k: string): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: () => {} };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("What's new: every route to the Changelog marks it seen (Story 10.5)", () => {
  beforeEach(() => {
    clearCommands();
    whatsNewSeen.mockReset();
    whatsNewSeen.mockResolvedValue(snapshot("0.2.0"));
    resetWhatsNew();
    usePaletteStore.setState({ isOpen: false, pick: null, query: "", selected: 0 });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, notice: null, elsewhereOpen: false, helpPage: null, helpAnchor: null, helpReturn: null, helpLastRead: null, openTerminals: [] });
    registerBuiltins();
  });
  afterEach(() => {
    clearCommands();
  });

  it("What's new is listed (unbound) whether or not the chip shows, titled with the version once known, and opens the Changelog", () => {
    const command = getCommand("help.whatsNew");
    expect(command?.keybinding).toBeUndefined();
    expect(listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.title)).toContain("What's new");

    useWhatsNewStore.getState().load(snapshot("0.1.0", "0.1.0"));
    expect(useWhatsNewStore.getState().show).toBe(false);
    usePaletteStore.getState().open();
    const rows = paletteRows(null, listCommands({ enabledOnly: true, visibleOnly: true }), "new").map((r) => r.title);
    expect(rows).toContain("What's new in 0.1.0");
    runPaletteRow("help.whatsNew");
    expect(useUiStore.getState().pane).toBe("help");
    expect(useUiStore.getState().helpPage).toBe(CHANGELOG_PAGE);
  });

  it("help.whatsNew clears the chip and records the version once", async () => {
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    expect(useWhatsNewStore.getState().show).toBe(true);
    expect(runCommand("help.whatsNew")).toBe(true);
    expect(useWhatsNewStore.getState().show).toBe(false);
    expect(whatsNewSeen).toHaveBeenCalledTimes(1);
    runCommand("help.whatsNew");
    runCommand("help.changelog");
    await flush();
    expect(whatsNewSeen).toHaveBeenCalledTimes(1);
  });

  it("help.changelog marks it seen", () => {
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    runCommand("help.changelog");
    expect(useWhatsNewStore.getState().show).toBe(false);
    expect(whatsNewSeen).toHaveBeenCalledTimes(1);
  });

  it("a Contents row or a page link (showHelpPage) marks it seen; another page does not", () => {
    useWhatsNewStore.getState().load(snapshot(null));
    expect(useWhatsNewStore.getState().show).toBe(true);
    showHelpPage(null);
    showHelpPage("roadmap");
    showHelpPage("canvas", "edges");
    expect(useWhatsNewStore.getState().show).toBe(true);
    expect(whatsNewSeen).not.toHaveBeenCalled();
    showHelpPage(CHANGELOG_PAGE);
    expect(useWhatsNewStore.getState().show).toBe(false);
    expect(whatsNewSeen).toHaveBeenCalledTimes(1);
  });

  it("Help: open page… picking Changelog marks it seen", async () => {
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    expect(runCommand("help.page")).toBe(true);
    await vi.waitFor(() => expect(usePaletteStore.getState().pick).not.toBeNull());
    runPaletteRow(CHANGELOG_PAGE);
    expect(useUiStore.getState().helpPage).toBe(CHANGELOG_PAGE);
    expect(useWhatsNewStore.getState().show).toBe(false);
    expect(whatsNewSeen).toHaveBeenCalledTimes(1);
  });

  it("F1 opening the last-read page (the Changelog) marks it seen", () => {
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    useUiStore.setState({ helpLastRead: CHANGELOG_PAGE });
    expect(handleKeydown(key("F1"))).toBe(true);
    expect(useUiStore.getState().helpPage).toBe(CHANGELOG_PAGE);
    expect(useWhatsNewStore.getState().show).toBe(false);
    expect(whatsNewSeen).toHaveBeenCalledTimes(1);
  });
});
