import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewport } from "../ipc";
import { HOME_VIEWPORT, isCanvasReady, useCanvasStore, type CanvasInstance } from "./canvas";

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
  };
}

describe("canvas store", () => {
  beforeEach(() => {
    useCanvasStore.setState({ instance: null });
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
});
