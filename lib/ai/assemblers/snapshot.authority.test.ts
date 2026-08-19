/**
 * lib/ai/assemblers/snapshot.authority.test.ts
 *
 * V26-PRE (B2) — the AI snapshot assembler must consume the CANONICAL
 * stamp-aware snapshot read (lib/data/snapshots.ts getRecentSnapshots), never
 * its own SpaceSnapshot query. The pre-fix assembler ran a currency-blind
 * `db.spaceSnapshot.findMany` (no `reportingCurrency` selected) and folded
 * net-worth trends across rows stamped in different currencies — a Space that
 * ever changed reporting currency produced a fabricated trend in AI answers.
 *
 * Two layers:
 *   A. Source-scan authority pin — the assembler imports getRecentSnapshots
 *      and holds no direct db/spaceSnapshot access. A regression back to a
 *      private query trips here even if behavior looks plausible.
 *   B. Behavioral pins on the pure projection (projectSnapshotSection):
 *      fxMiss exclusion + disclosure, estimated propagation, trend math over
 *      the converted series only, brief-scope shape, null on no usable rows.
 *
 * Also hosts the v2.6-WINDOW-1 pins merged from snapshot-window.test.ts: the
 * snapshot section states a window the product DEFINES. `snapshotCount` is a
 * ROW COUNT (`getRecentSnapshots` uses `take`), yet surfaces rendered it as a
 * number of DAYS while the trend spanned oldest→newest of whatever rows were
 * fetched — a real number over an ACCIDENTAL window. Those pins prove
 * `projectSnapshotSection` EMITS a true calendar span and a canonical
 * (subMonths) change, refuses short histories, and never resurfaces the
 * deleted accidental-trend fields. The cadence (weekly) fixture is the one
 * that matters: on a daily contiguous series row count and day span nearly
 * coincide, which is exactly why the defect survived.
 *
 * Standalone tsx:  npx tsx lib/ai/assemblers/snapshot.authority.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { projectSnapshotSection } from "./snapshot";
import type { Snapshot } from "@/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ─── A. Source-scan authority pin ────────────────────────────────────────────

const src = fs
  .readFileSync(path.join(process.cwd(), "lib", "ai", "assemblers", "snapshot.ts"), "utf8")
  // Strip comments so prose mentioning the old pattern can't false-positive.
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

check(
  "assembler imports the canonical read (getRecentSnapshots from @/lib/data/snapshots)",
  /import\s*\{[^}]*getRecentSnapshots[^}]*\}\s*from\s*['"]@\/lib\/data\/snapshots['"]/.test(src),
);
check(
  "assembler holds NO direct db import (truth is not rebuilt here)",
  !/from\s*['"]@\/lib\/db['"]/.test(src),
);
check(
  "assembler holds NO direct spaceSnapshot query",
  !/spaceSnapshot/.test(src),
);
check(
  // v2.6-WINDOW-2 — the bound became a named object (`{ rows: N }`) so a
  // positional number can no longer hide which unit it is. Same call, same
  // Space scoping, same limit; the pin follows the new shape and additionally
  // requires the bound be spelled `rows`, since that is the whole point.
  "assembler calls getRecentSnapshots scoped to the validated Space, bounded by ROWS",
  /getRecentSnapshots\(\s*\{\s*rows:\s*SNAPSHOT_HISTORY_LIMIT\s*\}\s*,\s*\{\s*spaceId\s*\}\s*\)/.test(src),
);

// ─── B. Behavioral pins on the pure projection ───────────────────────────────

function snap(over: Partial<Snapshot> & { date: string }): Snapshot {
  return {
    netWorth: 0, totalAssets: 0, totalDebt: 0, totalCash: 0, totalSavings: 0,
    totalInvestments: 0, totalCrypto: 0, cashOnHand: 0, netLiquid: 0,
    ...over,
  };
}

// B1. Homogeneous clean history — byte-familiar shape, no disclosure fields.
{
  const out = projectSnapshotSection(
    [
      snap({ date: "2026-07-01", netWorth: 1000, totalCash: 300, totalSavings: 200 }),
      snap({ date: "2026-07-02", netWorth: 1100, totalCash: 350, totalSavings: 200 }),
    ],
    "full",
  );
  check("clean history: section assembled", out !== null);
  check("clean history: no accidental-window trend fields (REVIEW-3)",
    out !== null && !("netWorthTrend" in out) && !("netWorthTrendPct" in out));
  check("clean history: fold endpoints usable (1000 → 1100)",
    out?.history[0]?.netWorth === 1000 && out?.history[1]?.netWorth === 1100);
  check("clean history: liquid = cash + savings", out?.latest?.liquid === 550);
  check("clean history: no estimated flag", out !== null && !("estimated" in out));
  check("clean history: no exclusion disclosure", out !== null && !("excludedFxMissPoints" in out));
}

// B2. fxMiss points are EXCLUDED from every fold and the exclusion is DISCLOSED.
// The fxMiss row carries a native-magnitude netWorth (unconverted JPY-scale
// number) that would corrupt the trend if it entered the series.
{
  const out = projectSnapshotSection(
    [
      snap({ date: "2026-07-01", netWorth: 1000 }),
      snap({ date: "2026-07-02", netWorth: 15_000_000, fxMiss: true }),
      snap({ date: "2026-07-03", netWorth: 1200 }),
    ],
    "full",
  );
  check("fxMiss: excluded from count", out?.snapshotCount === 2);
  check("fxMiss: excluded from the series endpoints (1000…1200, never native-magnitude)",
    out?.history[0]?.netWorth === 1000 && out?.history[out.history.length - 1]?.netWorth === 1200);
  check("fxMiss: excluded from history", out?.history.length === 2);
  check("fxMiss: exclusion disclosed", out?.excludedFxMissPoints === 1);
  check("fxMiss: latest is the last USABLE point", out?.latest?.date === "2026-07-03");
}

// B3. Estimated (read-time converted / reconstructed) propagates to the section.
{
  const out = projectSnapshotSection(
    [
      snap({ date: "2026-07-01", netWorth: 1000 }),
      snap({ date: "2026-07-02", netWorth: 1100, isEstimated: true }),
    ],
    "full",
  );
  check("estimated: propagated to section", out?.estimated === true);
}

// B4. All points unconvertible → null (domain honestly empty, never zeros).
{
  const out = projectSnapshotSection(
    [snap({ date: "2026-07-01", netWorth: 5, fxMiss: true })],
    "full",
  );
  check("all-fxMiss: section is null", out === null);
}

// B5. brief scope: latest + trend only, empty history array.
{
  const out = projectSnapshotSection(
    [
      snap({ date: "2026-07-01", netWorth: 1000 }),
      snap({ date: "2026-07-02", netWorth: 1100 }),
    ],
    "brief",
  );
  check("brief: history omitted", out?.history.length === 0);
  check("brief: latest retained", out?.latest?.netWorth === 1100);
  check("brief: canonical latest retained without trend fields",
    out !== null && !("netWorthTrend" in out));
}

// B6. Zero-baseline: pct is null when oldest netWorth is 0 (no fabricated %).
{
  const out = projectSnapshotSection(
    [
      snap({ date: "2026-07-01", netWorth: 0 }),
      snap({ date: "2026-07-02", netWorth: 500 }),
    ],
    "full",
  );
  // B6. Zero-baseline handling now lives in canonicalWindowChange (pct null on
  // zero opening value) — pinned in lib/data/snapshot-window.test.ts. Here we
  // pin only that the deleted accidental fields did not resurface.
  check("zero baseline: no accidental trend fields", out !== null && !("netWorthTrend" in out));
}

// ─────────────────────────────────────────────────────────────────────────────
// ── merged from lib/ai/assemblers/snapshot-window.test.ts (v2.6-WINDOW-1) ────
// The snapshot section states a window the product DEFINES. Measured on the
// live corpus before the fix:
//
//   Daily Brief    "up 14.9% over the last 90 days"   baseline 2026-05-10
//   Space  1M      "26.8% vs Jul 7, 2026"             baseline 2026-07-07
//   Space  90d     "47.4% vs May 7, 2026"             baseline 2026-05-07
//
// The Brief's baseline was the 90th ROW — 89 days back — while the Space's was
// `subMonths(asOf, 3)`, 92 days back. Both screens said "90 days" and differed
// by a factor of three. `scripts/audit-snapshot-window-claims.ts` measures the
// corpus but cannot load the assembler (`server-only`); this half is a property
// of a pure function, so it belongs on fixtures where it runs in CI with no
// database and cannot pass vacuously on a thin seed.
// ─────────────────────────────────────────────────────────────────────────────

/** N points, `stepDays` apart, ending on `endIso` (netWorth ramps from→to). */
function series(endIso: string, count: number, stepDays: number, from: number, to: number): Snapshot[] {
  const end = new Date(`${endIso}T00:00:00Z`).getTime();
  const out: Snapshot[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(end - i * stepDays * 86_400_000).toISOString().slice(0, 10);
    const t = count === 1 ? 1 : (count - 1 - i) / (count - 1);
    const v = from + (to - from) * t;
    out.push(snap({ date: d, netWorth: v, totalAssets: v }));
  }
  return out;
}

