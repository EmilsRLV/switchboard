import { describe, expect, it } from "vitest";
import { windowMode } from "./windowMode";

describe("windowMode (Story 4.5)", () => {
  it("is the app unless the URL names a terminal", () => {
    expect(windowMode("")).toEqual({ kind: "main" });
    expect(windowMode("?other=1")).toEqual({ kind: "main" });
    expect(windowMode("?terminal=")).toEqual({ kind: "main" });
    expect(windowMode("?terminal=%20")).toEqual({ kind: "main" });
  });

  it("decodes the terminal id Rust put in the URL", () => {
    expect(windowMode("?terminal=plain-ide")).toEqual({ kind: "terminal", id: "plain-ide" });
    expect(windowMode("?terminal=session%3A3f2a-9c")).toEqual({ kind: "terminal", id: "session:3f2a-9c" });
    expect(windowMode("terminal=plain-a&x=1")).toEqual({ kind: "terminal", id: "plain-a" });
  });
});
