import { useEffect, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { edgeLiveIn, endText, type EndText } from "../canvas/edges";
import { restartEdge, retryEdge, saveEdgeLabel } from "../commands/edges";
import { runCommand } from "../commands/registry";
import type { ChildNode, Edge, EdgeLive, Project } from "../ipc";
import { canRetryLive, isSessionContext, nowText, useEdgesLiveStore } from "../state/edgesLive";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";

const NO_EDGES: readonly Edge[] = [];
const NO_PROJECTS: readonly Project[] = [];
const NO_CHILDREN: readonly ChildNode[] = [];

/**
 * The edge inspector (Story 6.1): a small pane for the selected edge, opened by a click on its
 * line (or "Inspect edge"). It states the kind and both ends, holds the Label field (saved on
 * Enter or when it loses focus; blank clears it) and a Delete button (Del does the same while
 * focus is not in the field). Esc closes it; the edge stays selected. It never takes the focus
 * on opening, so Del right after the click deletes.
 */
export function EdgePane() {
  const selection = useUiStore((s) => s.selection);
  const edges = useWorkspaceStore((s) => s.snapshot?.workspace.edges ?? NO_EDGES);
  const projects = useWorkspaceStore((s) => s.snapshot?.workspace.projects ?? NO_PROJECTS);
  const children = useWorkspaceStore((s) => s.snapshot?.children ?? NO_CHILDREN);
  const entries = useEdgesLiveStore((s) => s.entries);
  const edge = selection !== null && selection.kind === "edge" ? (edges.find((e) => e.id === selection.id) ?? null) : null;
  if (edge === null) return null;
  return (
    <EdgeInspector
      key={edge.id}
      edge={edge}
      from={endText(edge.from, projects, children)}
      to={endText(edge.to, projects, children)}
      live={edgeLiveIn(entries, edge.id)}
    />
  );
}

function endLine(end: EndText): string {
  return end.project === null ? end.label : `${end.label} (${end.project})`;
}

function EdgeInspector({ edge, from, to, live }: { edge: Edge; from: EndText; to: EndText; live: EdgeLive | null }) {
  const [draft, setDraft] = useState(edge.label ?? "");
  const [restarting, setRestarting] = useState(false);
  // A label stored elsewhere (or trimmed by Rust) replaces the draft.
  useEffect(() => setDraft(edge.label ?? ""), [edge.label]);

  const save = () => void saveEdgeLabel(edge.id, draft);
  // Leaving the field for Delete deletes; it does not save a label first.
  const onBlur = (event: ReactFocusEvent<HTMLInputElement>) => {
    if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.dataset.edgeDelete !== undefined) return;
    save();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    save();
  };
  const cooperate = edge.kind === "cooperate";
  // Story 6.3: what the edge does now; Retry after a failure (or a draft held it back), and
  // Restart with flags always for a context edge from a session.
  const now = nowText(edge, live);
  const sessionContext = isSessionContext(edge);
  const restart = () => {
    setRestarting(true);
    void restartEdge(edge.id).finally(() => setRestarting(false));
  };

  return (
    <aside className="pane edge-pane" aria-label="Edge">
      <header className="pane-header">
        <h2 className="pane-title">Edge</h2>
        <button type="button" className="btn" onClick={() => runCommand("pane.close")} title="Close (Esc)">
          Close
        </button>
      </header>

      <section className="pane-section">
        <dl className="edge-facts">
          <dt>Kind</dt>
          <dd>{cooperate ? "cooperate" : "context"}</dd>
          <dt>{cooperate ? "Between" : "From"}</dt>
          <dd title={endLine(from)}>{endLine(from)}</dd>
          <dt>{cooperate ? "And" : "To"}</dt>
          <dd title={endLine(to)}>{endLine(to)}</dd>
        </dl>
        {now !== null && (
          <p className="edge-now" aria-live="polite">
            <span className="edge-now-term">Now:</span> {now}
          </p>
        )}
        <label className="launch-field">
          <span className="launch-label">Label</span>
          <input
            className="launch-input"
            type="text"
            value={draft}
            placeholder="What the link is for"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
          />
        </label>
        <div className="actions launch-start">
          {sessionContext && canRetryLive(live) && (
            <button type="button" className="btn" onClick={() => void retryEdge(edge.id)} title="Inject /add-dir again">
              Retry
            </button>
          )}
          {sessionContext && (
            <button
              type="button"
              className="btn"
              disabled={restarting}
              onClick={restart}
              title="Stop the session and resume it with --add-dir"
            >
              Restart with flags
            </button>
          )}
          <button type="button" className="btn" data-edge-delete onClick={() => runCommand("edge.delete")} title="Delete edge (Del)">
            Delete
          </button>
        </div>
      </section>
    </aside>
  );
}
