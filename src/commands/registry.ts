// The command registry: every action in the app is a `Command` registered here, reachable from
// the palette (`ctrl+k`) and, when it has a keybinding, from the keyboard through the one
// dispatcher in `./keybindings`. Menus and buttons call `runCommand` rather than the action.
//
// A plain module-level `Map`, not a store: the set of commands changes at registration time,
// not in response to UI; the palette's UI state lives in `state/palette.ts`.

import { parseKeybinding, type Keybinding } from "./keybindings";

export type Command = {
  /** Stable, dotted, lower-case: `"settings.open"`. Re-registering an id replaces it. */
  id: string;
  /** What the palette shows; also what it sorts and filters on (with `id`). */
  title: string;
  /**
   * `"ctrl+shift+k"` form; see `parseKeybinding`. Optional: palette-only commands have none.
   * Matching is on `KeyboardEvent.key`, which is layout-dependent, so `shift`+punctuation
   * bindings (`shift+,` where the key reports `<`) do not match.
   */
  keybinding?: string;
  /** Enabled when absent or when it returns true; otherwise hidden from the palette and ignored by the dispatcher. */
  when?: () => boolean;
  /** Key-only carrier: the dispatcher sees it, the palette never lists it. */
  hidden?: boolean;
  /** Also listed in a context menu: `"node"` is the menu of a right-clicked node. */
  menu?: "node";
  /**
   * Where the command sits in its context menu: ascending, with a separator wherever the
   * tens digit changes (`10, 11 ┃ 20, 21, 22 ┃ 30, 31 ┃ 40`). The palette ignores it (title
   * order); commands without one come after those with one.
   */
  menuOrder?: number;
  /** The action. A returned promise is awaited only to log a rejection. */
  run: () => void | Promise<void>;
};

/** A command as stored: the binding parsed once at registration. */
export type RegisteredCommand = Readonly<Command> & {
  readonly binding: Keybinding | null;
};

const commands = new Map<string, RegisteredCommand>();

/**
 * Register (or replace) a command. The keybinding is parsed now, so an invalid one throws
 * here. Returns a function that unregisters this exact registration (a no-op if the id has
 * since been replaced).
 */
export function registerCommand(command: Command): () => void {
  return install(prepare(command));
}

/** Parse the binding (throws on a bad one) without touching the map. */
function prepare(command: Command): RegisteredCommand {
  return {
    ...command,
    binding: command.keybinding === undefined ? null : parseKeybinding(command.keybinding),
  };
}

function install(registered: RegisteredCommand): () => void {
  commands.set(registered.id, registered);
  return () => {
    if (commands.get(registered.id) === registered) {
      commands.delete(registered.id);
    }
  };
}

/**
 * Register a batch. Two commands with the same id in one batch is a programming error
 * (one would silently shadow the other), and so is a bad keybinding: every command is
 * checked and parsed first, so either the whole batch registers or none of it does.
 */
export function registerCommands(batch: readonly Command[]): () => void {
  const seen = new Set<string>();
  for (const command of batch) {
    if (seen.has(command.id)) {
      throw new Error(`duplicate command id "${command.id}"`);
    }
    seen.add(command.id);
  }
  const prepared = batch.map(prepare);
  const unregisters = prepared.map(install);
  return () => unregisters.forEach((unregister) => unregister());
}

export function unregisterCommand(id: string): boolean {
  return commands.delete(id);
}

export function getCommand(id: string): RegisteredCommand | undefined {
  return commands.get(id);
}

/** True when the command has no `when` or its `when` returns true. */
export function isEnabled(command: Pick<Command, "when">): boolean {
  return command.when === undefined || command.when();
}

/**
 * All commands, ordered by title (then id, so order is total). `enabledOnly` drops those whose
 * `when` is false; `visibleOnly` drops `hidden` ones (what the palette lists).
 */
export function listCommands({
  enabledOnly = false,
  visibleOnly = false,
}: { enabledOnly?: boolean; visibleOnly?: boolean } = {}): RegisteredCommand[] {
  const list = [...commands.values()].filter(
    (command) => (!enabledOnly || isEnabled(command)) && (!visibleOnly || command.hidden !== true),
  );
  return list.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/**
 * Run a command by id if it exists and is enabled; returns whether it ran. A rejected promise
 * from `run` is logged, never thrown: callers (dispatcher, palette) have nowhere to show it.
 */
export function runCommand(id: string): boolean {
  const command = commands.get(id);
  if (command === undefined || !isEnabled(command)) {
    return false;
  }
  try {
    const result = command.run();
    if (result instanceof Promise) {
      result.catch((err: unknown) => console.error(`command "${id}" failed:`, err));
    }
  } catch (err) {
    console.error(`command "${id}" failed:`, err);
  }
  return true;
}

/** Remove every command. For tests. */
export function clearCommands(): void {
  commands.clear();
}
