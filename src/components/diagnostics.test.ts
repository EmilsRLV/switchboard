import { describe, expect, it } from "vitest";
import { clockTime, diagnosticsError, diagnosticsRows, mcpRefusalLines, memoryLevelText, perfRows, typingText } from "./diagnostics";
import type { DiagnosticsSnapshot, MemoryLevel, PerfSnapshot } from "../ipc";

const base: DiagnosticsSnapshot = {
  endpoint: null,
  endpoint_error: null,
  hook_events: 0,
  refused: 0,
  session_mismatches: 0,
  poll_overrides: 0,
  mcp_refused: 0,
  mcp_refusals: [],
};

describe("diagnosticsRows", () => {
  it("shows the endpoint, the four counters and the MCP refusals", () => {
    const rows = diagnosticsRows({ ...base, endpoint: "127.0.0.1:4242", hook_events: 12, refused: 1, session_mismatches: 2, poll_overrides: 3, mcp_refused: 4 });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["hooks endpoint", "127.0.0.1:4242"],
      ["hook events received", "12"],
      ["refused requests", "1"],
      ["session-id mismatches", "2"],
      ["poll overrides", "3"],
      ["MCP refused requests", "4"],
    ]);
    expect(rows.some((r) => r.attention)).toBe(false);
  });

  it("names the bind error, or says the endpoint has not started", () => {
    const failed = diagnosticsRows({ ...base, endpoint_error: "address in use" })[0]!;
    expect(failed).toEqual({ label: "hooks endpoint", value: "unavailable: address in use", attention: true });
    expect(diagnosticsRows(base)[0]!.value).toBe("not started");
  });
});

describe("mcpRefusalLines", () => {
  it("lists each refusal as time, path and reason, in the order given (newest first)", () => {
    const refusals = [
      { at: 2_000, path: "/mcp", reason: "unknown token" },
      { at: 1_000, path: "/mcp", reason: "missing token" },
    ];
    expect(mcpRefusalLines(refusals, (ms) => `t${ms}`)).toEqual(["t2000 /mcp — unknown token", "t1000 /mcp — missing token"]);
    expect(mcpRefusalLines([])).toEqual([]);
  });

  it("shows local wall-clock time as HH:MM:SS", () => {
    const at = new Date(2026, 9, 24, 9, 5, 7).getTime();
    expect(clockTime(at)).toBe("09:05:07");
    expect(mcpRefusalLines([{ at, path: "/mcp", reason: "missing token" }])).toEqual(["09:05:07 /mcp — missing token"]);
  });
});

describe("diagnosticsError", () => {
  it("says the last read failed next to stale counters, and is the bare error before any", () => {
    expect(diagnosticsError(null, true)).toBeNull();
    expect(diagnosticsError("ipc down", true)).toBe("last read failed: ipc down");
    expect(diagnosticsError("ipc down", false)).toBe("ipc down");
  });
});

describe("perfRows (Story 9.3)", () => {
  const perf = (
    startup: number | null,
    samples: number,
    median: number | null,
    p95: number | null,
    memory: MemoryLevel = "normal",
  ): PerfSnapshot => ({
    startup_ms: startup,
    typing: { samples, median_ms: median, p95_ms: p95 },
    memory_level: memory,
  });

  it("shows the startup ms and the typing median and p95", () => {
    expect(perfRows(perf(734, 50, 6.04, 11.96))).toEqual([
      { label: "startup", value: "734 ms", attention: false },
      { label: "typing", value: "median 6.0 ms · p95 12.0 ms", attention: false },
      { label: "memory target", value: "normal", attention: false },
    ]);
  });

  it("shows the memory target level (Story 9.6)", () => {
    expect(perfRows(perf(734, 50, 6, 12, "low"))[2]).toEqual({ label: "memory target", value: "low", attention: false });
    expect(perfRows(perf(734, 50, 6, 12, "unsupported"))[2]?.value).toBe("not supported");
    expect(memoryLevelText("normal")).toBe("normal");
    expect(memoryLevelText("low")).toBe("low");
    expect(memoryLevelText("unsupported")).toBe("not supported");
  });

  it("says when there is nothing to show yet", () => {
    expect(perfRows(null).map((r) => r.value)).toEqual(["reading…", "reading…", "reading…"]);
    expect(perfRows(perf(null, 4, null, null)).map((r) => r.value)).toEqual(["not measured yet", "not enough samples", "normal"]);
    expect(typingText(perf(900, 0, null, null))).toBe("not enough samples");
  });
});
