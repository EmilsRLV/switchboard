// Story 8.3: Files mode's tree rows, the folders' open state, and the line `o` opens on an old or a
// deleted line; the view's line provider.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { getChunks, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import type { DirEntry, DirListing } from "../ipc";
import { editorLine, filesOrder, filesRows, foldersToRead, moreEntriesText, oldToNewLine, toggleFolder, type FolderState } from "./model";
import { currentLine, setLineProvider } from "./place";
import { lineChunk } from "./DiffView";
import { DIFF_CONFIG } from "./lineDiff";

const entry = (path: string, kind: DirEntry["kind"], ignored = false): DirEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  kind,
  ignored,
  unreadableName: false,
});
const listing = (path: string, entries: DirEntry[], more = 0): FolderState => ({
  listing: { root: "/w/api", path, entries, more } satisfies DirListing,
  error: null,
});

describe("the Files tree", () => {
  const folders: Record<string, FolderState> = {
    "": listing("", [entry("node_modules", "dir", true), entry("src", "dir"), entry(".env", "file"), entry("link", "link")]),
    src: listing("src", [entry("src/auth", "dir"), entry("src/a.ts", "file")], 3),
    "src/auth": { listing: null, error: null },
  };

  it("lists the root, then each open folder's entries under it, one level deeper", () => {
    const rows = filesRows(folders, new Set(["src", "src/auth"]));
    expect(rows.map((r) => [r.kind, r.key, r.depth])).toEqual([
      ["entry", "entry:node_modules", 0],
      ["entry", "entry:src", 0],
      ["entry", "entry:src/auth", 1],
      ["loading", "loading:src/auth", 2],
      ["entry", "entry:src/a.ts", 1],
      ["more", "more:src", 1],
      ["entry", "entry:.env", 0],
      ["entry", "entry:link", 0],
    ]);
    const nodeModules = rows[0]!;
    expect(nodeModules.kind === "entry" && nodeModules.ignored && !nodeModules.open).toBe(true);
    expect(rows[1]!.kind === "entry" && rows[1]!.open).toBe(true);
    expect(moreEntriesText(3)).toBe("3 more not shown");
    // `j` / `k` step through the files and links, never the folders.
    expect(filesOrder(rows)).toEqual(["src/a.ts", ".env", "link"]);
  });

  it("an open folder that could not be read is an error row; the root not read yet is a loading row", () => {
    const rows = filesRows({ ...folders, src: { listing: null, error: "permission denied" } }, new Set(["src"]));
    expect(rows[2]).toEqual({ kind: "error", key: "error:src", depth: 1, message: "permission denied" });
    expect(filesRows({}, new Set())).toEqual([{ kind: "loading", key: "loading:", depth: 0 }]);
  });

  it("reads the root and each open folder once; a refresh reads them all again; a closed one is forgotten", () => {
    const read: FolderState = listing("", []);
    // First open: the root.
    expect(foldersToRead({}, new Set(), false)).toEqual({ kept: { "": { listing: null, error: null } }, toRead: [""] });
    // A folder opens: only it is read; the root is kept as it is.
    const opened = foldersToRead({ "": read }, new Set(["src"]), false);
    expect(opened.toRead).toEqual(["src"]);
    expect(opened.kept).toEqual({ "": read, src: { listing: null, error: null } });
    // Refresh: every open folder again, the shown ones kept while they read.
    const refreshed = foldersToRead({ "": read, src: read }, new Set(["src"]), true);
    expect(refreshed.toRead).toEqual(["", "src"]);
    expect(refreshed.kept).toEqual({ "": read, src: read });
    // Closed, then opened again: read again, not before.
    const closed = foldersToRead({ "": read, src: read }, new Set(), false);
    expect(closed).toEqual({ kept: { "": read }, toRead: [] });
    expect(foldersToRead(closed.kept, new Set(["src"]), false).toRead).toEqual(["src"]);
  });

  it("closing a folder closes the folders inside it", () => {
    const open = toggleFolder(toggleFolder(toggleFolder(new Set(), "src"), "src/auth"), "srcx");
    expect([...open].sort()).toEqual(["src", "src/auth", "srcx"]);
    expect([...toggleFolder(open, "src")]).toEqual(["srcx"]);
  });
});

