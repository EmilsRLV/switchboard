import { Suspense, lazy, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { runCommand } from "../commands/registry";
import { reviewFile, reviewList, type ChangeList, type ChangedFile, type FileText, type RequestedKey, type ReviewRequest, type ReviewTarget } from "../ipc";
import { requestIn, useReviewStore } from "../state/review";
import { REVIEW_WIDTH_KEY, clampReviewWidth, defaultReviewWidth, saveWidth, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import {
  FILTERS,
  buildTree,
  countsText,
  fileOrder,
  languageFor,
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
 */
export function ReviewPane() {
  const target = useReviewStore((s) => s.target);
  const requestId = useReviewStore((s) => s.requestId);
  const requests = useReviewStore((s) => s.requests);
  const filter = useReviewStore((s) => s.filter);
  const layout = useReviewStore((s) => s.layout);
  const selected = useReviewStore((s) => s.selected);
  const refreshSeq = useReviewStore((s) => s.refreshSeq);
  const stored = useUiStore((s) => s.reviewWidth);
  const [viewport, setViewport] = useState(viewportWidth);
  const width = clampReviewWidth(stored ?? defaultReviewWidth(viewport), viewport);
  const request = requestId === null ? null : requestIn(requests, requestId);
  const title = useTargetTitle(target, request);

  useEffect(() => {
    const onResize = () => setViewport(viewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The list: read on open, on a filter change, on Refresh and when the status poll moves.
  const [listState, setListState] = useState<ListState>({ list: null, error: null, loading: true });
  const listFor = useRef<string | null>(null);
  useEffect(() => {
    if (target === null) return;
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
  }, [target, filter, refreshSeq]);

  const files = listState.list?.files ?? NO_FILES;
  // A request's paths as Rust keyed them to this folder (only while the pane shows a request).
  const requestKeys = requestId === null ? NO_KEYS : (listState.list?.requested ?? NO_KEYS);
  const { requested, rest } = useMemo(() => orderForRequest(files, requestKeys), [files, requestKeys]);
  const tree = useMemo(() => buildTree(rest), [rest]);
  const order = useMemo(() => fileOrder(requested, tree), [requested, tree]);

  // Keep the store's order (for stepping) and the selection on a listed file.
  useEffect(() => {
    const store = useReviewStore.getState();
    store.setOrder(order);
    if (listState.list === null) return;
    store.select(pickSelected(store.selected, order));
  }, [order, listState.list]);

  const selectedFile = selected === null ? null : (files.find((f) => f.path === selected) ?? null);
  const selectedMark = selected === null ? null : (requested.find((r) => r.key === selected) ?? null);

  // The selected file's text, read again whenever the list is and on every Refresh.
  const [fileState, setFileState] = useState<FileState | null>(null);
  const fileKey = selectedFile === null || target === null ? null : `${JSON.stringify(target)}\u0000${filter}\u0000${selectedFile.path}`;
  useEffect(() => {
    if (fileKey === null || target === null || selectedFile === null) {
      setFileState(null);
      return;
    }
    let live = true;
    const kind = languageFor(selectedFile.path);
    if (kind !== null) void loadLanguage(kind).catch(() => undefined);
    reviewFile(target, selectedFile.path, filter).then(
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
    // `listState.list` and `refreshSeq` re-read the text after every list read and every Refresh.
  }, [fileKey, target, listState.list, refreshSeq]);

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

  return (
    <aside className="pane review-pane" aria-label={`Review: ${title}`} style={{ width: `${width}px` }}>
      <div className="terminal-drag" role="separator" aria-orientation="vertical" aria-label="Resize review pane" onPointerDown={onDragStart} />
      <header className="review-header">
        <h2 className="pane-title review-title" title={title}>
          {title}
        </h2>
        <span className="review-root" title={listState.list?.root}>
          {listState.list?.root ?? ""}
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
        <span className="review-totals">
          {listState.list === null ? "" : `${sum.files} ${sum.files === 1 ? "file" : "files"} +${sum.added} −${sum.removed}`}
        </span>
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
        <nav className="review-tree" aria-label="Changed files">
          {listState.error !== null ? (
            <p className="pane-error" role="alert">
              {listState.error}
            </p>
          ) : listState.list === null ? (
            <p className="muted">Reading changes…</p>
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
                <p className="muted">No changes</p>
              ) : (
                <ul className="review-rows">
                  {tree.map((row) => (
                    <TreeRowItem key={row.key} row={row} selected={selected} />
                  ))}
                </ul>
              )}
              {listState.list.more > 0 && <p className="muted review-more">{listState.list.more} more files not shown</p>}
            </>
          )}
        </nav>
        <section className="review-view" aria-label="Diff">
          <DiffArea file={selectedFile} mark={selectedMark} state={fileState} fileKey={fileKey} layout={layout} />
        </section>
      </div>
    </aside>
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
