// The diff view of the Review pane (Story 8.1): CodeMirror 6 with `@codemirror/merge`, read-only.
// Side by side (`MergeView`) or unified (`unifiedMergeView`), with word-level highlighting and the
// unchanged stretches collapsed to 3 lines of context. The diff runs line by line first
// (`lineDiff.ts`), so a large file with spread-out edits keeps one chunk per hunk. Syntax
// highlighting comes from the language pack of the file's extension, loaded on demand
// (`languages.ts`); until it arrives the text is plain and the view is reconfigured in place. Colours are tokens (`--diff-*` for the diff,
// the terminal's `--ansi-*` for syntax: diff content, like terminal content; never the accent).
// This module and CodeMirror are loaded lazily with the pane.
//
// Every line of the view carries its place: the content element names the file and side
// (`data-file`, `data-side`), each drawn line its number (`data-line`), so 8.3 (`o` to open in the
// editor) and 8.4 (line comments) can find the file and line under the cursor.

import { useEffect, useRef, useState } from "react";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { MergeView, getChunks, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, lineNumbers, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { loadLanguage, loadedLanguage } from "./languages";
import { DIFF_CONFIG } from "./lineDiff";
import { languageFor, type DiffLayout } from "./model";

/** Lines of context kept around each change; shorter unchanged stretches are not collapsed. */
export const COLLAPSE = { margin: 3, minSize: 4 } as const;

/** The view's chrome and diff colours, from the tokens. */
const diffTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--bg-raised)",
      color: "var(--fg)",
      fontSize: "var(--text-md)",
    },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.5" },
    ".cm-content": { caretColor: "transparent" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-raised)",
      color: "var(--fg-faint)",
      borderRight: "var(--line) solid var(--border)",
    },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
    "&.cm-focused": { outline: "none" },
    "& .cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--selection)" },
    // Inserted lines and words (side b, and the unified view's lines).
    ".cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "var(--diff-add-bg)" },
    ".cm-changedText": { background: "var(--diff-add-word)" },
    // Deleted lines and words (side a, and the unified view's deleted chunks).
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "var(--diff-del-bg)" },
    "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": { background: "var(--diff-del-word)" },
    "&.cm-merge-b .cm-deletedText": { background: "var(--diff-del-word)" },
    ".cm-insertedLine, .cm-deletedLine, .cm-deletedLine del": { textDecoration: "none" },
    ".cm-changeGutter": { width: "2px", paddingLeft: "0" },
    ".cm-changedLineGutter": { background: "var(--diff-add-word)" },
    "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": { background: "var(--diff-del-word)" },
    ".cm-collapsedLines": {
      background: "var(--bg-hover)",
      color: "var(--fg-muted)",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-xs)",
      padding: "0.15rem 0.5rem",
    },
  },
  { dark: true },
);

/** Syntax colours: the terminal palette (diff content, not chrome). */
export const diffHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: "var(--ansi-5)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--ansi-2)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--ansi-3)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--ansi-8)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--ansi-6)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--ansi-4)" },
  { tag: [t.tagName, t.invalid], color: "var(--ansi-1)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--ansi-11)" },
  { tag: [t.heading], color: "var(--ansi-4)", fontWeight: "500" },
  { tag: [t.link, t.url], color: "var(--ansi-6)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "500" },
  { tag: [t.meta, t.processingInstruction, t.punctuation, t.bracket], color: "var(--fg-muted)" },
]);

function lineMarks(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      builder.add(line.from, line.from, Decoration.line({ attributes: { "data-line": String(line.number) } }));
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** Each drawn line names its number; the content element names the file and the side. */
export function placeAttributes(path: string, side: "old" | "new"): Extension {
  return [
    EditorView.contentAttributes.of({ "data-file": path, "data-side": side }),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = lineMarks(view);
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.viewportChanged) this.decorations = lineMarks(update.view);
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
  ];
}

/**
 * The unified view's deleted lines carry their place too: each `.cm-deletedLine` of a deleted
 * chunk gets `data-side="old"`, `data-file` and its line number in the old text (`data-line`). The
 * chunks' DOM is drawn by `@codemirror/merge`, so it is tagged after each draw.
 */
