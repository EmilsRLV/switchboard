import { describe, expect, it, vi } from "vitest";
import { mirror, type MirrorDeps } from "./mirror";

type Snap = { n: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** Deps whose promises resolve only when the test says so. */
function harness() {
  const listenDeferred = deferred<() => void>();
  const getDeferred = deferred<Snap>();
  const stop = vi.fn();
  const applied: Snap[] = [];
  let listener: ((snapshot: Snap) => void) | null = null;
  const deps: MirrorDeps<Snap> = {
    listen: vi.fn((callback: (snapshot: Snap) => void) => {
      listener = callback;
      return listenDeferred.promise;
    }),
    get: vi.fn(() => getDeferred.promise),
    apply: vi.fn((snapshot: Snap) => {
      applied.push(snapshot);
    }),
    hasSnapshot: () => applied.length > 0,
    fail: vi.fn(),
  };
  return {
    deps,
    applied,
    stop,
    emit: (snapshot: Snap) => listener?.(snapshot),
    listenResolves: () => listenDeferred.resolve(stop),
    listenRejects: (reason: unknown) => listenDeferred.reject(reason),
    getResolves: (snapshot: Snap) => getDeferred.resolve(snapshot),
    getRejects: (reason: unknown) => getDeferred.reject(reason),
  };
}

describe("mirror", () => {
  it("registers the listener before it reads, and reads once the listener is in place", async () => {
    const h = harness();
    mirror(h.deps);
    expect(h.deps.listen).toHaveBeenCalledTimes(1);
    expect(h.deps.get).not.toHaveBeenCalled();

    h.listenResolves();
    await flush();
    expect(h.deps.get).toHaveBeenCalledTimes(1);

    h.getResolves({ n: 1 });
    await flush();
    expect(h.applied).toEqual([{ n: 1 }]);
    expect(h.deps.fail).not.toHaveBeenCalled();
  });

  it("never overwrites a snapshot the listener delivered with a later-resolving read", async () => {
    const h = harness();
    mirror(h.deps);
    h.listenResolves();
    await flush();
    h.emit({ n: 2 }); // the change event beats the read
    h.getResolves({ n: 1 }); // the older state
    await flush();
    expect(h.applied).toEqual([{ n: 2 }]);
    h.emit({ n: 3 }); // later events still apply
    expect(h.applied).toEqual([{ n: 2 }, { n: 3 }]);
  });

  it("reports a rejected read through fail", async () => {
    const h = harness();
    mirror(h.deps);
    h.listenResolves();
    await flush();
    h.getRejects(new Error("workspace_get exploded"));
    await flush();
    expect(h.deps.fail).toHaveBeenCalledWith("workspace_get exploded");
    expect(h.applied).toEqual([]);
  });

  it("reports a rejected subscribe through fail and never reads", async () => {
    const h = harness();
    mirror(h.deps);
    h.listenRejects("no event system");
    await flush();
    expect(h.deps.fail).toHaveBeenCalledWith("no event system");
    expect(h.deps.get).not.toHaveBeenCalled();
  });

  it("cleanup unlistens and ignores a read that resolves afterwards", async () => {
    const h = harness();
    const cleanup = mirror(h.deps);
    h.listenResolves();
    await flush();
    cleanup();
    expect(h.stop).toHaveBeenCalledTimes(1);
    h.getResolves({ n: 1 });
    h.emit({ n: 2 });
    await flush();
    expect(h.applied).toEqual([]);
    expect(h.deps.fail).not.toHaveBeenCalled();
  });

  it("cleanup before the subscription resolves still stops it, and a late failure is swallowed", async () => {
    const h = harness();
    const cleanup = mirror(h.deps);
    cleanup();
    h.listenResolves();
    await flush();
    expect(h.stop).toHaveBeenCalledTimes(1);
    h.getRejects(new Error("too late"));
    await flush();
    expect(h.deps.fail).not.toHaveBeenCalled();
  });
});
