import { beforeEach, describe, expect, it, vi } from "vitest";

const hintsSet = vi.fn();
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    hasTauriRuntime: () => true,
    hintsSet: (...args: unknown[]) => hintsSet(...args),
    checklistSet: async () => undefined,
  };
});

import type { AppStateSnapshot } from "../ipc";
import { applyStateError, applyStateReply } from "./appState";
import { resetChecklist, useChecklistStore } from "./checklist";
import { areHintsOn, hintsOn, isHintsLoaded, resetHints, useHintsStore } from "./hints";
import { resetWhatsNew } from "./whatsNew";

function snapshot(dismissed: boolean, hidden: boolean | null, shown = true): AppStateSnapshot {
  return { firstRun: false, checklist: { shown, dismissed, done: [] }, version: "0.1.0", lastSeenVersion: "0.1.0", hints: { hidden }, tour: { done: false } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the hints setting (Story 11.3)", () => {
  beforeEach(() => {
    hintsSet.mockReset();
    hintsSet.mockImplementation(async (hidden: boolean | null) => snapshot(false, hidden));
    resetChecklist();
    resetHints();
    resetWhatsNew();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("hintsOn: null follows the card, false shows, true hides", () => {
    expect(hintsOn(null, true)).toBe(true);
    expect(hintsOn(null, false)).toBe(false);
    expect(hintsOn(false, false)).toBe(true);
    expect(hintsOn(false, true)).toBe(true);
    expect(hintsOn(true, true)).toBe(false);
    expect(hintsOn(true, false)).toBe(false);
  });

  it("first project, fresh profile: on while the card shows", () => {
    applyStateReply(snapshot(false, null));
    expect(isHintsLoaded()).toBe(true);
    expect(useHintsStore.getState().hidden).toBeNull();
    expect(areHintsOn()).toBe(true);
  });

  it("dismissed card with hidden null: off", () => {
    applyStateReply(snapshot(true, null));
    expect(areHintsOn()).toBe(false);
    // Dismissing during the run turns them off too.
    resetChecklist();
    resetHints();
    applyStateReply(snapshot(false, null));
    useChecklistStore.getState().dismiss();
    expect(areHintsOn()).toBe(false);
  });

  it("show after dismiss: on, and hidden false is written", async () => {
    applyStateReply(snapshot(true, null));
    useHintsStore.getState().setHidden(false);
    expect(areHintsOn()).toBe(true);
    await flush();
    expect(hintsSet).toHaveBeenCalledWith(false);
  });

  it("hide: off, and hidden true is written; a repeat writes nothing", async () => {
    applyStateReply(snapshot(false, null));
    useHintsStore.getState().setHidden(true);
    expect(areHintsOn()).toBe(false);
    useHintsStore.getState().setHidden(true);
    await flush();
    expect(hintsSet).toHaveBeenCalledTimes(1);
    expect(hintsSet).toHaveBeenCalledWith(true);
  });

  it("a stored value loads as it is (false shows with the card never shown)", () => {
    applyStateReply(snapshot(false, false, false));
    expect(useHintsStore.getState().hidden).toBe(false);
    expect(areHintsOn()).toBe(true);
  });

  it("nothing changes before state.json loaded", async () => {
    useHintsStore.getState().setHidden(true);
    expect(useHintsStore.getState().hidden).toBeNull();
    await flush();
    expect(hintsSet).not.toHaveBeenCalled();
  });

  it("a failed load keeps changes in memory and writes nothing", async () => {
    applyStateError("boom");
    expect(isHintsLoaded()).toBe(true);
    useHintsStore.getState().setHidden(false);
    expect(useHintsStore.getState().hidden).toBe(false);
    await flush();
    expect(hintsSet).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("hints: cannot load state.json: boom");
  });

  it("a failed write is logged and the setting stays in memory", async () => {
    hintsSet.mockRejectedValueOnce("read-only");
    applyStateReply(snapshot(false, null));
    useHintsStore.getState().setHidden(true);
    await flush();
    await flush();
    expect(useHintsStore.getState().hidden).toBe(true);
    expect(console.error).toHaveBeenCalledWith("hints: cannot save state.json: read-only");
  });
});
