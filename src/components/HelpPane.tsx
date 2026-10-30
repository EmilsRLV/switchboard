import { useEffect, useReducer, useRef, type ReactNode } from "react";
import { openWebLink, showHelpPage } from "../commands/help";
import { formatKeybinding } from "../commands/keybindings";
import { listCommands, runCommand, subscribeBindings } from "../commands/registry";
import { HELP_PAGES, helpPage, renderHelpPage } from "../help/pages";
import type { HelpNode } from "../help/markdown";
import { usePaletteStore } from "../state/palette";
import { useUiStore } from "../state/ui";

/** The DOM id of a heading with slug `id`, kept apart from the rest of the app's ids. */
function headingDomId(id: string): string {
  return `help-${id}`;
}

/**
 * The Help pane (Story 10.1; F1, "Help" in the palette; Esc closes). It opens on Contents, the
 * guide pages in order; a page shows its Markdown through the safe renderer (`help/markdown`:
 * never HTML), and the Keyboard page ends with the commands and their keys now. Close and ←
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
            <button type="button" className="btn" onClick={() => runCommand("help.contents")}>
              ← Contents
            </button>
          )}
          <button ref={closeRef} type="button" className="btn" onClick={() => runCommand("pane.close")} title="Close (Esc)">
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
        </nav>
      ) : (
        <article ref={bodyRef} tabIndex={-1} className="help-page" aria-label={page.title}>
          {renderHelpPage(page).map((node, index) => (
            <Block key={index} node={node} />
          ))}
          {page.id === "keyboard" && <CommandTable />}
        </article>
      )}
    </aside>
  );
}

/** A heading's level on the page, under the pane's own `h2`: `#` is an `h3`, and so on. */
function headingTag(level: number): "h3" | "h4" | "h5" | "h6" {
  return level <= 1 ? "h3" : level === 2 ? "h4" : level === 3 ? "h5" : "h6";
}

function Block({ node }: { node: HelpNode }): ReactNode {
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
