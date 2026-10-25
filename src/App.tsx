import { Suspense, lazy, useEffect } from "react";
import {
  approvalsGet,
  edgesLiveGet,
  hasTauriRuntime,
  inboxUnreadGet,
  liveSessionsGet,
  onAgentStarted,
  onApprovalNotice,
  onApprovals,
  onEdgesLive,
  onInboxUnread,
  onLiveSessions,
  onNotifyReveal,
  onReviewComments,
  onReviewRequests,
  onProjectsStatus,
  onSettingsChanged,
  onWorkspaceChanged,
  projectsStatusGet,
  reviewRequestsGet,
  settingsGet,
  workspaceGet,
} from "./ipc";
import { mirror } from "./ipc/mirror";
import { revealToastSession } from "./commands/attention";
import { notify } from "./commands/navigation";
import { registerBuiltins } from "./commands/builtins";
import { useKeybindings } from "./commands/keybindings";
import { forgetTerminal } from "./commands/terminal";
import { useApprovalsStore } from "./state/approvals";
import { useEdgesLiveStore } from "./state/edgesLive";
import { useInboxStore } from "./state/inbox";
import { useReviewStore } from "./state/review";
import { useTerminalStore } from "./state/terminals";
import { useLiveStore } from "./state/live";
import { useSettingsStore } from "./state/settings";
import { useStatusStore } from "./state/status";
import { useUiStore } from "./state/ui";
import { useWorkspaceStore } from "./state/workspace";
import { Canvas } from "./canvas/Canvas";
import { ApprovalToasts } from "./components/ApprovalToasts";
import { Banners } from "./components/Banners";
import { ContextMenu } from "./components/ContextMenu";
import { EdgePane } from "./components/EdgePane";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { runCommand } from "./commands/registry";
import { ElsewhereTray } from "./components/ElsewhereTray";
import { ImportPane } from "./components/ImportPane";
import { LaunchPane } from "./components/LaunchPane";
import { WorktreePane } from "./components/WorktreePane";
import { RemoveWorktreePane } from "./components/RemoveWorktreePane";
import { Notice } from "./components/Notice";
import { Palette } from "./components/Palette";
import { SettingsPane } from "./components/SettingsPane";
import { connectTerminals } from "./terminal/registry";
import { TerminalHolder, TerminalPane } from "./terminal/TerminalPane";
import "./components/shell.css";

// The Review pane (Story 8.1) and its CodeMirror diff view are their own chunks, loaded when the
// pane first opens.
const ReviewPane = lazy(() => import("./components/ReviewPane"));

// Commands exist for the life of the module, not of a component: registered once here.
registerBuiltins();

/**
 * The shell: banner strip on top, the canvas filling the rest with the transient notice laid
 * over its top edge, the Elsewhere tray at its bottom-left and the agent approval toasts (Story
 * 7.2) at its bottom-right, one pane (settings, import, terminal, the launch sheet, the worktree sheet, the remove-worktree sheet, the edge inspector or the Review pane of Story 8.1, loaded lazily) on the right when open,
 * the hidden holder that keeps every terminal's view alive while the terminal pane is not showing it, the command
 * palette over everything when open, the node context menu at the pointer when open. Every
 * key goes through the command registry's dispatcher (`useKeybindings`).
 */
