// The command audit (Story 9.4): everything the UI can do, the palette can do. Every `onClick`,
// `onChange`, `onSubmit`, `onKeyDown`, `onDoubleClick` and `onContextMenu` handler (their
// `…Capture` forms too) in the app's components (`src/components`, `src/canvas`, and
// `src/terminal` for the terminal pane) must be exactly one command call -- `() =>
// runCommand(...)` (or `runCommandAsync`) -- or name a local function that runs exactly one
// command, or be on the allow-list below with the reason it is exempt. A new direct handler fails
// this test: make its action a command, or allow-list it with a reason.
//
// Exempt are item-level controls (they act on one specific row or item, not on the pane's
// current subject), form fields (typing a value is not an action) and pointer gestures. Each
// reason names the palette route where one makes sense. The sources are read from disk with
// `node:fs` (vitest's node environment), as the design lint does.

import { describe, expect, it } from "vitest";
import { registerBuiltins } from "./builtins";
import { REVIEW_FILTER_COMMANDS, REVIEW_LAYOUT_COMMANDS, REVIEW_MODE_COMMANDS } from "./review";
import { clearCommands, getCommand } from "./registry";
import { handlersIn, runsCommand, type Handler } from "./sourceScan";

type Exemption = {
  /** `/src/<path>`, forward slashes. */
  file: string;
  /** The handler's expression exactly, whitespace collapsed to single spaces. */
  handler: string;
  /** Why it is not a command, and the palette route where there is one. */
  reason: string;
};

const ITEM = "item-level: acts on one specific row or item";
const FIELD = "form field: typing or picking a value is not an action";
const NAV = "keyboard navigation inside the surface itself (moves, runs the selected row's command, traps Tab)";

const POPOUT = "a pop-out window's header: that window has no command registry, so it acts on its own terminal";

