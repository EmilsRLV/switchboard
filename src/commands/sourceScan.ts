// The source scan shared by the command audit (`audit.test.ts`, Story 9.4) and the tooltip scan
// (`hints.test.ts`, Story 11.1): finding JSX handler expressions in a component's source and
// telling whether one runs exactly one registered command. Pure string work, no I/O; only the
// tests import it.

/** A handler found in a source: its file, line and expression (whitespace collapsed). */
export type Handler = { file: string; line: number; handler: string };

/** The handler attributes the audit reads (`onClick={`, `onClick = {`, `onClickCapture={`, …). */
const HANDLER_ATTRIBUTE = /\bon(?:Click|Change|Submit|KeyDown|DoubleClick|ContextMenu)(?:Capture)?\s*=\s*\{/g;
/** One call that runs a registered command, alone: `() => runCommand(…)`, `(e) => void runCommandAsync(…)`. */
const COMMAND_CALL_START = /^(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:void\s+)?runCommand(?:Async)?\(/;
/** A call that runs a registered command. */
const COMMAND_CALL = /\brunCommand(?:Async)?\(/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The index just past the end of the string, template literal or comment starting at `i`, or
 * `i` when none starts there (so braces and parentheses inside them are never counted).
 */
export function skipLiteral(source: string, i: number): number {
  const ch = source[i];
  if (ch === "/" && source[i + 1] === "/") {
    const end = source.indexOf("\n", i);
    return end === -1 ? source.length : end;
  }
  if (ch === "/" && source[i + 1] === "*") {
    const end = source.indexOf("*/", i + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (ch !== '"' && ch !== "'" && ch !== "`") return i;
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === "\\") j++;
    else if (source[j] === ch) return j + 1;
    else if (ch !== "`" && source[j] === "\n") return j; // an apostrophe in JSX text, not a string
  }
  return source.length;
}

/** The index of the bracket closing the one at `open` (`{`→`}`, `(`→`)`), skipping literals and comments. */
function closing(source: string, open: number): number {
  const [up, down] = source[open] === "(" ? ["(", ")"] : ["{", "}"];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const skipped = skipLiteral(source, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (source[i] === up) depth++;
    else if (source[i] === down && --depth === 0) return i;
  }
  return source.length;
}

/** The text inside the bracket at `open`, exclusive. */
export function balanced(source: string, open: number): string {
  return source.slice(open + 1, closing(source, open));
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Every audited handler expression in `source`. */
export function handlersIn(file: string, source: string): Handler[] {
  const out: Handler[] = [];
  for (const match of source.matchAll(HANDLER_ATTRIBUTE)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    out.push({ file, line: source.slice(0, open).split("\n").length, handler: collapse(balanced(source, open)) });
  }
  return out;
}

/** True when `handler` is exactly one command call: the call's closing parenthesis ends it. */
export function isCommandCall(handler: string): boolean {
  const start = COMMAND_CALL_START.exec(handler);
  if (start === null) return false;
  const open = start[0].length - 1;
  return closing(handler, open) === handler.length - 1;
}

/**
 * True when the handler runs a command: it is exactly one command call, or it names a local
 * function (`onClick={toggle}`) whose body runs exactly one command.
 */
export function runsCommand(handler: string, source: string): boolean {
  if (isCommandCall(handler)) return true;
  if (!IDENTIFIER.test(handler)) return false;
  const definition = new RegExp(`(?:const|let|function)\\s+${handler.replace(/\$/g, "\\$")}\\b`).exec(source);
  if (definition === null) return false;
  const open = source.indexOf("{", definition.index);
  if (open === -1) return false;
  return (balanced(source, open).match(COMMAND_CALL) ?? []).length === 1;
}
