import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerBuiltins } from "../commands/builtins";
import { applyBindingOverrides, clearBindingOverrides, clearCommands, registerCommand } from "../commands/registry";
import { GhostCard, GhostCardView, ghostKeysLine } from "./GhostCard";

describe("the ghost card (Story 11.3)", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
  });
  afterEach(() => {
    clearBindingOverrides();
    clearCommands();
  });

  it("reads Drop a folder here with the registry's keys, titled Add project folder…", () => {
    expect(renderToStaticMarkup(<GhostCard />)).toBe(
      '<div class="ghost-layer"><button type="button" class="ghost-card" data-tour="ghost" tabindex="-1" aria-label="Add project folder" title="Add project folder… · ctrl+o">' +
        '<span class="ghost-card-box">Drop a folder here</span>' +
        '<span class="ghost-card-keys">ctrl+o pick a folder · ctrl+k palette · f1 help</span></button></div>',
    );
  });

  it("follows a rebind, and an unbound key leaves its words", () => {
    applyBindingOverrides({ "project.add": "ctrl+shift+o" });
    const html = renderToStaticMarkup(<GhostCard />);
    expect(html).toContain("ctrl+shift+o pick a folder · ctrl+k palette · f1 help");
    expect(html).toContain('title="Add project folder… · ctrl+shift+o"');
    applyBindingOverrides({ "help.toggle": null });
    expect(ghostKeysLine()).toBe("ctrl+o pick a folder · ctrl+k palette · help");
  });

  it("a click runs project.add; a press never takes focus", () => {
    const run = vi.fn();
    registerCommand({ id: "project.add", title: "Add project folder…", run });
    const layer = GhostCardView({ keys: "k" }) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
    const button = layer.props.children;
    expect(button.type).toBe("button");
    (button.props.onClick as () => void)();
    expect(run).toHaveBeenCalledTimes(1);
    const preventDefault = vi.fn();
    (button.props.onMouseDown as (e: { preventDefault(): void }) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });
});
