import { useUiStore } from "../state/ui";

/**
 * The transient notice (`ui.notice`: a stub saying what it will do, an action saying why it
 * could not run): one muted row laid over the top edge of the canvas, not in the banner
 * strip's flow, so its arrival and its exit never resize the canvas. Information, not
 * attention: no accent. Always one row: long text is cut with an ellipsis, the full text on
 * hover. Clicks pass through it (`pointer-events: none` in shell.css).
 */
export function Notice() {
  const notice = useUiStore((s) => s.notice);
  return (
    <div className="notice-region" role="status" aria-live="polite">
      {notice !== null && (
        <div className="notice">
          <span className="notice-mark" aria-hidden="true" />
          <span className="notice-text" title={notice.text}>
            {notice.text}
          </span>
        </div>
      )}
    </div>
  );
}
