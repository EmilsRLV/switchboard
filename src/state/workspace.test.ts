import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Banner, Viewport, WorkspaceSnapshot } from "../ipc";
import {
  LOAD_ERROR_BANNER_ID,
  mergeBanners,
  persistViewport,
  selectWorkspaceBanners,
  useWorkspaceStore,
  viewportDiffers,
  type PersistDeps,
} from "./workspace";

const snapshot: WorkspaceSnapshot = {
  path: "C:\\Users\\me\\AppData\\Roaming\\switchboard\\workspace.json",
  workspace: {
    version: 1,
    viewport: { x: -120, y: 40, zoom: 1.5 },
    projects: [],
    branches: [],
    sessions: [],
    edges: [],
    defaults: { model: null, effort: null, permissionMode: null },
  },
  banners: [{ id: "workspace.version", text: "workspace.json is version 2; this build understands 1" }],
};

describe("workspace store", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
  });

  it("starts with no snapshot and no load error", () => {
    expect(useWorkspaceStore.getState().snapshot).toBeNull();
    expect(useWorkspaceStore.getState().loadError).toBeNull();
  });

  it("applySnapshot stores what Rust sent and replaces it wholesale", () => {
    useWorkspaceStore.getState().applySnapshot(snapshot);
    expect(useWorkspaceStore.getState().snapshot).toEqual(snapshot);
    const moved: WorkspaceSnapshot = {
      ...snapshot,
      workspace: { ...snapshot.workspace, viewport: { x: 0, y: 0, zoom: 1 } },
      banners: [],
    };
    useWorkspaceStore.getState().applySnapshot(moved);
    expect(useWorkspaceStore.getState().snapshot?.workspace.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(useWorkspaceStore.getState().snapshot?.banners).toEqual([]);
    useWorkspaceStore.getState().applySnapshot(null);
    expect(useWorkspaceStore.getState().snapshot).toBeNull();
  });

  it("setLoadError records why loading failed without touching the snapshot", () => {
    useWorkspaceStore.getState().applySnapshot(snapshot);
    useWorkspaceStore.getState().setLoadError("workspace load failed: boom");
    expect(useWorkspaceStore.getState().loadError).toBe("workspace load failed: boom");
    expect(useWorkspaceStore.getState().snapshot).toEqual(snapshot);
    useWorkspaceStore.getState().setLoadError(null);
    expect(useWorkspaceStore.getState().loadError).toBeNull();
  });
});

describe("selectWorkspaceBanners", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
  });

  it("is an empty, reference-stable list before any snapshot", () => {
    const a = selectWorkspaceBanners(useWorkspaceStore.getState());
    const b = selectWorkspaceBanners(useWorkspaceStore.getState());
    expect(a).toEqual([]);
    expect(a).toBe(b);
  });

  it("returns the snapshot's banners and empties again when they clear", () => {
    useWorkspaceStore.getState().applySnapshot(snapshot);
    expect(selectWorkspaceBanners(useWorkspaceStore.getState())).toBe(snapshot.banners);
    useWorkspaceStore.getState().applySnapshot({ ...snapshot, banners: [] });
    expect(selectWorkspaceBanners(useWorkspaceStore.getState())).toEqual([]);
  });

  it("appends a workspace.load banner carrying loadError after the snapshot's banners", () => {
    useWorkspaceStore.getState().applySnapshot(snapshot);
    useWorkspaceStore.getState().setLoadError("workspace load failed: no Tauri runtime");
    const banners = selectWorkspaceBanners(useWorkspaceStore.getState());
    expect(banners).toEqual([
      snapshot.banners[0],
      { id: LOAD_ERROR_BANNER_ID, text: "workspace load failed: no Tauri runtime" },
    ]);
  });

  it("shows the load error alone when there is no snapshot, and is reference-stable per input", () => {
    useWorkspaceStore.getState().setLoadError("workspace load failed: boom");
    const a = selectWorkspaceBanners(useWorkspaceStore.getState());
    const b = selectWorkspaceBanners(useWorkspaceStore.getState());
    expect(a).toEqual([{ id: "workspace.load", text: "workspace load failed: boom" }]);
    expect(a).toBe(b);
    useWorkspaceStore.getState().setLoadError("workspace write failed: later");
    const c = selectWorkspaceBanners(useWorkspaceStore.getState());
    expect(c).not.toBe(a);
    expect(c[0]?.text).toBe("workspace write failed: later");
    useWorkspaceStore.getState().setLoadError(null);
    expect(selectWorkspaceBanners(useWorkspaceStore.getState())).toEqual([]);
  });
});

describe("mergeBanners", () => {
  const settings: Banner[] = [{ id: "settings.parse", text: "settings.json:3:12 expected value" }];
  const workspace: Banner[] = [{ id: "workspace.parse", text: "workspace.json:3:15 expected value" }];

  it("returns the shared empty list when both are empty", () => {
    const a = mergeBanners([], []);
    const b = mergeBanners([], []);
    expect(a).toEqual([]);
    expect(a).toBe(b);
    expect(a).toBe(selectWorkspaceBanners({ ...useWorkspaceStore.getState(), snapshot: null, loadError: null }));
  });

  it("returns the non-empty side by reference when the other is empty", () => {
    expect(mergeBanners(settings, [])).toBe(settings);
    expect(mergeBanners([], workspace)).toBe(workspace);
  });

  it("puts settings banners before workspace banners", () => {
    expect(mergeBanners(settings, workspace)).toEqual([...settings, ...workspace]);
  });
});

