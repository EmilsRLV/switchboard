// The xterm theme, read from the CSS tokens at runtime (Story 4.1): the surface, text, cursor
// and selection use the app's tokens; the 16 ANSI colours are `--ansi-0`…`--ansi-15` in
// `theme/tokens.css`. Terminal content is not chrome, so the accent rule does not apply inside
// the terminal (docs/DESIGN.md).

import type { ITheme } from "@xterm/xterm";

/** The ANSI colour names xterm's theme uses, in palette order (`--ansi-0` … `--ansi-15`). */
export const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** Reads one CSS custom property (`"--fg"`) as its computed, trimmed value. */
export type TokenReader = (name: string) => string;

/**
 * The xterm theme from the tokens: background `--bg-raised` (the pane surface), foreground
 * and cursor `--fg`, the cursor's text `--bg-raised`, selection `--selection` with `--bg`
 * text, and the ANSI palette. A token that reads empty is left out (xterm's default).
 */
export function buildTheme(read: TokenReader): ITheme {
  const theme: Record<string, string> = {};
  const put = (key: string, token: string) => {
    const value = read(token).trim();
    if (value !== "") theme[key] = value;
  };
  put("background", "--bg-raised");
  put("foreground", "--fg");
  put("cursor", "--fg");
  put("cursorAccent", "--bg-raised");
  put("selectionBackground", "--selection");
  put("selectionForeground", "--bg");
  ANSI_NAMES.forEach((name, i) => put(name, `--ansi-${i}`));
  return theme as ITheme;
}

/** The terminal font: the mono family and `--text-md` (13 px) from the tokens. */
export function buildFont(read: TokenReader): { fontFamily: string | undefined; fontSize: number | undefined } {
  const family = read("--font-mono").trim();
  const size = Number.parseFloat(read("--text-md"));
  return {
    fontFamily: family === "" ? undefined : family,
    fontSize: Number.isFinite(size) && size > 0 ? size : undefined,
  };
}

/** A {@link TokenReader} over the document's computed root style. */
export function documentTokens(): TokenReader {
  const style = getComputedStyle(document.documentElement);
  return (name) => style.getPropertyValue(name);
}
