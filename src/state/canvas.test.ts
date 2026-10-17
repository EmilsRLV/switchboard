import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Position, Viewport } from "../ipc";
import { HOME_VIEWPORT, clientToFlow, isCanvasReady, useCanvasStore, viewportCentre, type CanvasInstance } from "./canvas";

function fakeInstance(nodeCount: number): CanvasInstance & {
  setViewport: ReturnType<typeof vi.fn>;
  fitView: ReturnType<typeof vi.fn>;
} {
  let viewport: Viewport = { x: -120, y: 40, zoom: 1.5 };
  return {
    getNodes: () => new Array<unknown>(nodeCount).fill({}),
    getViewport: () => viewport,
    setViewport: vi.fn(async (next: Viewport) => {
      viewport = next;
      return true;
    }),
    fitView: vi.fn(async () => true),
    // xyflow's real one subtracts the container's rect and undoes the transform; the fake
    // only undoes the transform so tests can check what it was handed.
    screenToFlowPosition: (client: Position) => ({
      x: (client.x - viewport.x) / viewport.zoom,
      y: (client.y - viewport.y) / viewport.zoom,
    }),
  };
}

describe("canvas store", () => {
  beforeEach(() => {
    useCanvasStore.setState({ instance: null, element: null, dragging: {} });
  });

  it("starts with no drag overrides", () => {
    expect(useCanvasStore.getState().dragging).toEqual({});
  });

  it("setDragPosition records (a copy of) each dragged node's position by flow id; clearDrag forgets one", () => {
    const s = useCanvasStore.getState();
    const position = { x: 130, y: 20 };
    s.setDragPosition("a", position);
    s.setDragPosition("session:stub-2-a", { x: 5, y: 5 });
    s.setDragPosition("a", { x: 131, y: 20 });
    expect(useCanvasStore.getState().dragging).toEqual({ a: { x: 131, y: 20 }, "session:stub-2-a": { x: 5, y: 5 } });
    expect(useCanvasStore.getState().dragging.a).not.toBe(position);
    s.clearDrag("a");
    expect(useCanvasStore.getState().dragging).toEqual({ "session:stub-2-a": { x: 5, y: 5 } });
    s.clearDrag("session:stub-2-a");
    expect(useCanvasStore.getState().dragging).toEqual({});
  });

  it("dragging is reference-stable while nothing is dragged and when clearing an unknown id", () => {
    const s = useCanvasStore.getState();
    s.setDragPosition("a", { x: 1, y: 1 });
    s.clearDrag("a");
    const empty = useCanvasStore.getState().dragging;
    s.setDragPosition("b", { x: 1, y: 1 });
    s.clearDrag("b");
    expect(useCanvasStore.getState().dragging).toBe(empty);
    const before = useCanvasStore.getState().dragging;
    s.clearDrag("nope");
    expect(useCanvasStore.getState().dragging).toBe(before);
    s.setDragPosition("c", { x: 2, y: 2 });
    const withC = useCanvasStore.getState().dragging;
    s.clearDrag("nope");
    expect(useCanvasStore.getState().dragging).toBe(withC);
  });

  it("is not ready until an instance is set, and not after it is cleared", () => {
    expect(isCanvasReady()).toBe(false);
    useCanvasStore.getState().setInstance(fakeInstance(0));
    expect(isCanvasReady()).toBe(true);
    useCanvasStore.getState().setInstance(null);
    expect(isCanvasReady()).toBe(false);
  });

  it("fitView without a canvas resolves false and does nothing", async () => {
    await expect(useCanvasStore.getState().fitView()).resolves.toBe(false);
  });

  it("fitView with no nodes goes home to {0,0,1} instead of calling xyflow's no-op fitView", async () => {
    const instance = fakeInstance(0);
    useCanvasStore.getState().setInstance(instance);
    await expect(useCanvasStore.getState().fitView()).resolves.toBe(true);
    expect(instance.setViewport).toHaveBeenCalledTimes(1);
    expect(instance.setViewport).toHaveBeenCalledWith({ x: 0, y: 0, zoom: 1 });
    expect(instance.fitView).not.toHaveBeenCalled();
    expect(instance.getViewport()).toEqual(HOME_VIEWPORT);
  });

  it("fitView with nodes delegates to xyflow", async () => {
    const instance = fakeInstance(3);
    useCanvasStore.getState().setInstance(instance);
    await useCanvasStore.getState().fitView();
    expect(instance.fitView).toHaveBeenCalledTimes(1);
    expect(instance.setViewport).not.toHaveBeenCalled();
  });

  it("HOME_VIEWPORT is frozen and never handed out by reference", async () => {
    expect(Object.isFrozen(HOME_VIEWPORT)).toBe(true);
    const instance = fakeInstance(0);
    useCanvasStore.getState().setInstance(instance);
    await useCanvasStore.getState().fitView();
    expect(instance.setViewport.mock.calls[0]?.[0]).not.toBe(HOME_VIEWPORT);
  });

  it("viewportCentre is null without a canvas and the middle of the element's rect with one", () => {
    expect(viewportCentre()).toBeNull();
    const instance = fakeInstance(0);
    useCanvasStore.getState().setInstance(instance);
    useCanvasStore.getState().setElement({
      getBoundingClientRect: () => ({ left: 100, top: 40, width: 800, height: 600 }),
    });
    // Middle of the rect is client (500, 340); the fake undoes the {x:-120,y:40,zoom:1.5} transform.
    expect(viewportCentre()).toEqual({ x: (500 + 120) / 1.5, y: (340 - 40) / 1.5 });
  });

  it("viewportCentre without a measured element falls back to the window's middle via the transform", () => {
    const instance = fakeInstance(0);
    useCanvasStore.getState().setInstance(instance);
    // No `window` in vitest's node environment: the fallback uses 0x0.
    expect(viewportCentre()).toEqual({ x: (0 + 120) / 1.5, y: (0 - 40) / 1.5 });
  });

  it("clientToFlow converts through the instance and is null without one", () => {
    expect(clientToFlow({ x: 10, y: 10 })).toBeNull();
    useCanvasStore.getState().setInstance(fakeInstance(0));
    expect(clientToFlow({ x: 30, y: 100 })).toEqual({ x: (30 + 120) / 1.5, y: (100 - 40) / 1.5 });
  });
});
