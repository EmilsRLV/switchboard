import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useUiStore } from "../state/ui";
import { isInsideTerminal } from "../terminal/keys";
import { focusView } from "../terminal/registry";
import { formatKeybinding } from "../commands/keybindings";
import { listCommands } from "../commands/registry";
import { clampSelection, paletteKeyAction, paletteRows, runPaletteRow, usePaletteStore } from "../state/palette";

const OPTION_ID_PREFIX = "palette-option-";

/**
 * The command palette (`ctrl+k`): a centred overlay with an input and the enabled commands,
 * filtered as you type. ↑/↓ move, Enter runs the selected row and closes, Esc closes (through
 * the `palette.close` command, so the dispatcher owns that key too). Rows are clickable but
 * nothing here needs the mouse. Tokens only; this is the first piece of Story 2.5's system.
 * As a pick list (Story 6.1, "Link to…") it lists the pick's rows instead, and Enter hands the
 * chosen one to the pick.
 */
export function Palette() {
  const isOpen = usePaletteStore((s) => s.isOpen);
  return isOpen ? <PaletteDialog /> : null;
}

function PaletteDialog() {
  const query = usePaletteStore((s) => s.query);
  const selectedRaw = usePaletteStore((s) => s.selected);
  const setQuery = usePaletteStore((s) => s.setQuery);
  const move = usePaletteStore((s) => s.move);
  const close = usePaletteStore((s) => s.close);
  const pick = usePaletteStore((s) => s.pick);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // The registry is not reactive, so the list is recomputed on every render of the open
  // palette (each keystroke); `when` clauses are read at that moment.
  const rows = paletteRows(pick, listCommands({ enabledOnly: true, visibleOnly: true }), query);
  const selected = clampSelection(selectedRaw, rows.length);
  const activeId = rows[selected] === undefined ? undefined : OPTION_ID_PREFIX + rows[selected].id;

  // Take focus on open; give it back when the palette goes. Opened from a terminal, the
  // terminal the pane shows gets it back (through xterm, so its cursor and input wake up).
  useEffect(() => {
    const previous = document.activeElement;
    const fromTerminal = isInsideTerminal(previous) ? useUiStore.getState().activeTerminal : null;
    inputRef.current?.focus();
    return () => {
      if (fromTerminal !== null && useUiStore.getState().pane === "terminal") focusView(fromTerminal);
      else if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  // Keep the selected row visible when ↑/↓ run past the list's edge.
  useEffect(() => {
    if (activeId === undefined) return;
    listRef.current?.querySelector(`#${CSS.escape(activeId)}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const runRow = (index: number) => {
    const row = rows[index];
    if (row !== undefined) runPaletteRow(row.id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const action = paletteKeyAction(event.key);
    if (action === null) return; // typing; Escape bubbles to the dispatcher (`palette.close`)
    event.preventDefault();
    if (action === "down") move(1, rows.length);
    else if (action === "up") move(-1, rows.length);
    else if (action === "run") runRow(selected);
    // "trap": Tab/Shift+Tab stay on the input, the palette's only focusable element.
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-label={pick === null ? "Command palette" : pick.placeholder}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          placeholder={pick === null ? "Type a command…" : pick.placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul ref={listRef} id="palette-list" className="palette-list" role="listbox" aria-label={pick === null ? "Commands" : pick.placeholder}>
          {rows.length === 0 ? (
            <li className="palette-empty" role="option" aria-selected="false" aria-disabled="true">
              {pick === null ? "No matching commands" : "Nothing matches"}
            </li>
          ) : (
            rows.map((row, index) => (
              <li
                key={row.id}
                id={OPTION_ID_PREFIX + row.id}
                className={"palette-row" + (index === selected ? " is-selected" : "")}
                role="option"
                aria-selected={index === selected}
                onClick={() => runRow(index)}
              >
                <span className="palette-row-title">{row.title}</span>
                {row.binding !== null && <kbd className="palette-row-key">{formatKeybinding(row.binding)}</kbd>}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
