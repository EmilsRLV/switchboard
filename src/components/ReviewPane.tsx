import { Suspense, lazy, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { runCommand } from "../commands/registry";
import {
  reviewCommits,
  reviewFile,
  reviewList,
  reviewRangeFile,
  reviewRangeList,
  type ChangeList,
  type ChangedFile,
  type FileText,
  type RangeBases,
  type RangeList,
  type RequestedKey,
  type ReviewRequest,
  type ReviewTarget,
} from "../ipc";
import { requestIn, useReviewStore } from "../state/review";
import { REVIEW_WIDTH_KEY, clampReviewWidth, defaultReviewWidth, saveWidth, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import {
  FILTERS,
  MODES,
  NOT_IN_RANGE,
  NO_FOLDER_CHANGES,
  baseForChoice,
  baseSelectModel,
  buildTree,
  commitRows,
  countsText,
  fileOrder,
  languageFor,
  modesFor,
  noCommitsText,
  olderCommitsText,
  orderForRequest,
  pickSelected,
  rowLabel,
  statusMark,
  totals,
  type RequestedRow,
  type TreeRow,
} from "../review/model";
import { loadLanguage } from "../review/languages";
import { ErrorBoundary } from "./ErrorBoundary";

// CodeMirror and the merge view: their own chunk, loaded with the first diff shown.
const DiffView = lazy(() => import("../review/DiffView"));

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function viewportWidth(): number {
  return typeof window === "undefined" ? 1280 : window.innerWidth;
}

/** The list as last read: loading (keeping the previous one), read, or why it could not be. */
type ListState = { list: ChangeList | null; error: string | null; loading: boolean };

/** Story 8.2: vs base's (or one commit's) list as last read. */
type RangeState = { key: string | null; list: RangeList | null; error: string | null; loading: boolean };

/** Story 8.2: the commit list's read error, if the last read failed. */
type CommitsState = { error: string | null; loading: boolean };

/** The selected file's text: for which path and filter, the reply or its error, and when it arrived. */
type FileState = { key: string; text: FileText | null; error: string | null; arrivedAt: number };

/**
 * The Review pane (Story 8.1, replacing Story 7.4's list): a node's working-tree diff. A wide right
 * pane like the terminal pane (`min(1100px, 85vw)` by default, dragged by its left edge), the canvas
 * still visible beside it; Esc closes it. Its header names the node and the reviewed folder; the
 * toolbar holds the filter (All, Staged, Unstaged) and the layout (side by side, unified); then the
 * changed-files tree with plain +/− counts beside the selected file's merge view. Opened from a
 * review request, the request's summary and time sit on top and its paths are listed (and
 * selected) first, `unchanged` or `missing` where they name no changed file. Rust lists the files
 * and reads their text; the pane never builds a path. It never takes the focus on opening.
 *
 * Story 8.2: on a project or a branch the toolbar starts with the mode toggle (Changes, vs base,
 * Commits). vs base lists what the branch changed since its merge-base with the base (a dropdown
 * of local branches, the default first); Commits lists the branch's commits beyond the base, and a
 * commit's files show in the same tree and merge view with a "back to commits" control. Both are
 * read as they open and on Refresh; they never poll. The filter shows in Changes only.
 */
export function ReviewPane() {
  const target = useReviewStore((s) => s.target);
  const requestId = useReviewStore((s) => s.requestId);
  const requests = useReviewStore((s) => s.requests);
  const filter = useReviewStore((s) => s.filter);
  const mode = useReviewStore((s) => s.mode);
  const base = useReviewStore((s) => s.base);
  const commit = useReviewStore((s) => s.commit);
  const commitList = useReviewStore((s) => s.commitList);
  const layout = useReviewStore((s) => s.layout);
  const selected = useReviewStore((s) => s.selected);
  const refreshSeq = useReviewStore((s) => s.refreshSeq);
  const stored = useUiStore((s) => s.reviewWidth);
  const [viewport, setViewport] = useState(viewportWidth);
  const width = clampReviewWidth(stored ?? defaultReviewWidth(viewport), viewport);
  const request = requestId === null ? null : requestIn(requests, requestId);
  const title = useTargetTitle(target, request);
  const modes = modesFor(target);

  useEffect(() => {
    const onResize = () => setViewport(viewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Changes: read on open, on a filter change, on Refresh and when the status poll moves.
  const [listState, setListState] = useState<ListState>({ list: null, error: null, loading: true });
  const listFor = useRef<string | null>(null);
  useEffect(() => {
    if (target === null || mode !== "changes") return;
    let live = true;
    // Another node or filter: the old list goes at once (a refresh keeps it while it reads).
    const key = `${JSON.stringify(target)}\u0000${filter}`;
    const same = listFor.current === key;
    listFor.current = key;
    setListState((s) => ({ list: same ? s.list : null, error: same ? s.error : null, loading: true }));
    reviewList(target, filter).then(
      (list) => {
        if (!live) return;
        // An unchanged reply keeps the old object, so the open diff is not rebuilt.
        setListState((s) => ({ list: s.list !== null && JSON.stringify(s.list) === JSON.stringify(list) ? s.list : list, error: null, loading: false }));
        useReviewStore.getState().setRoot(list.root);
      },
      (err: unknown) => {
        if (live) setListState({ list: null, error: describe(err), loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [target, filter, mode, refreshSeq]);

  // vs base, or a commit's files: read as the mode opens, on a base or commit change and on Refresh.
  const rangeCommit = mode === "commits" ? commit : null;
  const showsRange = mode === "base" || (mode === "commits" && commit !== null);
  // What the range list is for; a list read for another key is never shown (not even for one render).
  const rangeKey = target === null || !showsRange ? null : `${JSON.stringify(target)}\u0000${base ?? ""}\u0000${rangeCommit ?? ""}`;
  const [rangeState, setRangeState] = useState<RangeState>({ key: null, list: null, error: null, loading: true });
  useEffect(() => {
    if (target === null || rangeKey === null) return;
    let live = true;
    // Another node, base or commit: the old list goes at once (a refresh keeps it while it reads).
    setRangeState((s) => (s.key === rangeKey ? { ...s, loading: true } : { key: rangeKey, list: null, error: null, loading: true }));
    reviewRangeList(target, base, rangeCommit).then(
      (list) => {
        if (!live) return;
        setRangeState((s) => ({
          key: rangeKey,
          list: s.key === rangeKey && s.list !== null && JSON.stringify(s.list) === JSON.stringify(list) ? s.list : list,
          error: null,
          loading: false,
        }));
      },
      (err: unknown) => {
        if (live) setRangeState({ key: rangeKey, list: null, error: describe(err), loading: false });
      },
    );
    return () => {
      live = false;
    };
    // `rangeKey` covers the target, the base and the commit.
  }, [rangeKey, refreshSeq]);
  const rangeList = rangeState.key === rangeKey ? rangeState.list : null;
  const rangeError = rangeState.key === rangeKey ? rangeState.error : null;

  // Commits: the list, read as the mode opens, on a base change and on Refresh.
  const [commitsState, setCommitsState] = useState<CommitsState>({ error: null, loading: false });
  useEffect(() => {
    if (target === null || mode !== "commits") return;
    let live = true;
    setCommitsState({ error: null, loading: true });
    reviewCommits(target, base).then(
      (log) => {
        if (!live) return;
        const store = useReviewStore.getState();
        const prev = store.commitList;
        // A shown commit no longer listed (the branch was rewritten) goes back to the list.
        store.setCommitList(prev !== null && JSON.stringify(prev) === JSON.stringify(log) ? prev : log);
        setCommitsState({ error: null, loading: false });
      },
      (err: unknown) => {
        if (!live) return;
        useReviewStore.getState().setCommitList(null);
        setCommitsState({ error: describe(err), loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [target, mode, base, refreshSeq]);

  const changes = mode === "changes";
  const files = (changes ? listState.list?.files : showsRange ? rangeList?.files : undefined) ?? NO_FILES;
  const more = (changes ? listState.list?.more : showsRange ? rangeList?.more : 0) ?? 0;
  // A commit Rust no longer lists is not an error while the commit list reloads (that drops it).
  const staleCommit = showsRange && mode === "commits" && rangeList?.error === NOT_IN_RANGE && commitsState.loading;
  const listed = changes ? listState.list !== null : showsRange ? rangeList !== null && !staleCommit : commitList !== null;
  const listError = changes
    ? listState.error
    : showsRange
      ? (rangeError ?? (staleCommit ? null : (rangeList?.error ?? null)))
      : (commitsState.error ?? commitList?.error ?? null);
  const root = changes ? listState.list?.root : showsRange ? rangeList?.root : commitList?.root;
  // The bases Rust last offered for this target: kept while a new base reads and after a failed
  // read, so another base can always be picked.
  const [knownBases, setKnownBases] = useState<{ key: string; bases: RangeBases } | null>(null);
  const targetKey = target === null ? "" : JSON.stringify(target);
  const latestBases = mode === "commits" && commitList !== null ? commitList : (rangeList ?? (mode === "commits" ? null : commitList));
  useEffect(() => {
    if (latestBases === null || target === null) return;
    setKnownBases((prev) =>
      prev !== null && prev.key === targetKey && JSON.stringify(prev.bases.bases) === JSON.stringify(latestBases.bases) && prev.bases.defaultBase === latestBases.defaultBase
        ? prev
        : { key: targetKey, bases: latestBases },
    );
  }, [latestBases, targetKey, target]);
  const bases = knownBases !== null && knownBases.key === targetKey ? knownBases.bases : null;
  const shownBase = base ?? latestBases?.base ?? bases?.defaultBase ?? null;
  const subfolder = showsRange && rangeList?.subfolder === true;
  // A request's paths as Rust keyed them to this folder (only while the pane shows a request, in Changes).
  const requestKeys = requestId === null || !changes ? NO_KEYS : (listState.list?.requested ?? NO_KEYS);
  const { requested, rest } = useMemo(() => orderForRequest(files, requestKeys), [files, requestKeys]);
  const tree = useMemo(() => buildTree(rest), [rest]);
  const order = useMemo(() => fileOrder(requested, tree), [requested, tree]);
  // Ages are as of the last read (Refresh reads the list again).
  const rows = useMemo(() => commitRows(commitList?.commits ?? [], Date.now()), [commitList]);
  const shownCommit = commit === null ? null : (commitList?.commits.find((c) => c.sha === commit) ?? null);

  // Keep the store's order (for stepping) and the selection on a listed file.
  const activeList = changes ? listState.list : showsRange ? rangeList : null;
  useEffect(() => {
    const store = useReviewStore.getState();
    store.setOrder(order);
    if (activeList === null) return;
    store.select(pickSelected(store.selected, order));
  }, [order, activeList]);

  const selectedFile = selected === null ? null : (files.find((f) => f.path === selected) ?? null);
  const selectedMark = selected === null ? null : (requested.find((r) => r.key === selected) ?? null);

  // The selected file's text, read again whenever the list is and on every Refresh.
  const [fileState, setFileState] = useState<FileState | null>(null);
  const source = changes ? `changes\u0000${filter}` : `range\u0000${base ?? ""}\u0000${rangeCommit ?? ""}`;
  const fileKey = selectedFile === null || target === null ? null : `${JSON.stringify(target)}\u0000${source}\u0000${selectedFile.path}`;
  useEffect(() => {
    if (fileKey === null || target === null || selectedFile === null) {
      setFileState(null);
      return;
    }
    let live = true;
    const kind = languageFor(selectedFile.path);
    if (kind !== null) void loadLanguage(kind).catch(() => undefined);
    const read = changes ? reviewFile(target, selectedFile.path, filter) : reviewRangeFile(target, base, rangeCommit, selectedFile.path);
    read.then(
      (text) => {
        if (!live) return;
        // The same text again keeps the shown diff (and its render time) as it is.
        setFileState((prev) =>
          prev !== null && prev.key === fileKey && prev.error === null && JSON.stringify(prev.text) === JSON.stringify(text)
            ? prev
            : { key: fileKey, text, error: null, arrivedAt: performance.now() },
        );
      },
      (err: unknown) => {
        if (live) setFileState({ key: fileKey, text: null, error: describe(err), arrivedAt: performance.now() });
      },
    );
    return () => {
      live = false;
    };
    // `activeList` and `refreshSeq` re-read the text after every list read and every Refresh.
  }, [fileKey, target, activeList, refreshSeq]);

  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      useUiStore.getState().setReviewWidth(clampReviewWidth(window.innerWidth - e.clientX, window.innerWidth));
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      const width = useUiStore.getState().reviewWidth;
      if (width !== null) saveWidth(REVIEW_WIDTH_KEY, width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const sum = totals(files);
  const showCommitList = mode === "commits" && commit === null;
  const totalsText = showCommitList
    ? commitList === null
      ? ""
      : `${commitList.commits.length + commitList.more} ${commitList.commits.length + commitList.more === 1 ? "commit" : "commits"}`
    : listed
      ? `${sum.files} ${sum.files === 1 ? "file" : "files"} +${sum.added} −${sum.removed}`
      : "";
  // vs base with nothing beyond the base, or an empty commit list.
  const nothingBeyond =
    mode === "base" && rangeList !== null && rangeList.error === null && rangeList.base !== null && rangeList.ahead === 0
      ? noCommitsText(rangeList.branch, rangeList.base)
      : showCommitList && commitList !== null && commitList.error === null && commitList.base !== null && commitList.commits.length === 0
        ? noCommitsText(commitList.branch, commitList.base)
        : null;

  return (
    <aside className="pane review-pane" aria-label={`Review: ${title}`} style={{ width: `${width}px` }}>
      <div className="terminal-drag" role="separator" aria-orientation="vertical" aria-label="Resize review pane" onPointerDown={onDragStart} />
      <header className="review-header">
        <h2 className="pane-title review-title" title={title}>
          {title}
        </h2>
        <span className="review-root" title={root}>
          {root ?? ""}
        </span>
        <span className="review-header-actions">
          <button type="button" className="btn" onClick={() => runCommand("review.refresh")} title="Read the changes again">
            Refresh
          </button>
          <button type="button" className="btn" onClick={() => runCommand("pane.close")} title="Close (Esc)">
            Close
          </button>
        </span>
      </header>
      {requestId !== null && <RequestSummary request={request} />}
      <div className="review-toolbar">
        {modes.length > 1 && (
          <span className="review-toggle" role="group" aria-label="Mode">
            {MODES.filter((m) => modes.includes(m.id)).map((m) => (
              <button key={m.id} type="button" className="btn" aria-pressed={mode === m.id} title={m.title} onClick={() => useReviewStore.getState().setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </span>
        )}
        {changes ? (
          <span className="review-toggle" role="group" aria-label="Compare">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="btn"
                aria-pressed={filter === f.id}
                title={f.title}
                onClick={() => useReviewStore.getState().setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </span>
        ) : (
          <BaseSelect bases={bases} current={shownBase} />
        )}
        <span className="review-totals">{totalsText}</span>
        <span className="review-toggle" role="group" aria-label="Layout">
          <button type="button" className="btn" aria-pressed={layout === "split"} onClick={() => useReviewStore.getState().setLayout("split")}>
            Side by side
          </button>
          <button type="button" className="btn" aria-pressed={layout === "unified"} onClick={() => useReviewStore.getState().setLayout("unified")}>
            Unified
          </button>
        </span>
      </div>
      <div className="review-body">
        <nav className="review-tree" aria-label={showCommitList ? "Commits" : "Changed files"}>
          {mode === "commits" && commit !== null && (
            <div className="review-commit-head">
              <button type="button" className="btn" onClick={() => useReviewStore.getState().selectCommit(null)} title="Back to the commit list">
                ← Commits
              </button>
              {shownCommit !== null && (
                <p className="review-commit-title" title={`${shownCommit.short} ${shownCommit.subject}`}>
                  {shownCommit.short} {shownCommit.subject}
                </p>
              )}
            </div>
          )}
          {listError !== null ? (
            <p className="pane-error" role="alert">
              {listError}
            </p>
          ) : !listed ? (
            <p className="muted">{showCommitList ? "Reading commits…" : "Reading changes…"}</p>
          ) : nothingBeyond !== null ? (
            <p className="muted">{nothingBeyond}</p>
          ) : showCommitList ? (
            <>
              <ul className="review-rows">
                {rows.map((row) => (
                  <li key={row.sha}>
                    <button type="button" className="review-row review-commit" aria-label={row.label} title={row.label} onClick={() => useReviewStore.getState().selectCommit(row.sha)}>
                      <span className="review-sha">{row.short}</span>
                      <span className="review-commit-subject">{row.subject}</span>
                      <span className="review-commit-meta">
                        {row.author} · {row.age}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {commitList !== null && commitList.more > 0 && <p className="muted review-more">{olderCommitsText(commitList.more)}</p>}
            </>
          ) : (
            <>
              {requested.length > 0 && (
                <>
                  <h3 className="pane-heading review-group">Requested</h3>
                  <ul className="review-rows">
                    {requested.map((row) => (
                      <RequestedRows key={row.key} row={row} selected={selected} />
                    ))}
                  </ul>
                  {tree.length > 0 && <h3 className="pane-heading review-group">Other changes</h3>}
                </>
              )}
              {files.length === 0 && requested.length === 0 ? (
                <p className="muted">{subfolder ? NO_FOLDER_CHANGES : "No changes"}</p>
              ) : (
                <ul className="review-rows">
                  {tree.map((row) => (
                    <TreeRowItem key={row.key} row={row} selected={selected} />
                  ))}
                </ul>
              )}
              {more > 0 && <p className="muted review-more">{more} more files not shown</p>}
            </>
          )}
        </nav>
        <section className="review-view" aria-label="Diff">
          {showCommitList ? (
            <p className="muted review-note">No commit selected.</p>
          ) : (
            <DiffArea file={selectedFile} mark={selectedMark} state={fileState} fileKey={fileKey} layout={layout} />
          )}
        </section>
      </div>
    </aside>
  );
}

/** Story 8.2: the base dropdown: the default base first, then every other local branch (the last bases Rust offered). */
function BaseSelect({ bases, current }: { bases: RangeBases | null; current: string | null }) {
  const model = baseSelectModel(bases, current);
  return (
    <label className="review-base">
      <span className="review-base-label">base</span>
      <select
        className="launch-input review-base-select"
        value={model.value}
        disabled={model.options.length === 0}
        onChange={(e) => useReviewStore.getState().setBase(baseForChoice(e.target.value, bases?.defaultBase ?? null))}
      >
        {model.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const NO_FILES: ChangedFile[] = [];
const NO_KEYS: RequestedKey[] = [];

/** The pane's title: the project's label, `<project>:<branch>`, or the session's name. */
function useTargetTitle(target: ReviewTarget | null, request: ReviewRequest | null): string {
  const snapshot = useWorkspaceStore((s) => s.snapshot);
  if (target === null) return "Review";
  const projectLabel = (id: string) => snapshot?.workspace.projects.find((p) => p.id === id)?.label ?? "project";
  if (target.kind === "project") return projectLabel(target.projectId);
  if (target.kind === "branch") return `${projectLabel(target.projectId)}:${target.branch}`;
  if (request !== null) return request.name;
  return snapshot?.children.find((c) => c.kind === "session" && c.id === target.sessionId)?.label ?? "session";
}

/** The review request on top (Story 7.4): its summary and when it was asked for. */
function RequestSummary({ request }: { request: ReviewRequest | null }) {
  if (request === null) return <p className="muted">This review request is gone.</p>;
  return (
    <section className="pane-section review-request">
      <h3 className="pane-heading">Summary</h3>
      <p className="review-summary">{request.summary}</p>
      <p className="review-at">
        Requested <time dateTime={request.at}>{requestedAt(request.at)}</time>
      </p>
    </section>
  );
}

function select(path: string): void {
  useReviewStore.getState().select(path);
}

function FileButton({ file, name, depth, selected }: { file: ChangedFile; name: string; depth: number; selected: boolean }) {
  const { mark } = statusMark(file.status);
  const label = rowLabel(file, file.path);
  return (
    <button
      type="button"
      className="review-row"
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
      title={label}
      onClick={() => select(file.path)}
      data-file={file.path}
    >
      <span className="review-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="review-name">
        {name}
        {file.oldPath !== null && <span className="review-from"> renamed from {file.oldPath}</span>}
      </span>
      <span className="review-counts">{countsText(file)}</span>
    </button>
  );
}

function TreeRowItem({ row, selected }: { row: TreeRow; selected: string | null }) {
  if (row.kind === "dir") {
    return (
      <li className="review-dir" style={{ paddingLeft: `${0.5 + row.depth * 0.85}rem` }}>
        {row.name}/
      </li>
    );
  }
  return (
    <li>
      <FileButton file={row.file} name={row.name} depth={row.depth} selected={selected === row.file.path} />
    </li>
  );
}

function RequestedRows({ row, selected }: { row: RequestedRow; selected: string | null }) {
  if (row.mark !== null) {
    return (
      <li>
        <button
          type="button"
          className="review-row"
          aria-current={selected === row.key ? "true" : undefined}
          aria-label={`${row.display}, ${row.mark}`}
          title={`${row.display}, ${row.mark}`}
          onClick={() => select(row.key)}
        >
          <span className="review-mark" aria-hidden="true">
            ·
          </span>
          <span className="review-name">{row.display}</span>
          <span className="review-counts">{row.mark}</span>
        </button>
      </li>
    );
  }
  return (
    <>
      {row.files.map((file) => (
        <li key={file.path}>
          <FileButton file={file} name={file.path} depth={0} selected={selected === file.path} />
        </li>
      ))}
    </>
  );
}

/** The right side: the selected file's merge view, or why there is none. */
function DiffArea({
  file,
  mark,
  state,
  fileKey,
  layout,
}: {
  file: ChangedFile | null;
  mark: RequestedRow | null;
  state: FileState | null;
  fileKey: string | null;
  layout: "split" | "unified";
}) {
  const onRendered = (ms: number) => useReviewStore.getState().setRenderMs(ms);
  if (mark !== null) {
    return (
      <p className="muted review-note">
        {mark.display}: {mark.mark}
      </p>
    );
  }
  if (file === null) return <p className="muted review-note">No file selected.</p>;
  if (state === null || state.key !== fileKey) return <p className="muted review-note">Reading {file.path}…</p>;
  if (state.error !== null) {
    return (
      <p className="pane-error review-note" role="alert">
        {state.error}
      </p>
    );
  }
  const text = state.text;
  if (text === null) return null;
  const content = text.content;
  if (content.kind === "binary") return <p className="muted review-note">binary file</p>;
  if (content.kind === "submodule") return <p className="muted review-note">submodule</p>;
  if (content.kind === "unreadable_name") return <p className="muted review-note">unreadable name</p>;
  if (content.kind === "too_large") {
    return (
      <p className="muted review-note">
        too large to show ({countsText(text.file)})
      </p>
    );
  }
  return (
    <div className="review-diff-wrap">
      {content.notUtf8 && <p className="review-mark-line">not UTF-8 (shown lossily)</p>}
      <ErrorBoundary
        label="diff view"
        resetKey={`${text.file.path} ${layout} ${state.arrivedAt}`}
        fallback={(message) => (
          <p className="pane-error review-note" role="alert">
            could not show this diff: {message}
          </p>
        )}
      >
        <Suspense fallback={<p className="muted review-note">Loading the diff view…</p>}>
          <DiffView
            path={text.file.path}
            oldText={content.old ?? ""}
            newText={content.new ?? ""}
            layout={layout}
            arrivedAt={state.arrivedAt}
            onRendered={onRendered}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

/** When a review was requested, in the viewer's locale (`HH:MM` today, else the date too); the raw text if unreadable. */
export function requestedAt(at: string, now: Date = new Date()): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return at;
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return when.toDateString() === now.toDateString() ? time : `${when.toLocaleDateString()} ${time}`;
}

export default ReviewPane;
