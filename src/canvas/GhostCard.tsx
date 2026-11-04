import { useEffect, useReducer } from "react";
import { commandHint, commandKey } from "../commands/keybindings";
import { runCommand, subscribeBindings } from "../commands/registry";

/** The ghost card's keys line: each command with the words after its key, in order. */
export const GHOST_KEYS: readonly (readonly [string, string])[] = [
  ["project.add", "pick a folder"],
  ["palette.toggle", "palette"],
  ["help.toggle", "help"],
];

/** The keys line as the registry has the keys now (`ctrl+o pick a folder · ctrl+k palette · f1 help`); an unbound key leaves its words. */
export function ghostKeysLine(): string {
  return GHOST_KEYS.map(([id, words]) => {
    const key = commandKey(id);
    return key === null ? words : `${key} ${words}`;
  }).join(" · ");
}

/** A press never focuses the card: Space (the pan key) or Enter would otherwise re-open the picker. */
function keepFocus(event: { preventDefault(): void }): void {
  event.preventDefault();
}

/**
 * The card itself (no hooks, so a test can call it and its handler): `keys` is the keys line. Out
 * of the Tab order and never focused by a click; named "Add project folder".
 */
export function GhostCardView({ keys }: { keys: string }) {
  return (
    <div className="ghost-layer">
      <button
        type="button"
        className="ghost-card"
        tabIndex={-1}
        aria-label="Add project folder"
        title={commandHint("project.add")}
        onMouseDown={keepFocus}
        onClick={() => runCommand("project.add")}
      >
        <span className="ghost-card-box">Drop a folder here</span>
        <span className="ghost-card-keys">{keys}</span>
      </button>
    </div>
  );
}

/**
 * Story 11.3: the empty canvas's state. A dashed `--fg-faint` box of a project card's size
 * (240 × 80), centred in the canvas element, reading `Drop a folder here`, with the keys line
 * under it (read from the registry, so a rebind shows; too wide for the box, so outside it). A
 * click runs **Add project folder…** (`project.add`). Only the card takes the pointer: the canvas
 * around it still pans and takes drops, and a right-click on it opens the canvas menu
 * (`Canvas.tsx`'s `isBackground`). It appears and goes without animation.
 */
export function GhostCard() {
  // Re-render on a rebind (`keybindings.json`).
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeBindings(bump), []);
  return <GhostCardView keys={ghostKeysLine()} />;
}
