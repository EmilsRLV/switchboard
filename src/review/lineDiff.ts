// The diff the merge view runs (Story 8.1): lines first, then characters within each changed
// stretch. `@codemirror/merge` diffs whole documents character by character and, past its scan
// limit, gives up on a big file whose edits are spread through it (a 3,000-line file with 40
// hunks comes out as one chunk). Here Myers' algorithm runs over the lines (cheap: one step per
// changed line), and only the stretches that differ are diffed by character, with the package's
// own `diff`, so word-level highlighting stays precise. Passed as `diffConfig.override`.

import { Change, diff } from "@codemirror/merge";

/** The most edits the line diff looks for on small inputs. */
const MAX_LINE_EDITS = 2000;

/**
 * The line diff's work budget, in edits times lines (Myers costs about that much): large inputs
 * get fewer edits, so two near-50,000-line sides never freeze the view. Past the budget what is
 * left (between the common first and last lines) is one coarse block.
 */
const LINE_WORK_BUDGET = 20_000_000;

/** The edit limit for inputs of `lines` lines in all. */
export function editBudget(lines: number): number {
  return Math.max(50, Math.min(MAX_LINE_EDITS, Math.floor(LINE_WORK_BUDGET / Math.max(1, lines))));
}

/** A changed stretch larger than this (both sides, in characters) is not refined by character. */
const REFINE_MAX = 20_000;

/** The character diff's own scan limit inside a stretch (the merge view's default). */
const REFINE_CONFIG = { scanLimit: 500 };

/** Each line's start offset (lines keep their `\n`), plus the text's length at the end. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  if (starts[starts.length - 1] !== text.length) starts.push(text.length);
  return starts;
}

/** Lines as ids (equal lines, equal ids), interned in `ids`. */
function lineIds(text: string, starts: number[], ids: Map<string, number>): Int32Array {
  const out = new Int32Array(starts.length - 1);
  for (let i = 0; i + 1 < starts.length; i++) {
    const line = text.slice(starts[i], starts[i + 1]);
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    out[i] = id;
  }
  return out;
}

/**
 * The matched line pairs of `a[0..n)` and `b[0..m)` in order (Myers 1986, greedy forward with a
 * trace for the walk back), or `null` past `limit` edits.
 */
function matchLines(a: Int32Array, b: Int32Array, limit: number): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, limit); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return walkBack(trace, a.length, b.length);
    }
  }
  return null;
}

function walkBack(trace: Int32Array[], n: number, m: number): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d]!; // v before step d, k from -d-1 at index 0
    const at = (k: number) => prev[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const startX = prevK === k + 1 ? prevX : prevX + 1;
    const startY = startX - k;
    while (x > startX && y > startY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

/** The changes of a stretch `a[fromA, toA)` / `b[fromB, toB)`, refined by character when small. */
function refine(a: string, fromA: number, toA: number, b: string, fromB: number, toB: number, out: Change[]): void {
  if (toA - fromA + (toB - fromB) > REFINE_MAX || fromA === toA || fromB === toB) {
    out.push(new Change(fromA, toA, fromB, toB));
    return;
  }
  for (const c of diff(a.slice(fromA, toA), b.slice(fromB, toB), REFINE_CONFIG)) {
    out.push(new Change(c.fromA + fromA, c.toA + fromA, c.fromB + fromB, c.toB + fromB));
  }
}

/** The character changes from `a` to `b`, found line by line first. */
export function lineDiff(a: string, b: string): Change[] {
  if (a === b) return [];
  const startsA = lineStarts(a);
  const startsB = lineStarts(b);
  const ids = new Map<string, number>();
  const linesA = lineIds(a, startsA, ids);
  const linesB = lineIds(b, startsB, ids);
  const out: Change[] = [];
  // The common first and last lines never cost a diff step.
  let head = 0;
  while (head < linesA.length && head < linesB.length && linesA[head] === linesB[head]) head++;
  let tail = 0;
  while (tail < linesA.length - head && tail < linesB.length - head && linesA[linesA.length - 1 - tail] === linesB[linesB.length - 1 - tail]) tail++;
  const endA = linesA.length - tail;
  const endB = linesB.length - tail;
  const middle = matchLines(linesA.subarray(head, endA), linesB.subarray(head, endB), editBudget(linesA.length + linesB.length));
  if (middle === null) {
    // Coarse: the stretch between the common lines is one block.
    refine(a, startsA[head]!, startsA[endA]!, b, startsB[head]!, startsB[endB]!, out);
    return out;
  }
  const pairs = middle.map(([x, y]) => [x + head, y + head] as [number, number]);
  let i = head;
  let j = head;
  for (const [pi, pj] of [...pairs, [endA, endB] as [number, number]]) {
    if (pi > i || pj > j) refine(a, startsA[i]!, startsA[pi]!, b, startsB[j]!, startsB[pj]!, out);
    i = pi + 1;
    j = pj + 1;
  }
  return out;
}

/** The merge view's diff configuration. */
export const DIFF_CONFIG = { override: lineDiff };
