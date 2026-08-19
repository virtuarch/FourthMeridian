/**
 * lib/data/snapshot-read-boundary.test.ts
 *
 * REVIEW-3 B-4 (E4) — THE SNAPSHOT READ-BOUNDARY RATCHET.
 *
 * `getRecentSnapshots` (lib/data/snapshots.ts) is the ONE consumer-facing
 * snapshot read: it resolves FX stamps, completeness, crypto assertability and
 * aggregate authorisation once, at the boundary. History shows what happens
 * when a reader bypasses it: the Spaces launcher raw-read `netWorth` for a year
 * and rendered rows the Wealth chart refuses to plot as plain numbers.
 *
 * This ratchet bans NEW direct `spaceSnapshot` READS outside the enumerated
 * authority files, house-ratchet style: the allowlist below is the census
 * (REVIEW-3 slice D), each entry classified. Adding a direct read elsewhere
 * fails this test; the fix is to consume `getRecentSnapshots` /
 * `getSpaceNetWorthSummaries` (or, for genuinely different questions, to argue
 * the entry here, in review).
 *
 * Writes (`upsert`/`createMany`/`update…`/`delete…`) are deliberately NOT this
 * guard's subject — the writer family has its own convergence pins
 * (regenerate.test.ts, background-authority.test.ts, regenerate-history.test.ts).
 *
 * `scripts/` and `prisma/` are excluded by scope: measuring instruments and the
 * seed read raw on purpose (they audit the very layers this boundary owns).
 *
 * Also carries the v2.6-WINDOW-2 rows-unit ratchet (merged from
 * lib/data/snapshot-read-bound.test.ts): every getRecentSnapshots call states
 * its bound as `{ rows: N }`, no duration-named constant feeds a row bound, and
 * the schema fact that makes a row cap safe (@@unique([spaceId, date])) holds.
 *
 * Standalone tsx script:  npx tsx lib/data/snapshot-read-boundary.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/**
 * THE CENSUS — every file allowed a direct spaceSnapshot READ, classified.
 *
 *   READ BOUNDARY (the authority itself)
 *     lib/data/snapshots.ts               getRecentSnapshots + the launcher
 *                                         summaries (both resolve per-row
 *                                         authority via snapshot-summary.core)
 *
 *   WRITER-INTERNAL (the regeneration family reading its own storage)
 *     lib/snapshots/backfill.ts           existing-row gate before createMany
 *     lib/snapshots/regenerate-history.ts frozen/partial-day planning + verify
 *     lib/snapshots/historical-work-window.ts  window bounds for regeneration
 *
 *   INTENTIONALLY DIFFERENT QUESTION
 *     lib/platform/connection-diagnostics.ts  groupBy _max(date) — snapshot
 *                                         RECENCY metadata for ops diagnostics,
 *                                         no financial value is read
 */
const ALLOWED_READERS = new Set([
  "lib/data/snapshots.ts",
  "lib/snapshots/backfill.ts",
  "lib/snapshots/regenerate-history.ts",
  "lib/snapshots/historical-work-window.ts",
  "lib/platform/connection-diagnostics.ts",
]);

