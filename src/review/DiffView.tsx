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
//
// Story 8.3: while a view is mounted it tells `o` its line (`place.ts`): the line at the cursor the
// operator last placed (a click in the text, or a selection change; an old-side line, or a deleted
// line of the unified view until the cursor moves, mapped to the
// nearest new line through the chunks), else the first visible line of the new side. `SourceView`
// is the Files mode's single read-only view of one file, on the same setup.

import { useEffect, useRef, useState } from "react";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { MergeView, getChunks, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, RangeSetBuilder, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, lineNumbers, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { loadLanguage, loadedLanguage } from "./languages";
import { DIFF_CONFIG } from "./lineDiff";
import { editorLine, languageFor, type CursorPlace, type DiffLayout, type LineChunk } from "./model";
import { setLineProvider } from "./place";

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

/** A merge chunk (document positions) as line numbers: 1-based, `to` exclusive. */
export function lineChunk(chunk: { fromA: number; toA: number; fromB: number; toB: number }, docA: Text, docB: Text): LineChunk {
  const span = (doc: Text, from: number, to: number): [number, number] => {
    const start = doc.lineAt(Math.min(from, doc.length)).number;
    return [start, to > from ? doc.lineAt(Math.min(to - 1, doc.length)).number + 1 : start];
  };
  const [fromA, toA] = span(docA, chunk.fromA, chunk.toA);
  const [fromB, toB] = span(docB, chunk.fromB, chunk.toB);
  return { fromA, toA, fromB, toB };
}

/** The first line of `view` visible inside `host` (the scrolling may be the view's or the merge view's). */
function firstVisibleLine(view: EditorView, host: HTMLElement): number {
  const top = Math.max(view.scrollDOM.getBoundingClientRect().top, host.getBoundingClientRect().top);
  const block = view.lineBlockAtHeight(Math.max(0, top - view.documentTop));
  return view.state.doc.lineAt(Math.min(block.from, view.state.doc.length)).number;
}

/** Where the operator last put a view's cursor, for `o` (Story 8.3). */
class CursorTracker {
  private place: { view: EditorView; side: "old" | "new"; deletedOld: number | null } | null = null;
  /** A pointer went down on a deleted line: the selection change it causes keeps that line. */
  private onDeleted = false;

  /** The extension a view of `side` carries: a selection change the operator makes puts the place there. */
  extension(side: "old" | "new"): Extension {
    return EditorView.updateListener.of((update) => {
      if (!update.selectionSet || !update.transactions.some((tr) => tr.isUserEvent("select"))) return;
      const pointer = update.transactions.some((tr) => tr.isUserEvent("select.pointer"));
      const keep = pointer && this.onDeleted;
      this.onDeleted = false;
      if (!keep) this.place = { view: update.view, side, deletedOld: null };
    });
  }

  /** Pointer downs inside a view's text (never its gutters or scrollbars); a deleted line keeps its old number. Returns the remover. */
  listen(host: HTMLElement, views: readonly { view: EditorView; side: "old" | "new" }[]): () => void {
    const down = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target === null) return;
      const hit = views.find((v) => v.view.contentDOM.contains(target));
      if (hit === undefined) return;
      const deleted = target.closest<HTMLElement>(".cm-deletedLine[data-line]");
      const oldLine = deleted === null ? NaN : Number(deleted.dataset.line);
      if (Number.isFinite(oldLine)) {
        this.place = { view: hit.view, side: "old", deletedOld: oldLine };
        this.onDeleted = true;
      } else {
        this.place = { view: hit.view, side: hit.side, deletedOld: null };
        this.onDeleted = false;
      }
    };
    host.addEventListener("pointerdown", down, true);
    return () => host.removeEventListener("pointerdown", down, true);
  }

  /** The place as a side and that side's line, or `null` before any. */
  cursor(): CursorPlace | null {
    if (this.place === null) return null;
    const { view, side, deletedOld } = this.place;
    return deletedOld !== null ? { side: "old", line: deletedOld } : { side, line: view.state.doc.lineAt(view.state.selection.main.head).number };
  }
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
    const tracker = new CursorTracker();
    const common = (side: "old" | "new"): Extension => [
      tracker.extension(side),
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
    // The new side's view and the chunks as lines, for `o`.
    let newView: EditorView;
    let sides: { view: EditorView; side: "old" | "new" }[];
    let lineChunks: () => LineChunk[];
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
        newView = merge.b;
        sides = [
          { view: merge.a, side: "old" },
          { view: merge.b, side: "new" },
        ];
        lineChunks = () => merge.chunks.map((c) => lineChunk(c, merge.a.state.doc, merge.b.state.doc));
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
        newView = view;
        sides = [{ view, side: "new" }];
        lineChunks = () => (getChunks(view.state)?.chunks ?? []).map((c) => lineChunk(c, getOriginalDoc(view.state), view.state.doc));
      }
    } catch (err) {
      parent.replaceChildren();
      setError(describeError(err));
      return;
    }
    setError(null);
    const frame = requestAnimationFrame(() => rendered.current(performance.now() - started));
    let live = true;
    const untrack = tracker.listen(parent, sides);
    const unregister = setLineProvider(() => editorLine(tracker.cursor(), () => firstVisibleLine(newView, parent), lineChunks, newView.state.doc.lines));
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
      untrack();
      unregister();
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

export type SourceViewProps = {
  path: string;
  text: string;
};

/**
 * Files mode (Story 8.3): one file, read-only, with line numbers and its language pack, on the
 * diff's setup (theme, syntax colours, places). `o` opens the line at its cursor, else its first
 * visible line.
 */
export function SourceView({ path, text }: SourceViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const kind = languageFor(path);
    const language = new Compartment();
    let view: EditorView;
    const tracker = new CursorTracker();
    try {
      view = new EditorView({
        parent,
        state: EditorState.create({
          doc: text,
          extensions: [
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            lineNumbers(),
            language.of(kind === null ? [] : (loadedLanguage(kind) ?? [])),
            syntaxHighlighting(diffHighlight),
            diffTheme,
            placeAttributes(path, "new"),
            tracker.extension("new"),
          ],
        }),
      });
    } catch (err) {
      parent.replaceChildren();
      setError(describeError(err));
      return;
    }
    setError(null);
    let live = true;
    const untrack = tracker.listen(parent, [{ view, side: "new" }]);
    const unregister = setLineProvider(() => editorLine(tracker.cursor(), () => firstVisibleLine(view, parent), () => [], view.state.doc.lines));
    if (kind !== null && loadedLanguage(kind) === null) {
      loadLanguage(kind).then(
        (ext) => {
          if (!live) return;
          try {
            view.dispatch({ effects: language.reconfigure(ext) });
          } catch (err) {
            console.warn(`language pack ${kind} could not be applied: ${describeError(err)}`);
          }
        },
        (err: unknown) => console.warn(`language pack ${kind} failed to load: ${describeError(err)}`),
      );
    }
    return () => {
      live = false;
      untrack();
      unregister();
      view.destroy();
    };
  }, [path, text]);

  return (
    <>
      {error !== null && (
        <p className="pane-error review-note" role="alert">
          could not show this file: {error}
        </p>
      )}
      <div className="review-diff review-source" ref={host} data-file={path} hidden={error !== null} />
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
