import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import "@xterm/xterm/css/xterm.css";
import type { TermInfo } from "../ipc";
import { runCommand } from "../commands/registry";
import {
  activateTab,
  closeTerminal,
  closeTerminalTab,
  isClosableTerminal,
  killTerminal,
  restartTerminal,
  returnToPane,
} from "../commands/terminal";
import { sessionState, useLiveStore } from "../state/live";
import { isTerminalRestartable, sessionIdOfTerminal, tabState, terminalStateText, useTerminalStore } from "../state/terminals";
import { clampTerminalWidth, defaultTerminalWidth, saveTerminalWidth, useUiStore } from "../state/ui";
import { TERMINAL_ATTRIBUTE } from "./keys";
import { focusView, hideView, setHolder, showView, subscribeViews, syncSize, viewVersion } from "./registry";

/** How long the pane waits after the last size change before refitting and resizing the PTY. */
export const RESIZE_DEBOUNCE_MS = 50;

/** The mark of a tab whose terminal is in its own window. */
export const POPPED_MARK = "↗";

function viewportWidth(): number {
  return typeof window === "undefined" ? 1280 : window.innerWidth;
}

/** The terminal info of `id` from the store, or `undefined`. */
function useTermInfo(id: string | null): TermInfo | undefined {
  return useTerminalStore((s) => (id !== null && Object.hasOwn(s.infos, id) ? s.infos[id] : undefined));
}

/**
 * Keep `id`'s full view in `host` while `show` holds: made (Story 9.5: replayed from the ring),
 * fitted (the PTY gets the size) and, when `focus()` says so, focused; disposed when it goes, its
 * shadow answering the program again (a pop-out's view moves back to the hidden holder instead).
 * Dragging an edge or resizing the window refits and resizes the PTY, debounced.
 */
