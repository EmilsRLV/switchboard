import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  CUSTOM_MODEL,
  EFFORT_CHOICES,
  formErrors,
  launchKeyAction,
  launchKeyTarget,
  MODEL_CHOICES,
  PERMISSION_CHOICES,
  startBlockedReason,
} from "../commands/launch";
import { runCommand } from "../commands/registry";
import { pickAddDir, removeAddDir, startLaunch } from "../commands/sessions";
import { shortenPath } from "../canvas/nodes";
import { useLaunchStore } from "../state/launch";
import { usePaletteStore } from "../state/palette";

/**
 * The launch sheet (`n` or "New session…" on a project; Esc closes): name, model (a named one
 * or custom text), effort, permission mode, extra add-dirs, an optional first prompt and
 * "start in background", prefilled from the project's last choices, then settings. Enter in a
 * single-line field or select starts, Enter in the prompt adds a newline, ctrl+Enter starts
 * from anywhere. A refusal stays here, under Start; a missing add-dir is marked on its row.
 */
export function LaunchPane() {
  const projectLabel = useLaunchStore((s) => s.projectLabel);
  const form = useLaunchStore((s) => s.form);
  const starting = useLaunchStore((s) => s.starting);
  const error = useLaunchStore((s) => s.error);
  const missingDirs = useLaunchStore((s) => s.missingDirs);
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
  const errors = formErrors(form);
  const blocked = startBlockedReason(form, missingDirs, starting);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (launchKeyAction(event.nativeEvent, launchKeyTarget(event.target)) !== "start") return;
    event.preventDefault();
    void startLaunch();
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
          Starts <code className="path">claude</code> in {projectLabel} in a terminal. Enter starts; ctrl+Enter starts from the prompt.
        </p>
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

      <section className="pane-section" aria-label="Extra folders">
        <h3 className="pane-heading">Add-dirs</h3>
        {form.addDirs.length === 0 ? (
          <p className="muted">None: the session sees the project folder only.</p>
        ) : (
          <ul className="launch-dirs">
            {form.addDirs.map((dir, index) => {
              const missing = missingDirs.includes(dir);
              const errorId = `launch-dir-error-${index}`;
              return (
                <li key={dir} className="launch-dir">
                  <span className="launch-dir-path" title={dir} aria-describedby={missing ? errorId : undefined}>
                    {shortenPath(dir, 44)}
                  </span>
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
        <div className="actions">
          <button type="button" className="btn" onClick={() => void pickAddDir()} disabled={starting}>
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
            onClick={() => void startLaunch()}
            disabled={blocked !== null}
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
