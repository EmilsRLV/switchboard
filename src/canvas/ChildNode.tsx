import { memo, useSyncExternalStore } from "react";
import type { NodeProps } from "@xyflow/react";
import type { ChildKind } from "../ipc";
import { commandHint } from "../commands/keybindings";
import { openReview } from "../commands/review";
import { unreadBadge } from "../state/inbox";
import { ForkHandles, LinkHandles } from "./LinkHandles";
import { NodeHint } from "./NodeHint";
import { NodeToolbar, useHover } from "./NodeToolbar";
import {
  branchCardParts,
  branchCardTitle,
  childAriaLabel,
  hasBranchSecondLine,
  moreLabel,
  sessionCardMeta,
  sessionCardTitle,
  type BranchFlowNode,
  type ChildNodeData,
  type MoreFlowNode,
  type SessionFlowNode,
} from "./nodes";

/**
 * One child card (208 × 40). A discovered (or live-only) session shows two lines: its title,
 * and a muted mono meta line `branch · N msgs · age` (the age recomputed each minute), led by
 * the state word while the poll has seen the session this run: `busy` in `--fg` after a
 * pulsing dot, `finished` / `waiting` in the accent after a pulsing accent dot (and the card's
 * border in the accent: `session-attention`, Story 3.3), `starting` (a session the app just
 * launched, Story 4.2), `idle`, `exited` and unrecognised states muted, historic sessions none. A
 * `finished` card from a hook shows the turn's last assistant line after the state word, muted
 * and cut with an ellipsis; a `waiting` card's tooltip leads with the hook's reason (Story 4.3). A
 * session's `set_status` text (Story 7.2) takes the place of branch, count and age until its state
 * changes. A session with unread peer messages (Story 7.3) shows a muted `N new` badge after its
 * title (the count badge's look, never the accent). A session that asks for review (Story 7.4)
 * shows a plain `review` flag beside it, in the same look; a click on the flag opens the Review
 * pane on that session (and lowers the flag). The
 * full title and exact times are on hover. Stubs and branches show the label and a muted
 * detail on one row. A live session whose Switchboard terminal is being stopped reads `stopping`
 * (muted, Story 4.4), and a fork's tooltip and label say what it was forked from; a session card
 * also carries the invisible anchors of the "forked from" line and, like every card, the edge
 * handles of Story 6.1 (`LinkHandles`). A discovered branch (Story 5.1)
 * shows its name with `*` when checked out, over a muted line: `↑n ↓m` against its upstream,
 * `upstream gone`, then the worktree chip (the folder's last two segments, or `missing`; the
 * full path on hover). `SessionNode` and `BranchNode` are thin wrappers so xyflow has a type per
 * child kind. A right-click opens the node menu (only its enabled entries: Attach for a live
 * session); selection is an outline in `--fg`, never the accent.
 */
function ChildCard({ data, kind }: { data: ChildNodeData; kind: ChildKind }) {
  const { child, selected, attention } = data;
  const className =
    `child-node child-node-${kind}` + (selected ? " is-selected" : "") + (attention ? " session-attention" : "");
  const ariaLabel = childAriaLabel(kind, data);
  if (child.session !== null) {
    return <SessionCard className={className + " child-node-two-line"} ariaLabel={ariaLabel} data={data} />;
  }
  if (child.branch !== null && child.branch !== undefined) {
    return <BranchCard className={className} ariaLabel={ariaLabel} data={data} />;
  }
  return (
    <div className={className} role="group" aria-label={ariaLabel} title={attention ? `${child.label}\nneeds you` : undefined}>
      <span className="child-node-label">{child.label}</span>
      {child.detail !== null && (
        <span className="child-node-detail" title={child.detail}>
          {child.detail}
        </span>
      )}
    </div>
  );
}

