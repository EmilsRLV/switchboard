import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { displayBinding, formatKeybinding } from "../commands/keybindings";
import { canvasMenuCommands, menuGroup, nodeMenuCommands } from "../commands/nodes";
import { runCommand } from "../commands/registry";
import type { Position } from "../ipc";
import { clampSelection, paletteKeyAction } from "../state/palette";
import { clampToArea, useUiStore, type OpenMenu } from "../state/ui";

/**
 * The node context menu (right-click on a project or session card): the enabled commands tagged
 * `menu: "node"` in their fixed `menuOrder`, a 1-px separator between groups, at the pointer
 * and kept inside the window. ↑/↓ move, Enter (or a click) runs the item and closes, Esc
 * closes through the `contextMenu.close` command (so the dispatcher owns that key and its
 * precedence), as does a press outside or the app losing focus. The selection it acts on was
 * made when the menu opened; should it stop having any rows (the project left the snapshot,
 * or was removed from it), the menu closes itself. Tokens only; no accent.
 *
 * Story 11.1: the same popup is the canvas menu (a right-click on the background: the commands
 * tagged `menu: "canvas"`), and each row ends with its effective key in the palette's key look,
 * read from the registry on every render so `keybindings.json` shows at the next opening.
 */
export function ContextMenu() {
  const at = useUiStore((s) => s.contextMenu);
  return at === null ? null : <ContextMenuPopup at={at} />;
}

const ITEM_SELECTOR = '[role="menuitem"]';

function close(): void {
  useUiStore.getState().closeContextMenu();
}

/** The open menu at `at`; exported for its render test (the store hook reads the initial state on the server). */
export function ContextMenuPopup({ at }: { at: OpenMenu }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>(at);
  const [active, setActive] = useState(0);

  // The registry is not reactive; the `when` clauses are read on every render of the open menu.
  const items = at.menu === "canvas" ? canvasMenuCommands() : nodeMenuCommands();
  const selected = clampSelection(active, items.length);

  // Nothing to offer: go away rather than linger as an empty box.
  useEffect(() => {
    if (items.length === 0) close();
  }, [items.length]);

  // Keep the menu inside the window: measured once laid out, before paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    setPosition(clampToArea(at, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [at]);

  // Roving focus: the active item is the focused one; focus goes back where it was on close.
  useEffect(() => {
    const previous = document.activeElement;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const item = el.querySelectorAll<HTMLElement>(ITEM_SELECTOR)[selected] ?? el;
    item.focus();
  }, [selected, items.length]);

  // A press anywhere outside closes it (capture phase, so a node under the pointer cannot
  // swallow it first); so does the window losing focus. Element blur is deliberately not
  // used: WebKit does not focus a button on mousedown, so a press on an item would blur the
  // menu (relatedTarget null) and unmount it before its click ran.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current !== null && event.target instanceof Node && !ref.current.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", close);
    };
  }, []);

  const run = (index: number) => {
    const item = items[index];
    if (item === undefined) return;
    runCommand(item.id);
    close();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = paletteKeyAction(event.key);
    if (action === null) return; // Escape bubbles to the dispatcher (`contextMenu.close`)
    event.preventDefault();
    if (action === "down") setActive(clampSelection(selected + 1, items.length));
    else if (action === "up") setActive(clampSelection(selected - 1, items.length));
    else if (action === "run") run(selected);
    // "trap": Tab stays inside; the menu is modal to the keyboard while it shows.
  };

  // Not even for one frame: the effect above closes it.
  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={at.menu === "canvas" ? "Canvas actions" : "Node actions"}
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        const previous = items[index - 1];
        const binding = displayBinding(item);
        return (
          <Fragment key={item.id}>
            {previous !== undefined && menuGroup(previous) !== menuGroup(item) && (
              <div className="context-menu-separator" role="separator" />
            )}
            <button
              type="button"
              className={"context-menu-item" + (index === selected ? " is-selected" : "")}
              role="menuitem"
              tabIndex={index === selected ? 0 : -1}
              onPointerEnter={() => setActive(index)}
              onClick={() => run(index)}
            >
              <span className="context-menu-title">{item.title}</span>
              {binding !== null && <kbd className="palette-row-key">{formatKeybinding(binding)}</kbd>}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