// W1. spanDays is the calendar distance, NOT the row count.
{
  // 13 WEEKLY points: 13 rows, 84 days. A surface printing the count would say
  // "13 days" about three months of history — or, in the shape that shipped,
  // "90 days" about 89.
  const weekly = projectSnapshotSection(series("2026-08-07", 13, 7, 20_000, 28_000), "full");
  check("WINDOW-1: weekly section assembled", weekly !== null);
  check("WINDOW-1: 13 rows counted", weekly?.snapshotCount === 13);
  check("WINDOW-1: spanDays is the calendar distance between the endpoints, not the number of rows",
    weekly?.spanDays === 84, `got ${weekly?.spanDays}`);
  check("WINDOW-1: a weekly series is exactly the case where count and span diverge — if these are " +
    "equal, spanDays is being derived from the count again",
    weekly !== null && weekly.spanDays !== weekly.snapshotCount);
}

// W2. The canonical change opens a CALENDAR month back, not a row offset.
{
  // Daily series across a month boundary. The canonical window must open on
  // 2026-07-07 (subMonths), whatever row that happens to be.
  const daily = projectSnapshotSection(series("2026-08-07", 90, 1, 10_000, 28_000), "full");
  check("WINDOW-1: daily section assembled", daily !== null);
  check("WINDOW-1: a 90-day daily series reaches back one month", daily?.canonicalChange != null);
  check("WINDOW-1: canonical window opens on the subMonths date", daily?.canonicalChange?.fromDate === "2026-07-07");
  check("WINDOW-1: canonical window closes on asOf", daily?.canonicalChange?.toDate === "2026-08-07");
  check("WINDOW-1: canonical window preset is PAST_MONTH", daily?.canonicalChange?.preset === "PAST_MONTH");
  // The change is measured between those two points — not oldest→newest.
  {
    // The accidental oldest→newest figure (computed inline here — the payload
    // field was deleted at REVIEW-3 integration) must differ from the canonical
    // window change, or the window would be decorative.
    const accidental = daily === null ? NaN :
      (daily.history[daily.history.length - 1].netWorth ?? 0) - (daily.history[0].netWorth ?? 0);
    check("WINDOW-1: canonicalChange must not equal the oldest→newest trend: that is the accidental " +
      "window it exists to replace",
      daily?.canonicalChange?.abs !== accidental);
  }
  check("WINDOW-1: abs is exactly toValue − fromValue",
    daily?.canonicalChange != null &&
    daily.canonicalChange.toValue - daily.canonicalChange.fromValue === daily.canonicalChange.abs);
}