export default function App() {
  const pane = useUiStore((s) => s.pane);
  const applySettings = useSettingsStore((s) => s.applySnapshot);
  const setSettingsLoadError = useSettingsStore((s) => s.setLoadError);
  const applyWorkspace = useWorkspaceStore((s) => s.applySnapshot);
  const setWorkspaceLoadError = useWorkspaceStore((s) => s.setLoadError);
  const applyStatuses = useStatusStore((s) => s.applyStatuses);
  const setStatusLoadError = useStatusStore((s) => s.setLoadError);
  const applyLive = useLiveStore((s) => s.applySnapshot);
  const setLiveLoadError = useLiveStore((s) => s.setLoadError);
  const applyEdgesLive = useEdgesLiveStore((s) => s.applySnapshot);
  const setEdgesLiveLoadError = useEdgesLiveStore((s) => s.setLoadError);
  const applyApprovals = useApprovalsStore((s) => s.applySnapshot);
  const setApprovalsLoadError = useApprovalsStore((s) => s.setLoadError);
  const applyInbox = useInboxStore((s) => s.applySnapshot);
  const setInboxLoadError = useInboxStore((s) => s.setLoadError);
  const applyReview = useReviewStore((s) => s.applySnapshot);
  const setReviewLoadError = useReviewStore((s) => s.setLoadError);

  // Rust is the source of truth for all four; `mirror` subscribes, then reads.
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onSettingsChanged,
      get: settingsGet,
      apply: applySettings,
      hasSnapshot: () => useSettingsStore.getState().snapshot !== null,
      fail: (message) => setSettingsLoadError(`settings load failed: ${message}`),
    });
  }, [applySettings, setSettingsLoadError]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onWorkspaceChanged,
      get: workspaceGet,
      apply: applyWorkspace,
      hasSnapshot: () => useWorkspaceStore.getState().snapshot !== null,
      fail: (message) => setWorkspaceLoadError(`workspace load failed: ${message}`),
    });
  }, [applyWorkspace, setWorkspaceLoadError]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onProjectsStatus,
      get: projectsStatusGet,
      apply: applyStatuses,
      hasSnapshot: () => useStatusStore.getState().received,
      // Cards then stay at "…"; the workspace itself is fine, so no banner.
      fail: (message) => setStatusLoadError(`status load failed: ${message}`),
    });
  }, [applyStatuses, setStatusLoadError]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onLiveSessions,
      get: liveSessionsGet,
      apply: applyLive,
      hasSnapshot: () => useLiveStore.getState().received,
      fail: (message) => setLiveLoadError(`live sessions load failed: ${message}`),
    });
  }, [applyLive, setLiveLoadError]);

  // Story 6.3: what each context edge on a running session does now (runtime only).
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onEdgesLive,
      get: edgesLiveGet,
      apply: applyEdgesLive,
      hasSnapshot: () => useEdgesLiveStore.getState().received,
      // The inspector then says what each edge does at the next launch; no banner.
      fail: (message) => setEdgesLiveLoadError(`live edges load failed: ${message}`),
    });
  }, [applyEdgesLive, setEdgesLiveLoadError]);

  // Story 7.2: the agents' requests waiting on the operator (runtime only).
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onApprovals,
      get: approvalsGet,
      apply: applyApprovals,
      hasSnapshot: () => useApprovalsStore.getState().received,
      // No toasts then; a waiting agent is denied at its deadline.
      fail: (message) => setApprovalsLoadError(`approvals load failed: ${message}`),
    });
  }, [applyApprovals, setApprovalsLoadError]);

  // Story 7.3: each session's unread peer-message count, for the `N new` badge (runtime only).
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onInboxUnread,
      get: inboxUnreadGet,
      apply: applyInbox,
      hasSnapshot: () => useInboxStore.getState().received,
      // No badges then; the agents still read their inbox.
      fail: (message) => setInboxLoadError(`inbox load failed: ${message}`),
    });
  }, [applyInbox, setInboxLoadError]);

  // Story 7.4: each session's review request and flag (runtime only).
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    return mirror({
      listen: onReviewRequests,
      get: reviewRequestsGet,
      apply: applyReview,
      hasSnapshot: () => useReviewStore.getState().received,
      // No flags or review toasts then: the banner says so.
      fail: (message) => setReviewLoadError(`review requests load failed: ${message}`),
    });
  }, [applyReview, setReviewLoadError]);

  // Story 7.2: an act that ran without a toast says so in the notice; a session an agent started
  // is known to the terminal store at once, in the background (nothing is focused).
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    const unlisten: (() => void)[] = [];
    let disposed = false;
    const keep = (fn: () => void) => {
      if (disposed) fn();
      else unlisten.push(fn);
    };
    void onApprovalNotice((text) => notify(text)).then(keep);
    // Story 8.4: every line comment of this run with its state (the pane reads its target's on opening).
    void onReviewComments((comments) => useReviewStore.getState().applyComments(comments)).then(keep);
    void onAgentStarted((term) => useTerminalStore.getState().upsert(term)).then(keep);
    return () => {
      disposed = true;
      for (const fn of unlisten) fn();
    };
  }, []);

  // A click on an OS toast: Rust has focused the window; reveal and select its session
  // (Story 3.3), or open its review (Story 7.4).
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onNotifyReveal((request) => {
      void revealToastSession(request);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Terminal output and exits stream in for every terminal, shown or not (Story 4.1).
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    // A terminal closed in a pop-out window (Story 4.5) leaves the pane too.
    return connectTerminals({ onClosed: forgetTerminal });
  }, []);

  useKeybindings();

  return (
    <div className="shell">
      <Banners />
      <div className="shell-body">
        <Canvas />
        <ElsewhereTray />
        <Notice />
        <ApprovalToasts />
        {pane === "settings" && <SettingsPane />}
        {pane === "import" && <ImportPane />}
        {pane === "launch" && <LaunchPane />}
        {pane === "worktree" && <WorktreePane />}
        {pane === "removeWorktree" && <RemoveWorktreePane />}
        {pane === "edge" && <EdgePane />}
        {pane === "review" && (
          <ErrorBoundary label="review pane" fallback={(message) => <ReviewPaneFailed message={message} />}>
            <Suspense fallback={null}>
              <ReviewPane />
            </Suspense>
          </ErrorBoundary>
        )}
        {pane === "terminal" && <TerminalPane />}
        <TerminalHolder />
        <Palette />
        <ContextMenu />
      </div>
    </div>
  );
}

/** What the Review pane leaves when it failed: one error line and Close; the rest of the app stays. */
function ReviewPaneFailed({ message }: { message: string }) {
  return (
    <aside className="pane" aria-label="Review">
      <header className="pane-header">
        <h2 className="pane-title">Review</h2>
        <button type="button" className="btn" onClick={() => runCommand("pane.close")} title="Close (Esc)">
          Close
        </button>
      </header>
      <p className="pane-error" role="alert">
        could not show the review: {message}
      </p>
    </aside>
  );
}
