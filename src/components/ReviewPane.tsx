import { runCommand } from "../commands/registry";
import { requestIn, useReviewStore } from "../state/review";

/**
 * The Review pane (Story 7.4, before Epic 8's diff view): a session's review request, opened from
 * its card's `review` flag, its toast's Open, the OS notification or "Open review request". The
 * title is the session's name; then the summary, when it was requested, and one row per listed path, relative to the
 * session's folder (the full path on hover), with a muted `missing` mark when nothing is there.
 * Existence is checked (by Rust); contents are never read: the pane only lists paths. Epic 8 replaces the list with its diff and
 * file views. It never takes the focus on opening; Esc closes it.
 */
export function ReviewPane() {
  const openId = useReviewStore((s) => s.openId);
  const requests = useReviewStore((s) => s.requests);
  const request = openId === null ? null : requestIn(requests, openId);
  return (
    <aside className="pane review-pane" aria-label={request === null ? "Review" : `Review: ${request.name}`}>
      <header className="pane-header">
        <h2 className="pane-title review-title" title={request?.name}>
          {request === null ? "Review" : request.name}
        </h2>
        <button type="button" className="btn" onClick={() => runCommand("pane.close")} title="Close (Esc)">
          Close
        </button>
      </header>
      {request === null ? (
        <p className="muted">This review request is gone.</p>
      ) : (
        <>
          <section className="pane-section">
            <h3 className="pane-heading">Summary</h3>
            <p className="review-summary">{request.summary}</p>
            <p className="review-at">
              Requested <time dateTime={request.at}>{requestedAt(request.at)}</time>
            </p>
          </section>
          <section className="pane-section">
            <h3 className="pane-heading">Paths</h3>
            {request.paths.length === 0 ? (
              <p className="muted">No paths listed.</p>
            ) : (
              <ul className="review-paths">
                {request.paths.map((path) => (
                  <li key={path.path} className="review-path" title={path.path}>
                    <span className="review-path-text">{path.display}</span>
                    {path.missing && <span className="review-missing">missing</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </aside>
  );
}

/** When a review was requested, in the viewer's locale (`HH:MM` today, else the date too); the raw text if unreadable. */
export function requestedAt(at: string, now: Date = new Date()): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return at;
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return when.toDateString() === now.toDateString() ? time : `${when.toLocaleDateString()} ${time}`;
}
