// The command registry: every action in the app is a `Command` registered here, reachable from
// the palette (`ctrl+k`) and, when it has a keybinding, from the keyboard through the one
// dispatcher in `./keybindings`. Menus and buttons call `runCommand` rather than the action.
//
// A plain module-level `Map`, not a store: the set of commands changes at registration time,
// not in response to UI; the palette's UI state lives in `state/palette.ts`.
//
// Story 9.4: a command's `keybinding` is its default. `keybindings.json` (read by Rust, parsed in
// `state/keybindings.ts`) overrides it through {@link applyBindingOverrides}: a registered
// command's `binding` is the effective one, its default or the override (`null` unbinds).

import { parseKeybinding, type Keybinding } from "./keybindings";
import { PASS_THROUGH_COMMANDS, TERMINAL_CLIPBOARD_KEYS } from "../terminal/keys";

export type Command = {
  /** Stable, dotted, lower-case: `"settings.open"`. Re-registering an id replaces it. */
  id: string;
  /** What the palette shows; also what it sorts and filters on (with `id`). */
  title: string;
  /**
   * A title that follows state (`Show branches` / `Hide branches`, Story 5.1): when present,
   * {@link listCommands} lists the command under what it returns now instead of `title`.
   */
  dynamicTitle?: () => string;
  /**
   * The default binding, `"ctrl+shift+k"` form; see `parseKeybinding`. Optional: palette-only
   * commands have none. `keybindings.json` may replace or remove it (`binding` is the effective one).
   * Matching is on `KeyboardEvent.key`, which is layout-dependent, so `shift`+punctuation
   * bindings (`shift+,` where the key reports `<`) do not match.
   */
  keybinding?: string;
  /** Enabled when absent or when it returns true; otherwise hidden from the palette and ignored by the dispatcher. */
  when?: () => boolean;
  /** Key-only carrier: the dispatcher sees it, the palette never lists it. */
  hidden?: boolean;
  /**
   * Also listed in a context menu: `"node"` is the menu of a right-clicked node, `"canvas"` the
   * menu of a right-click on the canvas background (Story 11.1).
   */
  menu?: "node" | "canvas";
  /**
   * Where the command sits in its context menu: ascending, with a separator wherever the
   * tens digit changes (`10, 11 ┃ 20, 21, 22 ┃ 30, 31 ┃ 40`). The palette ignores it (title
   * order); commands without one come after those with one.
   */
  menuOrder?: number;
  /**
   * Story 11.1: the id of the command whose effective binding menus and tooltips show for this
   * one (`help.open` shows `help.toggle`'s F1). Display only: dispatch never reads it.
   */
  keyFrom?: string;
  /**
   * Story 11.1: an extra condition for listing the command in its context menu, on top of
   * `when` (Fit view runs on an empty canvas, going home, but the canvas menu leaves it out then).
   */
  menuWhen?: () => boolean;
  /** The action. A returned promise is awaited only to log a rejection. */
  run: () => void | Promise<void>;
};

/** Where a command's effective binding came from. */
export type BindingSource = "default" | "override";

/** A command as stored: the binding parsed once at registration. */
export type RegisteredCommand = Readonly<Command> & {
  /** The effective binding: the default, or the override from `keybindings.json` (`null`: none). */
  readonly binding: Keybinding | null;
  /** The command's own `keybinding`, parsed. */
  readonly defaultBinding: Keybinding | null;
  /** `"override"` when `keybindings.json` changed the binding (to another key or to none). */
  readonly bindingSource: BindingSource;
};

/** A registration: the command with its default binding parsed, before any override. */
type Registration = Readonly<Command> & { readonly defaultBinding: Keybinding | null };

/** What was registered, by id; the unregister functions compare against these. */
const registrations = new Map<string, Registration>();
/** The registrations with their effective bindings, by id: what every reader sees. */
const commands = new Map<string, RegisteredCommand>();
/** `keybindings.json`'s entries as given (ids not registered yet wait here until they are). */
let rawOverrides: ReadonlyMap<string, unknown> = new Map();
/** The valid overrides of registered commands: id -> binding, or `null` to unbind. */
let overrides: ReadonlyMap<string, Keybinding | null> = new Map();
/** Called whenever the effective bindings may have changed (the overrides, or a registration they name). */
const bindingListeners = new Set<() => void>();

