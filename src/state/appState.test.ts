import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, hasTauriRuntime: () => false };
});

import type { AppStateSnapshot } from "../ipc";
import { applyStateError, applyStateReply } from "./appState";
import { resetChecklist, useChecklistStore } from "./checklist";
import { resetWhatsNew, useWhatsNewStore } from "./whatsNew";
import { resetHints, useHintsStore } from "./hints";

const SNAPSHOT: AppStateSnapshot = {
  firstRun: false,
  checklist: { shown: true, dismissed: true, done: ["palette"] },
  version: "0.2.0",
  lastSeenVersion: "0.1.0",
  hints: { hidden: null },
};

describe("state_get's reply feeds both stores (Stories 10.3, 10.5)", () => {
  beforeEach(() => {
    resetChecklist();
    resetWhatsNew();
    resetHints();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("a reply loads the checklist and the what's-new chip", () => {
    applyStateReply(SNAPSHOT);
    expect(useChecklistStore.getState()).toMatchObject({ loaded: true, writable: true, shown: true, dismissed: true });
    expect(useChecklistStore.getState().done).toContain("palette");
    expect(useWhatsNewStore.getState()).toMatchObject({ version: "0.2.0", show: true, writable: true });
    expect(useHintsStore.getState()).toMatchObject({ loaded: true, writable: true, hidden: null });
  });

  it("an error sets both stores' load error", () => {
    applyStateError("boom");
    expect(useChecklistStore.getState()).toMatchObject({ loaded: true, writable: false });
    expect(useWhatsNewStore.getState()).toMatchObject({ version: null, show: false, writable: false });
    expect(console.error).toHaveBeenCalledWith("checklist: cannot load state.json: boom");
    expect(console.error).toHaveBeenCalledWith("what's new: cannot load state.json: boom");
    expect(useHintsStore.getState()).toMatchObject({ loaded: true, writable: false });
  });
});
