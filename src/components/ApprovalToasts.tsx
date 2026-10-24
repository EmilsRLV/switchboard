import { useEffect, useState } from "react";
import { answerRequest } from "../commands/approvals";
import type { PendingRequest } from "../ipc";
import { alwaysTitle, requestTitle, secondsLeft, useApprovalsStore } from "../state/approvals";

/**
 * The agent approval toasts (Story 7.2): one per request an agent's act tool is waiting on,
 * stacked at the bottom right over the canvas and any pane, oldest first. Each says who asks and
 * what will happen, shows the exact argv (or the edge) in mono, and offers Allow, Deny and, when
 * a stored edge joins the caller and the target, Always for this edge. The toast is the one
 * attention surface with inline buttons: its border is the accent. It never takes the focus; the
 * palette's "Allow agent request" / "Deny agent request" answer the oldest from the keyboard.
 * Unanswered, Rust denies it at its deadline (the countdown) and it goes.
 */
export function ApprovalToasts() {
  const pending = useApprovalsStore((s) => s.pending);
  const answering = useApprovalsStore((s) => s.answering);
  const now = useSecond(pending.length > 0);
  if (pending.length === 0) return null;
  return (
    // Only new requests are announced: the countdown is hidden from assistive technology.
    <section className="approvals" aria-label="Agent requests" aria-live="polite" aria-relevant="additions">
      {pending.map((request) => (
        <ApprovalToast key={request.id} request={request} now={now} busy={answering.includes(request.id)} />
      ))}
    </section>
  );
}

function ApprovalToast({ request, now, busy }: { request: PendingRequest; now: number; busy: boolean }) {
  const title = requestTitle(request);
  return (
    <div className="approval-toast" role="group" aria-label={title}>
      <p className="approval-title">
        <span className="approval-caller">{request.callerName}</span> wants to {request.action}
      </p>
      <pre className="approval-detail" title={request.detail}>
        {request.detail}
      </pre>
      <div className="approval-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void answerRequest(request.id, "allow")}>
          Allow
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void answerRequest(request.id, "deny")}>
          Deny
        </button>
        {request.always && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void answerRequest(request.id, "always")}
            title={alwaysTitle(request)}
          >
            Always for this edge
          </button>
        )}
        <span className="approval-left" aria-hidden="true">
          denied in {secondsLeft(request, now)} s
        </span>
      </div>
    </div>
  );
}

/** `Date.now()`, refreshed every second while `on`. */
function useSecond(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}
