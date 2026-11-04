import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { commandHint } from "../commands/keybindings";
import { runCommand } from "../commands/registry";
import {
  reviewCommits,
  reviewDir,
  reviewFile,
  reviewList,
  reviewRangeFile,
  reviewRangeList,
  reviewView,
  reviewCommentsGet,
  reviewTouched,
  type ChangeList,
  type ChangedFile,
  type FileText,
  type FileView,
  type RangeBases,
  type RangeList,
  type RequestedKey,
  type ReviewComment,
  type ReviewRequest,
  type ReviewTarget,
} from "../ipc";
import { commentsOf, requestIn, useReviewStore, type CommentAnchor } from "../state/review";
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
  filesOrder,
  filesRows,
  foldersToRead,
  languageFor,
  moreEntriesText,
  noCommitsText,
  olderCommitsText,
  orderForRequest,
  pickSelected,
  rowLabel,
  statusMark,
  totals,
  TOUCHED_MARK,
  TOUCHED_TITLE,
  commentRow,
  touchedFor,
  withTouched,
  type FilesRow,
  type FolderState,
  type RequestedRow,
  type TreeRow,
} from "../review/model";
import { loadLanguage } from "../review/languages";
import {
  REVIEW_FILTER_COMMANDS,
  REVIEW_LAYOUT_COMMANDS,
  REVIEW_MODE_COMMANDS,
  commentBlockedReason,
  draftKey,
  handleCommentKey,
  reviewModes,
  sendComment,
  shownFilePath,
} from "../commands/review";
import { ErrorBoundary } from "./ErrorBoundary";