export function deletedLinePlaces(path: string): Extension {
  const tag = (view: EditorView) => {
    const result = getChunks(view.state);
    if (result === null) return;
    const original = getOriginalDoc(view.state);
    for (const chunkDom of Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-deletedChunk"))) {
      let pos: number;
      try {
        pos = view.posAtDOM(chunkDom);
      } catch {
        continue;
      }
      const chunk = result.chunks.find((c) => c.fromB === pos);
      if (chunk === undefined || chunk.fromA >= chunk.toA) continue;
      const first = original.lineAt(Math.min(chunk.fromA, original.length)).number;
      chunkDom.querySelectorAll<HTMLElement>(".cm-deletedLine").forEach((line, i) => {
        line.dataset.side = "old";
        line.dataset.file = path;
        line.dataset.line = String(first + i);
      });
    }
  };
  return ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        view.requestMeasure({ read: () => null, write: () => tag(view) });
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.geometryChanged) {
          update.view.requestMeasure({ read: () => null, write: () => tag(update.view) });
        }
      }
    },
  );
}

export type DiffViewProps = {
  path: string;
  /** The old side's text (`""` when it does not exist). */
  oldText: string;
  /** The new side's text (`""` when it does not exist). */
  newText: string;
  layout: DiffLayout;
  /** `performance.now()` when the text arrived: the render time is measured from it. */
  arrivedAt: number;
  /** Called once per view with the time from arrival to the first frame drawn, in ms. */
  onRendered: (ms: number) => void;
};

/** The merge view of one file; rebuilt when the file, its text or the layout changes. */
export default function DiffView({ path, oldText, newText, layout, arrivedAt, onRendered }: DiffViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const rendered = useRef(onRendered);
  // The arrival a render time was last measured from: a rebuild of the same text (the layout
  // toggle) is measured from its own start instead.
  const arrival = useRef(arrivedAt);
  const measured = useRef<number | null>(null);
  arrival.current = arrivedAt;
  const [error, setError] = useState<string | null>(null);
  rendered.current = onRendered;

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const fresh = measured.current !== arrival.current;
    const started = fresh ? arrival.current : performance.now();
    measured.current = arrival.current;
    const kind = languageFor(path);
    const language = new Compartment();
    const ready = kind === null ? [] : (loadedLanguage(kind) ?? []);
    const common = (side: "old" | "new"): Extension => [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      lineNumbers(),
      language.of(ready),
      syntaxHighlighting(diffHighlight),
      diffTheme,
      placeAttributes(path, side),
    ];
    let views: EditorView[];
    let destroy: () => void;
    // A failure inside CodeMirror is this diff's, never the app's: say so in the pane.
    try {
      if (layout === "split") {
        const merge = new MergeView({
          a: { doc: oldText, extensions: common("old") },
          b: { doc: newText, extensions: common("new") },
          parent,
          highlightChanges: true,
          gutter: true,
          collapseUnchanged: COLLAPSE,
          diffConfig: DIFF_CONFIG,
        });
        views = [merge.a, merge.b];
        destroy = () => merge.destroy();
      } else {
        const view = new EditorView({
          parent,
          state: EditorState.create({
            doc: newText,
            extensions: [
              common("new"),
              unifiedMergeView({ original: oldText, highlightChanges: true, gutter: true, mergeControls: false, collapseUnchanged: COLLAPSE, diffConfig: DIFF_CONFIG }),
              deletedLinePlaces(path),
            ],
          }),
        });
        views = [view];
        destroy = () => view.destroy();
      }
    } catch (err) {
      parent.replaceChildren();
      setError(describeError(err));
      return;
    }
    setError(null);
    const frame = requestAnimationFrame(() => rendered.current(performance.now() - started));
    let live = true;
    if (kind !== null && loadedLanguage(kind) === null) {
      loadLanguage(kind).then(
        (ext) => {
          if (!live) return;
          try {
            for (const view of views) view.dispatch({ effects: language.reconfigure(ext) });
          } catch (err) {
            console.warn(`language pack ${kind} could not be applied: ${describeError(err)}`);
          }
        },
        (err: unknown) => console.warn(`language pack ${kind} failed to load: ${describeError(err)}`),
      );
    }
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      destroy();
    };
  }, [path, oldText, newText, layout]);

  return (
    <>
      {error !== null && (
        <p className="pane-error review-note" role="alert">
          {diffErrorText(error)}
        </p>
      )}
      <div className={`review-diff review-diff-${layout}`} ref={host} data-file={path} hidden={error !== null} />
    </>
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The line a diff that could not be shown leaves in the pane. */
export function diffErrorText(message: string): string {
  return `could not show this diff: ${message}`;
}
