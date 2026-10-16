// Subscribe-then-get for a Rust-owned snapshot (settings, workspace). Rust is the source of
// truth and pushes `…://changed` events; the frontend mirrors them into a store. The order
// matters: subscribe first so no change between the initial read and the listener is lost,
// then read the current snapshot.

export type MirrorDeps<T> = {
  /** Subscribe to the change event; resolves with the unlisten function. */
  listen: (callback: (snapshot: T) => void) => Promise<() => void>;
  /** Read the current snapshot. */
  get: () => Promise<T>;
  apply: (snapshot: T) => void;
  /** True once the store holds a snapshot (then an older `get` result must not replace it). */
  hasSnapshot: () => boolean;
  /** Called with the error message when subscribing or reading rejects. */
  fail: (message: string) => void;
};

/**
 * Start mirroring; returns the cleanup (stops listening, ignores late results). A changed
 * event may already have delivered something newer than the `get` response, so the response
 * is applied only while the store is still empty.
 */
export function mirror<T>({ listen, get, apply, hasSnapshot, fail }: MirrorDeps<T>): () => void {
  let cancelled = false;
  let unlisten: (() => void) | null = null;
  listen((snapshot) => {
    if (!cancelled) apply(snapshot);
  })
    .then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
      return get();
    })
    .then((snapshot) => {
      if (!cancelled && !hasSnapshot()) apply(snapshot);
    })
    .catch((err: unknown) => {
      if (!cancelled) fail(err instanceof Error ? err.message : String(err));
    });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
