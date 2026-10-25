import { useEffect, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cooperateSides, edgeLiveIn, endText, type EndText } from "../canvas/edges";
import { retryEdge, saveEdgeLabel } from "../commands/edges";
import { runCommand, runCommandAsync } from "../commands/registry";
import type { ChildNode, Edge, EdgeLive, EdgesLiveMap, Project } from "../ipc";
import { canRetryLive, isCooperate, isSessionContext, nowText, sideNowText, useEdgesLiveStore } from "../state/edgesLive";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";

const NO_EDGES: readonly Edge[] = [];
const NO_PROJECTS: readonly Project[] = [];
const NO_CHILDREN: readonly ChildNode[] = [];

/**
 * The edge inspector (Story 6.1): a small pane for the selected edge, opened by a click on its
 * line (or "Inspect edge"). It states the kind and both ends, holds the Label field (saved on
 * Enter or when it loses focus; blank clears it) and a Delete button (Del does the same while
 * focus is not in the field). Story 7.2: an edge whose "Always for this edge" is set says
 * `Agent actions: always allowed`, with Revoke. Esc closes it; the edge stays selected. It never takes the focus
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
      entries={entries}
    />
  );
}

/**
 * Which of the inspector's command buttons show for `edge` (its live state `live`); each runs
 * the command beside it in {@link INSPECTOR_BUTTON_COMMANDS} on the selected edge, which is the
 * one the inspector shows.
 */
export function inspectorButtons(edge: Edge, live: EdgeLive | null): { revoke: boolean; retry: boolean; restart: boolean } {
  const sessionContext = isSessionContext(edge);
  return { revoke: edge.agentAllowed === true, retry: sessionContext && canRetryLive(live), restart: sessionContext };
}

export const INSPECTOR_BUTTON_COMMANDS = { revoke: "edge.revokeAgentPolicy", retry: "edge.retry", restart: "edge.restartWithFlags" } as const;

function endLine(end: EndText): string {
  return end.project === null ? end.label : `${end.label} (${end.project})`;
}

function EdgeInspector({ edge, from, to, live, entries }: { edge: Edge; from: EndText; to: EndText; live: EdgeLive | null; entries: EdgesLiveMap }) {
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
  const shown = inspectorButtons(edge, live);
  // Story 6.4: one Now line per side of a cooperate edge, each with its own Retry.
  const sides = isCooperate(edge)
    ? cooperateSides(edge, entries).map((side, i) => ({ ...side, name: (i === 0 ? from : to).label }))
    : [];
  // The inspector shows the selected edge, which is what `edge.restartWithFlags` acts on.
  const restart = () => {
    setRestarting(true);
    void runCommandAsync("edge.restartWithFlags").finally(() => setRestarting(false));
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
        {sides.map((side) => (
          <div key={side.sessionId} className="edge-now-side">
            <p className="edge-now" aria-live="polite">
              <span className="edge-now-term">Now:</span> {sideNowText(side.name, side.live)}
            </p>
            {canRetryLive(side.live) && (
              <button
                type="button"
                className="btn"
                onClick={() => void retryEdge(edge.id, side.sessionId)}
                title={`Send the peer line to ${side.name} again`}
              >
                Retry
              </button>
            )}
          </div>
        ))}
        {shown.revoke && (
          // Story 7.2: "Always for this edge" -- an agent at one end acts on the other without a toast.
          <div className="edge-policy">
            <p className="edge-now">
              <span className="edge-now-term">Agent actions:</span> always allowed
            </p>
            <button type="button" className="btn" onClick={() => runCommand("edge.revokeAgentPolicy")} title="The next agent action across this edge asks again">
              Revoke
            </button>
          </div>
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
          {shown.retry && (
            <button type="button" className="btn" onClick={() => runCommand("edge.retry")} title="Inject /add-dir again">
              Retry
            </button>
          )}
          {shown.restart && (
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
