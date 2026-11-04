import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { openWebLink, showHelpPage } from "../commands/help";
import { commandHint, formatKeybinding } from "../commands/keybindings";
import { isCommandEnabled, listCommands, runCommand, subscribeBindings } from "../commands/registry";
import { GETTING_STARTED_PAGE } from "../commands/help";
import { useChecklistStore } from "../state/checklist";
import { ChecklistRows, useStepCommandsRefresh } from "./ChecklistCard";
import { HELP_PAGES, helpPage, renderHelpPage } from "../help/pages";
import type { HelpNode } from "../help/markdown";
import { figureFor } from "../help/figures";
import { appInfo } from "../ipc";
import { usePaletteStore } from "../state/palette";
import { useSettingsStore } from "../state/settings";
import { useUiStore } from "../state/ui";

/** The DOM id of a heading with slug `id`, kept apart from the rest of the app's ids. */
function headingDomId(id: string): string {
  return `help-${id}`;
}

/**
 * The Help pane (Story 10.1; F1, "Help" in the palette; Esc closes). It opens on Contents, the
 * guide pages in order; a page shows its Markdown through the safe renderer (`help/markdown`:
 * never HTML), the Keyboard page ends with the commands and their keys now, and the Getting
 * started page with the live checklist and Show on canvas (Story 10.3). Close and ←
 * Contents run `pane.close` / `help.contents`; a Contents row or a page link shows that page and
 * a web link opens in the system browser (item-level: the palette route is "Help: open page…").
 * Loaded lazily, so the page text stays out of the main bundle.
 */
