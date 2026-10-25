// The language packs of the diff view (Story 8.1), each loaded on demand by `import()` the first
// time a file of its kind is shown, then cached. Part of the lazily loaded review code; every pack
// is its own chunk.

import type { Extension } from "@codemirror/state";
import type { LanguageKind } from "./model";

const loaded = new Map<LanguageKind, Extension>();
const loading = new Map<LanguageKind, Promise<Extension>>();

async function load(kind: LanguageKind): Promise<Extension> {
  switch (kind) {
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
  }
}

/** The pack for `kind` when it is already loaded (so a view can start with it), else `null`. */
export function loadedLanguage(kind: LanguageKind): Extension | null {
  return loaded.get(kind) ?? null;
}

/** Load the pack for `kind` (once); a failed load is retried next time. */
export function loadLanguage(kind: LanguageKind): Promise<Extension> {
  const ready = loaded.get(kind);
  if (ready !== undefined) return Promise.resolve(ready);
  let pending = loading.get(kind);
  if (pending === undefined) {
    pending = load(kind).then(
      (ext) => {
        loaded.set(kind, ext);
        loading.delete(kind);
        return ext;
      },
      (err: unknown) => {
        loading.delete(kind);
        throw err;
      },
    );
    loading.set(kind, pending);
  }
  return pending;
}