/**
 * Register (or replace) a command. The keybinding is parsed now, so an invalid one throws
 * here. Returns a function that unregisters this exact registration (a no-op if the id has
 * since been replaced).
 */
export function registerCommand(command: Command): () => void {
  return install(prepare(command));
}

/** Parse the binding (throws on a bad one) without touching the map. */
function prepare(command: Command): Registration {
  return {
    ...command,
    defaultBinding: command.keybinding === undefined ? null : parseKeybinding(command.keybinding),
  };
}

/** The registration with its effective binding (the override when there is one). */
function effective(registration: Registration): RegisteredCommand {
  if (!overrides.has(registration.id)) {
    return { ...registration, binding: registration.defaultBinding, bindingSource: "default" };
  }
  const binding = overrides.get(registration.id) ?? null;
  // An override naming the default key changes nothing: it is not the file's binding.
  const same = sameBinding(binding, registration.defaultBinding);
  return { ...registration, binding, bindingSource: same ? "default" : "override" };
}

function sameBinding(a: Keybinding | null, b: Keybinding | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}

function install(registration: Registration): () => void {
  registrations.set(registration.id, registration);
  // A pending override for this id (the file named it before it registered) applies now.
  if (rawOverrides.has(registration.id)) recomputeOverrides();
  else commands.set(registration.id, effective(registration));
  return () => {
    if (registrations.get(registration.id) === registration) {
      registrations.delete(registration.id);
      commands.delete(registration.id);
      if (rawOverrides.has(registration.id)) recomputeOverrides();
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
  registrations.delete(id);
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
  return list.map(withCurrentTitle).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** The command under its current title: its `dynamicTitle` now, when it has one. */
function withCurrentTitle(command: RegisteredCommand): RegisteredCommand {
  return command.dynamicTitle === undefined ? command : { ...command, title: command.dynamicTitle() };
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

/**
 * Like {@link runCommand}, but resolves once the command's `run` has settled (a rejection is
 * logged, not thrown): for a button that stays disabled while its command runs. Resolves `false`
 * when the command does not exist or is disabled.
 */
export async function runCommandAsync(id: string): Promise<boolean> {
  const command = commands.get(id);
  if (command === undefined || !isEnabled(command)) {
    return false;
  }
  try {
    await command.run();
  } catch (err) {
    console.error(`command "${id}" failed:`, err);
  }
  return true;
}

/** True for a pass-through command (its key still works with focus in a terminal). Read lazily: `terminal/keys` imports this module too. */
function isPassThrough(id: string): boolean {
  return PASS_THROUGH_COMMANDS.some(([passId]) => passId === id);
}

/**
 * Why `value` cannot be `id`'s binding, or the parsed binding. A pass-through command needs a
 * modifier (a bare key would be swallowed in every terminal and field) and may not take the
 * terminal's copy / paste keys.
 */
function validate(id: string, value: unknown): { binding: Keybinding | null } | { error: string } {
  if (value === null) return { binding: null };
  if (typeof value !== "string") return { error: `bad key ${JSON.stringify(value) ?? String(value)} for ${id}` };
  let binding: Keybinding;
  try {
    binding = parseKeybinding(value);
  } catch {
    return { error: `bad key ${JSON.stringify(value)} for ${id}` };
  }
  if (isPassThrough(id)) {
    if (!binding.ctrl && !binding.alt && !binding.shift) return { error: `${id} needs ctrl, alt or shift` };
    const clipboard = terminalClipboardKey(binding);
    if (clipboard !== null) return { error: `${keybindingText(binding)} is the terminal's ${clipboard}` };
  }
  return { binding };
}

/** `"copy"` / `"paste"` when `binding` is one of the terminal's clipboard keys; else `null`. */
function terminalClipboardKey(binding: Keybinding): string | null {
  for (const [key, use] of TERMINAL_CLIPBOARD_KEYS) {
    if (sameBinding(parseKeybinding(key), binding)) return use;
  }
  return null;
}

/**
 * A binding as `keybindings.json` and the README write it: `ctrl+shift+k`, `escape`, `arrowup`,
 * `space` (the palette's hints use the short forms of `formatKeybinding`).
 */
export function keybindingText(binding: Keybinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("ctrl");
  if (binding.shift) parts.push("shift");
  if (binding.alt) parts.push("alt");
  parts.push(binding.key === " " ? "space" : binding.key);
  return parts.join("+");
}

function recomputeOverrides(): void {
  const next = new Map<string, Keybinding | null>();
  for (const [id, value] of rawOverrides) {
    if (!registrations.has(id)) continue;
    const result = validate(id, value);
    if ("binding" in result) next.set(id, result.binding);
  }
  overrides = next;
  for (const registration of registrations.values()) {
    commands.set(registration.id, effective(registration));
  }
  for (const listener of bindingListeners) listener();
}

/**
 * Story 9.4: apply `keybindings.json` (already parsed to an object) over the default bindings,
 * replacing any earlier overrides. Each entry is `"<command id>": "<binding>"` or `null` (unbind).
 * A bad binding is an error and is skipped (the default stays); an id not registered (yet) is an
 * error until a command registers under it, when its entry applies. The other entries apply.
 * Returns {@link bindingErrors}.
 */
export function applyBindingOverrides(raw: Readonly<Record<string, unknown>>): string[] {
  rawOverrides = new Map(Object.entries(raw));
  recomputeOverrides();
  return bindingErrors();
}

/** Back to the default bindings (no `keybindings.json`). */
export function clearBindingOverrides(): void {
  applyBindingOverrides({});
}

/**
 * The file's errors now, in its order: `unknown command x`, `bad key "ctrl+" for review.refresh`,
 * `terminal.toggle needs ctrl, alt or shift`, `ctrl+shift+c is the terminal's copy`.
 */
export function bindingErrors(): string[] {
  const errors: string[] = [];
  for (const [id, value] of rawOverrides) {
    if (!registrations.has(id)) {
      errors.push(`unknown command ${id}`);
      continue;
    }
    const result = validate(id, value);
    if ("error" in result) errors.push(result.error);
  }
  return errors;
}

/**
 * Unbinds that leave something out of reach, one line each: the palette's keys (`palette.toggle`,
 * `palette.toggleFromTerminal`) and the hidden key-only commands (`pane.close`, the arrows…),
 * which have no palette row to fall back on.
 */
export function bindingWarnings(): string[] {
  const warnings: string[] = [];
  for (const [id, binding] of overrides) {
    const command = commands.get(id);
    if (binding !== null || command === undefined || command.defaultBinding === null) continue;
    if (id === "palette.toggle" || id === "palette.toggleFromTerminal") warnings.push(`${id} unbound: the palette loses that key`);
    else if (command.hidden === true) warnings.push(`${id} unbound: a key-only command, now out of reach`);
  }
  return warnings;
}

/** Call `listener` whenever the effective bindings may have changed; returns the unsubscribe. */
export function subscribeBindings(listener: () => void): () => void {
  bindingListeners.add(listener);
  return () => bindingListeners.delete(listener);
}

/**
 * Story 9.4: the keybinding conflicts after the overrides, one line each, sorted:
 * `ctrl+k: palette.toggle, review.refresh` -- two or more commands on one key where at least one
 * of those bindings came from `keybindings.json`. The defaults' shared keys (Esc, `n`), told
 * apart by their `when`s, are intended and never reported. An override onto the terminal's copy
 * or paste key is a conflict with it (`ctrl+shift+c: review.refresh, terminal copy`): with focus
 * in a terminal the key stays the terminal's.
 */
export function bindingConflicts(): string[] {
  const byKey = new Map<string, string[]>();
  const overridden = new Set<string>();
  for (const command of commands.values()) {
    if (command.binding === null) continue;
    const key = keybindingText(command.binding);
    byKey.set(key, [...(byKey.get(key) ?? []), command.id]);
    if (command.bindingSource === "override") overridden.add(key);
  }
  for (const [key, use] of TERMINAL_CLIPBOARD_KEYS) {
    const text = keybindingText(parseKeybinding(key));
    if (byKey.has(text)) byKey.set(text, [...byKey.get(text)!, `terminal ${use}`]);
  }
  const lines: string[] = [];
  for (const [key, ids] of byKey) {
    if (ids.length < 2 || !overridden.has(key)) continue;
    lines.push(`${key}: ${ids.sort().join(", ")}`);
  }
  return lines.sort();
}

/** True when command `id` exists and its `when` holds now (a button's `disabled` reads it). */
export function isCommandEnabled(id: string): boolean {
  const command = commands.get(id);
  return command !== undefined && isEnabled(command);
}

/** Remove every command (and every override). For tests. */
export function clearCommands(): void {
  registrations.clear();
  commands.clear();
  rawOverrides = new Map();
  overrides = new Map();
}
