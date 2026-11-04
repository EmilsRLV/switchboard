import { useEffect, useRef, useState } from "react";
import { commandHint } from "../commands/keybindings";
import { runCommand } from "../commands/registry";
import { diagnosticsGet, hasTauriRuntime, perfGet, type Binary, type DiagnosticsSnapshot, type PerfSnapshot } from "../ipc";
import { DIAGNOSTICS_REFRESH_MS, diagnosticsError, diagnosticsRows, keybindingsDiagnostics, mcpRefusalLines, perfRows } from "./diagnostics";
import { typingSink } from "../perf";
import { useKeybindingsStore } from "../state/keybindings";
import { usePaletteStore } from "../state/palette";
import { useReviewStore } from "../state/review";
import { useSettingsStore } from "../state/settings";
import { useWorkspaceStore } from "../state/workspace";

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
  const agentActions = useWorkspaceStore((s) => s.snapshot?.workspace.agentActions ?? "ask");

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
          title={commandHint("pane.close", "Close")}
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
                title={commandHint("settings.reveal")}
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
              <button type="button" className="btn" title={commandHint("binaries.redetect")} onClick={() => runCommand("binaries.redetect")} disabled={busy}>
                {busy ? "Detecting…" : "Re-detect"}
              </button>
            </div>
          </section>

          <section className="pane-section" aria-label="Agent actions">
            <h3 className="pane-heading">Agent actions</h3>
            {/* Story 7.2: the workspace's policy for the agents' act tools (palette: "Agent actions: …"). */}
            <p className="muted">
              {agentActions === "allowAll"
                ? "Allow all: sessions start, link and unlink without asking (a notice says what ran). \"Agent actions: ask\" turns it off."
                : "Ask: each start, link or unlink waits for your Allow or Deny. \"Agent actions: allow all\" skips asking."}
            </p>
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
 * `diagnostics_get` on open and every 2 s while the pane is open; below them (Story 7.1) the last
 * refused `/mcp` requests, when there are any; Story 8.1 adds `last diff render: N ms`; Story 9.4
 * the Keybindings list (`keybindings.json`'s status, its errors and the conflicts it made); Story 9.3
 * the Performance rows (`startup`, `typing`; Story 9.6 `memory target`), read through `perf_get`
 * on the same timer.
 */
function Diagnostics() {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);
  const lastDiffRenderMs = useReviewStore((s) => s.lastRenderMs);
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
      // This window's typing samples go first, so the numbers include the keys just typed.
      typingSink.flush();
      perfGet().then(
        (next) => {
          if (live) setPerf(next);
        },
        // The hooks read reports failures; a perf read failing only leaves the rows as they were.
        () => {},
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
          {diagnosticsRows(diagnostics, lastDiffRenderMs).map((row) => (
            <div key={row.label} className="diagnostics-row">
              <dt className="diagnostics-label">{row.label}</dt>
              <dd className={row.attention ? "diagnostics-value attention" : "diagnostics-value"}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {diagnostics !== null && diagnostics.mcp_refusals.length > 0 && (
        <>
          <h4 className="diagnostics-caption" id="mcp-refusals-caption">
            Recent MCP refusals
          </h4>
          <ul className="diagnostics-refusals" aria-labelledby="mcp-refusals-caption">
            {mcpRefusalLines(diagnostics.mcp_refusals).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </>
      )}
      <h4 className="diagnostics-caption" id="perf-caption">
        Performance
      </h4>
      <dl className="diagnostics" aria-labelledby="perf-caption">
        {perfRows(perf).map((row) => (
          <div key={row.label} className="diagnostics-row">
            <dt className="diagnostics-label">{row.label}</dt>
            <dd className={row.attention ? "diagnostics-value attention" : "diagnostics-value"}>{row.value}</dd>
          </div>
        ))}
      </dl>
      <KeybindingsDiagnostics />
    </section>
  );
}

/** Story 9.4: `keybindings.json: none | ok | n errors[, n conflicts]`, then each error, warning and conflict. */
function KeybindingsDiagnostics() {
  const status = useKeybindingsStore((s) => s.status);
  const errors = useKeybindingsStore((s) => s.errors);
  const warnings = useKeybindingsStore((s) => s.warnings);
  const conflicts = useKeybindingsStore((s) => s.conflicts);
  const { row, lines } = keybindingsDiagnostics({ status, errors, warnings, conflicts });
  return (
    <>
      <h4 className="diagnostics-caption" id="keybindings-caption">
        Keybindings
      </h4>
      <dl className="diagnostics" aria-labelledby="keybindings-caption">
        <div className="diagnostics-row">
          <dt className="diagnostics-label">{row.label}</dt>
          <dd className={row.attention ? "diagnostics-value attention" : "diagnostics-value"}>{row.value}</dd>
        </div>
      </dl>
      {lines.length > 0 && (
        <ul className="diagnostics-refusals" aria-label="Keybinding errors and conflicts">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </>
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
