// The tooltip scan (Story 11.1): every element in the app's chrome (`src/components`, `src/canvas`)
// whose `onClick` runs a command (by the command audit's rule, `runsCommand`) takes its `title`
// from `commandHint(...)`, so the tooltip is the command's title (or a label) and its effective key,
// and follows `keybindings.json`. A `title="…"` literal, or a `title={…}` expression with no
// `commandHint` in it, fails this test, and so does no `title` at all, unless it is on the
// allow-list below with the reason it keeps its own words (or has none).
//
// The sources are read from disk with `node:fs` (vitest's node environment), as the audit does.

import { describe, expect, it } from "vitest";
import { registerBuiltins } from "./builtins";
import { clearCommands, getCommand, listCommands } from "./registry";
import { runsCommand } from "./sourceScan";

type TitleExemption = {
  /** `/src/<path>`, forward slashes. */
  file: string;
  /** The `title` value exactly as written (`"…"` or `{…}`), whitespace collapsed; {@link NO_TITLE} when it has none. */
  title: string;
  /** Why it keeps its own words. */
  reason: string;
  /**
   * The element's `onClick` runs no command (the stale check then looks at every clicked
   * element's title, not only the command buttons'): the node toolbar's `⋯`, Story 11.2.
   */
  anyClick?: boolean;
};

const DESCRIBES = "describes what this one button does to this edge, in more words than the command's title";

/** The command buttons whose tooltip is not `commandHint`'s, with their reasons. */
const ALLOW_LIST: readonly TitleExemption[] = [
  { file: "/src/components/EdgePane.tsx", title: '"The next agent action across this edge asks again"', reason: `${DESCRIBES} (Revoke)` },
  { file: "/src/components/EdgePane.tsx", title: '"Inject /add-dir again"', reason: `${DESCRIBES} (Retry)` },
  { file: "/src/components/EdgePane.tsx", title: '"Stop the session and resume it with --add-dir"', reason: `${DESCRIBES} (Restart with flags)` },
  { file: "/src/canvas/NodeToolbar.tsx", title: '"Menu · right-click"', reason: "opens a menu at its own position, not a command (the node toolbar's ⋯)", anyClick: true },
];

/** What {@link commandTitlesIn} reports for a command-running element without a `title`. */
const NO_TITLE = "(none)";

/** A command-running element's `title` as found: where, and its value as written ({@link NO_TITLE} when absent). */
type Title = { file: string; line: number; title: string };

/** The index just past the string or template literal starting at `i`, or `i` when none starts there. */
function skipString(source: string, i: number): number {
  const ch = source[i];
  if (ch !== '"' && ch !== "'" && ch !== "`") return i;
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === "\\") j++;
    else if (source[j] === ch) return j + 1;
  }
  return source.length;
}

/** The index just past the `{…}` starting at `open`, skipping strings and template literals. */
function pastBraces(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const skipped = skipString(source, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i + 1;
  }
  return source.length;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A JSX opening tag's start: `<button`, `<Handle`, `<div` (a generic like `useState<T>(` has no attributes). */
const TAG_START = /<([A-Za-z][\w.]*)(?=[\s/>])/g;
const ATTRIBUTE_NAME = /^[A-Za-z_][\w:.-]*/;

/** The attributes of the opening tag whose name ends at `from`: name → value as written (`true` when bare). */
function attributesAt(source: string, from: number): Map<string, string | true> {
  const out = new Map<string, string | true>();
  let i = from;
  while (i < source.length) {
    while (/\s/.test(source[i] ?? "")) i++;
    const ch = source[i];
    if (ch === undefined || ch === ">" || (ch === "/" && source[i + 1] === ">")) break;
    if (ch === "{") {
      i = pastBraces(source, i); // a spread
      continue;
    }
    const name = ATTRIBUTE_NAME.exec(source.slice(i, i + 64));
    if (name === null) {
      i++;
      continue;
    }
    i += name[0].length;
    let j = i;
    while (/\s/.test(source[j] ?? "")) j++;
    if (source[j] !== "=") {
      out.set(name[0], true);
      continue;
    }
    j++;
    while (/\s/.test(source[j] ?? "")) j++;
    const end = source[j] === "{" ? pastBraces(source, j) : skipString(source, j);
    out.set(name[0], collapse(source.slice(j, end)));
    i = Math.max(end, j + 1);
  }
  return out;
}

/** The handler expression inside an attribute value `{…}`. */
function inner(value: string): string {
  return collapse(value.startsWith("{") ? value.slice(1, -1) : value);
}

/**
 * Every `title` of an element whose `onClick` runs a command, in `source`; with `anyClick`, of
 * every element with an `onClick`.
 */
export function commandTitlesIn(file: string, source: string, { anyClick = false }: { anyClick?: boolean } = {}): Title[] {
  const out: Title[] = [];
  for (const match of source.matchAll(TAG_START)) {
    const attributes = attributesAt(source, (match.index ?? 0) + match[0].length);
    const onClick = attributes.get("onClick");
    const title = attributes.get("title");
    if (typeof onClick !== "string" || title === true) continue;
    if (!anyClick && !runsCommand(inner(onClick), source)) continue;
    out.push({ file, line: source.slice(0, match.index).split("\n").length, title: title ?? NO_TITLE });
  }
  return out;
}

/** True when the title is built by `commandHint`. */
function isHint(title: string): boolean {
  return title.startsWith("{") && /\bcommandHint\(/.test(title);
}

/** The command titles that are neither `commandHint` nor allow-listed. */
export function ownWordTitles(sources: Record<string, string>, allowList: readonly TitleExemption[]): Title[] {
  const out: Title[] = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const t of commandTitlesIn(file, source)) {
      if (isHint(t.title)) continue;
      if (allowList.some((e) => e.file === file && e.title === t.title)) continue;
      out.push(t);
    }
  }
  return out;
}

