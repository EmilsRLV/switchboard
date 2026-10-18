import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import "@xterm/xterm/css/xterm.css";
import { runCommand } from "../commands/registry";
import { isTerminalRestartable, terminalStateText, useTerminalStore } from "../state/terminals";
import { clampTerminalWidth, defaultTerminalWidth, saveTerminalWidth, useUiStore } from "../state/ui";
import { TERMINAL_ATTRIBUTE } from "./keys";
import { focusView, hideView, setHolder, showView, subscribeViews, syncSize, viewVersion } from "./registry";

/** How long the pane waits after the last size change before refitting and resizing the PTY. */
export const RESIZE_DEBOUNCE_MS = 50;

function viewportWidth(): number {
  return typeof window === "undefined" ? 1280 : window.innerWidth;
}

/**
 * The terminal pane (Story 4.1): wider than the other panes and resizable by dragging its left
 * edge, it shows one terminal, the active one. The header has the project (or, for a launched
 * session, its name), its folder, the state (`running` / `exited N`, or why the shell could not
 * start) and Restart (plain terminals only) / Close (an exited session terminal) / Hide / Kill,
 * which run the registry commands. The body is the xterm view; focus inside it belongs to the
 * terminal (`[data-terminal]`). Hiding moves the view back to the hidden holder: the process and
 * its output carry on.
 */
export function TerminalPane() {
  const id = useUiStore((s) => s.activeTerminal);
  const stored = useUiStore((s) => s.terminalWidth);
  const info = useTerminalStore((s) => (id !== null && Object.hasOwn(s.infos, id) ? s.infos[id] : undefined));
  const [viewport, setViewport] = useState(viewportWidth);
  const hostRef = useRef<HTMLDivElement>(null);
  const width = clampTerminalWidth(stored ?? defaultTerminalWidth(viewport), viewport);

  useEffect(() => {
    const onResize = () => setViewport(viewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The active terminal's view instance: a resumed session gets a fresh view under the same
  // id (Story 4.4), and the pane must show that one, not the disposed one.
  const version = useSyncExternalStore(subscribeViews, () => (id === null ? 0 : viewVersion(id)));

  // Show the active terminal here and focus it; put it back in the holder when it goes.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (id === null || host === null) return;
    showView(id, host);
    syncSize(id);
    focusView(id);
    return () => hideView(id);
  }, [id, version]);

  // Once Rust knows the terminal (its info arrived), it gets the pane's size.
  const known = info !== undefined;
  useEffect(() => {
    if (id !== null && known) syncSize(id);
  }, [id, known]);

  // Dragging the edge or resizing the window: refit and resize the PTY, debounced.
  useEffect(() => {
    const host = hostRef.current;
    if (id === null || host === null || typeof ResizeObserver === "undefined") return;
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
  }, [id]);

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
      if (id !== null) focusView(id);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const exited = info !== undefined && info.exited !== null;
  // A session terminal is never restarted (its session is resumed instead); once exited it closes.
  const restartable = isTerminalRestartable(id);
  const closable = exited && info.kind === "session";
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
          {restartable && (
            <button type="button" className="btn" onClick={() => runCommand("terminal.restart")}>
              Restart
            </button>
          )}
          {closable && (
            <button type="button" className="btn" onClick={() => runCommand("terminal.close")} title="Close this exited session's terminal">
              Close
            </button>
          )}
          <button type="button" className="btn" onClick={() => runCommand("terminal.toggle")} title="Hide (ctrl+`)">
            Hide
          </button>
          {info !== undefined && !exited && (
            <button type="button" className="btn" onClick={() => runCommand("terminal.kill")}>
              Kill
            </button>
          )}
        </span>
      </header>
      <div className="terminal-host" ref={hostRef} {...terminalProps} />
    </aside>
  );
}

/**
 * The always-mounted hidden holder: every terminal's view lives here while the pane does not
 * show it, so its process keeps writing into it.
 */
export function TerminalHolder() {
  return <div className="terminal-holder" aria-hidden="true" ref={setHolder} />;
}
