import { useEffect, useRef, useState } from "react";
import { binariesRedetect, hasTauriRuntime, settingsReveal, type Binary } from "../ipc";
import { useSettingsStore } from "../state/settings";

/**
 * Read-only settings pane (`ctrl+,`; Esc closes). Shows where the file is, what was detected
 * and the effective settings as a tree. The JSON file is the editing surface, so the only
 * actions here are "Reveal file" and "Re-detect".
 */
export function SettingsPane() {
  const snapshot = useSettingsStore((s) => s.snapshot);
  const loadError = useSettingsStore((s) => s.loadError);
  const closePane = useSettingsStore((s) => s.closePane);
  const applySnapshot = useSettingsStore((s) => s.applySnapshot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Take focus so Esc and Tab work inside the pane; give it back when the pane goes.
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const reveal = () => {
    setError(null);
    settingsReveal().catch((err: unknown) => setError(describe(err)));
  };

  const redetect = () => {
    setError(null);
    setBusy(true);
    binariesRedetect()
      .then(applySnapshot)
      .catch((err: unknown) => setError(describe(err)))
      .finally(() => setBusy(false));
  };

  return (
    <aside className="pane" aria-label="Settings">
      <header className="pane-header">
        <h2 className="pane-title">Settings</h2>
        <button ref={closeRef} type="button" className="btn" onClick={closePane} title="Close (Esc)">
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
              <button type="button" className="btn" onClick={reveal} disabled={snapshot.path === null}>
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
              <button type="button" className="btn" onClick={redetect} disabled={busy}>
                {busy ? "Detecting…" : "Re-detect"}
              </button>
            </div>
          </section>

          <section className="pane-section">
            <h3 className="pane-heading">Effective settings</h3>
            <Tree value={snapshot.settings} />
          </section>
        </>
      )}

      {snapshot !== null && loadError !== null && <p className="pane-error">{loadError}</p>}
      {error !== null && <p className="pane-error">{error}</p>}
    </aside>
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
