// Pure helpers of the Review pane (Story 8.1): the changed-files tree, the filter, the language a
// file is highlighted with, and the order of a review request's paths. No React, no CodeMirror:
// the pane and its tests import these; the CodeMirror view lives in `DiffView.tsx`, loaded lazily.
// Story 8.2 adds the modes (Changes, vs base, Commits), the base choices and the commit list rows.
// Story 8.3 adds Files (the folder's lazy tree) and the line `o` opens a diff at.

import type { ChangedFile, CommitInfo, DiffFilter, DirListing, FileStatus, RangeBases, RequestedKey, ReviewTarget } from "../ipc";

/** The filter toggle's three positions, in order, with their labels. */
export const FILTERS: readonly { id: DiffFilter; label: string; title: string }[] = [
  { id: "all", label: "All", title: "HEAD against the working tree" },
  { id: "staged", label: "Staged", title: "HEAD against the index" },
  { id: "unstaged", label: "Unstaged", title: "The index against the working tree" },
];

/**
 * The pane's modes (Story 8.2): the working tree (`changes`, 8.1), the branch against its base
 * (`base`), and the branch's commits (`commits`). Story 8.3: every file of the folder (`files`).
 */
export type ReviewMode = "changes" | "base" | "commits" | "files";

/** The mode toggle's positions, in order, with their labels. */
export const MODES: readonly { id: ReviewMode; label: string; title: string }[] = [
  { id: "changes", label: "Changes", title: "Uncommitted changes" },
  { id: "base", label: "vs base", title: "What the branch changed since it forked from the base" },
  { id: "commits", label: "Commits", title: "The branch's commits beyond the base" },
  { id: "files", label: "Files", title: "Every file of the folder, read-only" },
];

/**
 * The modes a target offers: a session has Changes and Files; a project or a branch Changes, vs
 * base and Commits, and Files. Files needs a folder (`hasFolder`: false for a branch without a
 * linked worktree).
 */
export function modesFor(target: ReviewTarget | null, hasFolder = true): readonly ReviewMode[] {
  if (target === null) return [];
  const modes: ReviewMode[] = target.kind === "session" ? ["changes"] : ["changes", "base", "commits"];
  if (hasFolder) modes.push("files");
  return modes;
}

/** The line shown when the branch has no commits beyond its base. */
export function noCommitsText(branch: string, base: string): string {
  return `No commits on ${branch} beyond ${base}`;
}

/** The line under a cut commit list. */
export function olderCommitsText(more: number): string {
  return `${more} older ${more === 1 ? "commit" : "commits"} not shown`;
}

/** The base dropdown's choices: the default base first, then every other local branch by name. */
export function baseChoices(bases: Pick<RangeBases, "defaultBase" | "bases">): string[] {
  const def = bases.defaultBase;
  return def === null ? [...bases.bases] : [def, ...bases.bases.filter((b) => b !== def)];
}

/** Rust's refusal of a commit that is not (or no longer) in the list. */
export const NOT_IN_RANGE = "not a commit of this list";

/** The line shown when a subfolder project's range touches nothing in its folder. */
export const NO_FOLDER_CHANGES = "No changes in this folder";

/** One option of the base dropdown. */
export type BaseOption = { value: string; label: string };

/**
 * The base dropdown: its options (the default first and marked `(default)`, then every other
 * local branch; a `pick a base` placeholder while none is chosen) and the selected value.
 * `known` are the last bases Rust offered (kept while a new base reads, and after a failed read).
 */
export function baseSelectModel(known: Pick<RangeBases, "defaultBase" | "bases"> | null, current: string | null): { value: string; options: BaseOption[] } {
  const names = known === null ? [] : baseChoices(known);
  if (current !== null && !names.includes(current)) names.unshift(current);
  const options = names.map((name) => ({ value: name, label: known !== null && name === known.defaultBase ? `${name} (default)` : name }));
  if (current === null) options.unshift({ value: "", label: "pick a base" });
  return { value: current ?? "", options };
}

/** What a dropdown choice asks Rust for: `null` (the default) for the default base or the placeholder. */
export function baseForChoice(value: string, defaultBase: string | null): string | null {
  return value === "" || value === defaultBase ? null : value;
}

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * How long ago a commit was (`at`, seconds since the epoch), like a session card's age: `now`,
 * `5m`, `3h`, `2d` (under a week), then `12 Oct` this year or `12 Oct 2025`; `?` when unknown.
 */