// CodeMirror and the merge view: their own chunk, loaded with the first diff shown.
const DiffView = lazy(() => import("../review/DiffView"));
// Files mode's single view (Story 8.3), from the same chunk.
const SourceView = lazy(() => import("../review/DiffView").then((m) => ({ default: m.SourceView })));

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
 *
 * Story 8.3: Files (wherever the pane has a folder) is a lazy tree of the whole folder, folders
 * first, gitignored entries dimmed, each folder read when it is first opened; a selected file opens
 * read-only in a single CodeMirror view. Refresh reads the open folders and the open file again.
 *
 * Story 8.4: on a session, the rows of the files its transcript says it edited carry a muted `•`
 * (`edited by this session`), read with the list (so Refresh and the poll update it). "Comment on
 * line" (`c`, or the toolbar's Comment button) opens a one-line box under the toolbar anchored at
 * the shown file's current line; ctrl+Enter sends it to the session, Esc cancels. The comments sent
 * to the session this run are listed under it with their state (`queued`, `sent`, `read`), live.
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
  const storeRoot = useReviewStore((s) => s.root);
  const commentBox = useReviewStore((s) => s.commentBox);
  const allComments = useReviewStore((s) => s.comments);
  const stored = useUiStore((s) => s.reviewWidth);
  const [viewport, setViewport] = useState(viewportWidth);
  const width = clampReviewWidth(stored ?? defaultReviewWidth(viewport), viewport);
  const request = requestId === null ? null : requestIn(requests, requestId);
  const title = useTargetTitle(target, request);
  const modes = reviewModes(target);
  const filesMode = mode === "files";

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
  const root = filesMode ? (storeRoot ?? undefined) : changes ? listState.list?.root : showsRange ? rangeList?.root : commitList?.root;
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
  // Story 8.4: the files the session touched (Rust keys them like the list's paths).
  const touchedKeys = touchedFor(target, mode, listState.list);
  const touched = useMemo(() => new Set(touchedKeys), [touchedKeys]);
  const sessionId = target?.kind === "session" ? target.sessionId : null;
  const comments = useMemo(() => (sessionId === null ? NO_COMMENTS : commentsOf(allComments, sessionId)), [allComments, sessionId]);
  const commentBlocked = commentBlockedReason(target, shownFilePath(selected, mode, commit));
  // Story 8.4: the comments already sent to this session (the event keeps them fresh after).
  useEffect(() => {
    if (target === null || target.kind !== "session") return;
    let live = true;
    reviewCommentsGet(target).then(
      (list) => {
        if (live) useReviewStore.getState().mergeComments(list);
      },
      (err: unknown) => console.warn(`review comments read failed: ${describe(err)}`),
    );
    return () => {
      live = false;
    };
  }, [target]);
  const { requested, rest } = useMemo(() => orderForRequest(files, requestKeys), [files, requestKeys]);
  const tree = useMemo(() => buildTree(rest), [rest]);
  const order = useMemo(() => fileOrder(requested, tree), [requested, tree]);
  // Ages are as of the last read (Refresh reads the list again).
  const rows = useMemo(() => commitRows(commitList?.commits ?? [], Date.now()), [commitList]);
  const shownCommit = commit === null ? null : (commitList?.commits.find((c) => c.sha === commit) ?? null);

  // Keep the store's order (for stepping) and the selection on a listed file.
  const activeList = changes ? listState.list : showsRange ? rangeList : null;
  useEffect(() => {
    // Files keeps its own order (FilesBody).
    if (filesMode) return;
    const store = useReviewStore.getState();
    store.setOrder(order);
    if (activeList === null) return;
    store.select(pickSelected(store.selected, order));
  }, [order, activeList, filesMode]);

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
          <button type="button" className="btn" onClick={() => runCommand("review.refresh")} title={commandHint("review.refresh", "Read the changes again")}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={() => runCommand("pane.close")} title={commandHint("pane.close", "Close")}>
            Close
          </button>
        </span>
      </header>
      {requestId !== null && <RequestSummary request={request} />}
      <div className="review-toolbar">
        {modes.length > 1 && (
          <span className="review-toggle" role="group" aria-label="Mode">
            {MODES.filter((m) => modes.includes(m.id)).map((m) => (
              <button key={m.id} type="button" className="btn" aria-pressed={mode === m.id} title={commandHint(REVIEW_MODE_COMMANDS[m.id], m.title)} onClick={() => runCommand(REVIEW_MODE_COMMANDS[m.id])}>
                {m.label}
              </button>
            ))}
          </span>
        )}
        {filesMode ? null : changes ? (
          <span className="review-toggle" role="group" aria-label="Compare">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="btn"
                aria-pressed={filter === f.id}
                title={commandHint(REVIEW_FILTER_COMMANDS[f.id], f.title)}
                onClick={() => runCommand(REVIEW_FILTER_COMMANDS[f.id])}
              >
                {f.label}
              </button>
            ))}
          </span>
        ) : (
          <BaseSelect bases={bases} current={shownBase} />
        )}
        <span className="review-totals">{filesMode ? "" : totalsText}</span>
        <button
          type="button"
          className="btn"
          disabled={commentBlocked !== null}
          title={commentBlocked ?? commandHint("review.comment", "Comment on the current line")}
          onClick={() => runCommand("review.comment")}
        >
          Comment
        </button>
        {!filesMode && (
          <span className="review-toggle" role="group" aria-label="Layout">
            <button type="button" className="btn" aria-pressed={layout === "split"} title={commandHint(REVIEW_LAYOUT_COMMANDS.split)} onClick={() => runCommand(REVIEW_LAYOUT_COMMANDS.split)}>
              Side by side
            </button>
            <button type="button" className="btn" aria-pressed={layout === "unified"} title={commandHint(REVIEW_LAYOUT_COMMANDS.unified)} onClick={() => runCommand(REVIEW_LAYOUT_COMMANDS.unified)}>
              Unified
            </button>
          </span>
        )}
      </div>
      {commentBox !== null && target !== null && <CommentBox key={`${commentBox.path}:${commentBox.line}`} anchor={commentBox} target={target} />}
      {comments.length > 0 && <CommentList comments={comments} />}
      {filesMode && target !== null ? (
        <FilesBody target={target} refreshSeq={refreshSeq} />
      ) : (
        <div className="review-body">
          <nav className="review-tree" aria-label={showCommitList ? "Commits" : "Changed files"}>
            {mode === "commits" && commit !== null && (
              <div className="review-commit-head">
                <button type="button" className="btn" onClick={() => runCommand("review.backToCommits")} title={commandHint("review.backToCommits", "Back to the commit list")}>
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
                        <RequestedRows key={row.key} row={row} selected={selected} touched={touched} />
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
                      <TreeRowItem key={row.key} row={row} selected={selected} touched={touched} />
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
      )}
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
const NO_COMMENTS: ReviewComment[] = [];
const NO_TOUCHED_SET: ReadonlySet<string> = new Set();

/**
 * Story 8.4: the one-line comment box under the toolbar, anchored at a file and line. It takes the
 * focus as it opens (the operator asked for it); ctrl+Enter sends, Esc cancels, a bare Enter does
 * nothing (one line; pasted line breaks become spaces). The text is the target's draft (kept while
 * the box moves to another line, dropped when the pane closes). While it sends the box is
 * read-only; Rust's refusal shows under it and the focus goes back to it.
 */
function CommentBox({ anchor, target }: { anchor: CommentAnchor; target: ReviewTarget }) {
  const key = draftKey(target);
  const text = useReviewStore((s) => (Object.hasOwn(s.commentDrafts, key) ? (s.commentDrafts[key] ?? "") : ""));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const label = `Comment on ${anchor.path}:${anchor.line}`;
  const send = () => {
    if (sending) return;
    setSending(true);
    setError(null);
    sendComment(text).then(
      () => setSending(false),
      (err: unknown) => {
        setSending(false);
        setError(describe(err));
        input.current?.focus();
      },
    );
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Claimed here: the global bindings (Enter, Esc closing the pane) never see it.
    const action = handleCommentKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    });
    if (action === "send") send();
    else if (action === "cancel") useReviewStore.getState().closeCommentBox();
  };
  const onChange = (event: ReactChangeEvent<HTMLTextAreaElement>) =>
    useReviewStore.getState().setCommentDraft(key, event.target.value.replace(/[\r\n\u2028\u2029]+/g, " "));
  return (
    <section className="review-comment-box" aria-label={label}>
      <label className="review-comment-label">
        <span className="review-comment-where">{label}</span>
        <textarea
          className="launch-input review-comment-input"
          rows={1}
          value={text}
          autoFocus
          ref={input}
          aria-label={label}
          readOnly={sending}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
      </label>
      <p className="review-comment-hint">ctrl+Enter sends · Esc cancels</p>
      {error !== null && (
        <p className="pane-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Story 8.4: the comments sent to the session this run, oldest first, each with its state. */
function CommentList({ comments }: { comments: readonly ReviewComment[] }) {
  return (
    <section className="review-comments" aria-label="Comments">
      <ul className="review-rows" aria-live="polite">
        {comments.map((comment) => {
          const { where, body } = commentRow(comment);
          return (
            <li key={comment.id} className="review-comment" title={comment.text}>
              <span className="review-comment-where">{where}</span>
              <span className="review-comment-text">{body}</span>
              <span className="review-comment-state">{comment.state}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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

function FileButton({ file, name, depth, selected, touched }: { file: ChangedFile; name: string; depth: number; selected: boolean; touched: boolean }) {
  const { mark } = statusMark(file.status);
  const label = withTouched(rowLabel(file, file.path), touched);
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
      {touched && <TouchedMark />}
      <span className="review-counts">{countsText(file)}</span>
    </button>
  );
}

/** Story 8.4: the muted `•` on a row the session touched. */
function TouchedMark() {
  return (
    <span className="review-touched" title={TOUCHED_TITLE} aria-hidden="true">
      {TOUCHED_MARK}
    </span>
  );
}

function TreeRowItem({ row, selected, touched }: { row: TreeRow; selected: string | null; touched: ReadonlySet<string> }) {
  if (row.kind === "dir") {
    return (
      <li className="review-dir" style={{ paddingLeft: `${0.5 + row.depth * 0.85}rem` }}>
        {row.name}/
      </li>
    );
  }
  return (
    <li>
      <FileButton file={row.file} name={row.name} depth={row.depth} selected={selected === row.file.path} touched={touched.has(row.file.path)} />
    </li>
  );
}

function RequestedRows({ row, selected, touched }: { row: RequestedRow; selected: string | null; touched: ReadonlySet<string> }) {
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
          <FileButton file={file} name={file.path} depth={0} selected={selected === file.path} touched={touched.has(file.path)} />
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

/** Story 8.3: the Files tree's folders as last read, for one target. */
type Folders = { key: string; map: Readonly<Record<string, FolderState>> };

/** Story 8.3: the file Files shows: for which target and path, the reply or its error. */
type ViewState = { key: string; view: FileView | null; error: string | null };

/**
 * Files mode (Story 8.3): the folder's tree, each folder read when it is first opened (and every
 * open one again on Refresh), beside the selected file's read-only view.
 */
function FilesBody({ target, refreshSeq }: { target: ReviewTarget; refreshSeq: number }) {
  const open = useReviewStore((s) => s.filesOpen);
  const selected = useReviewStore((s) => s.selected);
  const targetKey = JSON.stringify(target);
  const [folders, setFolders] = useState<Folders>({ key: targetKey, map: {} });
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  // Each folder's latest read: an older reply never replaces a newer one.
  const reads = useRef(new Map<string, number>());
  const lastRefresh = useRef<{ key: string; seq: number } | null>(null);

  useEffect(() => {
    const refreshing = lastRefresh.current === null || lastRefresh.current.key !== targetKey || lastRefresh.current.seq !== refreshSeq;
    lastRefresh.current = { key: targetKey, seq: refreshSeq };
    const current = foldersRef.current.key === targetKey ? foldersRef.current.map : {};
    const { kept, toRead } = foldersToRead(current, open, refreshing);
    setFolders({ key: targetKey, map: kept });
    for (const path of toRead) {
      const id = (reads.current.get(path) ?? 0) + 1;
      reads.current.set(path, id);
      const apply = (state: FolderState) => {
        if (reads.current.get(path) !== id) return;
        setFolders((s) => (s.key !== targetKey || !Object.hasOwn(s.map, path) ? s : { key: s.key, map: { ...s.map, [path]: state } }));
        if (path === "" && state.listing !== null) useReviewStore.getState().setRoot(state.listing.root);
      };
      reviewDir(target, path).then(
        (listing) => apply({ listing, error: null }),
        (err: unknown) => apply({ listing: null, error: describe(err) }),
      );
    }
    // `targetKey` names the target; `open` and `refreshSeq` decide what is read.
  }, [targetKey, open, refreshSeq]);

  // Story 8.4: a session's touched files, read with the tree (on opening and on every Refresh).
  const touchedSeq = useReviewStore((s) => s.touchedSeq);
  const [touched, setTouched] = useState<{ key: string; set: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    if (target.kind !== "session") return;
    let live = true;
    reviewTouched(target).then(
      (keys) => {
        if (!live) return;
        const next = touchedFor(target, "files", { touched: keys });
        // The same marks again keep the rows as they are.
        setTouched((prev) =>
          prev !== null && prev.key === targetKey && prev.set.size === next.length && next.every((k) => prev.set.has(k)) ? prev : { key: targetKey, set: new Set(next) },
        );
      },
      (err: unknown) => console.warn(`touched files read failed: ${describe(err)}`),
    );
    return () => {
      live = false;
    };
    // `targetKey` names the target; Refresh and the git poll (`touchedSeq`) read it again.
  }, [targetKey, refreshSeq, touchedSeq]);
  const touchedSet = touched !== null && touched.key === targetKey ? touched.set : NO_TOUCHED_SET;

  const map = folders.key === targetKey ? folders.map : NO_FOLDERS;
  const rows = useMemo(() => filesRows(map, open), [map, open]);
  const order = useMemo(() => filesOrder(rows), [rows]);
  useEffect(() => {
    useReviewStore.getState().setOrder(order);
  }, [order]);

  // The selected file's text, read again on every Refresh.
  const [view, setView] = useState<ViewState | null>(null);
  const viewKey = selected === null ? null : `${targetKey}\u0000${selected}`;
  useEffect(() => {
    if (viewKey === null || selected === null) {
      setView(null);
      return;
    }
    let live = true;
    const kind = languageFor(selected);
    if (kind !== null) void loadLanguage(kind).catch(() => undefined);
    reviewView(target, selected).then(
      (reply) => {
        if (!live) return;
        // The same text again keeps the shown view (and its cursor) as it is.
        setView((prev) => (prev !== null && prev.key === viewKey && prev.error === null && JSON.stringify(prev.view) === JSON.stringify(reply) ? prev : { key: viewKey, view: reply, error: null }));
      },
      (err: unknown) => {
        if (live) setView({ key: viewKey, view: null, error: describe(err) });
      },
    );
    return () => {
      live = false;
    };
    // `viewKey` covers the target and the path.
  }, [viewKey, refreshSeq]);

  return (
    <div className="review-body">
      <nav className="review-tree" aria-label="Files">
        <ul className="review-rows">
          {rows.map((row) => (
            <FilesRowItem key={row.key} row={row} selected={selected} touched={touchedSet} />
          ))}
        </ul>
      </nav>
      <section className="review-view" aria-label="File">
        <FileViewArea path={selected} state={view} viewKey={viewKey} />
      </section>
    </div>
  );
}

const NO_FOLDERS: Readonly<Record<string, FolderState>> = Object.freeze({});

function indent(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${0.5 + depth * 0.85}rem` };
}

/** One row of the Files tree: a folder (opens and closes), a file or a link (selects), or a folder's state. */
function FilesRowItem({ row, selected, touched }: { row: FilesRow; selected: string | null; touched: ReadonlySet<string> }) {
  if (row.kind === "loading") {
    return (
      <li className="muted review-files-note" style={indent(row.depth)}>
        Reading…
      </li>
    );
  }
  if (row.kind === "error") {
    return (
      <li className="pane-error review-files-note" role="alert" style={indent(row.depth)}>
        {row.message}
      </li>
    );
  }
  if (row.kind === "more") {
    return (
      <li className="muted review-files-note" style={indent(row.depth)}>
        {moreEntriesText(row.count)}
      </li>
    );
  }
  const dir = row.entryKind === "dir";
  const isTouched = !dir && touched.has(row.path);
  const label = withTouched(
    `${row.path}${dir ? "/" : ""}${row.entryKind === "link" ? ", link" : ""}${row.ignored ? ", ignored" : ""}${row.unreadable ? ", unreadable name" : ""}`,
    isTouched,
  );
  return (
    <li>
      <button
        type="button"
        className={row.ignored ? "review-row review-ignored" : "review-row"}
        style={indent(row.depth)}
        aria-label={label}
        title={label}
        aria-expanded={dir ? row.open : undefined}
        aria-current={!dir && selected === row.path ? "true" : undefined}
        disabled={row.unreadable}
        onClick={() => (dir ? useReviewStore.getState().toggleFolder(row.path) : select(row.path))}
      >
        <span className="review-mark" aria-hidden="true">
          {dir ? (row.open ? "▾" : "▸") : ""}
        </span>
        <span className="review-name">
          {row.name}
          {dir ? "/" : ""}
        </span>
        {isTouched && <TouchedMark />}
        {row.entryKind === "link" && <span className="review-counts">link</span>}
      </button>
    </li>
  );
}

/** Files mode's right side: the selected file, read-only, or why it is not shown. */
function FileViewArea({ path, state, viewKey }: { path: string | null; state: ViewState | null; viewKey: string | null }) {
  if (path === null) return <p className="muted review-note">No file selected.</p>;
  if (state === null || state.key !== viewKey) return <p className="muted review-note">Reading {path}…</p>;
  if (state.error !== null) {
    return (
      <p className="pane-error review-note" role="alert">
        {state.error}
      </p>
    );
  }
  const content = state.view?.content;
  if (content === undefined) return null;
  if (content.kind === "binary") return <p className="muted review-note">binary file</p>;
  if (content.kind === "too_large") return <p className="muted review-note">too large to show</p>;
  if (content.kind !== "text") return <p className="muted review-note">{content.kind === "submodule" ? "submodule" : "unreadable name"}</p>;
  return (
    <div className="review-diff-wrap">
      {content.notUtf8 && <p className="review-mark-line">not UTF-8 (shown lossily)</p>}
      <ErrorBoundary
        label="file view"
        resetKey={`${path} ${viewKey}`}
        fallback={(message) => (
          <p className="pane-error review-note" role="alert">
            could not show this file: {message}
          </p>
        )}
      >
        <Suspense fallback={<p className="muted review-note">Loading the file view…</p>}>
          <SourceView path={path} text={content.new ?? ""} />
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
