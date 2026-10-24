// The actions behind Story 7.4's review requests: opening a session's review (the card's
// `review` flag, the toast's Open, a click on the OS notification, the palette's "Open review
// request") and "Clear review flag". Rust owns the requests and the flags: opening asks Rust
// (which lowers the flag and returns the request), then shows the Review pane on that session;
// a refusal is the notice. Each call names the request the UI showed (its `seq`), so a
// replacement the operator never saw keeps its flag. While the pane shows a session, a new
// request from it counts as seen: it is opened at once.

import { reviewClear, reviewOpen } from "../ipc";
import { isFlagged, requestIn, requestList, useReviewStore } from "../state/review";
import { useUiStore } from "../state/ui";
import { notify } from "./navigation";
import { openPane } from "./panes";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The selected session's id, when a session is selected. */
function selectedSessionId(): string | null {
  const selection = useUiStore.getState().selection;
  return selection !== null && selection.kind === "session" ? selection.id : null;
}

/**
 * The review "Open review request" opens: the selected session's whenever it has a request
 * (flagged or not), else the newest request. `null` with none.
 */
export function reviewToOpen(): string | null {
  const { requests } = useReviewStore.getState();
  const selected = selectedSessionId();
  if (selected !== null && requestIn(requests, selected) !== null) return selected;
  return requestList(requests).at(-1)?.sessionId ?? null;
}

/** The flag "Clear review flag" lowers: the selected session's when it is flagged, else the newest flagged one. */
export function flagToClear(): string | null {
  const { requests } = useReviewStore.getState();
  const selected = selectedSessionId();
  if (selected !== null && isFlagged(requests, selected)) return selected;
  return (
    requestList(requests)
      .filter((r) => r.flagged)
      .at(-1)?.sessionId ?? null
  );
}

/** The `when` of "Open review request": some session has a review request. */
export function canOpenReview(): boolean {
  return reviewToOpen() !== null;
}

/** The `when` of "Clear review flag": some session is flagged. */
export function canClearReview(): boolean {
  return flagToClear() !== null;
}

/** Whether the toast stack shows: some approval request is pending or some review toast is up. */
export function showsToastStack(pending: number, reviews: number): boolean {
  return pending > 0 || reviews > 0;
}

/**
 * Open session `sessionId`'s review, request `seq` (default: the one the UI shows now): Rust
 * lowers the flag and returns the request, which the Review pane then shows. Resolves whether the
 * pane opened; a refusal (no request, or one replaced since) is the notice.
 */
export async function openReview(sessionId: string, seq?: number): Promise<boolean> {
  const shown = seq ?? requestIn(useReviewStore.getState().requests, sessionId)?.seq;
  if (shown === undefined) {
    notify("could not open the review: no review request for this session");
    return false;
  }
  try {
    const request = await reviewOpen(sessionId, shown);
    const store = useReviewStore.getState();
    store.applyRequest(request);
    store.setOpen(sessionId);
    openPane("review");
    return true;
  } catch (err) {
    notify(`could not open the review: ${describe(err)}`);
    return false;
  }
}

/** Lower session `sessionId`'s review flag (request `seq`, default the one shown) without opening the pane. */
export async function clearReview(sessionId: string, seq?: number): Promise<boolean> {
  const current = requestIn(useReviewStore.getState().requests, sessionId);
  const shown = seq ?? current?.seq;
  if (shown === undefined) return false;
  try {
    await reviewClear(sessionId, shown);
    const now = requestIn(useReviewStore.getState().requests, sessionId);
    if (now !== null && now.seq === shown && now.flagged) useReviewStore.getState().applyRequest({ ...now, flagged: false });
    return true;
  } catch (err) {
    notify(`could not clear the review flag: ${describe(err)}`);
    return false;
  }
}

/** "Open review request" from the palette. */
export async function openReviewFromPalette(): Promise<boolean> {
  const id = reviewToOpen();
  return id === null ? false : openReview(id);
}

/** "Clear review flag" from the palette. */
export async function clearReviewFromPalette(): Promise<boolean> {
  const id = flagToClear();
  return id === null ? false : clearReview(id);
}

/** A review toast's Dismiss: the toast goes, the flag stays. */
export function dismissReviewToast(sessionId: string, seq: number): void {
  useReviewStore.getState().dismiss(sessionId, seq);
}

// The pane shows a session that asks again: the new request is seen, so it is opened (its flag
// and toast never rise). Once per `seq`.
let seenSeq: { id: string; seq: number } | null = null;
useReviewStore.subscribe((state) => {
  const id = state.openId;
  if (id === null || useUiStore.getState().pane !== "review") return;
  const request = requestIn(state.requests, id);
  if (request === null || !request.flagged) return;
  if (seenSeq !== null && seenSeq.id === id && seenSeq.seq === request.seq) return;
  seenSeq = { id, seq: request.seq };
  reviewOpen(id, request.seq).then(
    (opened) => useReviewStore.getState().applyRequest(opened),
    (err: unknown) => console.warn(`review open failed: ${describe(err)}`),
  );
});
