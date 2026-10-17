import { memo, useSyncExternalStore } from "react";
import type { NodeProps } from "@xyflow/react";
import type { ChildKind } from "../ipc";
import {
  moreLabel,
  sessionCardMeta,
  sessionHoverText,
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
 * border in the accent: `session-attention`, Story 3.3), `idle`, `exited` and unrecognised
 * states muted, historic sessions none. The
 * full title and exact times are on hover. Stubs and branches show the label and a muted
 * detail on one row. `SessionNode` and `BranchNode` are thin wrappers so xyflow has a type per
 * child kind. A right-click opens the node menu (only its enabled entries: Attach for a live
 * session); selection is an outline in `--fg`, never the accent.
 */
function ChildCard({ data, kind }: { data: ChildNodeData; kind: ChildKind }) {
  const { child, selected, attention } = data;
  const className =
    `child-node child-node-${kind}` + (selected ? " is-selected" : "") + (attention ? " session-attention" : "");
  const ariaLabel = `${kind === "session" ? "Session" : "Branch"} ${child.label}${attention ? ", needs you" : ""}`;
  if (child.session !== null) {
    return <SessionCard className={className + " child-node-two-line"} ariaLabel={ariaLabel} data={data} />;
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
  const { child, state, attention } = data;
  const meta = child.session;
  if (meta === null) return null;
  const parts = sessionCardMeta(meta, now, state);
  // Only the branch shrinks (ellipsis); the state word, the count and the age never do.
  const tail = parts.age === null ? parts.count : `${parts.count} · ${parts.age}`;
  return (
    <div
      className={className}
      role="group"
      aria-label={ariaLabel}
      title={sessionHoverText(child.label, meta) + (attention ? "\nneeds you" : "")}
    >
      <span className="child-node-label">{child.label}</span>
      <span className="child-node-meta">
        {parts.state !== null && (
          <span className={parts.state.tone === "attention" ? "session-attention-word session-state" : `session-state session-state-${parts.state.tone}`}>
            {parts.state.dot && <span className="session-dot" aria-hidden="true" />}
            {parts.state.word}
          </span>
        )}
        {parts.state !== null && <span aria-hidden="true">·</span>}
        {parts.branch !== null && (
          <>
            <span className="child-node-meta-branch">{parts.branch}</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <span>{tail}</span>
      </span>
    </div>
  );
}

export const SessionNode = memo(function SessionNode({ data }: NodeProps<SessionFlowNode>) {
  return <ChildCard data={data} kind="session" />;
});

export const BranchNode = memo(function BranchNode({ data }: NodeProps<BranchFlowNode>) {
  return <ChildCard data={data} kind="branch" />;
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
