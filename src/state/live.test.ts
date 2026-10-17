import { beforeEach, describe, expect, it } from "vitest";
import type { LiveSession, LiveSnapshot, SessionState } from "../ipc";
import {
  EMPTY_LIVE,
  LIVE_BANNER_ID,
  LIVE_LOAD_ERROR_BANNER_ID,
  elsewhereCount,
  isLiveState,
  liveSession,
  sameState,
  selectLiveBanners,
  stateWord,
  useLiveStore,
} from "./live";

function session(state: SessionState, project_id: string | null = "ide"): LiveSession {
  return { state, source: "poll", pid: 7, kind: "interactive", name: "ide-6e", project_id, cwd: "/p/ide", started_at: 1 };
}

const snapshot: LiveSnapshot = {
  sessions: { s1: session({ kind: "busy" }), s2: session({ kind: "exited" }), s3: session({ kind: "idle" }, null) },
  elsewhere: [{ session_id: "s3", state: { kind: "idle" }, name: "x", cwd: "C:\\work\\other", started_at: 1 }],
  banner: null,
};

describe("live store", () => {
  beforeEach(() => {
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
  });

  it("starts empty and not received; applySnapshot replaces it wholesale", () => {
    expect(useLiveStore.getState().snapshot.sessions).toEqual({});
    expect(useLiveStore.getState().received).toBe(false);
    expect(elsewhereCount()).toBe(0);
    useLiveStore.getState().applySnapshot(snapshot);
    expect(useLiveStore.getState().snapshot).toBe(snapshot);
    expect(useLiveStore.getState().received).toBe(true);
    expect(elsewhereCount()).toBe(1);
  });

  it("liveSession finds only sessions in a live state", () => {
    useLiveStore.getState().applySnapshot(snapshot);
    expect(liveSession("s1")?.state).toEqual({ kind: "busy" });
    expect(liveSession("s2")).toBeNull();
    expect(liveSession("nope")).toBeNull();
    expect(liveSession("constructor")).toBeNull();
  });

  it("state words, liveness and equality", () => {
    expect(stateWord({ kind: "busy" })).toBe("busy");
    expect(stateWord({ kind: "other", raw: "compacting" })).toBe("compacting");
    expect(isLiveState({ kind: "other", raw: "compacting" })).toBe(true);
    expect(isLiveState({ kind: "exited" })).toBe(false);
    expect(sameState({ kind: "idle" }, { kind: "idle" })).toBe(true);
    expect(sameState({ kind: "other", raw: "a" }, { kind: "other", raw: "b" })).toBe(false);
    expect(sameState({ kind: "busy" }, null)).toBe(false);
    expect(sameState(null, null)).toBe(true);
  });

  it("a snapshot arriving clears an earlier load error", () => {
    useLiveStore.getState().setLoadError("live sessions load failed: boom");
    useLiveStore.getState().applySnapshot(snapshot);
    expect(useLiveStore.getState().loadError).toBeNull();
  });
});

describe("selectLiveBanners", () => {
  beforeEach(() => {
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
  });

  it("is empty and reference-stable without a banner or load error", () => {
    const a = selectLiveBanners(useLiveStore.getState());
    expect(a).toEqual([]);
    expect(selectLiveBanners(useLiveStore.getState())).toBe(a);
  });

  it("carries the poll banner as claude.agents and the mirror failure as live.load; clears with them", () => {
    useLiveStore.getState().applySnapshot({ ...snapshot, banner: "live session status unavailable: claude agents: exit code 1" });
    const a = selectLiveBanners(useLiveStore.getState());
    expect(a).toEqual([{ id: LIVE_BANNER_ID, text: "live session status unavailable: claude agents: exit code 1" }]);
    expect(selectLiveBanners(useLiveStore.getState())).toBe(a);
    useLiveStore.getState().setLoadError("live sessions load failed: boom");
    expect(selectLiveBanners(useLiveStore.getState()).map((b) => b.id)).toEqual([LIVE_BANNER_ID, LIVE_LOAD_ERROR_BANNER_ID]);
    useLiveStore.getState().applySnapshot(snapshot);
    expect(selectLiveBanners(useLiveStore.getState())).toEqual([]);
  });
});
