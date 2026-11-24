import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useUiStore } from "../state/ui";
import { isInsideTerminal } from "../terminal/keys";
import { focusView } from "../terminal/registry";
import { displayBinding, formatKeybinding } from "../commands/keybindings";
import { listCommands } from "../commands/registry";
import {
  clampSelection,
  paletteKeyAction,
  paletteRows,
  PROMPT_HINT,
  runPaletteRow,
  submitPalettePrompt,
  usePaletteStore,
  type PaletteRow,
} from "../state/palette";

const OPTION_ID_PREFIX = "palette-option-";

/**
 * The command palette (`ctrl+k`): a centred overlay with an input and the enabled commands,
 * filtered as you type. ↑/↓ move, Enter runs the selected row and closes, Esc closes (through
 * the `palette.close` command, so the dispatcher owns that key too). Rows are clickable but
 * nothing here needs the mouse. Tokens only; this is the first piece of Story 2.5's system.
 * As a pick list (Story 6.1, "Link to…") it lists the pick's rows instead, and Enter hands the
 * chosen one to the pick. As a text prompt (Story 12.3, "New group…") it lists nothing, and Enter
 * hands what was typed to the prompt.
 */
/**
 * Enter or a click on row `index`: a prompt hands over what was typed (Story 12.3); otherwise the
 * row runs (its command, or the pick).
 */
export function runPaletteIndex(rows: readonly PaletteRow[], index: number): void {
  if (submitPalettePrompt()) return;
  const row = rows[index];
  if (row !== undefined) runPaletteRow(row.id);
}

/** A key pressed in the palette's input, over `rows` with `selected` the clamped selection. */
export function paletteKeyDown(event: { key: string; preventDefault(): void }, rows: readonly PaletteRow[], selected: number): void {
  const action = paletteKeyAction(event.key);
  if (action === null) return; // typing; Escape bubbles to the dispatcher (`palette.close`)
  event.preventDefault();
  const { move } = usePaletteStore.getState();
  if (action === "down") move(1, rows.length);
  else if (action === "up") move(-1, rows.length);
  else if (action === "run") runPaletteIndex(rows, selected);
  // "trap": Tab/Shift+Tab stay on the input, the palette's only focusable element.
}

export function Palette() {
  const isOpen = usePaletteStore((s) => s.isOpen);
  return isOpen ? <PaletteDialog /> : null;
}

function PaletteDialog() {
  const query = usePaletteStore((s) => s.query);
  const selectedRaw = usePaletteStore((s) => s.selected);
  const setQuery = usePaletteStore((s) => s.setQuery);
  const close = usePaletteStore((s) => s.close);
  const pick = usePaletteStore((s) => s.pick);
  const prompt = usePaletteStore((s) => s.prompt);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // The registry is not reactive, so the list is recomputed on every render of the open
  // palette (each keystroke); `when` clauses are read at that moment.
  const rows = prompt === null ? paletteRows(pick, listCommands({ enabledOnly: true, visibleOnly: true }), query) : [];
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

  // A prompt opens holding its text (a rename's label), all of it selected to type over; also when
  // the open palette turns into a prompt (Rename group… run from the palette).
  useEffect(() => {
    if (prompt !== null) inputRef.current?.select();
  }, [prompt]);

  // Keep the selected row visible when ↑/↓ run past the list's edge.
  useEffect(() => {
    if (activeId === undefined) return;
    listRef.current?.querySelector(`#${CSS.escape(activeId)}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const runRow = (index: number) => runPaletteIndex(rows, index);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => paletteKeyDown(event, rows, selected);

  const name = prompt !== null ? prompt.placeholder : pick === null ? "Command palette" : pick.placeholder;
  const placeholder = prompt !== null ? prompt.placeholder : pick === null ? "Type a command…" : pick.placeholder;

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-label={name}
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
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul ref={listRef} id="palette-list" className="palette-list" role="listbox" aria-label={pick === null ? "Commands" : pick.placeholder}>
          {prompt !== null ? (
            <li className="palette-empty" role="option" aria-selected="false" aria-disabled="true">
              {PROMPT_HINT}
            </li>
          ) : rows.length === 0 ? (
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
                <RowKey row={row} />
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

/** A row's key (Story 11.1: `help.open` shows `help.toggle`'s F1, as the menus do), or nothing. */
function RowKey({ row }: { row: PaletteRow }) {
  const binding = displayBinding(row);
  return binding === null ? null : <kbd className="palette-row-key">{formatKeybinding(binding)}</kbd>;
}