/** Every direct handler the audit accepts, with its reason. */
const ALLOW_LIST: readonly Exemption[] = [
  // -- toasts: the buttons of one specific toast; the palette answers the oldest ---------------
  { file: "/src/components/ApprovalToasts.tsx", handler: '() => void answerRequest(request.id, "allow")', reason: `${ITEM} (this toast's request); palette: approval.allow (oldest)` },
  { file: "/src/components/ApprovalToasts.tsx", handler: '() => void answerRequest(request.id, "deny")', reason: `${ITEM} (this toast's request); palette: approval.deny (oldest)` },
  { file: "/src/components/ApprovalToasts.tsx", handler: '() => void answerRequest(request.id, "always")', reason: `${ITEM} (this toast's request); palette: approval.always (oldest)` },
  { file: "/src/components/ReviewToasts.tsx", handler: "() => void openReview(request.sessionId, request.seq)", reason: `${ITEM} (this toast's request); palette: review.open (selected, else newest)` },
  { file: "/src/components/ReviewToasts.tsx", handler: "() => dismissReviewToast(request.sessionId, request.seq)", reason: `${ITEM} (this toast); palette: review.dismissToast (oldest)` },
  // -- the palette and the context menu: their rows run commands themselves --------------------
  { file: "/src/components/Palette.tsx", handler: "(event) => setQuery(event.target.value)", reason: `${FIELD} (the palette's filter)` },
  { file: "/src/components/Palette.tsx", handler: "() => runRow(index)", reason: "a palette row: runPaletteRow runs that row's command (or the pick)" },
  { file: "/src/components/Palette.tsx", handler: "onKeyDown", reason: `${NAV}: the palette's input` },
  { file: "/src/components/ContextMenu.tsx", handler: "() => run(index)", reason: "a menu row: runs that row's command through runCommand" },
  { file: "/src/components/ContextMenu.tsx", handler: "onKeyDown", reason: `${NAV}: the context menu` },
  { file: "/src/components/ContextMenu.tsx", handler: "(event) => event.preventDefault()", reason: "suppresses the webview's own menu over the menu; no action" },
  // -- edge inspector --------------------------------------------------------------------------
  { file: "/src/components/EdgePane.tsx", handler: "() => void retryEdge(edge.id, side.sessionId)", reason: `${ITEM} (one side of a cooperate edge); palette: edge.retry (every failed side)` },
  { file: "/src/components/EdgePane.tsx", handler: "(e) => setDraft(e.target.value)", reason: `${FIELD} (the label; saved on Enter or blur)` },
  { file: "/src/components/EdgePane.tsx", handler: "onKeyDown", reason: `${FIELD} (Enter saves the label)` },
  // -- Elsewhere tray: the tray has no selected row ----------------------------------------------
  { file: "/src/components/ElsewhereTray.tsx", handler: "() => void addElsewhereFolder(row.cwd)", reason: `${ITEM} (this row's folder; the tray has no selection)` },
  // -- import pane -------------------------------------------------------------------------------
  { file: "/src/components/ImportPane.tsx", handler: "() => toggle(project.cwd)", reason: `${ITEM} (ticks one folder); palette: import.addSelected adds the ticked ones` },
  // -- launch sheet --------------------------------------------------------------------------------
  { file: "/src/components/LaunchPane.tsx", handler: "(e) => edit({ name: e.target.value })", reason: FIELD },
  { file: "/src/components/LaunchPane.tsx", handler: "(e) => edit({ model: e.target.value })", reason: FIELD },
  { file: "/src/components/LaunchPane.tsx", handler: "(e) => edit({ customModel: e.target.value })", reason: FIELD },
  { file: "/src/components/LaunchPane.tsx", handler: "(e) => edit({ effort: e.target.value })", reason: FIELD },
  { file: "/src/components/LaunchPane.tsx", handler: "(e) => edit({ permissionMode: e.target.value })", reason: FIELD },
  { file: "/src/components/LaunchPane.tsx", handler: "(e) => edit({ useWorktree: e.target.checked })", reason: FIELD },
  { file: "/src/components/LaunchPane.tsx", handler: "(e) => edit({ worktreeName: e.target.value })", reason: FIELD },
  { file: "/src/components/LaunchPane.tsx", handler: "(e) => edit({ prompt: e.target.value })", reason: FIELD },
  { file: "/src/components/LaunchPane.tsx", handler: "(e) => edit({ background: e.target.checked })", reason: FIELD },
  { file: "/src/components/LaunchPane.tsx", handler: "() => removeAddDir(index)", reason: `${ITEM} (removes one add-dir row)` },
  // -- worktree sheets -----------------------------------------------------------------------------
  { file: "/src/components/WorktreePane.tsx", handler: "(e) => void editWorktree({ branch: e.target.value })", reason: FIELD },
  { file: "/src/components/WorktreePane.tsx", handler: "(e) => void editWorktree({ name: e.target.value })", reason: FIELD },
  { file: "/src/components/WorktreePane.tsx", handler: "(e) => void editWorktree({ base: e.target.value })", reason: FIELD },
  { file: "/src/components/RemoveWorktreePane.tsx", handler: "(e) => useRemoveWorktreeStore.getState().setDeleteBranch(e.target.checked)", reason: `${FIELD} (the "Also delete branch" box)` },
  { file: "/src/components/RemoveWorktreePane.tsx", handler: "onKeyDown", reason: "swallows Enter on a removing button so it never removes; no action" },
  // -- Review pane ---------------------------------------------------------------------------------
  { file: "/src/components/ReviewPane.tsx", handler: "(e) => useReviewStore.getState().setBase(baseForChoice(e.target.value, bases?.defaultBase ?? null))", reason: `${FIELD} (the base <select>)` },
  { file: "/src/components/ReviewPane.tsx", handler: "onChange", reason: `${FIELD} (the comment box; ctrl+Enter sends, Esc cancels)` },
  { file: "/src/components/ReviewPane.tsx", handler: "onKeyDown", reason: `${FIELD} (the comment box's own ctrl+Enter / Esc)` },
  { file: "/src/components/ReviewPane.tsx", handler: "() => select(file.path)", reason: `${ITEM} (a file row); palette: review.nextFile / review.prevFile` },
  { file: "/src/components/ReviewPane.tsx", handler: "() => select(row.key)", reason: `${ITEM} (a requested-file row); palette: review.nextFile / review.prevFile` },
  { file: "/src/components/ReviewPane.tsx", handler: "() => useReviewStore.getState().selectCommit(row.sha)", reason: `${ITEM} (a commit row)` },
  { file: "/src/components/ReviewPane.tsx", handler: "() => (dir ? useReviewStore.getState().toggleFolder(row.path) : select(row.path))", reason: `${ITEM} (a tree row: opens a folder or shows a file)` },
  // -- Help pane (Story 10.1): which page is a choice among a dynamic set --------------------------
  { file: "/src/components/HelpPane.tsx", handler: "() => showHelpPage(p.id)", reason: `${ITEM} (a Contents row: that page); palette: help.page (Help: open page…)` },
  { file: "/src/components/HelpPane.tsx", handler: "() => showHelpPage(target.page, target.anchor)", reason: `${ITEM} (a page link: that page and heading); palette: help.page (Help: open page…)` },
  { file: "/src/components/HelpPane.tsx", handler: "() => void openWebLink(target.url)", reason: `${ITEM} (a web link: that URL, http(s) only, in the system browser)` },
  // -- canvas --------------------------------------------------------------------------------------
  { file: "/src/canvas/Canvas.tsx", handler: "() => clickEdge(edgeId)", reason: "pointer gesture on the canvas (an edge's label selects it); palette: edge.select / edge.inspect" },
  { file: "/src/canvas/Canvas.tsx", handler: "suppress", reason: "pointer gesture: suppresses the webview's own menu (the node menu opens on right-press)" },
  {
    file: "/src/canvas/ChildNode.tsx",
    handler: '(event) => { // The button\'s own key: never also the canvas\'s Enter (or a palette key). if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }',
    reason: "keeps the review flag's own Enter / Space from reaching the canvas; no action",
  },
  {
    file: "/src/canvas/ChildNode.tsx",
    handler: "(event) => { event.stopPropagation(); void openReview(child.id); }",
    reason: `${ITEM} (this card's review flag); palette: review.open (selected, else newest)`,
  },
  // -- node toolbar (Story 11.2) -------------------------------------------------------------------
  { file: "/src/canvas/NodeToolbar.tsx", handler: "openMenu", reason: "opens a menu at its own position, not a command (the toolbar's ⋯; a right-click on the card opens the same menu)" },
  // -- terminal ------------------------------------------------------------------------------------
  { file: "/src/terminal/TerminalPane.tsx", handler: "() => activateTab(id)", reason: `${ITEM} (a tab); palette: terminal.nextTab / terminal.prevTab` },
  { file: "/src/terminal/TerminalPane.tsx", handler: "() => void closeTerminalTab(id)", reason: `${ITEM} (a tab's x)` },
  { file: "/src/terminal/TerminalPane.tsx", handler: "() => void returnToPane(id)", reason: `${POPOUT}; the pane's placeholder runs terminal.returnToPane` },
  { file: "/src/terminal/TerminalPane.tsx", handler: "() => void restartTerminal(id)", reason: `${POPOUT}; the pane runs terminal.restart` },
  { file: "/src/terminal/TerminalPane.tsx", handler: "() => void closeTerminal(id)", reason: `${POPOUT}; the pane runs terminal.close` },
  { file: "/src/terminal/TerminalPane.tsx", handler: "() => void killTerminal(id)", reason: `${POPOUT}; the pane runs terminal.kill` },
];