export default function HelpPane() {
  const pageId = useUiStore((s) => s.helpPage);
  const anchor = useUiStore((s) => s.helpAnchor);
  const nav = useUiStore((s) => s.helpNav);
  const page = helpPage(pageId);
  const closeRef = useRef<HTMLButtonElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLElement>(null);
  const firstNav = useRef(nav);

  // Take focus so Esc and Tab work inside the pane; give it back when the pane goes. Not when the
  // palette opened us: its input keeps the focus.
  useEffect(() => {
    const previous = document.activeElement;
    if (!usePaletteStore.getState().isOpen) closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  // Every navigation lands on its heading, or on the top. Instant: no new motion. After a
  // navigation (not on opening, where Close keeps the focus) the focus goes there too: the
  // button that was clicked has gone.
  useEffect(() => {
    const target = anchor === null ? null : document.getElementById(headingDomId(anchor));
    if (target !== null) target.scrollIntoView({ block: "start" });
    else if (paneRef.current !== null) paneRef.current.scrollTop = 0;
    if (nav !== firstNav.current) (target ?? bodyRef.current)?.focus({ preventScroll: true });
  }, [pageId, anchor, nav]);

  return (
    <aside ref={paneRef} className="pane help-pane" aria-label="Help">
      <header className="pane-header">
        <h2 className="pane-title">Help</h2>
        <div className="actions">
          {page !== null && (
            <button type="button" className="btn" title={commandHint("help.contents")} onClick={() => runCommand("help.contents")}>
              ← Contents
            </button>
          )}
          <button ref={closeRef} type="button" className="btn" onClick={() => runCommand("pane.close")} title={commandHint("pane.close", "Close")}>
            Close
          </button>
        </div>
      </header>

      {page === null ? (
        <nav ref={bodyRef} tabIndex={-1} className="pane-section" aria-label="Contents">
          <h3 className="pane-heading">Contents</h3>
          <ul className="help-contents">
            {HELP_PAGES.map((p) => (
              <li key={p.id}>
                <button type="button" className="help-contents-row" onClick={() => showHelpPage(p.id)}>
                  {p.title}
                </button>
              </li>
            ))}
          </ul>
          <AppVersion />
        </nav>
      ) : (
        <article ref={bodyRef} tabIndex={-1} className="help-page" aria-label={page.title}>
          {renderHelpPage(page).map((node, index) => (
            <Block key={index} node={node} />
          ))}
          {page.id === "keyboard" && <CommandTable />}
          {page.id === GETTING_STARTED_PAGE && <GettingStartedProgress />}
        </article>
      )}
    </aside>
  );
}

/** The folder holding `settingsPath` (cut at its last `/` or `\`), or `null` with no path or no folder in it. */
export function configFolder(settingsPath: string | null | undefined): string | null {
  if (settingsPath === null || settingsPath === undefined) return null;
  const cut = Math.max(settingsPath.lastIndexOf("/"), settingsPath.lastIndexOf("\\"));
  if (cut < 0) return null;
  // `/settings.json`: the root itself.
  return cut === 0 ? settingsPath.slice(0, 1) : settingsPath.slice(0, cut);
}

/** The version `app_info` last gave, kept for this run so Contents does not flash `Switchboard` on each visit. */
let knownVersion: string | null = null;

/** Ask `app_info` for the version and keep it for this run; `null` (never a throw) when it fails, as with no Tauri. */
export async function loadAppVersion(): Promise<string | null> {
  try {
    knownVersion = (await appInfo()).version;
    return knownVersion;
  } catch {
    return null;
  }
}

/** Tests only: forget the version `app_info` gave. */
export function resetKnownVersion(): void {
  knownVersion = null;
}

/**
 * Contents' footer (Story 10.4): `Switchboard <version>`, the version from `app_info` (Cargo's), and
 * the config folder under it. Before `app_info` answers, or when it fails (no Tauri), the line reads
 * `Switchboard`; with no settings path the folder line is left out. Neither shows an error.
 */
function AppVersion() {
  const [version, setVersion] = useState<string | null>(knownVersion);
  const folder = configFolder(useSettingsStore((s) => s.snapshot?.path));
  useEffect(() => {
    let cancelled = false;
    void loadAppVersion().then((loaded) => {
      if (!cancelled && loaded !== null) setVersion(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return <VersionFooter version={version} folder={folder} />;
}

/** The footer's look, given what is known: `Switchboard`, `Switchboard <version>`, the folder in mono under it. */
export function VersionFooter({ version, folder }: { version: string | null; folder: string | null }) {
  return (
    <footer className="help-version">
      <div className="help-version-name">{version === null || version === "" ? "Switchboard" : `Switchboard ${version}`}</div>
      {folder !== null && (
        <div className="help-version-folder" title="Config folder">
          {folder}
        </div>
      )}
    </footer>
  );
}

/** A heading's level on the page, under the pane's own `h2`: `#` is an `h3`, and so on. */
function headingTag(level: number): "h3" | "h4" | "h5" | "h6" {
  return level <= 1 ? "h3" : level === 2 ? "h4" : level === 3 ? "h5" : "h6";
}

/** One block of a rendered page (exported for tests). */
export function Block({ node }: { node: HelpNode }): ReactNode {
  switch (node.type) {
    case "heading": {
      const Tag = headingTag(node.level);
      return (
        <Tag id={headingDomId(node.id)} tabIndex={-1} className={`help-h help-h${Math.min(node.level, 3)}`}>
          <Inlines nodes={node.children} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="help-p">
          <Inlines nodes={node.children} />
        </p>
      );
    case "list": {
      const items = node.children.map((item, index) => (
        <li key={index}>{item.type === "item" ? <Blocks nodes={item.children} /> : <Block node={item} />}</li>
      ));
      return node.ordered ? <ol className="help-list">{items}</ol> : <ul className="help-list">{items}</ul>;
    }
    case "codeBlock":
      return <pre className="help-pre">{node.text}</pre>;
    case "figure": {
      // Story 11.4: a known figure is drawn; an unknown name shows its alt text as a code block,
      // so a typo shows and is never markup.
      const Figure = figureFor(node.name);
      return Figure === null ? <pre className="help-pre">{node.alt}</pre> : <Figure alt={node.alt} />;
    }
    case "item":
      return <Blocks nodes={node.children} />;
    default:
      // An inline node at block level (never produced by the renderer): shown inline.
      return <Inline node={node} />;
  }
}

function Blocks({ nodes }: { nodes: readonly HelpNode[] }): ReactNode {
  return nodes.map((node, index) => <Block key={index} node={node} />);
}

function Inlines({ nodes }: { nodes: readonly HelpNode[] }): ReactNode {
  return nodes.map((node, index) => <Inline key={index} node={node} />);
}

function Inline({ node }: { node: HelpNode }): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "emphasis":
      return (
        <em>
          <Inlines nodes={node.children} />
        </em>
      );
    case "strong":
      return (
        <strong>
          <Inlines nodes={node.children} />
        </strong>
      );
    case "code":
      return <code className="help-code">{node.text}</code>;
    case "link":
      return <HelpLink node={node} />;
    case "item":
      return <Blocks nodes={node.children} />;
    case "heading":
    case "paragraph":
    case "list":
    case "codeBlock":
    case "figure":
      // A block node inline (never produced by the renderer): shown as a block.
      return <Block node={node} />;
  }
}

/** A link: a page link shows its page in the pane, a web link opens in the system browser on a click. */
function HelpLink({ node }: { node: Extract<HelpNode, { type: "link" }> }): ReactNode {
  const target = node.target;
  if (target.kind === "page") {
    return (
      <button type="button" className="help-link" onClick={() => showHelpPage(target.page, target.anchor)}>
        <Inlines nodes={node.children} />
      </button>
    );
  }
  return (
    <button type="button" className="help-link" title={target.url} onClick={() => void openWebLink(target.url)}>
      <Inlines nodes={node.children} />
    </button>
  );
}

/**
 * The Getting started page's live checklist (Story 10.3): the card's rows, ticked as the operator
 * goes, and **Show on canvas** (`checklist.show`), which brings the card back.
 */
function GettingStartedProgress() {
  const done = useChecklistStore((s) => s.done);
  // Show on canvas's `when` follows the card (Dismiss on it while this page is open, the load).
  useChecklistStore((s) => s.loaded && s.shown && !s.dismissed && !s.allDoneAtLoad);
  useStepCommandsRefresh();
  return (
    <section className="help-checklist" aria-label="Your progress">
      <h4 className="pane-heading">Your progress</h4>
      <ChecklistRows done={done} />
      <div className="actions">
        <button type="button" className="btn" disabled={!isCommandEnabled("checklist.show")} title={commandHint("checklist.show")} onClick={() => runCommand("checklist.show")}>
          Show on canvas
        </button>
      </div>
    </section>
  );
}

/**
 * The Keyboard page's table: every palette command with its effective key (after
 * `keybindings.json`) or `—`, then the key-only commands the palette does not list. Re-renders
 * whenever the bindings change.
 */
function CommandTable() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeBindings(bump), []);
  const visible = listCommands({ visibleOnly: true });
  const keyOnly = listCommands().filter((c) => c.hidden === true && (c.binding !== null || c.defaultBinding !== null));
  return (
    <>
      <CommandRows caption="Commands" commands={visible} />
      <CommandRows caption="Key-only commands" commands={keyOnly} />
    </>
  );
}

function CommandRows({ caption, commands }: { caption: string; commands: ReturnType<typeof listCommands> }) {
  return (
    <table className="help-table">
      <caption className="pane-heading">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Command</th>
          <th scope="col">Key</th>
        </tr>
      </thead>
      <tbody>
        {commands.map((command) => (
          <tr key={command.id}>
            <td>{command.title}</td>
            <td>{command.binding === null ? "—" : <kbd className="help-key">{formatKeybinding(command.binding)}</kbd>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
