import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewRequest } from "../ipc";
import { EMPTY_REVIEWS, flaggedIds, isFlagged, requestIn, reviewToastText, toastRequests, useReviewStore } from "../state/review";
import { useUiStore } from "../state/ui";
import { childAriaLabel, REVIEW_TEXT } from "../canvas/nodes";
import { registerBuiltins } from "./builtins";
import { clearCommands, getCommand, runCommand } from "./registry";
import { revealToastSession } from "./attention";
import { closeOpenPane } from "./panes";
import {
  canClearReview,
  canOpenReview,
  clearReview,
  dismissReviewToast,
  flagToClear,
  openReview,
  reviewToOpen,
  showsToastStack,
} from "./review";

vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  reviewOpen: vi.fn(),
  reviewClear: vi.fn(),
}));

const ipc = await import("../ipc");
const reviewOpen = vi.mocked(ipc.reviewOpen);
const reviewClear = vi.mocked(ipc.reviewClear);

function request(sessionId: string, seq: number, flagged = true, over: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    sessionId,
    name: `name-${sessionId}`,
    summary: "token refresh done",
    root: "/w/api",
    paths: [{ path: "/w/api/src/auth/refresh.ts", display: "src/auth/refresh.ts", missing: true }],
    at: "2026-10-25T10:00:00.000Z",
    seq,
    flagged,
    ...over,
  };
}

