import { beforeEach, describe, expect, it, vi } from "vitest";

const tourSet = vi.fn();
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    hasTauriRuntime: () => true,
    tourSet: (...args: unknown[]) => tourSet(...args),
    checklistSet: async () => undefined,
    hintsSet: async () => undefined,
  };
});

import type { AppStateSnapshot } from "../ipc";
import { TOUR_STOP_COUNT } from "../help/tour";
import { applyStateError, applyStateReply } from "./appState";
import { cardVisible, resetChecklist, useChecklistStore } from "./checklist";
import { resetHints } from "./hints";
import { autoStartDue, isTourDone, isTourOn, resetTour, tourFirstFrame, useTourStore } from "./tour";
import { resetWhatsNew } from "./whatsNew";

function snapshot(firstRun: boolean, tour: { done: boolean } | undefined): AppStateSnapshot {
  const base = { firstRun, checklist: { shown: firstRun, dismissed: false, done: [] }, version: "0.1.0", lastSeenVersion: "0.1.0", hints: { hidden: null } };
  // `tour` left out: a reply from a file without it (an older schema reads as the default).
  return (tour === undefined ? base : { ...base, tour }) as AppStateSnapshot;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const tour = () => useTourStore.getState();

describe("the first-run tour's state (Story 11.6)", () => {
  beforeEach(() => {
    tourSet.mockReset();
    tourSet.mockImplementation(async () => snapshot(false, { done: true }));
    resetChecklist();
    resetHints();
    resetWhatsNew();
    resetTour();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("fresh profile: starts after the first frame, whichever comes first; the checklist card is held back meanwhile", () => {
    applyStateReply(snapshot(true, { done: false }));
    expect(isTourOn()).toBe(false);
    tourFirstFrame();
    expect(isTourOn()).toBe(true);
    expect(tour().stop).toBe(0);
    // The card would show (Story 10.3); `ChecklistCard` holds it back while the tour is on.
    expect(cardVisible(useChecklistStore.getState())).toBe(true);

    resetTour();
    tourFirstFrame();
    expect(isTourOn()).toBe(false);
    applyStateReply(snapshot(true, { done: false }));
    expect(isTourOn()).toBe(true);
  });

  it("existing profile: no auto-start; tour.start still runs it", () => {
    applyStateReply(snapshot(false, { done: false }));
    tourFirstFrame();
    expect(isTourOn()).toBe(false);
    tour().start();
    expect(isTourOn()).toBe(true);
  });

  it("a fresh profile whose tour is done, or a failed load, never starts it", () => {
    applyStateReply(snapshot(true, { done: true }));
    tourFirstFrame();
    expect(isTourOn()).toBe(false);
    resetTour();
    applyStateError("boom");
    tourFirstFrame();
    expect(isTourOn()).toBe(false);
    expect(tour().writable).toBe(false);
  });

  it("autoStartDue needs every flag", () => {
    const due = { framed: true, started: false, loaded: true, firstRun: true, done: false, on: false };
    expect(autoStartDue(due)).toBe(true);
    for (const flip of [{ framed: false }, { started: true }, { loaded: false }, { firstRun: false }, { done: true }, { on: true }]) {
      expect(autoStartDue({ ...due, ...flip }), JSON.stringify(flip)).toBe(false);
    }
  });

  it("Skip (Esc) ends it at any stop and writes tour_set(true) once", async () => {
    applyStateReply(snapshot(true, { done: false }));
    tourFirstFrame();
    tour().next();
    tour().next();
    expect(tour().stop).toBe(2);
    tour().end();
    expect(isTourOn()).toBe(false);
    expect(isTourDone()).toBe(true);
    await flush();
    expect(tourSet).toHaveBeenCalledTimes(1);
    expect(tourSet).toHaveBeenCalledWith(true);
    // Ending again does nothing.
    tour().end();
    await flush();
    expect(tourSet).toHaveBeenCalledTimes(1);
  });

  it("Finish: Next on the last stop is the same as Skip", async () => {
    applyStateReply(snapshot(true, { done: false }));
    tourFirstFrame();
    for (let i = 1; i < TOUR_STOP_COUNT; i++) tour().next();
    expect(tour().stop).toBe(TOUR_STOP_COUNT - 1);
    expect(isTourOn()).toBe(true);
    tour().next();
    expect(isTourOn()).toBe(false);
    expect(isTourDone()).toBe(true);
    await flush();
    expect(tourSet).toHaveBeenCalledWith(true);
  });

  it("Back on stop 1 stays on stop 1; Back after Next goes back", () => {
    tour().start();
    tour().back();
    expect(tour().stop).toBe(0);
    tour().next();
    tour().back();
    expect(tour().stop).toBe(0);
    expect(isTourOn()).toBe(true);
  });

  it("re-run with done true runs from stop 1 and ending writes nothing new", async () => {
    applyStateReply(snapshot(false, { done: true }));
    tour().start();
    tour().next();
    tour().start();
    expect(tour().stop).toBe(0);
    tour().end();
    await flush();
    expect(tourSet).not.toHaveBeenCalled();
  });

  it("starts on its own at most once per launch (a read-only file keeps done only in memory)", () => {
    applyStateReply(snapshot(true, { done: false }));
    tourFirstFrame();
    tour().end();
    // A second load (StrictMode, or a read-only file Rust never wrote) with done false again.
    applyStateReply(snapshot(true, { done: false }));
    tourFirstFrame();
    expect(isTourOn()).toBe(false);
    expect(isTourDone()).toBe(true);
  });

  it("asked for before the first frame, it does not start again on its own after that one ends", () => {
    applyStateReply(snapshot(true, { done: false }));
    tour().start();
    useTourStore.setState({ on: false });
    tourFirstFrame();
    expect(isTourOn()).toBe(false);
  });

  it("a v2 / early v3 reply without `tour` loads done: false", () => {
    applyStateReply(snapshot(false, undefined));
    expect(tour().loaded).toBe(true);
    expect(isTourDone()).toBe(false);
  });

  it("nothing moves while off", () => {
    tour().next();
    tour().back();
    expect(tour()).toMatchObject({ on: false, stop: 0 });
  });
});