const SCAN_DIRS = ["lib", "app", "components", "jobs"];
const READ_METHODS = /\bspaceSnapshot\s*\.\s*(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|groupBy|aggregate|count)\s*\(/g;

/** Remove comments so prose (like this file's own docs) can't trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collect(dir: string, includeTests = false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "prototype") continue;
      out.push(...collect(full, includeTests));
    } else if (/\.(ts|tsx)$/.test(entry.name) && (includeTests || !/\.test\.tsx?$/.test(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

console.log("REVIEW-3 — spaceSnapshot read-boundary ratchet\n");

const readers = new Map<string, string[]>(); // rel path → matched calls
for (const dir of SCAN_DIRS) {
  for (const file of collect(path.join(ROOT, dir))) {
    const code = stripComments(readFileSync(file, "utf8"));
    const matches = [...code.matchAll(READ_METHODS)].map((m) => m[1]);
    if (matches.length > 0) readers.set(path.relative(ROOT, file), matches);
  }
}

// The scan must actually see the boundary itself — a silently-empty scan would
// make the ban vacuously green.
check("scan is not vacuous (the read boundary itself is found)",
  readers.has("lib/data/snapshots.ts"));

const offenders = [...readers.keys()].filter((f) => !ALLOWED_READERS.has(f));
check(
  "no direct spaceSnapshot READ outside the enumerated authority files",
  offenders.length === 0,
  offenders.map((f) => `${f} (${readers.get(f)!.join(", ")})`).join("; "),
);

// Ratchet hygiene: an allowlist entry that no longer reads directly should be
// REMOVED (otherwise the list silently over-licenses future edits).
const stale = [...ALLOWED_READERS].filter((f) => !readers.has(f));
check("allowlist carries no stale entries", stale.length === 0, stale.join(", "));

// The launcher path must consume the shared per-row authority, not re-derive.
const snapshotsSrc = stripComments(readFileSync(path.join(ROOT, "lib/data/snapshots.ts"), "utf8"));
check("launcher summaries go through the shared admissibility core",
  /admissibleNetWorthSeries\s*\(/.test(snapshotsSrc) && /summarizeNetWorthSeries\s*\(/.test(snapshotsSrc));
check("getRecentSnapshots resolves rows through the same shared authority",
  /resolveSnapshotRowProvenance\s*\(/.test(snapshotsSrc));

// ── merged from lib/data/snapshot-read-bound.test.ts ─────────────────────────
// v2.6-WINDOW-2 — a snapshot read states its UNIT, and that unit is ROWS.
//
// What this protects: `getRecentSnapshots` took `days = 30` and used it as
// `take: -days`. The parameter named a duration and meant a row count, and
// every caller inherited the misnomer. One of them published it: the Daily
// Brief told a user "Net worth is up 14.9% over the last 90 days" about a
// 90-ROW window, while the Space said 47.4% for the same words on the same day
// (v2.6-WINDOW-1). The bound is now an object (`{ rows: N }`), so a positional
// number does not compile and the unit is stated at every call site. That is
// the real guard — the type. These assertions cover what the type cannot:
//
//   1. nobody reintroduces a duration-named alias for the row bound;
//   2. no CONSTANT feeding the bound is named as a duration;
//   3. the safety fact that makes a row cap legitimate stays true in the schema.
//
// Why a row bound is correct, and not merely tolerated: `SpaceSnapshot` carries
// `@@unique([spaceId, date])` — at most one row per Space per day. So N rows
// always span at least N−1 calendar days: a row cap is a CONSERVATIVE
// over-cover of the same number of days, never a silent truncation. Measured
// across the corpus every Space runs at exactly 1.00 rows/day, and gaps only
// widen the span (Jane's Space: 366 rows across 371 calendar days). That is why
// every caller is a generous cap with client-side clipping and none needs a
// date-bounded read. No date-window reader was added, deliberately: an
// authority with no consumer is the failure this codebase already learned once
// (TX-3, "never ship an authority without a consumer"). A surface that wants to
// make a CLAIM about a window resolves it through `canonicalWindowChange`.
console.log("\nWINDOW-2 — snapshot reads state their unit (rows)\n");

// The WINDOW-2 scan deliberately INCLUDES test files (a test calling the read
// positionally would inherit the misnomer too) and adds scripts/ to the roots.
const UNIT_SCAN_ROOTS = ["lib", "app", "components", "jobs", "scripts"];
/** The DEFINITION (whose parameter list is not a call) and this guard itself
 *  (whose regex literals contain the pattern being searched for). */
const NOT_CALL_SITES = new Set([
  path.join("lib", "data", "snapshots.ts"),
  path.join("lib", "data", "snapshot-read-boundary.test.ts"),
]);

{
  const offenders: string[] = [];
  for (const root of UNIT_SCAN_ROOTS) {
    let files: string[] = [];
    try { files = collect(path.join(ROOT, root), true); } catch { continue; }
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (NOT_CALL_SITES.has(rel)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/getRecentSnapshots\s*\(([^)]*)/g)) {
        const arg = m[1].trim();
        if (arg === "") continue;                       // a type-only mention
        if (/^\{\s*rows\s*:/.test(arg)) continue;       // the sanctioned shape
        offenders.push(`${rel}  →  getRecentSnapshots(${arg.slice(0, 48)}…`);
      }
    }
  }
  check(
    "WINDOW-2: every getRecentSnapshots call states its bound as rows",
    offenders.length === 0,
    `A snapshot read is not stating its unit:\n${offenders.map((o) => `  ${o}`).join("\n")}\n\n` +
    `Pass \`{ rows: N }\`. A positional number cannot say whether it means rows or ` +
    `days, and when it meant rows while being called days the Daily Brief published ` +
    `"over the last 90 days" about a 90-row window.`,
  );
}

{
  // `SERIES_DAYS` was such a constant: 1100, correctly used as rows, entirely
  // misleading. The value was never wrong — the name was, and a name that lies
  // survives review precisely because the behaviour is right.
  const offenders: string[] = [];
  for (const root of UNIT_SCAN_ROOTS) {
    let files: string[] = [];
    try { files = collect(path.join(ROOT, root), true); } catch { continue; }
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (NOT_CALL_SITES.has(rel)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (!/getRecentSnapshots\s*\(/.test(code)) continue;
      for (const m of code.matchAll(/getRecentSnapshots\s*\(\s*\{\s*rows:\s*([A-Za-z_$][\w$]*)/g)) {
        const ident = m[1];
        if (/DAY|DURATION|MONTH|YEAR|WEEK/i.test(ident)) {
          offenders.push(`${rel}  →  { rows: ${ident} }`);
        }
      }
    }
  }
  check(
    "WINDOW-2: no constant feeding a snapshot row bound is named as a duration",
    offenders.length === 0,
    `A ROW bound is being fed by a duration-named constant:\n` +
    `${offenders.map((o) => `  ${o}`).join("\n")}\n\n` +
    `Rename it (…_ROWS). The bound is rows; a duration name re-creates exactly ` +
    `the ambiguity the object parameter removed.`,
  );
}

{
  // The whole argument that a ROW cap is safe rests on this constraint: with at
  // most one row per day, N rows span at least N−1 days, so a row bound can only
  // ever OVER-cover a date range. Drop the constraint and every caller silently
  // becomes capable of under-covering the window it believes it read.
  const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
  const model = schema.slice(schema.indexOf("model SpaceSnapshot"));
  const body = model.slice(0, model.indexOf("\n}"));
  check(
    "WINDOW-2: one snapshot row per Space per day is still enforced by the schema",
    /@@unique\(\[spaceId,\s*date\]\)/.test(body),
    "SpaceSnapshot lost @@unique([spaceId, date]). A row-bounded snapshot read is only " +
    "a safe proxy for a day window while at most one row exists per Space per day; " +
    "without it, every `{ rows: N }` caller can silently under-cover N days.",
  );
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll snapshot read-boundary checks passed");