/** The handlers that neither run a command nor are allow-listed. */
export function directHandlers(sources: Record<string, string>, allowList: readonly Exemption[]): Handler[] {
  const out: Handler[] = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const h of handlersIn(file, source)) {
      if (runsCommand(h.handler, source)) continue;
      if (allowList.some((e) => e.file === file && e.handler === h.handler)) continue;
      out.push(h);
    }
  }
  return out;
}

/** The slice of `node:fs` the audit reads with (the project has no Node typings). */
type Fs = {
  readdirSync(path: URL, options: { recursive: true }): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
};
// A non-literal specifier keeps `tsc` from looking for Node's typings; vitest runs in Node.
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;
const SRC = new URL("../", import.meta.url);
const AUDITED = ["components/", "canvas/", "terminal/"];

/** Every audited `.tsx` file (tests aside), keyed `/src/<path>` with forward slashes. */
function auditedSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(SRC, { recursive: true })) {
    const path = entry.replace(/\\/g, "/");
    if (!path.endsWith(".tsx") || path.endsWith(".test.tsx") || !AUDITED.some((dir) => path.startsWith(dir))) continue;
    out[`/src/${path}`] = fs.readFileSync(new URL(path, SRC), "utf8");
  }
  return out;
}

const sources = auditedSources();

