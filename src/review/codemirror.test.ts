// The CodeMirror stack the diff view runs on (Story 8.1), without a DOM: one copy of each package
// (a second @lezer/common or @codemirror/* copy breaks `instanceof` and NodeProp identity: no syntax
// colours, and a language pack that throws when a view is built with it), the language packs
// highlighting through the view's style, and the unified view's state built with a pack loaded.

import { describe, expect, it } from "vitest";
import { ensureSyntaxTree } from "@codemirror/language";
import { unifiedMergeView, getChunks } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { syntaxHighlighting } from "@codemirror/language";
import { COLLAPSE, diffErrorText, diffHighlight } from "./DiffView";
import { DIFF_CONFIG } from "./lineDiff";
import { loadLanguage } from "./languages";
import { ErrorBoundary } from "../components/ErrorBoundary";

/** The slice of `node:fs` the check reads with (the project has no Node typings). */
type Fs = { readdirSync(path: URL): string[]; existsSync(path: URL): boolean };
// A non-literal specifier keeps `tsc` from looking for Node's typings; vitest runs in Node.
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;
const ROOT = new URL("../../node_modules/", import.meta.url);

describe("one copy of each CodeMirror and Lezer package", () => {
  it("has no nested @codemirror or @lezer copies under node_modules", () => {
    const nested: string[] = [];
    for (const scope of ["@codemirror", "@lezer"]) {
      for (const pkg of fs.readdirSync(new URL(`${scope}/`, ROOT))) {
        for (const inner of ["@codemirror", "@lezer"]) {
          const dir = new URL(`${scope}/${pkg}/node_modules/${inner}/`, ROOT);
          if (fs.existsSync(dir)) for (const dup of fs.readdirSync(dir)) nested.push(`${scope}/${pkg} -> ${inner}/${dup}`);
        }
      }
    }
    expect(nested).toEqual([]);
  });
});

function classesOf(state: EditorState, text: string): Set<string> {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  expect(tree).not.toBeNull();
  const found = new Set<string>();
  highlightTree(tree!, diffHighlight, (from, to, cls) => {
    found.add(`${text.slice(from, to)}=${cls}`);
  });
  return found;
}

describe("syntax colours", () => {
  const old = 'export const v7 = 7;\nconst line37 = "value 37";\n';
  const next = 'export const v7 = 8;\nconst line37 = "value 38";\n';

  it("a TypeScript file is highlighted by the view's style, in the unified view too", async () => {
    const ts = await loadLanguage("typescript");
    const state = EditorState.create({
      doc: next,
      extensions: [
        ts,
        syntaxHighlighting(diffHighlight),
        unifiedMergeView({ original: old, mergeControls: false, collapseUnchanged: COLLAPSE, diffConfig: DIFF_CONFIG }),
      ],
    });
    const found = classesOf(state, next);
    const keyword = [...found].find((f) => f.startsWith("export="));
    const string = [...found].find((f) => f.startsWith('"value 38"='));
    const number = [...found].find((f) => f.startsWith("8="));
    expect(keyword, [...found].join(" ")).toBeDefined();
    expect(string).toBeDefined();
    expect(number).toBeDefined();
    // Three different colours.
    expect(new Set([keyword, string, number].map((f) => f!.split("=")[1])).size).toBe(3);
    expect(getChunks(state)?.chunks).toHaveLength(1);
  });

  it("every pack loads and parses", async () => {
    for (const kind of ["javascript", "jsx", "tsx", "rust", "python", "json", "css", "html", "markdown", "yaml"] as const) {
      const ext = await loadLanguage(kind);
      const state = EditorState.create({ doc: "x", extensions: [ext] });
      expect(ensureSyntaxTree(state, 1, 1000), kind).not.toBeNull();
    }
  });
});

describe("a failing diff", () => {
  it("is one error line, never the app", () => {
    expect(diffErrorText("boom")).toBe("could not show this diff: boom");
    expect(ErrorBoundary.getDerivedStateFromError(new Error("bad range"))).toEqual({ message: "bad range" });
    // The next file or layout clears it.
    expect(ErrorBoundary.getDerivedStateFromProps({ label: "diff view", fallback: () => null, resetKey: "b", children: null }, { message: "x", key: "a" })).toEqual({
      message: null,
      key: "b",
    });
  });
});