export function commitAge(at: number, nowMs: number): string {
  if (!Number.isFinite(at) || at <= 0) return "?";
  const age = Math.floor(nowMs / 1000) - at;
  if (age < MINUTE_S) return "now";
  if (age < HOUR_S) return `${Math.floor(age / MINUTE_S)}m`;
  if (age < DAY_S) return `${Math.floor(age / HOUR_S)}h`;
  if (age < 7 * DAY_S) return `${Math.floor(age / DAY_S)}d`;
  const date = new Date(at * 1000);
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === new Date(nowMs).getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

/** One row of the commit list as the pane shows it. */
export type CommitRow = { sha: string; short: string; subject: string; author: string; age: string; label: string };

/** The commit list's rows, newest first as Rust sent them. */
export function commitRows(commits: readonly CommitInfo[], nowMs: number): CommitRow[] {
  return commits.map((c) => {
    const age = commitAge(c.at, nowMs);
    const subject = c.subject === "" ? "(no subject)" : c.subject;
    return { sha: c.sha, short: c.short, subject, author: c.author, age, label: `${c.short} ${subject}, ${c.author}, ${age}` };
  });
}

/** The filter's label. */
export function filterLabel(filter: DiffFilter): string {
  return FILTERS.find((f) => f.id === filter)?.label ?? filter;
}

/** Side by side (the default) or unified. */
export type DiffLayout = "split" | "unified";

/** The other layout. */
export function otherLayout(layout: DiffLayout): DiffLayout {
  return layout === "split" ? "unified" : "split";
}

/** A row's one-letter status mark and the word on hover. */
export function statusMark(status: FileStatus): { mark: string; word: string } {
  switch (status) {
    case "modified":
      return { mark: "M", word: "modified" };
    case "added":
      return { mark: "A", word: "added" };
    case "deleted":
      return { mark: "D", word: "deleted" };
    case "renamed":
      return { mark: "R", word: "renamed" };
    case "untracked":
      return { mark: "U", word: "untracked" };
    case "conflicted":
      return { mark: "C", word: "conflicted" };
  }
}

/** A row's counts as plain text: `+3 −1`, or why there are none (`binary file`, `submodule`, …). */
export function countsText(
  file: Pick<ChangedFile, "added" | "removed" | "binary"> & Partial<Pick<ChangedFile, "submodule" | "unreadableName" | "tooLarge">>,
): string {
  if (file.unreadableName === true) return "unreadable name";
  if (file.submodule === true) return "submodule";
  if (file.tooLarge === true) return "too large";
  return file.binary ? "binary file" : `+${file.added} −${file.removed}`;
}

/** What a row says to a screen reader and on hover: its name, its status word and its counts. */
export function rowLabel(file: ChangedFile, name: string): string {
  const word = file.onDisk ? "deleted from index, still on disk" : statusMark(file.status).word;
  const renamed = file.oldPath === null ? "" : `, renamed from ${file.oldPath}`;
  return `${name}, ${word}${renamed}, ${countsText(file)}`;
}

/** The totals over `files` (binary files count nothing). */
export function totals(files: readonly ChangedFile[]): { files: number; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }
  return { files: files.length, added, removed };
}

/** One row of the changed-files tree. */
export type TreeRow =
  | { kind: "dir"; key: string; name: string; depth: number }
  | { kind: "file"; key: string; name: string; depth: number; file: ChangedFile };

type Dir = { dirs: Map<string, Dir>; files: ChangedFile[] };

/**
 * The tree's rows, in display order: in each folder its subfolders first, then its files, each by
 * name; a chain of folders holding only one folder shows as one row (`src/auth`). Depth counts
 * the folder rows above.
 */
export function buildTree(files: readonly ChangedFile[]): TreeRow[] {
  const root: Dir = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }
  const rows: TreeRow[] = [];
  const walk = (dir: Dir, prefix: string, depth: number) => {
    for (const name of [...dir.dirs.keys()].sort()) {
      let sub = dir.dirs.get(name)!;
      let label = name;
      while (sub.files.length === 0 && sub.dirs.size === 1) {
        const [only, next] = [...sub.dirs.entries()][0]!;
        label = `${label}/${only}`;
        sub = next;
      }
      const path = `${prefix}${label}`;
      rows.push({ kind: "dir", key: `dir:${path}`, name: label, depth });
      walk(sub, `${path}/`, depth + 1);
    }
    for (const file of [...dir.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: "file", key: `file:${file.path}`, name: file.path.slice(prefix.length), depth, file });
    }
  };
  walk(root, "", 0);
  return rows;
}