describe("command audit", () => {
  it("reads the components it guards", () => {
    for (const file of ["/src/components/LaunchPane.tsx", "/src/components/ReviewPane.tsx", "/src/canvas/ProjectNode.tsx", "/src/terminal/TerminalPane.tsx"]) {
      expect(Object.keys(sources), file).toContain(file);
    }
    expect(Object.values(sources).flatMap((s) => handlersIn("", s)).length).toBeGreaterThan(50);
  });

  it("every onClick / onChange / onSubmit runs a registered command or is allow-listed with a reason", () => {
    const found = directHandlers(sources, ALLOW_LIST).map((h) => `${h.file}:${h.line} ${h.handler}`);
    expect(found, "make the action a command (runCommand) or allow-list it with a reason").toEqual([]);
  });

  it("every allow-list entry still matches a handler and gives a reason", () => {
    const stale = ALLOW_LIST.filter((e) => {
      const source = sources[e.file];
      return source === undefined || !handlersIn(e.file, source).some((h) => h.handler === e.handler);
    });
    expect(stale.map((e) => `${e.file} ${e.handler}`)).toEqual([]);
    for (const e of ALLOW_LIST) expect(e.reason.trim(), e.handler).not.toBe("");
  });

  it("every command id a handler names is registered", () => {
    clearCommands();
    registerBuiltins();
    const ids = new Set<string>();
    for (const source of Object.values(sources)) {
      for (const match of source.matchAll(/\brunCommand(?:Async)?\("([^"]+)"\)/g)) ids.add(match[1]!);
    }
    expect(ids.size).toBeGreaterThan(20);
    expect([...ids].filter((id) => getCommand(id) === undefined)).toEqual([]);
    // The Review pane's maps: each value registered, and named after its key.
    const maps = [
      ["mode", REVIEW_MODE_COMMANDS],
      ["filter", REVIEW_FILTER_COMMANDS],
      ["layout", REVIEW_LAYOUT_COMMANDS],
    ] as const;
    for (const [kind, map] of maps) {
      for (const [key, id] of Object.entries(map)) {
        expect(id, `${kind} ${key}`).toBe(`review.${kind}${key[0]!.toUpperCase()}${key.slice(1)}`);
        expect(getCommand(id), id).toBeDefined();
      }
    }
    clearCommands();
  });

  it("a new direct handler fails; one that runs a command, or calls a local function that does, passes", () => {
    const planted = {
      "/src/components/Planted.tsx": [
        "const go = () => { runCommand(\"pane.close\"); };",
        "<button onClick={doThing}>x</button>",
        "<button onClick={() => runCommand(\"pane.close\")}>y</button>",
        "<button onClick={go}>z</button>",
        "<input onChange={(e) => setValue(e.target.value)} />",
        "<form onSubmit={() => void submit()} />",
        "<div onKeyDownCapture = {() => runCommand(\"a\") && other()} />",
        "<div onDoubleClick={() => (x ? runCommand(\"a\") : doThing())} />",
        "<div onContextMenu={() => { doThing(); runCommand(\"a\"); }} />",
        "<div onClick={() => runCommand(`a${\"}\"}`)} />",
        "const two = () => { runCommand(\"a\"); runCommand(\"b\"); };",
        "<div onClick={two} />",
      ].join("\n"),
    };
    expect(directHandlers(planted, []).map((h) => [h.line, h.handler])).toEqual([
      [2, "doThing"],
      [5, "(e) => setValue(e.target.value)"],
      [6, "() => void submit()"],
      [7, '() => runCommand("a") && other()'],
      [8, '() => (x ? runCommand("a") : doThing())'],
      [9, '() => { doThing(); runCommand("a"); }'],
      [12, "two"],
    ]);
    const allowed = [{ file: "/src/components/Planted.tsx", handler: "doThing", reason: "test" }];
    expect(directHandlers(planted, allowed).map((h) => h.line)).toEqual([5, 6, 7, 8, 9, 12]);
  });
});