describe("the line `o` opens", () => {
  // Old lines 3–4 became new lines 3–5; old 8 was deleted (new has nothing there); new 9–10 were inserted.
  const chunks = [
    { fromA: 3, toA: 5, fromB: 3, toB: 6 },
    { fromA: 8, toA: 9, fromB: 9, toB: 9 },
    { fromA: 12, toA: 12, fromB: 12, toB: 14 },
  ];

  it("maps an old line to the nearest new line", () => {
    expect(oldToNewLine(chunks, 1, 20)).toBe(1);
    expect(oldToNewLine(chunks, 3, 20)).toBe(3);
    expect(oldToNewLine(chunks, 4, 20)).toBe(4);
    // After the first chunk, one line further down.
    expect(oldToNewLine(chunks, 5, 20)).toBe(6);
    // A deleted line: the line after the deletion.
    expect(oldToNewLine(chunks, 8, 20)).toBe(9);
    expect(oldToNewLine(chunks, 9, 20)).toBe(9);
    // Past the insertion: two lines further.
    expect(oldToNewLine(chunks, 12, 20)).toBe(14);
    // Clamped to the new file.
    expect(oldToNewLine(chunks, 40, 20)).toBe(20);
    expect(oldToNewLine([{ fromA: 1, toA: 3, fromB: 1, toB: 1 }], 2, 0)).toBe(1);
  });

  it("picks the cursor's line, maps an old-side or deleted line, else the first visible line", () => {
    let visible = 0;
    const firstVisible = () => {
      visible += 1;
      return 17;
    };
    expect(editorLine(null, firstVisible, () => chunks, 20)).toBe(17);
    expect(visible).toBe(1);
    // The new side: its own line, never mapped.
    expect(editorLine({ side: "new", line: 5 }, firstVisible, () => chunks, 20)).toBe(5);
    // The old side of the side-by-side view: old 5 is new 6.
    expect(editorLine({ side: "old", line: 5 }, firstVisible, () => chunks, 20)).toBe(6);
    // A deleted line of the unified view (old 8): the line after the deletion.
    expect(editorLine({ side: "old", line: 8 }, firstVisible, () => chunks, 20)).toBe(9);
    expect(visible, "the first visible line only without a cursor").toBe(1);
  });

  it("takes the shorter new side's last line inside a chunk", () => {
    expect(oldToNewLine([{ fromA: 2, toA: 6, fromB: 2, toB: 3 }], 5, 10)).toBe(2);
  });

  it("reads CodeMirror's chunks as lines", () => {
    const old = "a\nb\nc\nd\ne\n";
    const next = "a\nB\nB2\nc\ne\n";
    const state = EditorState.create({ doc: next, extensions: [unifiedMergeView({ original: old, mergeControls: false, diffConfig: DIFF_CONFIG })] });
    const lines = (getChunks(state)?.chunks ?? []).map((c) => lineChunk(c, getOriginalDoc(state), state.doc));
    expect(lines).toEqual([
      { fromA: 2, toA: 3, fromB: 2, toB: 4 },
      { fromA: 4, toA: 5, fromB: 5, toB: 5 },
    ]);
    // Old `d` (deleted, line 4) opens new line 5 (`e`); old `e` (5) is new 5.
    expect(oldToNewLine(lines, 4, state.doc.lines)).toBe(5);
    expect(oldToNewLine(lines, 5, state.doc.lines)).toBe(5);
  });
});

describe("the view's line provider", () => {
  afterEach(() => {
    setLineProvider(() => null)();
  });

  it("gives the mounted view's line, nothing once it is gone, and never a bad number", () => {
    expect(currentLine()).toBeNull();
    const unregister = setLineProvider(() => 42);
    expect(currentLine()).toBe(42);
    // A view replaced before the old one unregisters keeps the new one.
    const second = setLineProvider(() => 7);
    unregister();
    expect(currentLine()).toBe(7);
    second();
    expect(currentLine()).toBeNull();
    setLineProvider(() => 0);
    expect(currentLine()).toBeNull();
    setLineProvider(() => {
      throw new Error("view gone");
    });
    expect(currentLine()).toBeNull();
  });
});
