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
 *     lib/investments/historical-point-detail.ts  ONE row's stocks/crypto for
 *                                         the drill-down reconciliation, using
 *                                         the same canonical interpreters
 *                                         (resolveCryptoValuationState) — a
 *                                         component question, not a net-worth
 *                                         series read
 *     lib/platform/connection-diagnostics.ts  groupBy _max(date) — snapshot
 *                                         RECENCY metadata for ops diagnostics,
 *                                         no financial value is read
 */
const ALLOWED_READERS = new Set([
  "lib/data/snapshots.ts",
  "lib/snapshots/backfill.ts",
  "lib/snapshots/regenerate-history.ts",
  "lib/snapshots/historical-work-window.ts",
  "lib/investments/historical-point-detail.ts",
  "lib/platform/connection-diagnostics.ts",
]);

const SCAN_DIRS = ["lib", "app", "components", "jobs"];
const READ_METHODS = /\bspaceSnapshot\s*\.\s*(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|groupBy|aggregate|count)\s*\(/g;

/** Remove comments so prose (like this file's own docs) can't trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "prototype") continue;
      out.push(...collect(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
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

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll snapshot read-boundary checks passed");