// W3. A history shorter than the window is REFUSED, not approximated.
{
  // Ten days of history cannot support a one-month claim. The authority must
  // return null rather than comparing against the earliest point it holds —
  // which is precisely how an accidental window gets presented as a real one.
  const short = projectSnapshotSection(series("2026-08-07", 10, 1, 27_000, 28_000), "full");
  check("WINDOW-1: short section assembled", short !== null);
  check("WINDOW-1: history that does not reach the window must refuse, never fall back to oldest→newest",
    short?.canonicalChange === null);
  // The accidental-trend fields were deleted at REVIEW-3 integration — the
  // refusal above is the ONLY change answer the payload may carry.
  check("WINDOW-1: no accidental-trend fields on a refused window",
    short !== null && !("netWorthTrend" in short) && !("netWorthTrendPct" in short));
  check("WINDOW-1: short spanDays is 9", short?.spanDays === 9);
}

// W4. An unassertable endpoint does not silently become a window.
{
  // A single point cannot produce a change of any kind.
  const one = projectSnapshotSection([snap({ date: "2026-08-07", netWorth: 28_000, totalAssets: 28_000 })], "full");
  check("WINDOW-1: single-point section assembled", one !== null);
  check("WINDOW-1: single point spans 0 days", one?.spanDays === 0);
  check("WINDOW-1: single point carries no trend field", one !== null && !("netWorthTrend" in one));
  check("WINDOW-1: single point yields no canonical change", one?.canonicalChange === null);
}

if (failures > 0) {
  console.error(`\nsnapshot.authority: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll snapshot-authority checks passed.");
process.exit(0);
