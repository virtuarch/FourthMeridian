/**
 * lib/data/snapshot-read-bound.test.ts
 *
 * v2.6-WINDOW-2 — a snapshot read states its UNIT, and that unit is ROWS.
 *
 * ── What this protects ──────────────────────────────────────────────────────
 *
 * `getRecentSnapshots` took `days = 30` and used it as `take: -days`. The
 * parameter named a duration and meant a row count, and every caller inherited
 * the misnomer. One of them published it: the Daily Brief told a user "Net worth
 * is up 14.9% over the last 90 days" about a 90-ROW window, while the Space said
 * 47.4% for the same words on the same day (v2.6-WINDOW-1).
 *
 * The bound is now an object (`{ rows: N }`), so a positional number does not
 * compile and the unit is stated at every call site. That is the real guard —
 * the type. These assertions cover what the type cannot:
 *
 *   1. nobody reintroduces a duration-named alias for the row bound;
 *   2. no CONSTANT feeding the bound is named as a duration;
 *   3. the safety fact that makes a row cap legitimate stays true in the schema.
 *
 * ── Why a row bound is correct, and not merely tolerated ────────────────────
 *
 * `SpaceSnapshot` carries `@@unique([spaceId, date])`: at most one row per Space
 * per day. So N rows always span at least N−1 calendar days — a row cap is a
 * CONSERVATIVE over-cover of the same number of days, never a silent truncation.
 * Measured across the corpus every Space runs at exactly 1.00 rows/day, and gaps
 * only widen the span (Jane's Space: 366 rows across 371 calendar days).
 *
 * That is why every caller is a generous cap with client-side clipping and none
 * needs a date-bounded read. No date-window reader was added, deliberately: an
 * authority with no consumer is the failure this codebase already learned once
 * (TX-3, "never ship an authority without a consumer"). A surface that wants to
 * make a CLAIM about a window resolves it through `canonicalWindowChange`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = process.cwd();
const SCAN_ROOTS = ["lib", "app", "components", "jobs", "scripts"];

/** The DEFINITION (whose parameter list is not a call) and this guard itself
 *  (whose regex literals contain the pattern being searched for). */
const NOT_CALL_SITES = new Set([
  path.join("lib", "data", "snapshots.ts"),
  path.join("lib", "data", "snapshot-read-bound.test.ts"),
]);

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const childRel = path.join(rel, e);
    if (statSync(path.join(ROOT, childRel)).isDirectory()) { out.push(...walk(childRel)); continue; }
    if (!/\.(ts|tsx)$/.test(e)) continue;
    out.push(childRel);
  }
  return out;
}

/** Strip comments — the defect is DESCRIBED in several headers, and prose about
 *  a fixed bug is not the bug. */
function codeOf(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

test("WINDOW-2: every getRecentSnapshots call states its bound as rows", () => {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      if (NOT_CALL_SITES.has(file)) continue;
      const code = codeOf(file);
      for (const m of code.matchAll(/getRecentSnapshots\s*\(([^)]*)/g)) {
        const arg = m[1].trim();
        if (arg === "") continue;                       // a type-only mention
        if (/^\{\s*rows\s*:/.test(arg)) continue;       // the sanctioned shape
        offenders.push(`${file}  →  getRecentSnapshots(${arg.slice(0, 48)}…`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    `A snapshot read is not stating its unit:\n${offenders.map((o) => `  ${o}`).join("\n")}\n\n` +
    `Pass \`{ rows: N }\`. A positional number cannot say whether it means rows or ` +
    `days, and when it meant rows while being called days the Daily Brief published ` +
    `"over the last 90 days" about a 90-row window.`,
  );
});

test("WINDOW-2: no constant feeding a snapshot row bound is named as a duration", () => {
  // `SERIES_DAYS` was such a constant: 1100, correctly used as rows, entirely
  // misleading. The value was never wrong — the name was, and a name that lies
  // survives review precisely because the behaviour is right.
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      if (NOT_CALL_SITES.has(file)) continue;
      const code = codeOf(file);
      if (!/getRecentSnapshots\s*\(/.test(code)) continue;
      for (const m of code.matchAll(/getRecentSnapshots\s*\(\s*\{\s*rows:\s*([A-Za-z_$][\w$]*)/g)) {
        const ident = m[1];
        if (/DAY|DURATION|MONTH|YEAR|WEEK/i.test(ident)) {
          offenders.push(`${file}  →  { rows: ${ident} }`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    `A ROW bound is being fed by a duration-named constant:\n` +
    `${offenders.map((o) => `  ${o}`).join("\n")}\n\n` +
    `Rename it (…_ROWS). The bound is rows; a duration name re-creates exactly ` +
    `the ambiguity the object parameter removed.`,
  );
});

test("WINDOW-2: one snapshot row per Space per day is still enforced by the schema", () => {
  // The whole argument that a ROW cap is safe rests on this constraint: with at
  // most one row per day, N rows span at least N−1 days, so a row bound can only
  // ever OVER-cover a date range. Drop the constraint and every caller silently
  // becomes capable of under-covering the window it believes it read.
  const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
  const model = schema.slice(schema.indexOf("model SpaceSnapshot"));
  const body = model.slice(0, model.indexOf("\n}"));
  assert.match(
    body, /@@unique\(\[spaceId,\s*date\]\)/,
    "SpaceSnapshot lost @@unique([spaceId, date]). A row-bounded snapshot read is only " +
    "a safe proxy for a day window while at most one row exists per Space per day; " +
    "without it, every `{ rows: N }` caller can silently under-cover N days.",
  );
});
