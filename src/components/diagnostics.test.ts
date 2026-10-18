import { describe, expect, it } from "vitest";
import { diagnosticsError, diagnosticsRows } from "./diagnostics";

const base = { endpoint: null, endpoint_error: null, hook_events: 0, refused: 0, session_mismatches: 0, poll_overrides: 0 };

describe("diagnosticsRows", () => {
  it("shows the endpoint and the four counters", () => {
    const rows = diagnosticsRows({ ...base, endpoint: "127.0.0.1:4242", hook_events: 12, refused: 1, session_mismatches: 2, poll_overrides: 3 });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["hooks endpoint", "127.0.0.1:4242"],
      ["hook events received", "12"],
      ["refused requests", "1"],
      ["session-id mismatches", "2"],
      ["poll overrides", "3"],
    ]);
    expect(rows.some((r) => r.attention)).toBe(false);
  });

  it("names the bind error, or says the endpoint has not started", () => {
    const failed = diagnosticsRows({ ...base, endpoint_error: "address in use" })[0]!;
    expect(failed).toEqual({ label: "hooks endpoint", value: "unavailable: address in use", attention: true });
    expect(diagnosticsRows(base)[0]!.value).toBe("not started");
  });
});

describe("diagnosticsError", () => {
  it("says the last read failed next to stale counters, and is the bare error before any", () => {
    expect(diagnosticsError(null, true)).toBeNull();
    expect(diagnosticsError("ipc down", true)).toBe("last read failed: ipc down");
    expect(diagnosticsError("ipc down", false)).toBe("ipc down");
  });
});
