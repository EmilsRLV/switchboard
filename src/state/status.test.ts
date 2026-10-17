import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectStatusMap } from "../ipc";
import { STATUS_LOAD_ERROR_BANNER_ID, selectStatusBanners, useStatusStore } from "./status";

const map: ProjectStatusMap = {
  p1: { kind: "repo", branch: "master", detached: false, dirty: 2, ahead: 1, behind: 0 },
  p2: { kind: "not_repo" },
  p3: { kind: "missing" },
};

describe("status store", () => {
  beforeEach(() => {
    useStatusStore.setState({ statuses: {}, received: false, loadError: null });
  });

  it("starts empty, not received, without a load error", () => {
    const s = useStatusStore.getState();
    expect(s.statuses).toEqual({});
    expect(s.received).toBe(false);
    expect(s.loadError).toBeNull();
  });

  it("applyStatuses replaces the map wholesale and marks it received", () => {
    useStatusStore.getState().applyStatuses(map);
    expect(useStatusStore.getState().statuses).toEqual(map);
    expect(useStatusStore.getState().received).toBe(true);
    useStatusStore.getState().applyStatuses({ p2: { kind: "git_unavailable" } });
    expect(useStatusStore.getState().statuses).toEqual({ p2: { kind: "git_unavailable" } });
  });

  it("setLoadError records and clears without touching the map", () => {
    useStatusStore.getState().applyStatuses(map);
    useStatusStore.getState().setLoadError("status load failed: boom");
    expect(useStatusStore.getState().loadError).toBe("status load failed: boom");
    expect(useStatusStore.getState().statuses).toEqual(map);
    useStatusStore.getState().setLoadError(null);
    expect(useStatusStore.getState().loadError).toBeNull();
  });
});

describe("selectStatusBanners", () => {
  beforeEach(() => {
    useStatusStore.setState({ statuses: {}, received: false, loadError: null });
  });

  it("is an empty, reference-stable list without a load error", () => {
    const a = selectStatusBanners(useStatusStore.getState());
    const b = selectStatusBanners(useStatusStore.getState());
    expect(a).toEqual([]);
    expect(a).toBe(b);
  });

  it("carries the load error as a status.load banner, stable per input, and empties when cleared", () => {
    useStatusStore.getState().setLoadError("status load failed: boom");
    const a = selectStatusBanners(useStatusStore.getState());
    expect(a).toEqual([{ id: STATUS_LOAD_ERROR_BANNER_ID, text: "status load failed: boom" }]);
    expect(selectStatusBanners(useStatusStore.getState())).toBe(a);
    useStatusStore.getState().setLoadError("status load failed: later");
    const b = selectStatusBanners(useStatusStore.getState());
    expect(b).not.toBe(a);
    expect(b[0]?.text).toBe("status load failed: later");
    useStatusStore.getState().setLoadError(null);
    expect(selectStatusBanners(useStatusStore.getState())).toEqual([]);
  });
});
