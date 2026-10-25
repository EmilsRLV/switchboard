// Where `o` (Open in editor, Story 8.3) opens: the line of the diff or file view the Review pane
// shows. The CodeMirror views (`DiffView.tsx`, loaded lazily) register a provider while they are
// mounted; the command asks it. No CodeMirror here, so the commands never pull the editor chunk in.

/** Gives the new file's line to open: at the cursor of the view last clicked, else the first visible line. */
export type LineProvider = () => number | null;

let current: LineProvider | null = null;

/** Register the mounted view's provider; the returned function unregisters it (if it is still the one). */
export function setLineProvider(provider: LineProvider): () => void {
  current = provider;
  return () => {
    if (current === provider) current = null;
  };
}

/** The line `o` opens: the mounted view's, else `null` (no view: the caller opens line 1). */
export function currentLine(): number | null {
  if (current === null) return null;
  try {
    const line = current();
    return line !== null && Number.isFinite(line) && line >= 1 ? Math.floor(line) : null;
  } catch {
    return null;
  }
}
