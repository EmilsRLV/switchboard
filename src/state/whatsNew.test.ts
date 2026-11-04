import { beforeEach, describe, expect, it, vi } from "vitest";

const whatsNewSeen = vi.fn();
let tauri = true;
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, hasTauriRuntime: () => tauri, whatsNewSeen: (...args: unknown[]) => whatsNewSeen(...args) };
});

import type { AppStateSnapshot } from "../ipc";
import { resetWhatsNew, useWhatsNewStore } from "./whatsNew";

function snapshot(lastSeenVersion: string | null, version = "0.2.0", firstRun = false): AppStateSnapshot {
  return { firstRun, checklist: { shown: firstRun, dismissed: false, done: [] }, version, lastSeenVersion, hints: { hidden: null }, tour: { done: false } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the what's-new store (Story 10.5)", () => {
  beforeEach(() => {
    tauri = true;
    whatsNewSeen.mockReset();
    whatsNewSeen.mockResolvedValue(snapshot("0.2.0"));
    resetWhatsNew();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("starts with no version and no chip", () => {
    expect(useWhatsNewStore.getState()).toMatchObject({ version: null, show: false, writable: false });
  });

  it("an update, a downgrade and a profile from before this story show the chip", () => {
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    expect(useWhatsNewStore.getState()).toMatchObject({ version: "0.2.0", show: true, writable: true });
    resetWhatsNew();
    useWhatsNewStore.getState().load(snapshot("0.3.0"));
    expect(useWhatsNewStore.getState().show).toBe(true);
    resetWhatsNew();
    useWhatsNewStore.getState().load(snapshot(null));
    expect(useWhatsNewStore.getState().show).toBe(true);
  });

  it("the same version and a fresh profile show nothing", () => {
    useWhatsNewStore.getState().load(snapshot("0.2.0"));
    expect(useWhatsNewStore.getState().show).toBe(false);
    resetWhatsNew();
    useWhatsNewStore.getState().load(snapshot("0.2.0", "0.2.0", true));
    expect(useWhatsNewStore.getState()).toMatchObject({ version: "0.2.0", show: false });
  });

  it("markSeen clears the chip and sends whats_new_seen once", async () => {
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    useWhatsNewStore.getState().markSeen();
    expect(useWhatsNewStore.getState().show).toBe(false);
    useWhatsNewStore.getState().markSeen();
    useWhatsNewStore.getState().markSeen();
    await flush();
    expect(whatsNewSeen).toHaveBeenCalledTimes(1);
  });

  it("markSeen with nothing to record sends nothing", () => {
    useWhatsNewStore.getState().load(snapshot("0.2.0"));
    useWhatsNewStore.getState().markSeen();
    expect(whatsNewSeen).not.toHaveBeenCalled();
  });

  it("a failed load shows no chip and never writes", () => {
    useWhatsNewStore.getState().setLoadError("boom");
    expect(useWhatsNewStore.getState()).toMatchObject({ version: null, show: false, writable: false });
    useWhatsNewStore.getState().markSeen();
    expect(whatsNewSeen).not.toHaveBeenCalled();
  });

  it("without Tauri the chip goes but nothing is sent", () => {
    tauri = false;
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    useWhatsNewStore.getState().markSeen();
    expect(useWhatsNewStore.getState().show).toBe(false);
    expect(whatsNewSeen).not.toHaveBeenCalled();
  });

  it("the Changelog opened before the file loaded: no chip, and the version is recorded on load", () => {
    useWhatsNewStore.getState().markSeen();
    expect(whatsNewSeen).not.toHaveBeenCalled();
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    expect(useWhatsNewStore.getState().show).toBe(false);
    expect(whatsNewSeen).toHaveBeenCalledTimes(1);
  });

  it("a rejected write is logged; the chip stays gone", async () => {
    whatsNewSeen.mockRejectedValueOnce("disk full");
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    useWhatsNewStore.getState().markSeen();
    await flush();
    expect(console.error).toHaveBeenCalledWith("what's new: cannot save state.json: disk full");
    expect(useWhatsNewStore.getState().show).toBe(false);
  });

  it("a rejected write is retried at the next showing of the Changelog, then not again", async () => {
    whatsNewSeen.mockRejectedValueOnce("disk full");
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    useWhatsNewStore.getState().markSeen();
    await flush();
    useWhatsNewStore.getState().markSeen();
    await flush();
    expect(whatsNewSeen).toHaveBeenCalledTimes(2);
    useWhatsNewStore.getState().markSeen();
    await flush();
    expect(whatsNewSeen).toHaveBeenCalledTimes(2);
  });
});
