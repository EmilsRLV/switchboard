import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { launchKeyAction, launchKeyTarget } from "../commands/launch";
import { commandHint } from "../commands/keybindings";
import { isCommandEnabled, runCommand } from "../commands/registry";
import { createBlockedReason, editWorktree } from "../commands/worktree";
import { usePaletteStore } from "../state/palette";
import { useWorktreeStore } from "../state/worktree";

/**
 * The "New worktree" sheet (Story 5.2; "New worktree…" on a project or a branch card; Esc
 * closes): "New branch" (a name and a base) or "Existing branch" (a free local branch), then
 * the exact `git worktree add` command Rust will run, updated as the operator types. Enter or
 * ctrl+Enter creates; the submit is the consent. A refusal or git's error stays here.
 */
export function WorktreePane() {
  const projectLabel = useWorktreeStore((s) => s.projectLabel);
  const form = useWorktreeStore((s) => s.form);
  const preview = useWorktreeStore((s) => s.preview);
  const creating = useWorktreeStore((s) => s.creating);
  const error = useWorktreeStore((s) => s.error);
  const appliedSeq = useWorktreeStore((s) => s.appliedSeq);
  const previewSeq = useWorktreeStore((s) => s.previewSeq);
  const nameRef = useRef<HTMLInputElement>(null);
  const branchRef = useRef<HTMLSelectElement>(null);
  const existing = form?.mode === "existing";

  // Take focus on the first field; give it back when the sheet goes. Not when the palette
  // opened us: its input keeps the focus until it closes.
  useEffect(() => {
    const previous = document.activeElement;
    if (!usePaletteStore.getState().isOpen) (existing ? branchRef.current : nameRef.current)?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
    // Only on mount: switching modes keeps the focus where the operator put it.
  }, []);

  if (form === null) return null;
  const blocked = createBlockedReason({ form, preview, creating, previewSeq, appliedSeq });
  const shownError = error ?? preview?.error ?? null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (launchKeyAction(event.nativeEvent, launchKeyTarget(event.target)) !== "start") return;
    event.preventDefault();
    runCommand("worktree.create");
  };

  return (
    <aside className="pane worktree-pane" aria-label="New worktree" onKeyDown={onKeyDown}>
      <header className="pane-header">
        <h2 className="pane-title">New worktree</h2>
        <button type="button" className="btn" onClick={() => runCommand("pane.close")} title={commandHint("pane.close", "Close")}>
          Close
        </button>
      </header>

      <section className="pane-section">
        <p className="muted">A separate checkout of {projectLabel} for parallel work. Enter creates it.</p>
        <div className="worktree-mode" role="group" aria-label="Branch">
          <button type="button" className="btn" aria-pressed={!existing} disabled={creating} title={commandHint("worktree.modeNew")} onClick={() => runCommand("worktree.modeNew")}>
            New branch
          </button>
          <button type="button" className="btn" aria-pressed={existing} disabled={creating} title={commandHint("worktree.modeExisting")} onClick={() => runCommand("worktree.modeExisting")}>
            Existing branch
          </button>
        </div>
        {existing ? (
          <label className="launch-field">
            <span className="launch-label">Branch</span>
            <select ref={branchRef} className="launch-input" value={form.branch} disabled={creating} onChange={(e) => void editWorktree({ branch: e.target.value })}>
              {form.branch !== "" && !(preview?.available ?? []).includes(form.branch) && <option value={form.branch}>{form.branch}</option>}
              {(preview?.available ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="launch-field">
              <span className="launch-label">Name</span>
              <input
                ref={nameRef}
                className="launch-input worktree-name"
                type="text"
                value={form.name}
                spellCheck={false}
                autoComplete="off"
                disabled={creating}
                onChange={(e) => void editWorktree({ name: e.target.value })}
              />
            </label>
            <label className="launch-field">
              <span className="launch-label">Base</span>
              <select className="launch-input" value={form.base ?? ""} disabled={creating} onChange={(e) => void editWorktree({ base: e.target.value })}>
                {form.base === null && <option value="">…</option>}
                {form.base !== null && !(preview?.branches ?? []).includes(form.base) && <option value={form.base}>{form.base}</option>}
                {(preview?.branches ?? []).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </section>

      <section className="pane-section" aria-label="Command">
        <h3 className="pane-heading">Runs</h3>
        <code className="worktree-command" aria-live="polite">
          {preview?.command ?? "—"}
        </code>
        <div className="actions launch-start">
          <button
            type="button"
            className="btn"
            title={commandHint("worktree.create")}
            onClick={() => runCommand("worktree.create")}
            disabled={!isCommandEnabled("worktree.create")}
            aria-describedby={blocked !== null ? "worktree-create-reason" : undefined}
          >
            {creating ? "Creating…" : "Create"}
          </button>
          {blocked !== null && !creating && (
            <span id="worktree-create-reason" className="launch-hint">
              {blocked}
            </span>
          )}
        </div>
        {shownError !== null && (
          <p className="pane-error launch-error" role="alert">
            {shownError}
          </p>
        )}
      </section>
    </aside>
  );
}
