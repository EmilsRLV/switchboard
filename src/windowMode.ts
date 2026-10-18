// Which root a webview renders (Story 4.5): the app, or one terminal popped out into its own
// window. Rust opens a pop-out at `index.html?terminal=<id>`.

export type WindowMode = { kind: "main" } | { kind: "terminal"; id: string };

/** The mode a window's `location.search` asks for: `?terminal=<id>` is a pop-out, anything else the app. */
export function windowMode(search: string): WindowMode {
  let id: string | null;
  try {
    id = new URLSearchParams(search).get("terminal");
  } catch {
    id = null;
  }
  return id !== null && id.trim() !== "" ? { kind: "terminal", id } : { kind: "main" };
}
