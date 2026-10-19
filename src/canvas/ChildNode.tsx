import { memo, useSyncExternalStore } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ChildKind } from "../ipc";
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
 * and cut with an ellipsis; a `waiting` card's tooltip leads with the hook's reason (Story 4.3). The
 * full title and exact times are on hover. Stubs and branches show the label and a muted
 * detail on one row. A live session whose Switchboard terminal is being stopped reads `stopping`
 * (muted, Story 4.4), and a fork's tooltip and label say what it was forked from; a session card
 * also carries the invisible anchors of the "forked from" line. A discovered branch (Story 5.1)
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
  const parts = sessionCardMeta(meta, now, state, data.lastLine, data.stopping);
  // Only the branch shrinks (ellipsis); the state word, the count and the age never do.
  const tail = parts.age === null ? parts.count : `${parts.count} · ${parts.age}`;
  return (
    <div className={className} role="group" aria-label={ariaLabel} title={sessionCardTitle(data, meta)}>
      <span className="child-node-label">{child.label}</span>
      <span className="child-node-meta">
        {parts.state !== null && (
          <span className={parts.state.tone === "attention" ? "session-attention-word session-state" : `session-state session-state-${parts.state.tone}`}>
            {parts.state.dot && <span className="session-dot" aria-hidden="true" />}
            {parts.state.word}
          </span>
        )}
        {parts.state !== null && <span aria-hidden="true">·</span>}
        {parts.lastLine !== null ? (
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

export const SessionNode = memo(function SessionNode({ data }: NodeProps<SessionFlowNode>) {
  return (
    <>
      <ChildCard data={data} kind="session" />
      <ForkHandles />
    </>
  );
});

/**
 * The anchors of the "forked from" line (Story 4.4) at the card's left edge: invisible and
 * inert (no connecting, no pointer events), only there so xyflow can route the line.
 */
function ForkHandles() {
  return (
    <>
      <Handle type="source" position={Position.Left} className="fork-handle" isConnectable={false} />
      <Handle type="target" position={Position.Left} className="fork-handle" isConnectable={false} />
    </>
  );
}

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
