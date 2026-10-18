import { describe, expect, it } from "vitest";
import type { TermInfo } from "../ipc";
import { tabState } from "./terminals";

function info(overrides: Partial<TermInfo> = {}): TermInfo {
  return { id: "session:s1", kind: "session", project_id: "p", title: "ide-3f2a", cwd: "/p", exited: null, error: null, cols: 80, rows: 24, stopping: false, ...overrides };
}

describe("tabState (Story 4.5)", () => {
  it("a running session terminal shows its session's word, with the dot for waiting and finished", () => {
    expect(tabState(info(), { kind: "busy" })).toEqual({ word: "busy", attention: false });
    expect(tabState(info(), { kind: "idle" })).toEqual({ word: "idle", attention: false });
    expect(tabState(info(), { kind: "waiting" })).toEqual({ word: "waiting", attention: true });
    expect(tabState(info(), { kind: "finished" })).toEqual({ word: "finished", attention: true });
    expect(tabState(info(), { kind: "other", raw: "compacting" })).toEqual({ word: "compacting", attention: false });
  });

  it("otherwise the header's word, never the dot", () => {
    expect(tabState(info(), null)).toEqual({ word: "running", attention: false });
    expect(tabState(info({ exited: 0 }), { kind: "finished" })).toEqual({ word: "exited 0", attention: false });
    expect(tabState(info({ stopping: true }), { kind: "waiting" })).toEqual({ word: "stopping", attention: false });
    expect(tabState(info({ id: "plain-p", kind: "plain" }), { kind: "waiting" })).toEqual({ word: "running", attention: false });
    expect(tabState(info({ kind: "plain", exited: -1, error: "could not start sh: gone" }), null)).toEqual({
      word: "could not start sh: gone",
      attention: false,
    });
    expect(tabState(null, null)).toEqual({ word: "", attention: false });
  });
});
