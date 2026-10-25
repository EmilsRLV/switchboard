// The review store mirrors Story 7.4's review requests (`review_requests_get`, then every
// `review://requests`): each session's last `request_review` (its summary and paths) and whether
// its node still shows the `review` flag. Rust owns the requests, the flags and the path checks;
// the UI renders them. The rest is the UI's own: which requests' toasts the operator dismissed
// (a toast does not wait or expire; Dismiss closes it and keeps the flag; a new request from the
// same session shows a toast again) and what the Review pane shows (Story 8.1): its target (a
// project, a branch or a session; Rust finds the folder), the session whose request it shows on
// top (if any), the filter, the layout, the selected file, and the last diff's render time for
// Diagnostics. Runtime only, never persisted.

import { create } from "zustand";
import type { Banner, DiffFilter, ReviewMap, ReviewRequest, ReviewTarget } from "../ipc";
import type { DiffLayout } from "../review/model";

export type ReviewStoreState = {
  requests: ReviewMap;
  /** True once the first map arrived (so an older `get` result must not replace a push). */
  received: boolean;
  /** Why the mirror failed, if it did. */
  loadError: string | null;
  /** Session id → the `seq` of the request whose toast was dismissed. */
  dismissed: Readonly<Record<string, number>>;
  /** What the Review pane reviews (Story 8.1), or `null` while it is closed. */
  target: ReviewTarget | null;
  /** The session whose review request the pane shows on top (opened from the request), or `null`. */
  requestId: string | null;
  filter: DiffFilter;
  layout: DiffLayout;
  /** The selected file (its path in the list), or `null`. */
  selected: string | null;
  /** The tree's selectable paths in display order (the pane sets it), for stepping through the files. */
  order: readonly string[];
  /** The folder the last list came from (Rust's), or `null`. */
  root: string | null;
  /** Rises on Refresh and when the target's status poll changes: the pane reads the list again. */
  refreshSeq: number;
  /** How long the last diff took to render after its text arrived, in ms (Diagnostics). */
  lastRenderMs: number | null;
  applySnapshot: (requests: ReviewMap) => void;
  /** Put one request (the reply of `review_open`) into the map at once. */
  applyRequest: (request: ReviewRequest) => void;
  setLoadError: (error: string | null) => void;
  /** Close the toast of request `seq` of session `id` (the flag stays). */
  dismiss: (id: string, seq: number) => void;
  /** Show `target` in the pane (a new target starts at the All filter with no file selected). */
  openTarget: (target: ReviewTarget, requestId: string | null) => void;
  /** The pane closed: nothing is reviewed. */
  closeTarget: () => void;
  setFilter: (filter: DiffFilter) => void;
  setLayout: (layout: DiffLayout) => void;
  select: (path: string | null) => void;
  setOrder: (order: readonly string[]) => void;
  setRoot: (root: string | null) => void;
  refresh: () => void;
  setRenderMs: (ms: number) => void;
};

export const EMPTY_REVIEWS: ReviewMap = Object.freeze({}) as ReviewMap;
const NO_ORDER: readonly string[] = Object.freeze([]);
const NO_DISMISSED: Readonly<Record<string, number>> = Object.freeze({});

