// The Help tables (Story 11.5): rows a help page names with a fenced block whose info string is
// `table <name>` and that the pane draws from code, so the meanings live in one place
// (`stateMeaning` in `canvas/nodes`, `edgeLooks` in `canvas/edges`) and never as a second copy in
// Markdown. One typed table from name to component, beside `FIGURES`; a name missing here shows
// the block's text as a code block. Imported only by the lazily loaded Help pane.

import { useEffect, useReducer, type ComponentType } from "react";
import { subscribeBindings } from "../commands/registry";
import { edgeLooks, type EdgeLook } from "../canvas/edges";
import { sessionStateTone, stateMeaning, STATE_MEANING_KINDS, STOPPING_WORD, type SessionStateTone, type StateMeaningKind } from "../canvas/nodes";
import { EdgeLine } from "./figures/parts";
import "./figures.css";

/** The session-states row of an unrecognised state: no card shows the word `other`. */
export const OTHER_WORD = "any other word";

/** What every table takes: the fenced block's text, its accessible name. */
export type TableProps = { label: string };

/** One row of the session-states table: the word, how the canvas draws it, and what it means. */
export type StateRow = { kind: StateMeaningKind; word: string; tone: SessionStateTone; dot: boolean; meaning: string };

/**
 * The session-states rows, one per state {@link stateMeaning} knows: the word as the card shows it
 * (`any other word` for a state the app does not know, shown as the session reports it), drawn in its canvas tone (`stopping` muted
 * with no dot, as on the card), then its meaning.
 */
export function stateRows(): StateRow[] {
  return STATE_MEANING_KINDS.map((kind) => {
    const tone: SessionStateTone =
      kind === "stopping" ? "muted" : (sessionStateTone(kind === "other" ? { kind, raw: kind } : { kind }) ?? "muted");
    const word = kind === "stopping" ? STOPPING_WORD : kind === "other" ? OTHER_WORD : kind;
    return { kind, word, tone, dot: tone !== "muted", meaning: stateMeaning(kind) };
  });
}

/** Re-render when the key bindings change: a meaning names a key (`enter`). */
function useBindings(): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeBindings(bump), []);
}

/** A state word in the card's own look: the busy dot, the accent on `waiting` / `finished`, the rest muted. */
function StateWord({ row }: { row: StateRow }) {
  const className = row.tone === "attention" ? "session-attention-word session-state" : `session-state session-state-${row.tone}`;
  return (
    <span className={`help-legend-word ${className}`}>
      {row.dot && <span className="session-dot" aria-hidden="true" />}
      {row.word}
    </span>
  );
}

function SessionStatesTable({ label }: TableProps) {
  useBindings();
  return (
    <table className="help-table help-legend" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">State</th>
          <th scope="col">Means</th>
        </tr>
      </thead>
      <tbody>
        {stateRows().map((row) => (
          <tr key={row.kind}>
            <td>
              <StateWord row={row} />
            </td>
            <td>{row.meaning}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A short line in the edge look's canvas classes, as the edge-kinds figure draws it. */
function EdgeSample({ look }: { look: EdgeLook["look"] }) {
  const kind = look === "cooperate" ? "cooperate" : "context";
  const className = look === "pending" ? "is-pending" : look === "selected" ? "is-selected" : undefined;
  return (
    <svg className="help-legend-line" width="40" height="12" viewBox="0 0 40 12" aria-hidden="true">
      <EdgeLine kind={kind} d="M2,6 L38,6" className={className} failed={look === "failed"} />
    </svg>
  );
}

function EdgeLooksTable({ label }: TableProps) {
  useBindings();
  return (
    <table className="help-table help-legend" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">Edge</th>
          <th scope="col">Means</th>
        </tr>
      </thead>
      <tbody>
        {edgeLooks().map(({ look, meaning }) => (
          <tr key={look}>
            <td>
              <span className="help-legend-edge">
                <EdgeSample look={look} />
                <span className="help-legend-word">{look}</span>
              </span>
            </td>
            <td>{meaning}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type TableName = "session-states" | "edge-looks";

export const TABLES: Readonly<Record<TableName, ComponentType<TableProps>>> = Object.freeze({
  "session-states": SessionStatesTable,
  "edge-looks": EdgeLooksTable,
});

/** The table named exactly `name`, or `null` (never a key of `Object.prototype`). */
export function tableFor(name: string): ComponentType<TableProps> | null {
  return Object.prototype.hasOwnProperty.call(TABLES, name) ? TABLES[name as TableName] : null;
}
