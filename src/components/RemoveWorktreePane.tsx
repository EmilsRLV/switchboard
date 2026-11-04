import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { commandHint } from "../commands/keybindings";
import { isCommandEnabled, runCommand } from "../commands/registry";
import {
  FORCE_CONFIRM_DELAY_MS,
  dirtyLine,
  discardLabel,
  plannedCommands,
} from "../commands/removeWorktree";
import { usePaletteStore } from "../state/palette";
import { useRemoveWorktreeStore } from "../state/removeWorktree";

/**
 * The "Remove worktree" sheet (Story 5.4; "Remove worktree…" on a branch card with a worktree
 * chip; Esc closes): the app's first confirmation. It names the branch and folder, states what
 * Rust's read-only checks found, and shows the exact commands that run. A clean worktree goes on
 * one click of **Remove**; a dirty one needs **Force remove…** and then the second, explicit
 * button that names the files discarded -- a separate button below it, not focused when it
 * appears and disabled for a moment, so a double-click on Force remove… never confirms; a locked
 * one, or one a session runs in, is refused.
 * Enter never removes: only a click (or Space on a focused button) does.
 */
export function RemoveWorktreePane() {
  const branch = useRemoveWorktreeStore((s) => s.branch);
  const check = useRemoveWorktreeStore((s) => s.check);
  const deleteBranch = useRemoveWorktreeStore((s) => s.deleteBranch);
  const forceArmed = useRemoveWorktreeStore((s) => s.forceArmed);
  const forceArmedAt = useRemoveWorktreeStore((s) => s.forceArmedAt);
  // Re-rendered once the second button's delay has passed.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!forceArmed || forceArmedAt === null) return;
    const wait = Math.max(0, forceArmedAt + FORCE_CONFIRM_DELAY_MS - Date.now());
    const timer = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [forceArmed, forceArmedAt]);
  const removing = useRemoveWorktreeStore((s) => s.removing);
  const removed = useRemoveWorktreeStore((s) => s.removed);
  const error = useRemoveWorktreeStore((s) => s.error);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus goes to Close, never to a button that removes; it goes back when the sheet goes. Not
  // when the palette opened us: its input keeps the focus until it closes.
  useEffect(() => {
    const previous = document.activeElement;
    if (!usePaletteStore.getState().isOpen) closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const commands = plannedCommands({ check, deleteBranch, forceArmed });
  const dirty = check?.dirty ?? 0;

  // Enter is swallowed so it never submits (a focused button would otherwise take it as a click).
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && event.target instanceof HTMLButtonElement && event.target.dataset.removes === "true") event.preventDefault();
  };

  return (
    <aside className="pane remove-worktree-pane" aria-label="Remove worktree" onKeyDown={onKeyDown}>
      <header className="pane-header">
        <h2 className="pane-title">Remove worktree</h2>
        <button ref={closeRef} type="button" className="btn" onClick={() => runCommand("pane.close")} title={commandHint("pane.close", "Close")}>
          Close
        </button>
      </header>

      <section className="pane-section" aria-label="Worktree">
        <p className="remove-worktree-branch">{branch}</p>
        <p className="remove-worktree-path" title={check?.path}>
          {check?.path ?? "…"}
        </p>
        {check !== null && check.missing && <p className="muted">The folder is gone: Remove clears git's record of it.</p>}
        {check !== null && check.refusal !== null && (
          <p className="pane-error launch-error">
            {check.locked
              ? `${check.refusal} (unlock it in git first)`
              : check.refusal.startsWith("a session is running") ? `${check.refusal}. Stop it first.` : check.refusal}
          </p>
        )}
        {check !== null && check.refusal === null && dirty > 0 && <p className="remove-worktree-dirty">{dirtyLine(dirty)}</p>}
        {check !== null && check.refusal === null && dirty === 0 && !check.missing && !removed && <p className="muted">No changed files.</p>}
      </section>

      {check !== null && check.refusal === null && (
        <section className="pane-section" aria-label="Command">
          <label className="launch-check">
            <input
              type="checkbox"
              checked={deleteBranch}
              disabled={removing || removed}
              onChange={(e) => useRemoveWorktreeStore.getState().setDeleteBranch(e.target.checked)}
            />
            <span>
              Also delete branch <span className="remove-worktree-name">{branch}</span>
            </span>
          </label>
          {!deleteBranch && <p className="launch-hint">The branch is kept.</p>}
          <h3 className="pane-heading">Runs</h3>
          <code className="worktree-command" aria-live="polite">
            {commands.length === 0 ? "—" : commands.join("\n")}
          </code>
          {!removed && dirty === 0 && (
            <div className="actions launch-start">
              <button type="button" className="btn" data-removes="true" disabled={!isCommandEnabled("worktree.remove")} title={commandHint("worktree.remove")} onClick={() => runCommand("worktree.remove")}>
                {removing ? "Removing…" : "Remove"}
              </button>
            </div>
          )}
          {!removed && dirty > 0 && (
            <div className="actions launch-start">
              <button
                key="force"
                type="button"
                className="btn"
                disabled={!isCommandEnabled("worktree.forceRemove")}
                title={commandHint("worktree.forceRemove")}
                onClick={() => runCommand("worktree.forceRemove")}
              >
                Force remove…
              </button>
            </div>
          )}
          {!removed && dirty > 0 && forceArmed && (
            <div key="discard" className="actions launch-start remove-worktree-discard">
              <button
                type="button"
                className="btn"
                data-removes="true"
                disabled={!isCommandEnabled("worktree.discardAndRemove")}
                title={commandHint("worktree.discardAndRemove")}
                onClick={() => runCommand("worktree.discardAndRemove")}
              >
                {removing ? "Removing…" : discardLabel(dirty)}
              </button>
            </div>
          )}
        </section>
      )}

      {(error !== null || removed) && (
        <section className="pane-section">
          {removed && <p className="muted">Worktree removed; the branch was kept.</p>}
          {error !== null && (
            <p className="pane-error launch-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </aside>
  );
}