/** A requested path's row (Story 7.4's paths, listed first): its changed files, or a mark. */
export type RequestedRow = {
  key: string;
  /** As the request names it (relative to the session's folder, else absolute). */
  display: string;
  /** The changed files it names: the file itself, or the files under a requested folder. */
  files: ChangedFile[];
  /** `missing` (nothing there), `unchanged` (there, but not in the list), `outside this folder`, or `null`. */
  mark: "missing" | "unchanged" | "outside this folder" | null;
};

/**
 * The request's paths first, in its order, each with the changed files it names, then the rest
 * of the files for the tree. Rust keys each path to the reviewed folder (`key`, like the list's
 * paths), so a path matches by key: the file itself, the files under a folder, or a rename's old
 * path. One that names no changed file is `missing` when nothing is there, else `unchanged`; one
 * outside the reviewed folder is `outside this folder`.
 */
export function orderForRequest(
  files: readonly ChangedFile[],
  paths: readonly RequestedKey[],
): { requested: RequestedRow[]; rest: ChangedFile[] } {
  const taken = new Set<string>();
  const requested: RequestedRow[] = [];
  for (const path of paths) {
    const key = path.key;
    if (path.outside || key === null) {
      requested.push({ key: `req:${path.display}`, display: path.display, files: [], mark: "outside this folder" });
      continue;
    }
    const named = key === "" ? [...files] : files.filter((f) => f.path === key || f.path.startsWith(`${key}/`) || f.oldPath === key);
    const fresh = named.filter((f) => !taken.has(f.path));
    for (const f of fresh) taken.add(f.path);
    requested.push({
      key: `req:${path.display}`,
      display: path.display,
      files: fresh,
      mark: named.length > 0 ? null : path.missing ? "missing" : "unchanged",
    });
  }
  return { requested, rest: files.filter((f) => !taken.has(f.path)) };
}

/**
 * The selectable rows in display order: the requested rows (a marked one, `unchanged`, `missing`
 * or outside, by its key; else its files), then the tree's files.
 */
export function fileOrder(requested: readonly RequestedRow[], tree: readonly TreeRow[]): string[] {
  const out: string[] = [];
  for (const row of requested) {
    if (row.mark !== null) out.push(row.key);
    else for (const f of row.files) out.push(f.path);
  }
  for (const row of tree) if (row.kind === "file") out.push(row.file.path);
  return out;
}

/** The path `delta` places from `current` in `order`, clamped at the ends; the first when `current` is not in it. */
export function stepPath(order: readonly string[], current: string | null, delta: number): string | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  if (index < 0) return order[0] ?? null;
  return order[Math.max(0, Math.min(order.length - 1, index + delta))] ?? null;
}

/**
 * The file shown after a (re)load: the current one while it is still listed, else the first
 * requested file, else the first file; `null` without any.
 */
export function pickSelected(current: string | null, order: readonly string[]): string | null {
  if (current !== null && order.includes(current)) return current;
  return order[0] ?? null;
}

/** The language packs loaded on demand; anything else is plain text. */
export type LanguageKind = "javascript" | "jsx" | "typescript" | "tsx" | "rust" | "python" | "json" | "css" | "html" | "markdown" | "yaml";

const EXTENSIONS: Readonly<Record<string, LanguageKind>> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  rs: "rust",
  py: "python",
  pyi: "python",
  json: "json",
  jsonc: "json",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
};

/** The language `path` is highlighted with, by its extension (case-insensitive); `null` for plain text. */
export function languageFor(path: string): LanguageKind | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(EXTENSIONS, ext) ? (EXTENSIONS[ext] ?? null) : null;
}

// -- Story 8.3: Files mode and the line `o` opens -----------------------------------------------

/** One row of the Files tree. */
export type FilesRow =
  | { kind: "entry"; key: string; name: string; path: string; depth: number; entryKind: "dir" | "file" | "link"; ignored: boolean; open: boolean; unreadable: boolean }
  | { kind: "more"; key: string; depth: number; count: number }
  | { kind: "loading"; key: string; depth: number }
  | { kind: "error"; key: string; depth: number; message: string };

/** One folder as last read: its listing, or why it could not be read (`null` both: reading). */
export type FolderState = { listing: DirListing | null; error: string | null };

/**
 * The Files tree's rows in display order: the root folder's entries (as Rust sorted them), each
 * open folder's entries under it, one level deeper. An open folder not read yet shows a loading
 * row; one that could not be read, an error row; a folder past the cap, `N more not shown`.
 */
