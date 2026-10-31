import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checklistSet = vi.fn();
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, hasTauriRuntime: () => true, checklistSet: (...args: unknown[]) => checklistSet(...args) };
});

import type { AppStateSnapshot, ChecklistFile, WorkspaceSnapshot } from "../ipc";
import { usePaletteStore } from "./palette";
import { useWorkspaceStore } from "./workspace";
import { cardVisible, isChecklistCardShown, resetChecklist, startChecklist, useChecklistStore } from "./checklist";

function snapshot(checklist: Partial<ChecklistFile> = {}, firstRun = false): AppStateSnapshot {
  return { firstRun, checklist: { shown: false, dismissed: false, done: [], ...checklist }, version: "0.1.0", lastSeenVersion: "0.1.0" };
}

function workspaceWith(projects: number, edges: number): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects: Array.from({ length: projects }, (_, i) => ({ id: `p${i}` })) as never,
      branches: [],
      sessions: [],
      edges: Array.from({ length: edges }, (_, i) => ({ id: `e${i}` })) as never,
      defaults: {} as never,
    },
    banners: [],
    revision: 1,
    children: [],
    branchErrors: {},
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const ALL = ["palette", "project", "session", "terminal", "edge", "review"];

describe("the checklist store (Story 10.3)", () => {
  let stop: (() => void) | null = null;
  beforeEach(() => {
    checklistSet.mockReset();
    checklistSet.mockImplementation(async (checklist: ChecklistFile) => ({ firstRun: false, checklist, version: "0.1.0", lastSeenVersion: "0.1.0" }));
    resetChecklist();
    usePaletteStore.setState({ isOpen: false, pick: null, query: "", selected: 0 });
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
  });
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it("a fresh profile shows the card; an existing one does not, until Show getting started", async () => {
    useChecklistStore.getState().load(snapshot({ shown: true }, true));
    expect(isChecklistCardShown()).toBe(true);
    expect(useChecklistStore.getState().firstRun).toBe(true);

    resetChecklist();
    useChecklistStore.getState().load(snapshot());
    expect(isChecklistCardShown()).toBe(false);
    useChecklistStore.getState().show();
    expect(isChecklistCardShown()).toBe(true);
    await flush();
    expect(checklistSet).toHaveBeenLastCalledWith({ shown: true, dismissed: false, done: [] });
  });

  it("restart: the card is back with the saved ticks, and nothing is written", async () => {
    useChecklistStore.getState().load(snapshot({ shown: true, done: ["edge", "palette"] }));
    expect(useChecklistStore.getState().done).toEqual(["palette", "edge"]);
    expect(isChecklistCardShown()).toBe(true);
    await flush();
    expect(checklistSet).not.toHaveBeenCalled();
  });

  it("already true: a project on the canvas when the card first shows is ticked at once and saved", async () => {
    useWorkspaceStore.setState({ snapshot: workspaceWith(1, 0) });
    useChecklistStore.getState().load(snapshot({ shown: true }, true));
    expect(useChecklistStore.getState().done).toEqual(["project"]);
    await flush();
    expect(checklistSet).toHaveBeenCalledWith({ shown: true, dismissed: false, done: ["project"] });
  });

  it("transient: the palette opened then closed, an edge drawn then deleted, both stay ticked", async () => {
    useChecklistStore.getState().load(snapshot({ shown: true }));
    stop = startChecklist();
    usePaletteStore.getState().open();
    usePaletteStore.getState().close();
    useWorkspaceStore.setState({ snapshot: workspaceWith(2, 1) });
    useWorkspaceStore.setState({ snapshot: workspaceWith(2, 0) });
    expect(useChecklistStore.getState().done).toEqual(["palette", "project", "edge"]);
    await flush();
    // One write per new tick, in order.
    expect(checklistSet.mock.calls.map(([c]) => (c as ChecklistFile).done)).toEqual([["palette"], ["palette", "project", "edge"]]);
  });

  it("steps seen before the file loads are added when it does", () => {
    stop = startChecklist();
    usePaletteStore.getState().open();
    usePaletteStore.getState().close();
    expect(useChecklistStore.getState().done).toEqual([]);
    useChecklistStore.getState().load(snapshot({ shown: true, done: ["review"] }));
    expect(useChecklistStore.getState().done).toEqual(["palette", "review"]);
  });

  it("all done: the sixth tick keeps the card (All done) this run; at the next launch it is gone", () => {
    useChecklistStore.getState().load(snapshot({ shown: true, done: ALL.slice(0, 5) }));
    useChecklistStore.getState().latch(["review"]);
    expect(useChecklistStore.getState().done).toEqual(ALL);
    expect(isChecklistCardShown()).toBe(true);

    resetChecklist();
    useChecklistStore.getState().load(snapshot({ shown: true, done: ALL }));
    expect(isChecklistCardShown()).toBe(false);
    // Show getting started brings it back on purpose.
    useChecklistStore.getState().show();
    expect(isChecklistCardShown()).toBe(true);
  });

  it("dismiss: the card goes and the dismissal is saved; progress stays", async () => {
    useChecklistStore.getState().load(snapshot({ shown: true, done: ["palette"] }));
    useChecklistStore.getState().dismiss();
    expect(isChecklistCardShown()).toBe(false);
    expect(useChecklistStore.getState().done).toEqual(["palette"]);
    await flush();
    expect(checklistSet).toHaveBeenLastCalledWith({ shown: true, dismissed: true, done: ["palette"] });
  });

  it("a failed load runs with the defaults (no card), keeps ticking in memory and never writes the file", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    useChecklistStore.getState().setLoadError("boom");
    expect(isChecklistCardShown()).toBe(false);
    useChecklistStore.getState().latch(["edge"]);
    useChecklistStore.getState().show();
    useChecklistStore.getState().dismiss();
    expect(useChecklistStore.getState().done).toEqual(["edge"]);
    await flush();
    expect(checklistSet).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("a failed write is logged and the state stays in memory", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    useChecklistStore.getState().load(snapshot({ shown: true }));
    checklistSet.mockRejectedValueOnce("unknown checklist step: x");
    useChecklistStore.getState().latch(["edge"]);
    await flush();
    expect(useChecklistStore.getState().done).toEqual(["edge"]);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("show and dismiss do nothing before the file loads, so they never write over it", async () => {
    useChecklistStore.getState().show();
    useChecklistStore.getState().dismiss();
    expect(useChecklistStore.getState()).toMatchObject({ shown: false, dismissed: false });
    await flush();
    expect(checklistSet).not.toHaveBeenCalled();
  });

  it("a second load keeps the steps latched since the first", () => {
    useChecklistStore.getState().load(snapshot({ shown: true }));
    useChecklistStore.getState().latch(["edge"]);
    useChecklistStore.getState().load(snapshot({ shown: true, done: ["palette"] }));
    expect(useChecklistStore.getState().done).toEqual(["palette", "edge"]);
  });

  it("detection stops once all six steps are latched", () => {
    useChecklistStore.getState().load(snapshot({ shown: true, done: ALL.slice(0, 5) }));
    stop = startChecklist();
    const latch = vi.spyOn(useChecklistStore.getState(), "latch");
    useChecklistStore.getState().latch(["review"]);
    latch.mockClear();
    usePaletteStore.getState().open();
    usePaletteStore.getState().close();
    expect(latch).not.toHaveBeenCalled();
    latch.mockRestore();
  });

  it("card visibility is shown, not dismissed, not all done at load, once loaded", () => {
    const base = { loaded: true, shown: true, dismissed: false, allDoneAtLoad: false };
    expect(cardVisible(base)).toBe(true);
    expect(cardVisible({ ...base, loaded: false })).toBe(false);
    expect(cardVisible({ ...base, shown: false })).toBe(false);
    expect(cardVisible({ ...base, dismissed: true })).toBe(false);
    expect(cardVisible({ ...base, allDoneAtLoad: true })).toBe(false);
  });
});
