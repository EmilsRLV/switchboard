import { describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Group } from "../ipc";
import { GroupCardNode, GroupFrameNode, groupColorClass } from "./GroupNode";
import type { GroupCardData, GroupFrameData } from "./nodes";

const WEB: Group = { id: "g", label: "web", color: null, collapsed: true };

function card(over: Partial<GroupCardData> = {}): string {
  const data: GroupCardData = { group: WEB, memberCount: 2, liveCount: 0, attention: false, attentionText: null, selected: false, ...over };
  return renderToStaticMarkup(<GroupCardNode {...({ id: "group:g", data } as unknown as ComponentProps<typeof GroupCardNode>)} />);
}

function frame(over: Partial<GroupFrameData> = {}): string {
  const data: GroupFrameData = { group: { ...WEB, collapsed: false }, width: 300, height: 140, selected: false, ...over };
  return renderToStaticMarkup(<GroupFrameNode {...({ id: "group:g", data } as unknown as ComponentProps<typeof GroupFrameNode>)} />);
}

describe("the group card (Story 12.3)", () => {
  it("shows the label and N projects; N live only above 0", () => {
    const quiet = card();
    expect(quiet).toContain("web");
    expect(quiet).toContain("2 projects");
    expect(quiet).not.toContain("project-node-live");
    expect(card({ memberCount: 1 })).toContain("1 project<");
    const busy = card({ liveCount: 3 });
    expect(busy).toContain('<span class="project-node-live" title="3 sessions running">3 live</span>');
  });

  it("glows with the project glow while a member needs the operator", () => {
    expect(card()).not.toContain("project-glow");
    const glowing = card({ attention: true, attentionText: "fix login is waiting" });
    expect(glowing).toMatch(/class="[^"]*project-glow/);
    expect(glowing).toContain('title="fix login is waiting"');
  });

  it("carries its colour as a class, and the selection", () => {
    expect(card({ group: { ...WEB, color: "sage" }, selected: true })).toMatch(/class="project-node group-card group-color-sage is-selected"/);
  });
});

describe("the group frame (Story 12.3)", () => {
  it("is sized from its data with the label as the drag handle", () => {
    const html = frame({ group: { ...WEB, color: "sky", collapsed: false }, selected: true });
    expect(html).toContain('class="group-frame group-color-sky is-selected"');
    expect(html).toContain("width:300px;height:140px");
    expect(html).toContain('<div class="group-frame-label" title="web">web</div>');
  });
});

describe("groupColorClass", () => {
  it("names one of the five colours, and nothing for none or an unknown one", () => {
    expect(groupColorClass("rose")).toBe(" group-color-rose");
    expect(groupColorClass(null)).toBe("");
    expect(groupColorClass("#ff0000")).toBe("");
    expect(groupColorClass("accent")).toBe("");
  });
});
