import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import "../components/shell.css";
import { forgetTerminal } from "../commands/terminal";
import { Notice } from "../components/Notice";
import { hasTauriRuntime } from "../ipc";
import { startActivityReporter } from "../perf";
import { useTerminalStore } from "../state/terminals";
import { TERMINAL_ATTRIBUTE } from "./keys";
import { connectTerminals } from "./registry";
import { TerminalHeader, TerminalHolder, useHostedView } from "./TerminalPane";

/**
 * The root of a pop-out window (Story 4.5, `index.html?terminal=<id>`): that one terminal and
 * nothing else. A header with its title, state, Restart / Close / Kill as in the pane and
 * "Return to pane", then the xterm view filling the window. The view is this window's own: it
 * replays `term_buffer` (dropping what the live chunks repeat), then follows `term://data` for
 * this id only. Input goes through `term_write`, and this window owns the PTY's size while it
 * is open. Keys are the terminal's (copy and paste included, the app's pass-through keys too);
 * no canvas command runs here, and Alt+F4 closes the window. The window stays when the process
 * exits, showing `exited N`. An action's failure is the notice, over the top of this window.
 */
export function TerminalWindow({ id }: { id: string }) {
  const info = useTerminalStore((s) => (Object.hasOwn(s.infos, id) ? s.infos[id] : undefined));
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    // Closed for good (its Close here or in the pane): Rust closes this window too.
    return connectTerminals({ only: id, onClosed: forgetTerminal });
  }, [id]);

  // Story 9.6: input in a pop-out counts as use too (the memory target stays Normal).
  useEffect(() => startActivityReporter(), []);

  const title = info?.title ?? "";
  useEffect(() => {
    document.title = title === "" ? "Switchboard terminal" : `${title} — Switchboard terminal`;
  }, [title]);

  useHostedView(id, true, hostRef, () => true);

  const terminalProps = { [TERMINAL_ATTRIBUTE]: "" };
  return (
    <div className="terminal-window" aria-label="Terminal">
      <TerminalHeader id={id} info={info} where="window" popped={false} />
      <div className="terminal-host" ref={hostRef} {...terminalProps} />
      {/* A refused Restart, Kill or Close shows here, in this window. */}
      <Notice />
      <TerminalHolder />
    </div>
  );
}
