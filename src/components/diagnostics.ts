import type { DiagnosticsSnapshot } from "../ipc";

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
 * bind error, or `not started`), then the four counters.
 */
export function diagnosticsRows(d: DiagnosticsSnapshot): DiagnosticsRow[] {
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
  ];
}
