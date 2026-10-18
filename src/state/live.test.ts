import { beforeEach, describe, expect, it } from "vitest";
import type { ChildNode, LiveSession, LiveSnapshot, SessionState } from "../ipc";
import {
  EMPTY_LIVE,
  LIVE_BANNER_ID,
  LIVE_LOAD_ERROR_BANNER_ID,
  elsewhereCount,
  attentionQueue,
  isAcknowledging,
  isLiveState,
  liveSession,
  markAcknowledging,
  needsAttention,
  projectAttention,
  sessionState,
  unmarkAcknowledging,
  sameState,
  selectLiveBanners,
  stateWord,
  useLiveStore,
} from "./live";

function session(state: SessionState, project_id: string | null = "ide"): LiveSession {
  return { state, source: "poll", pid: 7, kind: "interactive", name: "ide-6e", project_id, cwd: "/p/ide", started_at: 1, attention_since: null, last_line: null, detail: null };
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

describe("attention", () => {
  const child = (id: string, projectId: string): ChildNode => ({
    id,
    projectId,
    kind: "session",
    label: id,
    detail: null,
    position: null,
    session: null,
    branchId: null,
  });
  const at = (state: SessionState, since: number | null, project_id: string | null = "ide"): LiveSession => ({
    ...session(state, project_id),
    attention_since: since,
  });

  beforeEach(() => {
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
    for (const id of ["a", "b", "c"]) unmarkAcknowledging(id);
  });

  it("finished and waiting need attention; nothing else does", () => {
    expect(needsAttention({ kind: "finished" })).toBe(true);
    expect(needsAttention({ kind: "waiting" })).toBe(true);
    for (const state of [{ kind: "busy" }, { kind: "idle" }, { kind: "exited" }, { kind: "other", raw: "x" }] as SessionState[]) {
      expect(needsAttention(state)).toBe(false);
    }
    expect(needsAttention(null)).toBe(false);
    expect(sessionState("nope")).toBeNull();
    expect(sessionState("constructor")).toBeNull();
  });

  it("a project glows while any of its session children needs attention, keyed by the child's project", () => {
    const children = [child("a", "ide"), child("b", "ide"), child("c", "other")];
    const sessions = { a: at({ kind: "busy" }, null), b: at({ kind: "finished" }, 1), c: at({ kind: "idle" }, null, "other") };
    expect(projectAttention("ide", children, sessions)).toBe(true);
    expect(projectAttention("other", children, sessions)).toBe(false);
    // The live row says another project; the child's project is what counts.
    expect(projectAttention("other", children, { c: at({ kind: "waiting" }, 2, "ide") })).toBe(true);
    useLiveStore.getState().applySnapshot({ sessions, elsewhere: [], banner: null });
    expect(projectAttention("ide", children)).toBe(true);
  });

  it("the queue is oldest first, canvas sessions only, and skips those being acknowledged", () => {
    const children = [child("a", "ide"), child("b", "ide"), child("c", "other")];
    const sessions = {
      a: at({ kind: "finished" }, 30),
      b: at({ kind: "finished" }, 10),
      c: at({ kind: "waiting" }, 20, "other"),
      elsewhere: at({ kind: "finished" }, 1, null),
    };
    expect(attentionQueue(children, sessions).map((t) => t.sessionId)).toEqual(["b", "c", "a"]);
    expect(attentionQueue(children, sessions)[1]).toEqual({ sessionId: "c", projectId: "other", since: 20 });
    markAcknowledging("b");
    expect(isAcknowledging("b")).toBe(true);
    expect(attentionQueue(children, sessions).map((t) => t.sessionId)).toEqual(["c", "a"]);
    // The snapshot showing it settled clears the mark.
    useLiveStore.getState().applySnapshot({ sessions: { ...sessions, b: at({ kind: "idle" }, null) }, elsewhere: [], banner: null });
    expect(isAcknowledging("b")).toBe(false);
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
