import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  claudeWorktreeFolder,
  CLAUDE_WORKTREE_BRANCH_PREFIX,
  CUSTOM_MODEL,
  EFFORT_CHOICES,
  edgeVia,
  formErrors,
  launchKeyAction,
  launchKeyTarget,
  MODEL_CHOICES,
  PERMISSION_CHOICES,
  skippedNote,
  startBlockedReason,
} from "../commands/launch";
import { isCommandEnabled, runCommand } from "../commands/registry";
import { removeAddDir } from "../commands/sessions";
import { shortenPath } from "../canvas/nodes";
import { useLaunchStore } from "../state/launch";
import { usePaletteStore } from "../state/palette";

/**
 * The launch sheet (`n` or "New session…" on a project; Esc closes): name, model (a named one
 * or custom text), effort, permission mode, extra add-dirs, an optional first prompt and
 * "start in background", prefilled from the project's last choices, then settings. Enter in a
 * single-line field or select starts, Enter in the prompt adds a newline, ctrl+Enter starts
 * from anywhere. A refusal stays here, under Start; a missing add-dir is marked on its row.
 *
 * On a branch card (Story 5.3) the subtitle names the branch and the folder Rust resolved; a
 * branch without a worktree adds a "Worktree" section with the exact `git worktree add` the
 * Start runs first. The project sheet of a git project offers `claude --worktree <name>`.
 *
 * Story 6.2: the project's context edges prefill the add-dirs; such a row reads `via edge →
 * <target>` and can be removed for this launch only (the edge stays). Edges whose target gives
 * no folder are listed in a muted `not added:` line; they never block Start.
 */