export function filesRows(folders: Readonly<Record<string, FolderState>>, open: ReadonlySet<string>): FilesRow[] {
  const rows: FilesRow[] = [];
  const walk = (path: string, depth: number) => {
    const state = Object.hasOwn(folders, path) ? folders[path] : undefined;
    if (state === undefined || (state.listing === null && state.error === null)) {
      rows.push({ kind: "loading", key: `loading:${path}`, depth });
      return;
    }
    if (state.error !== null) {
      rows.push({ kind: "error", key: `error:${path}`, depth, message: state.error });
      return;
    }
    const listing = state.listing!;
    for (const e of listing.entries) {
      const isOpen = e.kind === "dir" && open.has(e.path);
      rows.push({ kind: "entry", key: `entry:${e.path}`, name: e.name, path: e.path, depth, entryKind: e.kind, ignored: e.ignored, open: isOpen, unreadable: e.unreadableName });
      if (isOpen) walk(e.path, depth + 1);
    }
    if (listing.more > 0) rows.push({ kind: "more", key: `more:${path}`, depth, count: listing.more });
  };
  walk("", 0);
  return rows;
}

/** The line under a cut folder. */
export function moreEntriesText(count: number): string {
  return `${count} more not shown`;
}

/** The selectable files of the tree in display order (for `j` / `k` in Files). */
export function filesOrder(rows: readonly FilesRow[]): string[] {
  return rows.filter((r): r is Extract<FilesRow, { kind: "entry" }> => r.kind === "entry" && r.entryKind !== "dir" && !r.unreadable).map((r) => r.path);
}

/** The open folders after toggling `path`: closing a folder closes the folders inside it too. */
export function toggleFolder(open: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(open);
  if (next.has(path)) {
    for (const p of open) if (p === path || p.startsWith(`${path}/`)) next.delete(p);
  } else {
    next.add(path);
  }
  return next;
}

/** A chunk of a diff by line numbers (1-based; `to` exclusive): old lines `[fromA, toA)` became new lines `[fromB, toB)`. */
export type LineChunk = { fromA: number; toA: number; fromB: number; toB: number };

/**
 * The new file's line nearest to old line `oldLine` (Story 8.3: `o` on the old side or a deleted
 * line opens the new file): inside a changed chunk the line at the same offset in its new lines
 * (the last of them when the new side is shorter; the line after the deletion for a pure
 * deletion); outside, the old line shifted by the chunks above it. Clamped to `[1, newLines]`.
 */
export function oldToNewLine(chunks: readonly LineChunk[], oldLine: number, newLines: number): number {
  const clamp = (n: number) => Math.max(1, Math.min(Math.max(1, newLines), n));
  let shift = 0;
  for (const c of chunks) {
    if (oldLine < c.fromA) break;
    if (oldLine < c.toA) {
      const len = c.toB - c.fromB;
      return clamp(len > 0 ? c.fromB + Math.min(oldLine - c.fromA, len - 1) : c.fromB);
    }
    shift = c.toB - c.toA;
  }
  return clamp(oldLine + shift);
}

/** Where the operator put a view's cursor: a side and that side's line (a deleted line of the unified view is old). */
export type CursorPlace = { side: "old" | "new"; line: number };

/**
 * The new file's line `o` opens: the cursor's line on the new side; an old-side (or deleted) line
 * mapped to the nearest new line; with no cursor placed, the first visible line.
 */
export function editorLine(place: CursorPlace | null, firstVisible: () => number, chunks: () => readonly LineChunk[], newLines: number): number {
  if (place === null) return firstVisible();
  return place.side === "old" ? oldToNewLine(chunks(), place.line, newLines) : place.line;
}

/**
 * Which folders Files reads (the root and every open one): on a refresh all of them, else only
 * those not read yet. A closed folder is forgotten, so it is read again when it opens; a folder
 * about to be read shows as reading unless it is kept.
 */
export function foldersToRead(
  current: Readonly<Record<string, FolderState>>,
  open: ReadonlySet<string>,
  refreshing: boolean,
): { kept: Record<string, FolderState>; toRead: string[] } {
  const wanted = ["", ...[...open].filter((p) => p !== "")];
  const kept: Record<string, FolderState> = {};
  for (const path of wanted) if (Object.hasOwn(current, path)) kept[path] = current[path]!;
  const toRead = refreshing ? wanted : wanted.filter((path) => !Object.hasOwn(kept, path));
  for (const path of toRead) if (!Object.hasOwn(kept, path)) kept[path] = { listing: null, error: null };
  return { kept, toRead };
}
