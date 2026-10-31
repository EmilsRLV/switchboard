// The version test (Story 10.4): `package.json` and `src-tauri/Cargo.toml` carry the same version, and the
// newest released heading in `CHANGELOG.md` starts with it, so a version bump without a changelog entry
// fails `npm test`. The checks are pure helpers, tested here against the story's cases, then run on the
// repo's own files (read with `node:fs`, as the help-content test does).

import { describe, expect, it } from "vitest";

/** The slice of `node:fs` the test reads with (the project has no Node typings). */
type Fs = { readFileSync(path: URL, encoding: "utf8"): string };
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;
const REPO_ROOT = new URL("../../", import.meta.url);

/** The text of the first `## ` heading of `changelog` that is not `Unreleased`, or `null` when there is none. */
function newestReleased(changelog: string): string | null {
  for (const line of changelog.split(/\r?\n/)) {
    const match = /^## +(.*?)\s*$/.exec(line);
    const heading = match?.[1];
    if (heading === undefined || heading.toLowerCase() === "unreleased") continue;
    return heading;
  }
  return null;
}

/** The `[package]` table's `version` in a `Cargo.toml`, or `null`. */
function cargoVersion(toml: string): string | null {
  let inPackage = false;
  for (const line of toml.split(/\r?\n/)) {
    const table = /^\s*\[([^\]]*)\]/.exec(line);
    if (table !== null) {
      inPackage = table[1]?.trim() === "package";
      continue;
    }
    const version = inPackage ? /^\s*version\s*=\s*"([^"]*)"/.exec(line)?.[1] : undefined;
    if (version !== undefined) return version;
  }
  return null;
}

/** What is wrong between the two manifests' versions and the changelog, or `null` when they agree. */
function versionProblem(packageVersion: string, cargo: string | null, changelog: string): string | null {
  if (cargo === null) return "Cargo.toml has no [package] version";
  if (packageVersion !== cargo) return `package.json is ${packageVersion} but Cargo.toml is ${cargo}`;
  const heading = newestReleased(changelog);
  if (heading === null) return `CHANGELOG.md has no released heading for ${packageVersion}`;
  // `0.1.0 — 2026-10-31`: the version, then anything but more of a version.
  if (!heading.startsWith(packageVersion) || /^[0-9A-Za-z.+-]/.test(heading.slice(packageVersion.length))) {
    return `CHANGELOG.md's newest release is "${heading}" but the app is ${packageVersion}`;
  }
  return null;
}

const CHANGELOG_010 = "# Changelog\n\n## Unreleased\n\n### Help\n\n- A thing.\n\n## 0.1.0 — 2026-10-31\n\n### Canvas\n\n- A canvas.\n";

describe("the version check's helpers", () => {
  it("newestReleased skips Unreleased and ### headings", () => {
    expect(newestReleased(CHANGELOG_010)).toBe("0.1.0 — 2026-10-31");
    expect(newestReleased(CHANGELOG_010.replace(/\n/g, "\r\n"))).toBe("0.1.0 — 2026-10-31");
    expect(newestReleased("# Changelog\n\n## Unreleased\n\n### Help\n\n- A thing.\n")).toBeNull();
  });

  it("cargoVersion reads [package] only", () => {
    expect(cargoVersion('[package]\nname = "switchboard"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n')).toBe("0.1.0");
    expect(cargoVersion('[dependencies]\nversion = "9.9.9"\n[package]\nname = "x"\nversion = "0.2.0"\n')).toBe("0.2.0");
    expect(cargoVersion('[workspace]\nversion = "1.0.0"\n')).toBeNull();
  });

  it("the version matches: package 0.1.0, Cargo 0.1.0, newest heading 0.1.0", () => {
    expect(versionProblem("0.1.0", "0.1.0", CHANGELOG_010)).toBeNull();
  });

  it("a bump without an entry fails, naming both versions", () => {
    const problem = versionProblem("0.2.0", "0.2.0", CHANGELOG_010);
    expect(problem).toContain("0.2.0");
    expect(problem).toContain("0.1.0");
  });

  it("mismatched manifests fail", () => {
    expect(versionProblem("0.2.0", "0.1.0", CHANGELOG_010)).toBe("package.json is 0.2.0 but Cargo.toml is 0.1.0");
    expect(versionProblem("0.1.0", null, CHANGELOG_010)).not.toBeNull();
  });

  it("a changelog with Unreleased only fails (no released heading)", () => {
    expect(versionProblem("0.1.0", "0.1.0", "# Changelog\n\n## Unreleased\n\n- Soon.\n")).toContain("no released heading");
  });

  it("a longer version that starts with this one does not count", () => {
    expect(versionProblem("0.1.0", "0.1.0", "## 0.1.01 — 2026-11-01\n")).not.toBeNull();
    expect(versionProblem("0.1.0", "0.1.0", "## 0.1.0-beta — 2026-11-01\n")).not.toBeNull();
    expect(versionProblem("0.1.0", "0.1.0", "## 0.1.0\n")).toBeNull();
  });
});

describe("the repo's version", () => {
  it("package.json, Cargo.toml and the newest CHANGELOG.md release agree", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("package.json", REPO_ROOT), "utf8")) as { version: string };
    const cargo = cargoVersion(fs.readFileSync(new URL("src-tauri/Cargo.toml", REPO_ROOT), "utf8"));
    const changelog = fs.readFileSync(new URL("CHANGELOG.md", REPO_ROOT), "utf8");
    expect(versionProblem(pkg.version, cargo, changelog)).toBeNull();
  });
});