export function LaunchPane() {
  const projectLabel = useLaunchStore((s) => s.projectLabel);
  const branch = useLaunchStore((s) => s.branch);
  const targetPath = useLaunchStore((s) => s.targetPath);
  const worktreePlan = useLaunchStore((s) => s.worktreePlan);
  const repoTop = useLaunchStore((s) => s.repoTop);
  const form = useLaunchStore((s) => s.form);
  const starting = useLaunchStore((s) => s.starting);
  const error = useLaunchStore((s) => s.error);
  const missingDirs = useLaunchStore((s) => s.missingDirs);
  const edgeDirs = useLaunchStore((s) => s.edgeDirs);
  const skipped = useLaunchStore((s) => s.skipped);
  const edit = useLaunchStore((s) => s.edit);
  const nameRef = useRef<HTMLInputElement>(null);

  // Take focus on the name (selected, so typing replaces it); give it back when the sheet
  // goes. Not when the palette opened us: its input keeps the focus until it closes.
  useEffect(() => {
    const previous = document.activeElement;
    if (!usePaletteStore.getState().isOpen) nameRef.current?.select();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  if (form === null) return null;
  const errors = formErrors(form, repoTop);
  const blocked = startBlockedReason(form, missingDirs, starting, worktreePlan, repoTop);
  const worktreeFolder = repoTop === null ? null : claudeWorktreeFolder(repoTop, form.worktreeName.trim() || "<name>");
  const notAdded = skippedNote("not added", skipped);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (launchKeyAction(event.nativeEvent, launchKeyTarget(event.target)) !== "start") return;
    event.preventDefault();
    runCommand("launch.start");
  };

  return (
    <aside className="pane launch-pane" aria-label="New session" onKeyDown={onKeyDown}>
      <header className="pane-header">
        <h2 className="pane-title">New session</h2>
        <button type="button" className="btn" onClick={() => runCommand("pane.close")} title="Close (Esc)">
          Close
        </button>
      </header>

      <section className="pane-section">
        <p className="muted">
          {branch === null ? (
            <>
              Starts <code className="path">claude</code> in {projectLabel} in a terminal.
            </>
          ) : (
            <>
              Starts <code className="path">claude</code> on {branch} in{" "}
              <span className="path" title={targetPath ?? undefined}>
                {targetPath === null ? "a new worktree" : shortenPath(targetPath, 44)}
              </span>
              .
            </>
          )}{" "}
          Enter starts; ctrl+Enter starts from the prompt.
        </p>
        {worktreePlan !== null && branch !== null && (
          <div className="launch-worktree" role="group" aria-label="Worktree">
            <h3 className="pane-heading">Worktree</h3>
            <p className="muted">
              Creates a worktree for <code className="path">{branch}</code>, then starts the session in it.
            </p>
            <code className="worktree-command" aria-live="polite">
              {worktreePlan.command ?? "—"}
            </code>
            {worktreePlan.error !== null && (
              <p className="pane-error launch-error" role="alert">
                {worktreePlan.error}
              </p>
            )}
          </div>
        )}
        <label className="launch-field">
          <span className="launch-label">Name</span>
          <input
            ref={nameRef}
            className="launch-input"
            type="text"
            value={form.name}
            spellCheck={false}
            aria-invalid={errors.name !== null}
            aria-describedby={errors.name !== null ? "launch-name-hint" : undefined}
            onChange={(e) => edit({ name: e.target.value })}
          />
          {errors.name !== null && (
            <span id="launch-name-hint" className="launch-hint">
              {errors.name}
            </span>
          )}
        </label>
        <label className="launch-field">
          <span className="launch-label">Model</span>
          <select className="launch-input" value={form.model} onChange={(e) => edit({ model: e.target.value })}>
            {MODEL_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
        {form.model === CUSTOM_MODEL && (
          <label className="launch-field">
            <span className="launch-label">Custom model</span>
            <input
              className="launch-input"
              type="text"
              value={form.customModel}
              spellCheck={false}
              aria-invalid={errors.model !== null}
              aria-describedby={errors.model !== null ? "launch-model-hint" : undefined}
              onChange={(e) => edit({ customModel: e.target.value })}
            />
            {errors.model !== null && (
              <span id="launch-model-hint" className="launch-hint">
                {errors.model}
              </span>
            )}
          </label>
        )}
        <label className="launch-field">
          <span className="launch-label">Effort</span>
          <select className="launch-input" value={form.effort} onChange={(e) => edit({ effort: e.target.value })}>
            {EFFORT_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
        <label className="launch-field">
          <span className="launch-label">Permission mode</span>
          <select className="launch-input" value={form.permissionMode} onChange={(e) => edit({ permissionMode: e.target.value })}>
            {PERMISSION_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
      </section>

      {branch === null && repoTop !== null && worktreeFolder !== null && (
        <section className="pane-section" aria-label="Claude worktree">
          <label className="launch-check">
            <input type="checkbox" checked={form.useWorktree} disabled={starting} onChange={(e) => edit({ useWorktree: e.target.checked })} />
            <span>
              Let Claude make a worktree (<code className="path">--worktree</code>)
            </span>
          </label>
          {form.useWorktree && (
            <label className="launch-field">
              <span className="launch-label">Worktree name</span>
              <input
                className="launch-input worktree-name"
                type="text"
                value={form.worktreeName}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={errors.worktree !== null}
                aria-describedby="launch-worktree-hint"
                onChange={(e) => edit({ worktreeName: e.target.value })}
              />
              <span id="launch-worktree-hint" className="launch-hint">
                {errors.worktree ?? (
                  <>
                    Claude creates the new branch {CLAUDE_WORKTREE_BRANCH_PREFIX}
                    {form.worktreeName.trim()} from the repo&apos;s default branch in{" "}
                    <span title={worktreeFolder}>{shortenPath(worktreeFolder, 44)}</span>.
                  </>
                )}
              </span>
            </label>
          )}
        </section>
      )}

      <section className="pane-section" aria-label="Extra folders">
        <h3 className="pane-heading">Add-dirs</h3>
        {form.addDirs.length === 0 ? (
          <p className="muted">None: the session sees the folder it starts in only.</p>
        ) : (
          <ul className="launch-dirs">
            {form.addDirs.map((dir, index) => {
              const missing = missingDirs.includes(dir);
              const errorId = `launch-dir-error-${index}`;
              const via = edgeVia(edgeDirs, dir);
              return (
                <li key={dir} className="launch-dir">
                  <span className="launch-dir-path" title={dir} aria-describedby={missing ? errorId : undefined}>
                    {shortenPath(dir, 44)}
                  </span>
                  {via !== null && (
                    <span className="launch-dir-via" title={`via edge → ${via}`}>
                      via edge → {via}
                    </span>
                  )}
                  <button type="button" className="btn" onClick={() => removeAddDir(index)} aria-label={`Remove ${dir}`}>
                    Remove
                  </button>
                  {missing && (
                    <span id={errorId} className="pane-error launch-dir-error" role="alert">
                      folder does not exist
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {notAdded !== null && <p className="launch-skipped">{notAdded}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={() => runCommand("launch.addFolder")} disabled={!isCommandEnabled("launch.addFolder")}>
            Add folder…
          </button>
        </div>
      </section>

      <section className="pane-section">
        <label className="launch-field">
          <span className="launch-label">First prompt (optional)</span>
          <textarea
            className="launch-input launch-prompt"
            value={form.prompt}
            rows={4}
            onChange={(e) => edit({ prompt: e.target.value })}
          />
        </label>
        <label className="launch-check">
          <input type="checkbox" checked={form.background} onChange={(e) => edit({ background: e.target.checked })} />
          <span>Start in background</span>
        </label>
        <div className="actions launch-start">
          <button
            type="button"
            className="btn"
            onClick={() => runCommand("launch.start")}
            disabled={!isCommandEnabled("launch.start")}
            aria-describedby={blocked !== null ? "launch-start-reason" : undefined}
          >
            {starting ? "Starting…" : "Start"}
          </button>
          {blocked !== null && !starting && (
            <span id="launch-start-reason" className="launch-hint">
              {blocked}
            </span>
          )}
        </div>
        {error !== null && (
          <p className="pane-error launch-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </aside>
  );
}
