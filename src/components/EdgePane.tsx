import { useEffect, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { endText, type EndText } from "../canvas/edges";
import { saveEdgeLabel } from "../commands/edges";
import { runCommand } from "../commands/registry";
import type { ChildNode, Edge, Project } from "../ipc";
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
  const edge = selection !== null && selection.kind === "edge" ? (edges.find((e) => e.id === selection.id) ?? null) : null;
  if (edge === null) return null;
  return (
    <EdgeInspector key={edge.id} edge={edge} from={endText(edge.from, projects, children)} to={endText(edge.to, projects, children)} />
  );
}

function endLine(end: EndText): string {
  return end.project === null ? end.label : `${end.label} (${end.project})`;
}

function EdgeInspector({ edge, from, to }: { edge: Edge; from: EndText; to: EndText }) {
  const [draft, setDraft] = useState(edge.label ?? "");
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
          <button type="button" className="btn" data-edge-delete onClick={() => runCommand("edge.delete")} title="Delete edge (Del)">
            Delete
          </button>
        </div>
      </section>
    </aside>
  );
}
