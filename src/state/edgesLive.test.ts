import { beforeEach, describe, expect, it } from "vitest";
import type { EdgeLive } from "../ipc";
import { canRetryLive, edgeLive, isCooperate, isSessionContext, nowText, sideNowText, TYPING_DETAIL, useEdgesLiveStore } from "./edgesLive";

const live = (state: EdgeLive["state"], detail: string | null = null): EdgeLive => ({ state, detail, edgeId: "e1", sessionId: "s1", path: "/w/ui" });
const fromSession = { kind: "context", from: { type: "session", id: "s1" } } as const;
const fromProject = { kind: "context", from: { type: "project", id: "a" } } as const;
const cooperate = { kind: "cooperate", from: { type: "session", id: "s1" }, to: { type: "session", id: "s2" } } as const;

describe("edges-live store (Story 6.3)", () => {
  beforeEach(() => useEdgesLiveStore.setState({ entries: {}, received: false, loadError: "old" }));

  it("mirrors the map Rust pushes and clears a load error", () => {
    useEdgesLiveStore.getState().applySnapshot({ e1: live("pending", "waiting for idle") });
    const state = useEdgesLiveStore.getState();
    expect(state.received).toBe(true);
    expect(state.loadError).toBeNull();
    expect(edgeLive("e1")?.state).toBe("pending");
    expect(edgeLive("e2")).toBeNull();
    expect(edgeLive("constructor")).toBeNull();
  });

  it("says what the edge does now: the live state and detail, else what it does at the next launch", () => {
    expect(nowText(fromSession, live("pending", "waiting for idle"))).toBe("pending (waiting for idle)");
    expect(nowText(fromSession, live("applied"))).toBe("applied");
    expect(nowText(fromSession, live("applied", "restarted with flags"))).toBe("applied (restarted with flags)");
    expect(nowText(fromSession, live("failed", "not confirmed"))).toBe("failed (not confirmed)");
    expect(nowText(fromSession, null)).toBe("--add-dir at the next resume");
    expect(nowText(fromProject, null)).toBe("--add-dir for every new session on this project");
    expect(nowText(cooperate, null)).toBeNull();
    expect(nowText(cooperate, live("notified"))).toBeNull();
  });

  it("says what each side of a cooperate edge does now (Story 6.4)", () => {
    expect(sideNowText("ui-2", live("notified"))).toBe("ui-2: notified");
    expect(sideNowText("ui-2", live("pending", "waiting for idle"))).toBe("ui-2: pending (waiting for idle)");
    expect(sideNowText("ui-2", live("pending", TYPING_DETAIL))).toBe("ui-2: pending (you're typing — Retry when done)");
    expect(sideNowText("ui-2", live("failed", "not confirmed"))).toBe("ui-2: failed (not confirmed)");
    expect(sideNowText("ui-2", null)).toBe("ui-2: peer named at the next resume");
    expect(canRetryLive(live("notified"))).toBe(false);
    expect(isCooperate(cooperate)).toBe(true);
    expect(isCooperate({ ...fromSession, to: { type: "project", id: "a" } })).toBe(false);
  });

  it("offers Retry after a failure or while a draft holds the line back, never while it waits for idle or once applied", () => {
    // Rust's `live_edges::TYPING`, word for word (its integration test pins the same literal).
    expect(TYPING_DETAIL).toBe("you're typing — Retry when done");
    expect(canRetryLive(null)).toBe(false);
    expect(canRetryLive(live("failed", "session stayed busy"))).toBe(true);
    expect(canRetryLive(live("pending", TYPING_DETAIL))).toBe(true);
    expect(canRetryLive(live("pending", "waiting for idle"))).toBe(false);
    expect(canRetryLive(live("applied"))).toBe(false);
    expect(isSessionContext(fromSession)).toBe(true);
    expect(isSessionContext(fromProject)).toBe(false);
    expect(isSessionContext(cooperate)).toBe(false);
  });
});
