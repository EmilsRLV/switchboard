import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { commandHint } from "../commands/keybindings";
import { isCommandEnabled, runCommand } from "../commands/registry";
import { importRows, selectedToAdd, useImportStore } from "../state/import";
import { usePaletteStore } from "../state/palette";
import { shortenPath } from "../canvas/nodes";

/**
 * "Import from Claude" (`project.import`; Esc closes): every folder Claude Code has been run
 * in (`~/.claude/projects`, read-only) that still exists, with its session count and a
 * checkbox; folders already on the canvas are ticked and disabled. Keyboard-operable: Tab
 * between rows, Space ticks, Enter (on a row or the list) adds the selection, as does the
 * button. The list is loaded by the command that opened the pane; this only renders it.
 */
export function ImportPane() {
  const items = useImportStore((s) => s.items);
  const loading = useImportStore((s) => s.loading);
  const error = useImportStore((s) => s.error);
  const selected = useImportStore((s) => s.selected);
  const adding = useImportStore((s) => s.adding);
  const toggle = useImportStore((s) => s.toggle);
  const closeRef = useRef<HTMLButtonElement>(null);

  // "On canvas" is decided by Rust when the list is fetched (the pane reloads on open).
  const rows = useMemo(() => importRows(items ?? []), [items]);
  const toAdd = selectedToAdd(rows, selected);

  // Take focus so Esc and Tab work inside the pane; give it back when the pane goes. Not when
  // the palette opened us: its input keeps the focus.
  useEffect(() => {
    const previous = document.activeElement;
    if (!usePaletteStore.getState().isOpen) closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  // Enter on a checkbox (or the list itself) confirms; buttons handle Enter natively.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter") return;
    const target = event.target as HTMLElement;
    const onRow = (target instanceof HTMLInputElement && target.type === "checkbox") || target.tagName === "UL";
    if (!onRow) return;
    event.preventDefault();
    runCommand("import.addSelected");
  };

  return (
    <aside className="pane" aria-label="Import from Claude" onKeyDown={onKeyDown}>
      <header className="pane-header">
        <h2 className="pane-title">Import from Claude</h2>
        <button ref={closeRef} type="button" className="btn" onClick={() => runCommand("pane.close")} title={commandHint("pane.close", "Close")}>
          Close
        </button>
      </header>

      <section className="pane-section">
        <p className="muted">
          Folders Claude Code has been run in (<code className="path">~/.claude/projects</code>) that still exist.
          Tick the ones to add; Enter or "Add selected" places them at the centre of the canvas.
        </p>
        {loading && items === null ? (
          <p className="muted" aria-busy="true">
            reading Claude's project list…
          </p>
        ) : rows.length === 0 && error === null ? (
          <p className="muted">No Claude project whose folder still exists.</p>
        ) : (
          <ul className="import-list" aria-label="Claude projects" tabIndex={rows.length === 0 ? -1 : 0}>
            {rows.map(({ project, label, onCanvas }) => {
              const checked = onCanvas || selected.includes(project.cwd);
              return (
                <li key={project.dir} className={"import-row" + (onCanvas ? " is-on-canvas" : "")}>
                  <label className="import-row-label">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={onCanvas || adding}
                      onChange={() => toggle(project.cwd)}
                      aria-label={`${label}, ${sessionsText(project.sessions)}${onCanvas ? ", on canvas" : ""}`}
                    />
                    <span className="import-row-body">
                      <span className="import-row-name">{label}</span>
                      <span className="import-row-path" title={project.cwd}>
                        {shortenPath(project.cwd, 48)}
                      </span>
                    </span>
                    <span className="import-row-meta">{onCanvas ? "on canvas" : sessionsText(project.sessions)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="actions">
          <button type="button" className="btn" title={commandHint("import.addSelected")} onClick={() => runCommand("import.addSelected")} disabled={!isCommandEnabled("import.addSelected")}>
            {adding ? "Adding…" : toAdd.length === 0 ? "Add selected" : `Add selected (${toAdd.length})`}
          </button>
        </div>
      </section>

      {error !== null && <p className="pane-error">{error}</p>}
    </aside>
  );
}

function sessionsText(count: number): string {
  return count === 1 ? "1 session" : `${count} sessions`;
}