export function useHostedView(id: string | null, show: boolean, hostRef: React.RefObject<HTMLDivElement | null>, focus: () => boolean): void {
  // The view instance: a resumed session gets a fresh view under the same id (Story 4.4), and
  // the host must show that one, not the disposed one.
  const version = useSyncExternalStore(subscribeViews, () => (id === null ? 0 : viewVersion(id)));

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (id === null || host === null || !show) return;
    showView(id, host);
    syncSize(id);
    if (focus()) focusView(id);
    return () => hideView(id);
    // `focus` is read when the view is shown, not a reason to show it again.
  }, [id, version, show, hostRef]);

  // Once Rust knows the terminal (its info arrived), it gets the host's size.
  const known = useTermInfo(id) !== undefined;
  useEffect(() => {
    if (id !== null && known && show) syncSize(id);
  }, [id, known, show]);

  useEffect(() => {
    const host = hostRef.current;
    if (id === null || host === null || !show || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => syncSize(id), RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [id, show, hostRef]);
}

/**
 * The terminal pane (Story 4.1): wider than the other panes and resizable by dragging its left
 * edge. Story 4.5 adds a tab strip (every terminal opened or shown here, scrolling sideways);
 * the pane shows the active tab. The header has the project (or, for a launched session, its
 * name), its folder, the state (`running` / `exited N`, or why the shell could not start) and
 * Restart (plain terminals only) / Close (an exited session terminal) / Pop out / Hide / Kill.
 * The body is the xterm view; focus inside it belongs to the terminal (`[data-terminal]`). A
 * popped-out terminal shows a placeholder instead ("In its own window"), with no full view here.
 * Hiding disposes the full view (Story 9.5): the process carries on, its output followed by the
 * terminal's shadow, and showing it again replays the ring.
 */
export function TerminalPane() {
  const id = useUiStore((s) => s.activeTerminal);
  const stored = useUiStore((s) => s.terminalWidth);
  const popped = useUiStore((s) => id !== null && Object.hasOwn(s.poppedOut, id));
  const info = useTermInfo(id);
  const [viewport, setViewport] = useState(viewportWidth);
  const hostRef = useRef<HTMLDivElement>(null);
  const width = clampTerminalWidth(stored ?? defaultTerminalWidth(viewport), viewport);

  useEffect(() => {
    const onResize = () => setViewport(viewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A switch made by selecting a node keeps focus on the canvas (`focusOnShow` false).
  useHostedView(id, !popped, hostRef, () => useUiStore.getState().focusOnShow);

  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      useUiStore.getState().setTerminalWidth(clampTerminalWidth(window.innerWidth - e.clientX, window.innerWidth));
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      const width = useUiStore.getState().terminalWidth;
      if (width !== null) saveTerminalWidth(width);
      if (id !== null && !popped) focusView(id);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const terminalProps = { [TERMINAL_ATTRIBUTE]: "" };

  return (
    <aside className="pane terminal-pane" aria-label="Terminal" style={{ width: `${width}px` }}>
      <div
        className="terminal-drag"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize terminal pane"
        onPointerDown={onDragStart}
      />
      <TerminalTabs />
      <TerminalHeader id={id} info={info} where="pane" popped={popped} />
      {popped && id !== null && (
        <div className="terminal-popped" role="status">
          <span className="terminal-popped-text">In its own window</span>
          <span className="terminal-actions">
            <button type="button" className="btn" onClick={() => runCommand("terminal.focusWindow")}>
              Focus window
            </button>
            <button type="button" className="btn" onClick={() => runCommand("terminal.returnToPane")}>
              Return to pane
            </button>
          </span>
        </div>
      )}
      <div className="terminal-host" ref={hostRef} hidden={popped} {...terminalProps} />
    </aside>
  );
}

const CLOSE_TITLE = "Close this exited session's terminal";

/**
 * Which of the header's action buttons show. In the pane each runs the command beside it in
 * {@link HEADER_BUTTON_COMMANDS} on the pane's terminal (`id`); a popped-out tab keeps none of them.
 */
export function headerButtons(
  id: string | null,
  info: TermInfo | undefined,
  where: "pane" | "window",
  popped: boolean,
): { restart: boolean; close: boolean; popOut: boolean; kill: boolean } {
  const actions = !(where === "pane" && popped);
  return {
    // A session terminal is never restarted (its session is resumed instead); once exited it closes.
    restart: actions && isTerminalRestartable(id),
    close: actions && isClosableTerminal(id),
    popOut: where === "pane" && id !== null && info !== undefined && !popped,
    kill: actions && info !== undefined && info.exited === null,
  };
}

export const HEADER_BUTTON_COMMANDS = { restart: "terminal.restart", close: "terminal.close", popOut: "terminal.popOut", kill: "terminal.kill" } as const;

/**
 * A terminal's header row, in the pane (`where="pane"`: Pop out and Hide too) or in its pop-out
 * window (`where="window"`: Return to pane). Restart / Close / Kill act on `id` itself. In the
 * pane, a popped-out terminal keeps only its title, state and Hide: its window has the rest, and
 * the placeholder below offers Focus window and Return to pane.
 *
 * Story 9.4: in the pane every button runs its command (`terminal.restart`, `terminal.close`,
 * `terminal.popOut`, `terminal.kill`: they act on the pane's terminal, which is `id`). A pop-out
 * window has no command registry, so there the buttons act on its own terminal directly.
 */
export function TerminalHeader({ id, info, where, popped }: { id: string | null; info: TermInfo | undefined; where: "pane" | "window"; popped: boolean }) {
  const { restart: restartable, close: closable, popOut, kill } = headerButtons(id, info, where, popped);
  return (
    <header className="terminal-header">
      <span className="terminal-title">{info?.title ?? ""}</span>
      <span className="terminal-cwd" title={info?.cwd}>
        {info?.cwd ?? ""}
      </span>
      {info !== undefined && (
        <span className={info.error !== null ? "terminal-state pane-error" : "terminal-state"} title={terminalStateText(info)}>
          {terminalStateText(info)}
        </span>
      )}
      <span className="terminal-actions">
        {restartable && where === "pane" && (
          <button type="button" className="btn" onClick={() => runCommand("terminal.restart")}>
            Restart
          </button>
        )}
        {restartable && where === "window" && (
          <button type="button" className="btn" onClick={() => void restartTerminal(id)}>
            Restart
          </button>
        )}
        {closable && where === "pane" && (
          <button type="button" className="btn" onClick={() => runCommand("terminal.close")} title={CLOSE_TITLE}>
            Close
          </button>
        )}
        {closable && where === "window" && (
          <button type="button" className="btn" onClick={() => void closeTerminal(id)} title={CLOSE_TITLE}>
            Close
          </button>
        )}
        {popOut && (
          <button type="button" className="btn" onClick={() => runCommand("terminal.popOut")} title="Pop out into its own window">
            Pop out
          </button>
        )}
        {where === "window" && id !== null && (
          <button type="button" className="btn" onClick={() => void returnToPane(id)}>
            Return to pane
          </button>
        )}
        {where === "pane" && (
          <button type="button" className="btn" onClick={() => runCommand("terminal.toggle")} title="Hide (ctrl+`)">
            Hide
          </button>
        )}
        {kill && where === "pane" && (
          <button type="button" className="btn" onClick={() => runCommand("terminal.kill")}>
            Kill
          </button>
        )}
        {kill && where === "window" && (
          <button type="button" className="btn" onClick={() => void killTerminal(id)}>
            Kill
          </button>
        )}
      </span>
    </header>
  );
}

/**
 * The pane's tab strip (Story 4.5): one tab per terminal opened or shown here, in order, each
 * with its title, its state word (muted), the attention dot for a `waiting` / `finished`
 * session, `↗` while it is popped out, and × (the tab goes, the process keeps running). Plain
 * text, the active tab underlined; the strip scrolls sideways. Each tab is a plain button (the
 * active one `aria-current`) with a separate, labelled × button: no tablist semantics.
 */
function TerminalTabs() {
  const tabs = useUiStore((s) => s.openTerminals);
  if (tabs.length === 0) return null;
  return (
    <nav className="terminal-tabs" aria-label="Terminal tabs">
      {tabs.map((id) => (
        <TerminalTab key={id} id={id} />
      ))}
    </nav>
  );
}

function TerminalTab({ id }: { id: string }) {
  const active = useUiStore((s) => s.activeTerminal === id);
  const popped = useUiStore((s) => Object.hasOwn(s.poppedOut, id));
  const info = useTermInfo(id);
  const sessionId = sessionIdOfTerminal(id);
  const session = useLiveStore((s) => (sessionId === null ? null : sessionState(sessionId, s.snapshot.sessions)));
  const state = tabState(info ?? null, session);
  const title = info?.title ?? "…";
  return (
    <div className={active ? "terminal-tab is-active" : "terminal-tab"}>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        className="terminal-tab-label"
        title={popped ? `${title} (in its own window)` : title}
        onClick={() => activateTab(id)}
      >
        <span className="terminal-tab-title">{title}</span>
        {state.word !== "" && (
          <span className="terminal-tab-state">
            {state.attention && <span className="session-attention terminal-tab-dot" aria-hidden="true" />}
            {state.word}
          </span>
        )}
        {popped && (
          <span className="terminal-tab-popped" aria-label="popped out">
            {POPPED_MARK}
          </span>
        )}
      </button>
      <button type="button" className="terminal-tab-close" aria-label={`Close tab ${title}`} title="Close tab" onClick={() => void closeTerminalTab(id)}>
        ×
      </button>
    </div>
  );
}

/**
 * The always-mounted hidden holder: a full view is opened here before it moves into the pane, and
 * a pop-out keeps its view here while not shown. Hidden terminals have no element (Story 9.5).
 */
export function TerminalHolder() {
  return <div className="terminal-holder" aria-hidden="true" ref={setHolder} />;
}
