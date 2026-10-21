import { Handle, Position, useConnection } from "@xyflow/react";
import { FORK_HANDLE, LINK_SOURCE_HANDLE, LINK_SOURCE_LEFT_HANDLE, LINK_TARGET_HANDLE, LINK_TARGET_RIGHT_HANDLE } from "./edges";

/**
 * A card's edge handles (Story 6.1). Session and project cards (`source`) carry the one handle
 * an edge is dragged from, on the right edge: a small round mark shown on hover and while the
 * card is selected. Every project, branch and session card is a drop target: an invisible
 * handle over the whole card that takes the pointer only while a link is being dragged, so a
 * drop anywhere on the card links to it; over a card the pair is refused for, it shows the
 * not-allowed cursor.
 */
export function LinkHandles({ source, shown }: { source: boolean; shown: boolean }) {
  // Re-renders only when a drag starts or ends.
  const linking = useConnection((connection) => connection.inProgress);
  return (
    <>
      {source && (
        <Handle
          type="source"
          id={LINK_SOURCE_HANDLE}
          position={Position.Right}
          className={"link-handle" + (shown ? " is-shown" : "")}
          isConnectableEnd={false}
          title="Drag to link"
          aria-label="Link to…"
        />
      )}
      <Handle
        type="target"
        id={LINK_TARGET_HANDLE}
        position={Position.Left}
        className={"link-target" + (linking ? " is-armed" : "")}
        isConnectableStart={false}
      />
      {/* Where an edge to a card further left leaves: inert, invisible. */}
      {source && (
        <Handle type="source" id={LINK_SOURCE_LEFT_HANDLE} position={Position.Left} className="link-anchor" isConnectable={false} />
      )}
      {/* Where an edge from a card of the same column, or from one further right, ends: inert, invisible. */}
      <Handle type="target" id={LINK_TARGET_RIGHT_HANDLE} position={Position.Right} className="link-anchor" isConnectable={false} />
    </>
  );
}

/**
 * The anchors of the "forked from" line (Story 4.4) at a session card's left edge: invisible and
 * inert (no connecting, no pointer events), only there so xyflow can route the line. They carry
 * their own id so the line never picks a link handle.
 */
export function ForkHandles() {
  return (
    <>
      <Handle type="source" id={FORK_HANDLE} position={Position.Left} className="fork-handle" isConnectable={false} />
      <Handle type="target" id={FORK_HANDLE} position={Position.Left} className="fork-handle" isConnectable={false} />
    </>
  );
}