function SessionCard({ className, ariaLabel, data }: { className: string; ariaLabel: string; data: ChildNodeData }) {
  const now = useMinute();
  const { child, state } = data;
  const meta = child.session;
  if (meta === null) return null;
  const parts = sessionCardMeta(meta, now, state, data.lastLine, data.stopping, data.statusText ?? null);
  // Only the branch shrinks (ellipsis); the state word, the count and the age never do.
  const tail = parts.age === null ? parts.count : `${parts.count} · ${parts.age}`;
  // Story 7.3: unread peer messages, a plain muted `N new` after the title (never the accent).
  const badge = unreadBadge(data.unread ?? 0);
  // Story 7.4: the session asks for review: a plain `review` flag; a click opens the review.
  const review = data.review === true;
  return (
    <div className={className} role="group" aria-label={ariaLabel} title={sessionCardTitle(data, meta)}>
      {badge === null && !review ? (
        <span className="child-node-label">{child.label}</span>
      ) : (
        <span className="session-name-row">
          <span className="child-node-label">{child.label}</span>
          {badge !== null && <span className="session-unread">{badge}</span>}
          {review && (
            <button
              type="button"
              className="session-review nodrag"
              title={commandHint("review.open")}
              aria-label={`Open review request of ${child.label}`}
              onClick={(event) => {
                event.stopPropagation();
                void openReview(child.id);
              }}
              onKeyDown={(event) => {
                // The button's own key: never also the canvas's Enter (or a palette key).
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}
            >
              review
            </button>
          )}
        </span>
      )}
      <span className="child-node-meta">
        {parts.state !== null && (
          <span className={parts.state.tone === "attention" ? "session-attention-word session-state" : `session-state session-state-${parts.state.tone}`}>
            {parts.state.dot && <span className="session-dot" aria-hidden="true" />}
            {parts.state.word}
          </span>
        )}
        {parts.state !== null && <span aria-hidden="true">·</span>}
        {parts.statusText !== null ? (
          // What the session said through `set_status` (Story 7.2), until its state changes.
          <span className="session-status-text">{parts.statusText}</span>
        ) : parts.lastLine !== null ? (
          // A finished turn's last assistant line (Story 4.3), in place of branch, count, age.
          <span className="session-last-line">{parts.lastLine}</span>
        ) : (
          <>
            {parts.branch !== null && (
              <>
                <span className="child-node-meta-branch">{parts.branch}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span>{tail}</span>
          </>
        )}
      </span>
    </div>
  );
}

function BranchCard({ className, ariaLabel, data }: { className: string; ariaLabel: string; data: ChildNodeData }) {
  const { child } = data;
  const meta = child.branch ?? null;
  if (meta === null) return null;
  const parts = branchCardParts(meta);
  const twoLine = hasBranchSecondLine(parts);
  return (
    <div
      className={className + (twoLine ? " child-node-two-line" : "")}
      role="group"
      aria-label={ariaLabel}
      title={branchCardTitle(child.label, meta)}
    >
      <span className="branch-node-name">
        <span className="branch-node-label">{child.label}</span>
        {meta.head && (
          <span className="branch-node-current" aria-hidden="true">
            *
          </span>
        )}
      </span>
      {twoLine && (
        <span className="child-node-meta">
          {parts.counts !== null && <span>{parts.counts}</span>}
          {parts.gone && <span>upstream gone</span>}
          {parts.chip !== null && (
            <span
              className="branch-node-worktree"
              title={parts.chip.path}
              aria-label={parts.chip.missing ? `worktree missing: ${parts.chip.path}` : `worktree ${parts.chip.path}`}
            >
              {parts.chip.text}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * A session card, with its node toolbar (Story 11.2) while hovered or selected and not dragged.
 * The first live session carries the `review` hint (Story 11.3) to its right, except while the
 * toolbar shows (it offers `review` itself).
 */
export const SessionNode = memo(function SessionNode({ data, dragging }: NodeProps<SessionFlowNode>) {
  const [hovered, hover] = useHover();
  const toolbarShown = (hovered || data.selected) && dragging !== true;
  return (
    <div className="node-hover" {...hover}>
      <ChildCard data={data} kind="session" />
      <ForkHandles />
      <LinkHandles source shown={data.selected} />
      <NodeToolbar target={{ kind: "session", id: data.child.id }} shown={toolbarShown} />
      <NodeHint target={{ kind: "session", id: data.child.id }} handleShown={false} drawn={!toolbarShown} />
    </div>
  );
});

/** A branch card: an edge may end on it (Story 6.1) but never start from it. Its node toolbar as a session's. */
export const BranchNode = memo(function BranchNode({ data, dragging }: NodeProps<BranchFlowNode>) {
  const [hovered, hover] = useHover();
  return (
    <div className="node-hover" {...hover}>
      <ChildCard data={data} kind="branch" />
      <LinkHandles source={false} shown={false} />
      <NodeToolbar target={{ kind: "branch", id: data.child.id }} shown={(hovered || data.selected) && dragging !== true} />
    </div>
  );
});

/**
 * The row after the tenth child of a long column: `show all (N)`, or `show fewer` while the
 * project shows everything. Clicking it (the canvas's `onNodeClick`) or Enter while it is
 * selected toggles the project's `showAll`. Muted, no border; not draggable, no menu.
 */
export const MoreNode = memo(function MoreNode({ data }: NodeProps<MoreFlowNode>) {
  return (
    <div className={"more-node" + (data.selected ? " is-selected" : "")} role="button" aria-label={moreLabel(data.total, data.showingAll)}>
      {moreLabel(data.total, data.showingAll)}
    </div>
  );
});

// --- the minute clock: one interval shared by every session card ---------------------------

const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();
let minuteNow = Date.now();
let minuteTimer: ReturnType<typeof setInterval> | undefined;

function subscribeMinute(listener: () => void): () => void {
  listeners.add(listener);
  if (minuteTimer === undefined) {
    minuteNow = Date.now();
    minuteTimer = setInterval(() => {
      minuteNow = Date.now();
      for (const notify of listeners) notify();
    }, MINUTE_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && minuteTimer !== undefined) {
      clearInterval(minuteTimer);
      minuteTimer = undefined;
    }
  };
}

function minuteSnapshot(): number {
  return minuteNow;
}

/** `Date.now()`, refreshed once a minute while any session card is mounted. */
function useMinute(): number {
  return useSyncExternalStore(subscribeMinute, minuteSnapshot);
}