describe("viewportDiffers", () => {
  const home = { x: 0, y: 0, zoom: 1 };

  it("is false for the same viewport", () => {
    expect(viewportDiffers(home, { ...home })).toBe(false);
  });

  it("ignores a pan of 0.5 px or less on either axis", () => {
    expect(viewportDiffers(home, { x: 0.5, y: 0, zoom: 1 })).toBe(false);
    expect(viewportDiffers(home, { x: 0, y: -0.5, zoom: 1 })).toBe(false);
    expect(viewportDiffers(home, { x: 0.3, y: 0.3, zoom: 1 })).toBe(false);
  });

  it("notices a pan of more than 0.5 px on either axis", () => {
    expect(viewportDiffers(home, { x: 0.51, y: 0, zoom: 1 })).toBe(true);
    expect(viewportDiffers(home, { x: 0, y: -0.6, zoom: 1 })).toBe(true);
    expect(viewportDiffers({ x: -120, y: 40, zoom: 1.5 }, { x: -121, y: 40, zoom: 1.5 })).toBe(true);
  });

  it("ignores a zoom change within 0.001 and notices more", () => {
    // Not the exact boundary: 1 - 0.999 is 0.00100000000000000009 in floating point.
    expect(viewportDiffers(home, { x: 0, y: 0, zoom: 1.0005 })).toBe(false);
    expect(viewportDiffers(home, { x: 0, y: 0, zoom: 0.9995 })).toBe(false);
    expect(viewportDiffers(home, { x: 0, y: 0, zoom: 1.0011 })).toBe(true);
    expect(viewportDiffers(home, { x: 0, y: 0, zoom: 0.998 })).toBe(true);
    expect(viewportDiffers(home, { x: 0, y: 0, zoom: 1.5 })).toBe(true);
  });

  it("is symmetric", () => {
    const a = { x: 10, y: 20, zoom: 2 };
    const b = { x: 10.4, y: 20.4, zoom: 2.0005 };
    expect(viewportDiffers(a, b)).toBe(viewportDiffers(b, a));
    expect(viewportDiffers(a, b)).toBe(false);
  });
});

describe("persistViewport", () => {
  const stored: Viewport = { x: -120, y: 40, zoom: 1.5 };
  const moved: Viewport = { x: 10, y: 10, zoom: 1 };

  function deps(overrides: Partial<PersistDeps> = {}) {
    const acknowledged: WorkspaceSnapshot = {
      ...snapshot,
      workspace: { ...snapshot.workspace, viewport: moved },
      banners: [],
    };
    const d = {
      lastSent: null,
      stored,
      hasRuntime: true,
      send: vi.fn(async (_v: Viewport) => acknowledged),
      apply: vi.fn(),
      fail: vi.fn(),
      ...overrides,
    } satisfies PersistDeps;
    return { d, acknowledged };
  }

  it("skips a gesture that ends where the stored viewport is", async () => {
    const { d } = deps();
    await expect(persistViewport({ x: -120.4, y: 40.2, zoom: 1.5005 }, d)).resolves.toBeNull();
    expect(d.send).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.fail).not.toHaveBeenCalled();
  });

  it("sends a moved viewport and applies the snapshot that comes back", async () => {
    const { d, acknowledged } = deps();
    await expect(persistViewport(moved, d)).resolves.toEqual(moved);
    expect(d.send).toHaveBeenCalledWith(moved);
    expect(d.apply).toHaveBeenCalledWith(acknowledged);
    expect(d.fail).not.toHaveBeenCalled();
  });

  it("sends when there is no stored viewport yet", async () => {
    const { d } = deps({ stored: undefined });
    await expect(persistViewport(stored, d)).resolves.toEqual(stored);
    expect(d.send).toHaveBeenCalledWith(stored);
  });

  it("compares against the last sent viewport when there is one (a write in flight)", async () => {
    // Gesture A moved away and is in flight (lastSent = moved, stored still the old value);
    // gesture B comes back to the stored viewport: it differs from what was sent, so it goes.
    const { d } = deps({ lastSent: moved });
    await expect(persistViewport(stored, d)).resolves.toEqual(stored);
    expect(d.send).toHaveBeenCalledWith(stored);
    // ... and a gesture ending where the in-flight one did is skipped even though `stored`
    // still differs.
    const again = deps({ lastSent: moved });
    await expect(persistViewport({ ...moved, x: 10.3 }, again.d)).resolves.toBeNull();
    expect(again.d.send).not.toHaveBeenCalled();
  });

  it("calls send synchronously, before awaiting, so the caller can record lastSent at once", () => {
    const { d } = deps();
    void persistViewport(moved, d);
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("does not send without a Tauri runtime", async () => {
    const { d } = deps({ hasRuntime: false });
    await expect(persistViewport(moved, d)).resolves.toBeNull();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("reports a rejected send through fail instead of throwing", async () => {
    const { d } = deps({ send: vi.fn(async () => Promise.reject(new Error("disk full"))) });
    await expect(persistViewport(moved, d)).resolves.toEqual(moved);
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.fail).toHaveBeenCalledWith("workspace write failed: disk full");

    const plain = deps({ send: vi.fn(async () => Promise.reject("nope")) });
    await persistViewport(moved, plain.d);
    expect(plain.d.fail).toHaveBeenCalledWith("workspace write failed: nope");
  });
});