/** The slice of `node:fs` the scan reads with (the project has no Node typings). */
type Fs = {
  readdirSync(path: URL, options: { recursive: true }): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
};
// A non-literal specifier keeps `tsc` from looking for Node's typings; vitest runs in Node.
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;
const SRC = new URL("../", import.meta.url);
const SCANNED = ["components/", "canvas/"];

/** Every scanned `.tsx` file (tests aside), keyed `/src/<path>` with forward slashes. */
function scannedSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(SRC, { recursive: true })) {
    const path = entry.replace(/\\/g, "/");
    if (!path.endsWith(".tsx") || path.endsWith(".test.tsx") || !SCANNED.some((dir) => path.startsWith(dir))) continue;
    out[`/src/${path}`] = fs.readFileSync(new URL(path, SRC), "utf8");
  }
  return out;
}

const sources = scannedSources();

describe("command tooltips (Story 11.1)", () => {
  it("reads the chrome it guards and finds the command buttons' titles", () => {
    for (const file of ["/src/components/ReviewPane.tsx", "/src/components/EdgePane.tsx", "/src/canvas/ProjectNode.tsx"]) {
      expect(Object.keys(sources), file).toContain(file);
    }
    const found = Object.entries(sources).flatMap(([file, source]) => commandTitlesIn(file, source));
    expect(found.length).toBeGreaterThan(15);
  });

  it("every element whose onClick runs a command takes its title from commandHint, or is allow-listed", () => {
    const found = ownWordTitles(sources, ALLOW_LIST).map((t) => `${t.file}:${t.line} title=${t.title}`);
    expect(found, "use title={commandHint(id)} (or commandHint(id, label)), or allow-list it with a reason").toEqual([]);
  });

  it("every allow-list entry still matches a command button's title and gives a reason", () => {
    const stale = ALLOW_LIST.filter((e) => {
      const source = sources[e.file];
      return source === undefined || !commandTitlesIn(e.file, source, { anyClick: e.anyClick === true }).some((t) => t.title === e.title);
    });
    expect(stale.map((e) => `${e.file} ${e.title}`)).toEqual([]);
    for (const e of ALLOW_LIST) expect(e.reason.trim(), e.title).not.toBe("");
  });

  it("a literal, a hint-less expression or no title fails; commandHint or a non-command button passes", () => {
    const planted = {
      "/src/components/Planted.tsx": [
        "const go = () => { runCommand(\"pane.close\"); };",
        '<button onClick={() => runCommand("a")} title="Close (Esc)">a</button>',
        '<button onClick={() => runCommand("a")} title={"Close"}>b</button>',
        "<button onClick={() => runCommand(\"a\")} title={`Close ${x}`}>c</button>",
        '<button title={commandHint("pane.close", "Close")} onClick={() => runCommand("pane.close")}>d</button>',
        '<button onClick={() => runCommand("a")}>e</button>',
        '<button onClick={() => doThing()} title="Something">f</button>',
        '<button\n  type="button"\n  onClick={go}\n  title="Go"\n>g</button>',
        '<button onClick={go} title={busy ?? commandHint("a")}>h</button>',
      ].join("\n"),
    };
    expect(ownWordTitles(planted, []).map((t) => [t.line, t.title])).toEqual([
      [2, '"Close (Esc)"'],
      [3, '{"Close"}'],
      [4, "{`Close ${x}`}"],
      [6, NO_TITLE],
      [8, '"Go"'],
    ]);
    const allowed = [{ file: "/src/components/Planted.tsx", title: '"Go"', reason: "test" }];
    expect(ownWordTitles(planted, allowed).map((t) => t.line)).toEqual([2, 3, 4, 6]);
  });

  it("every commandHint id in the chrome and every builtin keyFrom names a registered command", () => {
    clearCommands();
    registerBuiltins();
    const ids = new Set<string>();
    for (const source of Object.values(sources)) {
      for (const match of source.matchAll(/\bcommandHint\(\s*"([^"]+)"/g)) ids.add(match[1]!);
    }
    expect(ids.size).toBeGreaterThan(10);
    expect([...ids].filter((id) => getCommand(id) === undefined)).toEqual([]);
    const keyFroms = listCommands().filter((c) => c.keyFrom !== undefined);
    expect(keyFroms.map((c) => c.id).sort()).toEqual(["help.open", "settings.open"]);
    expect(keyFroms.filter((c) => getCommand(c.keyFrom!) === undefined).map((c) => `${c.id} → ${c.keyFrom}`)).toEqual([]);
    clearCommands();
  });
});
