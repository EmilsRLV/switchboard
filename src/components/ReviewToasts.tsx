import { dismissReviewToast, openReview } from "../commands/review";
import type { ReviewRequest } from "../ipc";
import { reviewToastText, toastRequests, useReviewStore } from "../state/review";

/**
 * The review toasts (Story 7.4): one per flagged session whose toast the operator has not
 * dismissed, in the bottom-right stack after the agent approval toasts (`ApprovalToasts` renders
 * the stack and these inside it), in the approval toast's look. Each says `<name> asks for review:
 * <summary>` and offers Open (the Review pane on that session; the flag goes) and Dismiss (the
 * toast goes, the flag stays). It does not wait or expire, and a new request from the same session
 * replaces it. It never takes the focus; "Open review request" is the keyboard's way.
 */
export function ReviewToasts() {
  const toasts = useReviewToasts();
  return (
    <>
      {toasts.map((request) => (
        // Keyed by the request: a replacement is a new toast, announced again.
        <ReviewToast key={`${request.sessionId}#${request.seq}`} request={request} />
      ))}
    </>
  );
}

/** The requests showing a toast now. */
export function useReviewToasts(): ReviewRequest[] {
  const requests = useReviewStore((s) => s.requests);
  const dismissed = useReviewStore((s) => s.dismissed);
  return toastRequests(requests, dismissed);
}

function ReviewToast({ request }: { request: ReviewRequest }) {
  return (
    <div className="approval-toast review-toast" role="group" aria-label={reviewToastText(request)}>
      <p className="approval-title">
        <span className="approval-caller">{request.name}</span> asks for review: {request.summary}
      </p>
      <div className="approval-actions">
        <button type="button" className="btn" onClick={() => void openReview(request.sessionId, request.seq)}>
          Open
        </button>
        <button type="button" className="btn" onClick={() => dismissReviewToast(request.sessionId, request.seq)} title="The flag stays on the card">
          Dismiss
        </button>
      </div>
    </div>
  );
}