describe("review requests (Story 7.4)", () => {
  beforeEach(() => {
    useReviewStore.setState({ requests: EMPTY_REVIEWS, received: false, loadError: null, dismissed: {}, openId: null });
    useUiStore.setState({ pane: null, selection: null });
    reviewOpen.mockReset();
    reviewClear.mockReset();
    registerBuiltins();
  });
  afterEach(() => clearCommands());

  it("mirrors the map, draws the flag of flagged sessions only and never reads a prototype key", () => {
    useReviewStore.getState().applySnapshot({ s1: request("s1", 1), s2: request("s2", 2, false) });
    const { requests } = useReviewStore.getState();
    expect(isFlagged(requests, "s1")).toBe(true);
    expect(isFlagged(requests, "s2")).toBe(false);
    expect(requestIn(requests, "constructor")).toBeNull();
    expect(flaggedIds(requests)).toEqual({ s1: true });
    expect(reviewToastText(request("s1", 1))).toBe("name-s1 asks for review: token refresh done");
    expect(childAriaLabel("session", { child: { label: "api-1" } as never, attention: false, detail: null, lastLine: null, review: true })).toBe(
      `Session api-1, ${REVIEW_TEXT}`,
    );
  });

  it("shows one toast per flagged session; Dismiss keeps the flag and a new request shows it again", () => {
    useReviewStore.getState().applySnapshot({ s1: request("s1", 1), s2: request("s2", 2, false) });
    let { requests, dismissed } = useReviewStore.getState();
    expect(toastRequests(requests, dismissed).map((r) => r.sessionId)).toEqual(["s1"]);
    dismissReviewToast("s1", 1);
    ({ requests, dismissed } = useReviewStore.getState());
    expect(toastRequests(requests, dismissed)).toEqual([]);
    expect(isFlagged(requests, "s1")).toBe(true);
    // The same session asks again: its one toast is back, with the new summary.
    useReviewStore.getState().applySnapshot({ s1: request("s1", 3, true, { summary: "second pass" }), s2: request("s2", 2, false) });
    ({ requests, dismissed } = useReviewStore.getState());
    expect(toastRequests(requests, dismissed).map((r) => r.summary)).toEqual(["second pass"]);
  });

  it("opening asks Rust, shows the Review pane on that session and leaves no flag; closing forgets it", async () => {
    useReviewStore.getState().applySnapshot({ s1: request("s1", 1) });
    reviewOpen.mockResolvedValue(request("s1", 1, false));
    await expect(openReview("s1")).resolves.toBe(true);
    expect(reviewOpen).toHaveBeenCalledWith("s1", 1);
    expect(useUiStore.getState().pane).toBe("review");
    expect(useReviewStore.getState().openId).toBe("s1");
    expect(isFlagged(useReviewStore.getState().requests, "s1")).toBe(false);
    closeOpenPane();
    expect(useReviewStore.getState().openId).toBeNull();
    // A refusal is the notice; no pane.
    reviewOpen.mockRejectedValue(new Error("no review request for this session"));
    await expect(openReview("s9")).resolves.toBe(false);
    expect(useUiStore.getState().pane).toBeNull();
    expect(useUiStore.getState().notice?.text).toContain("no review request");
  });

  it("an older reply never replaces a newer request", () => {
    useReviewStore.getState().applySnapshot({ s1: request("s1", 5, true, { summary: "newer" }) });
    useReviewStore.getState().applyRequest(request("s1", 4, false, { summary: "older" }));
    expect(requestIn(useReviewStore.getState().requests, "s1")?.summary).toBe("newer");
  });

  it("the palette opens the selected flagged session's review, else the newest; Clear lowers a flag without a pane", async () => {
    expect(canOpenReview()).toBe(false);
    expect(canClearReview()).toBe(false);
    expect(getCommand("review.open")?.when?.()).toBe(false);
    useReviewStore.getState().applySnapshot({ s1: request("s1", 1), s2: request("s2", 2), s3: request("s3", 3, false) });
    expect(reviewToOpen()).toBe("s3");
    expect(flagToClear()).toBe("s2");
    useUiStore.getState().select({ kind: "session", id: "s1" });
    expect(reviewToOpen()).toBe("s1");
    expect(flagToClear()).toBe("s1");

    reviewOpen.mockResolvedValue(request("s1", 1, false));
    expect(runCommand("review.open")).toBe(true);
    await vi.waitFor(() => expect(useUiStore.getState().pane).toBe("review"));
    expect(reviewOpen).toHaveBeenCalledWith("s1", 1);
    closeOpenPane();

    reviewClear.mockResolvedValue(undefined);
    expect(runCommand("review.clear")).toBe(true);
    await vi.waitFor(() => expect(isFlagged(useReviewStore.getState().requests, "s2")).toBe(false));
    expect(reviewClear).toHaveBeenCalledWith("s2", 2);
    expect(useUiStore.getState().pane).toBeNull();
    await expect(clearReview("s2")).resolves.toBe(true);
  });

  it("a click on a review notification opens that session's review", async () => {
    useReviewStore.getState().applySnapshot({ s1: request("s1", 1) });
    reviewOpen.mockResolvedValue(request("s1", 1, false));
    await expect(revealToastSession({ session_id: "s1", project_id: null, review: true })).resolves.toBe(true);
    expect(reviewOpen).toHaveBeenCalledWith("s1", 1);
    expect(useUiStore.getState().pane).toBe("review");
  });

  it("the palette prefers the selected session whenever it has a request, flagged or not", () => {
    useReviewStore.getState().applySnapshot({ s1: request("s1", 1, false), s2: request("s2", 2) });
    useUiStore.getState().select({ kind: "session", id: "s1" });
    expect(reviewToOpen()).toBe("s1");
    useUiStore.getState().select({ kind: "session", id: "s9" });
    expect(reviewToOpen()).toBe("s2");
  });

  it("a dismissal goes with its request", () => {
    useReviewStore.getState().applySnapshot({ s1: request("s1", 1), s2: request("s2", 2) });
    dismissReviewToast("s1", 1);
    dismissReviewToast("s2", 2);
    useReviewStore.getState().applySnapshot({ s2: request("s2", 2) });
    expect(useReviewStore.getState().dismissed).toEqual({ s2: 2 });
  });

  it("a new request from the session whose pane is open is opened at once (no flag, no toast)", async () => {
    useReviewStore.getState().applySnapshot({ s1: request("s1", 1) });
    reviewOpen.mockResolvedValueOnce(request("s1", 1, false));
    await openReview("s1");
    reviewOpen.mockResolvedValueOnce(request("s1", 2, false, { summary: "again" }));
    useReviewStore.getState().applySnapshot({ s1: request("s1", 2, true, { summary: "again" }) });
    expect(reviewOpen).toHaveBeenLastCalledWith("s1", 2);
    await vi.waitFor(() => expect(isFlagged(useReviewStore.getState().requests, "s1")).toBe(false));
    const { requests, dismissed } = useReviewStore.getState();
    expect(toastRequests(requests, dismissed)).toEqual([]);
    // With the pane closed a new request flags as usual.
    closeOpenPane();
    reviewOpen.mockClear();
    useReviewStore.getState().applySnapshot({ s1: request("s1", 3) });
    expect(reviewOpen).not.toHaveBeenCalled();
    expect(isFlagged(useReviewStore.getState().requests, "s1")).toBe(true);
  });

  it("the toast stack shows while approvals or reviews exist", () => {
    expect(showsToastStack(0, 0)).toBe(false);
    expect(showsToastStack(1, 0)).toBe(true);
    expect(showsToastStack(0, 1)).toBe(true);
    expect(showsToastStack(2, 3)).toBe(true);
  });
});
