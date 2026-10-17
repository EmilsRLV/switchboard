import { useEffect, useRef } from "react";
import { shortenPath } from "../canvas/nodes";
import { addElsewhereFolder } from "../commands/projects";
import { runCommand } from "../commands/registry";
import type { ElsewhereRow } from "../ipc";
import { stateWord, useLiveStore } from "../state/live";
import { useUiStore } from "../state/ui";

/** Longest cwd a tray row shows before the middle is elided. */
const TRAY_PATH_MAX_CHARS = 40;

/** A row's name: the session's `name`, else (blank or missing) its id. */
export function elsewhereName(row: Pick<ElsewhereRow, "name" | "session_id">): string {
  const name = row.name?.trim() ?? "";
  return name === "" ? row.session_id : name;
}

/** The accessible name of a row's button: which folder it adds, for which session. */
export function addFolderLabel(row: Pick<ElsewhereRow, "name" | "session_id" | "cwd">): string {
  return `Add folder ${shortenPath(row.cwd, TRAY_PATH_MAX_CHARS)} for ${elsewhereName(row)}`;
}

/**
 * The Elsewhere tray: live sessions whose `cwd` is no project on the canvas (Claude started
 * from a plain terminal in another folder). A chip at the canvas's bottom-left reads
 * `elsewhere N` and shows only while N > 0; clicking it runs `elsewhere.toggle`, which opens a
 * list above it with one row per session: the state word (`busy` in `--fg`, the rest muted),
 * the session's name (its id when it has none), its shortened cwd (full path on hover) and an
 * **Add folder** button that puts that folder on the canvas at the view centre; the row leaves
 * on the next poll, when the session sits under its new project. Esc (`elsewhere.close`, after
 * the menu) or a press outside the tray closes the list. Nothing here is persisted. Tokens
 * only; no accent.
 */
export function ElsewhereTray() {
  const rows = useLiveStore((s) => s.snapshot.elsewhere);
  const open = useUiStore((s) => s.elsewhereOpen);
  const ref = useRef<HTMLDivElement>(null);

  // A press anywhere outside closes the open list (capture phase, as the context menu does,
  // so a node under the pointer cannot swallow it first).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current !== null && event.target instanceof Node && !ref.current.contains(event.target)) {
        useUiStore.getState().closeElsewhere();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  if (rows.length === 0) return null;
  return (
    <div className="elsewhere" ref={ref}>
      {open && (
        <ul className="elsewhere-list" aria-label="Live sessions elsewhere">
          {rows.map((row) => (
            <li key={row.session_id} className="elsewhere-row">
              <span className={"elsewhere-state" + (row.state.kind === "busy" ? " is-busy" : "")}>{stateWord(row.state)}</span>
              <span className="elsewhere-name" title={elsewhereName(row)}>
                {elsewhereName(row)}
              </span>
              <span className="elsewhere-path" title={row.cwd}>
                {shortenPath(row.cwd, TRAY_PATH_MAX_CHARS)}
              </span>
              <button
                type="button"
                className="btn elsewhere-add"
                aria-label={addFolderLabel(row)}
                onClick={() => void addElsewhereFolder(row.cwd)}
              >
                Add folder
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="elsewhere-chip"
        aria-expanded={open}
        title="Live sessions in folders not on the canvas"
        onClick={() => runCommand("elsewhere.toggle")}
      >
        elsewhere {rows.length}
      </button>
    </div>
  );
}
