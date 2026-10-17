import { describe, expect, it } from "vitest";
import type { Project, ProjectStatusMap } from "../ipc";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  LIVE_SESSIONS,
  aheadBehind,
  cardTopLeft,
  physicalToClient,
  shortenPath,
  statusLine,
  toFlowNodes,
} from "./nodes";

function project(id: string, path: string, x = 0, y = 0): Project {
  return {
    id,
    path,
    label: path.split(/[\\/]/).pop() ?? path,
    position: { x, y },
    expanded: false,
    color: null,
    launchDefaults: null,
  };
}

describe("toFlowNodes", () => {
  const projects = [project("a", "B:\\projects\\ide", 10, 20), project("b", "/home/me/src", -5, 7)];
  const statuses: ProjectStatusMap = {
    a: { kind: "repo", branch: "master", detached: false, dirty: 3, ahead: 0, behind: 0 },
  };

  it("makes one inert project node per workspace project at its stored position", () => {
    const nodes = toFlowNodes(projects, statuses, []);
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(nodes[0]?.type).toBe("project");
    expect(nodes[0]?.position).toEqual({ x: 10, y: 20 });
    expect(nodes[1]?.position).toEqual({ x: -5, y: 7 });
    expect(nodes[0]?.draggable).toBe(false);
    expect(nodes[0]?.selectable).toBe(false);
    expect(nodes[0]?.connectable).toBe(false);
    expect(nodes[0]?.data.project).toBe(projects[0]);
  });

  it("attaches the project's status, or null while unpolled, and the flash flag", () => {
    const nodes = toFlowNodes(projects, statuses, ["b"]);
    expect(nodes[0]?.data.status).toEqual(statuses.a);
    expect(nodes[1]?.data.status).toBeNull();
    expect(nodes[0]?.data.flashed).toBe(false);
    expect(nodes[1]?.data.flashed).toBe(true);
  });

  it("is empty for an empty workspace", () => {
    expect(toFlowNodes([], {}, [])).toEqual([]);
  });
});

describe("cardTopLeft", () => {
  it("offsets a centre by half the card so the card sits centred on it", () => {
    expect([CARD_WIDTH, CARD_HEIGHT]).toEqual([240, 80]);
    expect(cardTopLeft({ x: 500, y: 300 })).toEqual({ x: 380, y: 260 });
    expect(cardTopLeft({ x: 0, y: 0 })).toEqual({ x: -120, y: -40 });
  });
});

describe("shortenPath", () => {
  it("leaves a short path alone", () => {
    expect(shortenPath("B:\\projects\\ide")).toBe("B:\\projects\\ide");
    expect(shortenPath("/home/me/src")).toBe("/home/me/src");
  });

  it("elides the middle, keeping the drive and as many trailing folders as fit", () => {
    const long = "B:\\projects\\some\\quite\\deep\\tree\\guild-auth";
    expect(long.length).toBeGreaterThan(36);
    // Exactly 36 characters with one folder elided: fits.
    expect(shortenPath(long)).toBe("B:\\…\\some\\quite\\deep\\tree\\guild-auth");
    expect(shortenPath(long, 35)).toBe("B:\\…\\quite\\deep\\tree\\guild-auth");
    expect(shortenPath(long, 18)).toBe("B:\\…\\guild-auth");
    expect(shortenPath(long, 20)).toBe("B:\\…\\tree\\guild-auth");
  });

  it("keeps the last folder even when it alone is too long, and handles unix roots", () => {
    const unix = "/home/emils/projects/an-extremely-long-folder-name-here";
    expect(shortenPath(unix, 30)).toBe("/…/an-extremely-long-folder-name-here");
    expect(shortenPath("/a-very-long-single-component-path-x", 10)).toBe("/a-very-long-single-component-path-x");
  });
});

describe("statusLine / aheadBehind", () => {
  it("renders the branch and changed count for a repo", () => {
    expect(statusLine({ kind: "repo", branch: "master", detached: false, dirty: 0, ahead: 0, behind: 0 })).toEqual({
      text: "master · 0 changed",
      tone: "normal",
    });
    expect(statusLine({ kind: "repo", branch: "5ff9de9", detached: true, dirty: 2, ahead: 0, behind: 0 }).text).toBe(
      "5ff9de9 detached · 2 changed",
    );
  });

  it("renders the muted non-repo states and a placeholder while unpolled", () => {
    expect(statusLine({ kind: "not_repo" })).toEqual({ text: "not a git repo", tone: "muted" });
    expect(statusLine({ kind: "missing" })).toEqual({ text: "folder missing", tone: "muted" });
    expect(statusLine({ kind: "git_unavailable" })).toEqual({ text: "git unavailable", tone: "muted" });
    expect(statusLine(null)).toEqual({ text: "…", tone: "muted" });
  });

  it("renders a git failure as 'git error' with the message as hover text", () => {
    expect(statusLine({ kind: "git_error", message: "fatal: detected dubious ownership" })).toEqual({
      text: "git error",
      tone: "muted",
      title: "fatal: detected dubious ownership",
    });
  });

  it("aheadBehind shows only when the upstream differs", () => {
    expect(aheadBehind({ kind: "repo", branch: "m", detached: false, dirty: 0, ahead: 0, behind: 0 })).toBeNull();
    expect(aheadBehind({ kind: "repo", branch: "m", detached: false, dirty: 0, ahead: 3, behind: 0 })).toBe("↑3 ↓0");
    expect(aheadBehind({ kind: "repo", branch: "m", detached: false, dirty: 0, ahead: 0, behind: 12 })).toBe("↑0 ↓12");
    expect(aheadBehind({ kind: "not_repo" })).toBeNull();
    expect(aheadBehind({ kind: "git_error", message: "x" })).toBeNull();
    expect(aheadBehind(null)).toBeNull();
  });

  it("the live badge is wired to 0 until Epic 3", () => {
    expect(LIVE_SESSIONS).toBe(0);
  });
});

describe("physicalToClient", () => {
  it("divides by the device pixel ratio and tolerates a bad ratio", () => {
    expect(physicalToClient({ x: 300, y: 150 }, 1.5)).toEqual({ x: 200, y: 100 });
    expect(physicalToClient({ x: 300, y: 150 }, 1)).toEqual({ x: 300, y: 150 });
    expect(physicalToClient({ x: 300, y: 150 }, 0)).toEqual({ x: 300, y: 150 });
    expect(physicalToClient({ x: 300, y: 150 }, Number.NaN)).toEqual({ x: 300, y: 150 });
  });
});
