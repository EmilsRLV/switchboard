import type { DiagnosticsSnapshot, McpRefusal, PerfSnapshot } from "../ipc";
import { keybindingsStatusText, type KeybindingsReport } from "../state/keybindings";

/** How often Settings → Diagnostics re-reads `diagnostics_get` while the pane is open. */
export const DIAGNOSTICS_REFRESH_MS = 2_000;

/** One row of Settings → Diagnostics: a label and its value; `attention` for an endpoint error. */
export type DiagnosticsRow = { label: string; value: string; attention: boolean };

/**
 * The line shown when the latest `diagnostics_get` failed: next to the last counters read (they
 * are then stale), or alone before any read succeeded. `null` when the latest read worked.
 */
export function diagnosticsError(error: string | null, hasCounters: boolean): string | null {
  if (error === null) return null;
  return hasCounters ? `last read failed: ${error}` : error;
}

/**
 * The Diagnostics section's rows (Story 4.3): the hooks endpoint (`127.0.0.1:<port>`, the
 * bind error, or `not started`), then the four counters, then (Story 7.1) the `/mcp` refusals and,
 * when given (Story 8.1), the last diff's render time.
 */
export function diagnosticsRows(d: DiagnosticsSnapshot, lastDiffRenderMs?: number | null): DiagnosticsRow[] {
  const endpoint =
    d.endpoint !== null
      ? { value: d.endpoint, attention: false }
      : d.endpoint_error !== null
        ? { value: `unavailable: ${d.endpoint_error}`, attention: true }
        : { value: "not started", attention: false };
  return [
    { label: "hooks endpoint", ...endpoint },
    { label: "hook events received", value: String(d.hook_events), attention: false },
    { label: "refused requests", value: String(d.refused), attention: false },
    { label: "session-id mismatches", value: String(d.session_mismatches), attention: false },
    { label: "poll overrides", value: String(d.poll_overrides), attention: false },
    { label: "MCP refused requests", value: String(d.mcp_refused), attention: false },
    // Story 8.1: how long the Review pane's last diff took to render after its text arrived (the
    // UI's own measure, kept in the review store).
    ...(lastDiffRenderMs === undefined ? [] : [{ label: "last diff render", value: renderTimeText(lastDiffRenderMs), attention: false }]),
  ];
}

/** The `last diff render` value: `N ms`, or `none yet` before any diff was shown. */
export function renderTimeText(ms: number | null): string {
  return ms === null ? "none yet" : `${Math.round(ms)} ms`;
}

/**
 * Story 9.3: the measuring points' rows: `startup` (process start → the first canvas frame, `N ms`)
 * and `typing` (keydown → echo drawn over the last 100 keystrokes: `median N ms · p95 M ms`, or
 * `not enough samples` below 5). Before the first `perf_get` read: both `reading…`.
 */
export function perfRows(perf: PerfSnapshot | null): DiagnosticsRow[] {
  if (perf === null) {
    return [
      { label: "startup", value: "reading…", attention: false },
      { label: "typing", value: "reading…", attention: false },
    ];
  }
  return [
    { label: "startup", value: perf.startup_ms === null ? "not measured yet" : `${Math.round(perf.startup_ms)} ms`, attention: false },
    { label: "typing", value: typingText(perf), attention: false },
  ];
}

/** The `typing` value: `median N ms · p95 M ms`, or `not enough samples` (fewer than 5). */
export function typingText(perf: PerfSnapshot): string {
  const { median_ms: median, p95_ms: p95 } = perf.typing;
  if (median === null || p95 === null) return "not enough samples";
  return `median ${latencyMs(median)} ms · p95 ${latencyMs(p95)} ms`;
}

/** A latency to one decimal (`7.4`), so values near the 16 ms budget stay readable. */
function latencyMs(ms: number): string {
  return (Math.round(ms * 10) / 10).toFixed(1);
}

/**
 * Story 9.4: the Keybindings part of Diagnostics: the `keybindings.json` row (`none`, `ok` or
 * `n errors`, then `, n conflicts`; in attention while there are errors or conflicts) and one line
 * per error, then per warning, then per conflict (`ctrl+k: palette.toggle, review.refresh`).
 */
export function keybindingsDiagnostics(state: KeybindingsReport): { row: DiagnosticsRow; lines: string[] } {
  return {
    row: {
      label: "keybindings.json",
      value: keybindingsStatusText(state.status, state.errors.length, state.conflicts.length),
      attention: state.errors.length > 0 || state.conflicts.length > 0,
    },
    // Unique, so each can be its own React key.
    lines: [...new Set([...state.errors, ...state.warnings, ...state.conflicts])],
  };
}

/** A time of day as the refusal list shows it (local time, `HH:MM:SS`). */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/**
 * The last `/mcp` refusals (Story 7.1), newest first, one line each:
 * `<time> <path> — <reason>`. Never any part of a token (Rust does not keep one).
 */
export function mcpRefusalLines(refusals: McpRefusal[], time: (ms: number) => string = clockTime): string[] {
  return refusals.map((r) => `${time(r.at)} ${r.path} — ${r.reason}`);
}