export const useReviewStore = create<ReviewStoreState>()((set) => ({
  requests: EMPTY_REVIEWS,
  received: false,
  loadError: null,
  dismissed: NO_DISMISSED,
  target: null,
  requestId: null,
  filter: "all",
  layout: "split",
  selected: null,
  order: NO_ORDER,
  root: null,
  refreshSeq: 0,
  lastRenderMs: null,
  applySnapshot: (requests) =>
    set((s) => {
      // A request that went (its session was removed) takes its dismissal with it.
      const gone = Object.keys(s.dismissed).filter((id) => requestIn(requests, id) === null);
      if (gone.length === 0) return { requests, received: true, loadError: null };
      const dismissed = { ...s.dismissed };
      for (const id of gone) delete dismissed[id];
      return { requests, received: true, loadError: null, dismissed };
    }),
  applyRequest: (request) =>
    set((s) => {
      const current = requestIn(s.requests, request.sessionId);
      // A newer request arrived meanwhile: keep it.
      if (current !== null && current.seq > request.seq) return {};
      return { requests: { ...s.requests, [request.sessionId]: request } };
    }),
  setLoadError: (loadError) => set({ loadError }),
  dismiss: (id, seq) => set((s) => ({ dismissed: { ...s.dismissed, [id]: seq } })),
  openTarget: (target, requestId) =>
    set((s) =>
      s.target !== null && sameReviewTarget(s.target, target) && s.requestId === requestId
        ? { refreshSeq: s.refreshSeq + 1 }
        : { target, requestId, filter: "all", selected: null, root: null, refreshSeq: s.refreshSeq + 1 },
    ),
  closeTarget: () =>
    set((s) => (s.target === null && s.requestId === null ? {} : { target: null, requestId: null, selected: null, order: NO_ORDER, root: null })),
  setFilter: (filter) => set((s) => (s.filter === filter ? {} : { filter })),
  setLayout: (layout) => set((s) => (s.layout === layout ? {} : { layout })),
  select: (selected) => set((s) => (s.selected === selected ? {} : { selected })),
  setRoot: (root) => set((s) => (s.root === root ? {} : { root })),
  setOrder: (order) => set((s) => (sameOrder(s.order, order) ? {} : { order })),
  refresh: () => set((s) => ({ refreshSeq: s.refreshSeq + 1 })),
  setRenderMs: (lastRenderMs) => set({ lastRenderMs }),
}));

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** True when both name the same node. */
export function sameReviewTarget(a: ReviewTarget, b: ReviewTarget): boolean {
  if (a.kind === "project" && b.kind === "project") return a.projectId === b.projectId;
  if (a.kind === "branch" && b.kind === "branch") return a.projectId === b.projectId && a.branch === b.branch;
  if (a.kind === "session" && b.kind === "session") return a.sessionId === b.sessionId;
  return false;
}

/** Session `id`'s request in `requests`, or `null` (never a prototype key). */
export function requestIn(requests: ReviewMap, id: string): ReviewRequest | null {
  return Object.prototype.hasOwnProperty.call(requests, id) ? (requests[id] ?? null) : null;
}

/** Whether session `id`'s node shows the `review` flag. */
export function isFlagged(requests: ReviewMap, id: string): boolean {
  return requestIn(requests, id)?.flagged === true;
}

/** Every request, oldest first (by `seq`). */
export function requestList(requests: ReviewMap): ReviewRequest[] {
  return Object.values(requests).sort((a, b) => a.seq - b.seq);
}

/** The flagged session ids as a `{sessionId: true}` map (what the canvas draws the flag from). */
export function flaggedIds(requests: ReviewMap): Readonly<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const request of Object.values(requests)) if (request.flagged) out[request.sessionId] = true;
  return out;
}

/** The requests that show a toast: flagged, and not dismissed at this `seq`; oldest first. */
export function toastRequests(requests: ReviewMap, dismissed: Readonly<Record<string, number>>): ReviewRequest[] {
  return requestList(requests).filter((r) => r.flagged && !(Object.hasOwn(dismissed, r.sessionId) && dismissed[r.sessionId] === r.seq));
}

/** A review toast's line: `<name> asks for review: <summary>`. */
export function reviewToastText(request: Pick<ReviewRequest, "name" | "summary">): string {
  return `${request.name} asks for review: ${request.summary}`;
}

/** The id of the banner a failed review load raises. */
export const REVIEW_LOAD_ERROR_BANNER_ID = "review.load";

const NO_BANNERS: readonly Banner[] = Object.freeze([]);
let memoError: string | null = null;
let memoResult: readonly Banner[] = NO_BANNERS;

/** The banner a failed review mirror raises (a request could go unseen); reference-stable while the error is. */
export function selectReviewBanners(state: ReviewStoreState): readonly Banner[] {
  if (state.loadError !== memoError) {
    memoError = state.loadError;
    memoResult = state.loadError === null ? NO_BANNERS : [{ id: REVIEW_LOAD_ERROR_BANNER_ID, text: state.loadError }];
  }
  return memoResult;
}
