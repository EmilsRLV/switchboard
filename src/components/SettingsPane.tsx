import { useEffect, useRef, useState } from "react";
import { runCommand } from "../commands/registry";
import { diagnosticsGet, hasTauriRuntime, type Binary, type DiagnosticsSnapshot } from "../ipc";
import { DIAGNOSTICS_REFRESH_MS, diagnosticsError, diagnosticsRows } from "./diagnostics";
import { usePaletteStore } from "../state/palette";
import { useSettingsStore } from "../state/settings";

/**
 * Read-only settings pane (`ctrl+,`; Esc closes). Shows where the file is, what was detected
 * and the effective settings as a tree. The JSON file is the editing surface, so the only
 * actions here are "Reveal file" and "Re-detect", and both are registry commands: the buttons
 * run the same `settings.reveal` / `binaries.redetect` the palette offers.
 */
export function SettingsPane() {
  const snapshot = useSettingsStore((s) => s.snapshot);
  const loadError = useSettingsStore((s) => s.loadError);
  const error = useSettingsStore((s) => s.actionError);
  const busy = useSettingsStore((s) => s.actionBusy);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Take focus so Esc and Tab work inside the pane; give it back when the pane goes. Not when
  // the palette opened us (`ctrl+,` from inside it): its input keeps the focus.
  useEffect(() => {
    const previous = document.activeElement;
    if (!usePaletteStore.getState().isOpen) closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <aside className="pane" aria-label="Settings">
      <header className="pane-header">
        <h2 className="pane-title">Settings</h2>
        <button
          ref={closeRef}
          type="button"
          className="btn"
          onClick={() => runCommand("pane.close")}
          title="Close (Esc)"
        >
          Close
        </button>
      </header>

      {snapshot === null ? (
        <p className="muted">
          {!hasTauriRuntime()
            ? "no Tauri runtime"
            : (loadError ?? "waiting for the settings snapshot…")}
        </p>
      ) : (
        <>
          <section className="pane-section">
            <h3 className="pane-heading">File</h3>
            <code className="path">{snapshot.path ?? "no config directory on this platform"}</code>
            <div className="actions">
              <button
                type="button"
                className="btn"
                onClick={() => runCommand("settings.reveal")}
                disabled={snapshot.path === null}
              >
                Reveal file
              </button>
            </div>
            <p className="muted">
              Edit the file to change settings; it reloads live. Missing keys take their defaults,
              unknown keys are ignored.
            </p>
          </section>

          <section className="pane-section">
            <h3 className="pane-heading">Binaries</h3>
            <BinaryRow binary={snapshot.binaries.claude} />
            <BinaryRow binary={snapshot.binaries.git} />
            <div className="actions">
              <button type="button" className="btn" onClick={() => runCommand("binaries.redetect")} disabled={busy}>
                {busy ? "Detecting…" : "Re-detect"}
              </button>
            </div>
          </section>

          <section className="pane-section">
            <h3 className="pane-heading">Effective settings</h3>
            <Tree value={snapshot.settings} />
          </section>

          <Diagnostics />
        </>
      )}

      {snapshot !== null && loadError !== null && <p className="pane-error">{loadError}</p>}
      {error !== null && <p className="pane-error">{error}</p>}
    </aside>
  );
}

/**
 * Settings → Diagnostics (Story 4.3): the hooks endpoint and its counters, read through
 * `diagnostics_get` on open and every 2 s while the pane is open.
 */
function Diagnostics() {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let live = true;
    const read = () => {
      diagnosticsGet().then(
        (next) => {
          if (!live) return;
          setDiagnostics(next);
          setError(null);
        },
        (err: unknown) => {
          if (live) setError(String(err));
        },
      );
    };
    read();
    const timer = setInterval(read, DIAGNOSTICS_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  // A failed read shows even after earlier successes (the counters below are then stale).
  const failure = diagnosticsError(error, diagnostics !== null);
  return (
    <section className="pane-section" aria-label="Diagnostics">
      <h3 className="pane-heading">Diagnostics</h3>
      {diagnostics !== null && failure !== null && (
        <p className="pane-error" role="alert">
          {failure}
        </p>
      )}
      {diagnostics === null ? (
        <p className="muted">{failure ?? (hasTauriRuntime() ? "reading…" : "no Tauri runtime")}</p>
      ) : (
        <dl className="diagnostics">
          {diagnosticsRows(diagnostics).map((row) => (
            <div key={row.label} className="diagnostics-row">
              <dt className="diagnostics-label">{row.label}</dt>
              <dd className={row.attention ? "diagnostics-value attention" : "diagnostics-value"}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function BinaryRow({ binary }: { binary: Binary }) {
  return (
    <div className="binary">
      <span className="binary-name">{binary.name}</span>
      <span className="binary-detail">
        {binary.status === "pending" && <span className="muted">detecting…</span>}
        {binary.status === "missing" && <span className="attention">not found</span>}
        {binary.status === "configured_missing" && (
          <>
            <code className="path">{binary.path}</code>
            <span className="attention"> (configured, does not exist)</span>
          </>
        )}
        {(binary.status === "found" || binary.status === "version_failed") && (
          <>
            <code className="path">{binary.path}</code>
            <span className={binary.version === null ? "attention" : "muted"}>
              {" "}
              {binary.version ?? "version unknown"}
            </span>
            {binary.configured && <span className="muted"> · from settings</span>}
          </>
        )}
      </span>
    </div>
  );
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A read-only tree of a JSON value: objects nest, leaves render in monospace. */
function Tree({ value }: { value: Json }) {
  if (value === null || typeof value !== "object") {
    return <code className="leaf">{formatLeaf(value)}</code>;
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value);
  return (
    <ul className="tree">
      {entries.map(([key, child]) => (
        <li key={key} className="tree-row">
          <span className="tree-key">{key}</span>
          <Tree value={child} />
        </li>
      ))}
    </ul>
  );
}

function formatLeaf(value: string | number | boolean | null): string {
  return value === null ? "null" : typeof value === "string" ? JSON.stringify(value) : String(value);
}
