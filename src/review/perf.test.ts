// Story 8.1's budget: a 3,000-line file with 40 hunks renders in under 300 ms after its text
// arrives. The DOM half of that is measured in the app (Diagnostics, `last diff render`); here the
// half that runs without a DOM, the merge view's diff of the two documents into its chunks (what
// both the side-by-side and the unified view compute first), with the view's diff configuration.

import { describe, expect, it } from "vitest";
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { DIFF_CONFIG, editBudget, lineDiff } from "./lineDiff";

const NL = "\n";

/** Lines joined with newlines (and one at the end when `end`). */
function text(lines: string[], end = true): string {
  return lines.join(NL) + (end ? NL : "");
}

/** A 3,000-line file and the same file with `hunks` edits spread through it. */
export function fixture(lines = 3000, hunks = 40): { old: string; new: string } {
  const old: string[] = [];
  for (let i = 0; i < lines; i++) old.push(`  const value${i} = compute(${i}, "line ${i}"); // ${i % 7 === 0 ? "note" : "plain"}`);
  const next = [...old];
  const step = Math.floor(lines / hunks);
  for (let h = hunks - 1; h >= 0; h--) {
    const at = h * step + 5;
    next[at] = `  const value${at} = compute(${at} + 1, "line ${at} changed");`;
    next.splice(at + 1, 0, `  // hunk ${h}: an inserted line`);
  }
  return { old: text(old, false), new: text(next, false) };
}

describe("the 3,000-line, 40-hunk budget", () => {
  it("diffs into 40 chunks well under 300 ms", () => {
    const { old, new: next } = fixture();
    const a = Text.of(old.split(NL));
    const b = Text.of(next.split(NL));
    Chunk.build(a, b, DIFF_CONFIG); // warm up the JIT once
    const started = performance.now();
    const chunks = Chunk.build(a, b, DIFF_CONFIG);
    const ms = performance.now() - started;
    expect(chunks).toHaveLength(40);
    expect(ms).toBeLessThan(300);
    // The package's character diff alone gives up on this file: one chunk for everything.
    expect(Chunk.build(a, b, { scanLimit: 500 })).toHaveLength(1);
  });

  it("finds changes that turn the old text into the new, line by line first", () => {
    const apply = (a: string, b: string) => {
      let out = "";
      let at = 0;
      for (const c of lineDiff(a, b)) {
        expect(c.fromA).toBeGreaterThanOrEqual(at);
        out += a.slice(at, c.fromA) + b.slice(c.fromB, c.toB);
        at = c.toA;
      }
      return out + a.slice(at);
    };
    const small = fixture(300, 7);
    const cases: [string, string][] = [
      ["", ""],
      ["", text(["a", "b"])],
      [text(["a", "b"]), ""],
      [text(["a", "b", "c"]), text(["a", "B", "c"])],
      [text(["a", "b", "c"], false), text(["a", "b", "c", "d"], false)],
      [text(["one two three"]), text(["one 2 three"])],
      [text(["x", "y", "z"]), text(["z", "y", "x"])],
      [small.old, small.new],
    ];
    for (const [a, b] of cases) expect(apply(a, b)).toBe(b);
    // Word-level: only the changed character of a changed line.
    const changes = lineDiff(text(["let a = 1;", "let b = 2;"]), text(["let a = 1;", "let b = 3;"]));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromA: 19, toA: 20, fromB: 19, toB: 20 });
    expect(lineDiff(text(["same"]), text(["same"]))).toEqual([]);
  });

  it("near-50,000-line sides that differ everywhere fall back to a coarse block, quickly", () => {
    expect(editBudget(6000)).toBe(2000);
    expect(editBudget(95_000)).toBeLessThan(300);
    const a: string[] = [];
    const b: string[] = [];
    for (let i = 0; i < 47_000; i++) {
      a.push(`line ${i} a`);
      b.push(i % 3 === 0 ? `line ${i} b` : `line ${i} a`);
    }
    a.push("same end");
    b.push("same end");
    const started = performance.now();
    const changes = lineDiff(text(a), text(b));
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(1500);
    // Still a correct diff: applying it gives the new text.
    let out = "";
    let at = 0;
    const oldText = text(a);
    const newText = text(b);
    for (const c of changes) {
      out += oldText.slice(at, c.fromA) + newText.slice(c.fromB, c.toB);
      at = c.toA;
    }
    expect(out + oldText.slice(at)).toBe(newText);
  });
});
