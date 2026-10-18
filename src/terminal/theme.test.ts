import { describe, expect, it } from "vitest";
import { ANSI_NAMES, buildFont, buildTheme } from "./theme";

const TOKENS: Record<string, string> = {
  "--bg": "#0f1115",
  "--bg-raised": " #161920",
  "--fg": "#d7dae0",
  "--selection": "#8b919c",
  "--font-mono": " ui-monospace, monospace",
  "--text-md": "13px",
  ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`--ansi-${i}`, `#0000${i.toString(16).padStart(2, "0")}`])),
};

const read = (name: string) => TOKENS[name] ?? "";

describe("buildTheme", () => {
  it("maps the surface, text, cursor and selection to the app's tokens", () => {
    const theme = buildTheme(read);
    expect(theme.background).toBe("#161920");
    expect(theme.foreground).toBe("#d7dae0");
    expect(theme.cursor).toBe("#d7dae0");
    expect(theme.cursorAccent).toBe("#161920");
    expect(theme.selectionBackground).toBe("#8b919c");
    expect(theme.selectionForeground).toBe("#0f1115");
  });

  it("maps --ansi-0 … --ansi-15 to the sixteen palette colours in order", () => {
    const theme = buildTheme(read) as Record<string, string>;
    expect(ANSI_NAMES).toHaveLength(16);
    ANSI_NAMES.forEach((name, i) => expect(theme[name], name).toBe(`#0000${i.toString(16).padStart(2, "0")}`));
    expect(theme.black).toBe("#000000");
    expect(theme.brightWhite).toBe("#00000f");
  });

  it("leaves out a token that reads empty (xterm keeps its default)", () => {
    const theme = buildTheme(() => "");
    expect(theme).toEqual({});
  });
});

describe("buildFont", () => {
  it("uses the mono family and --text-md", () => {
    expect(buildFont(read)).toEqual({ fontFamily: "ui-monospace, monospace", fontSize: 13 });
    expect(buildFont(() => "")).toEqual({ fontFamily: undefined, fontSize: undefined });
  });
});
