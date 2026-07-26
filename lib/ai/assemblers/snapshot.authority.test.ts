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
  "assembler calls getRecentSnapshots scoped to the validated Space",
  /getRecentSnapshots\(\s*SNAPSHOT_HISTORY_LIMIT\s*,\s*\{\s*spaceId\s*\}\s*\)/.test(src),
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
  check("clean history: trend = latest − oldest", out?.netWorthTrend === 100);
  check("clean history: pct rounded to 2dp", out?.netWorthTrendPct === 10);
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
  check("fxMiss: excluded from trend (1200−1000, not native-magnitude)", out?.netWorthTrend === 200);
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
  check("brief: trend retained", out?.netWorthTrend === 100);
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
  check("zero baseline: absolute trend kept", out?.netWorthTrend === 500);
  check("zero baseline: pct null", out?.netWorthTrendPct === null);
}

if (failures > 0) {
  console.error(`\nsnapshot.authority: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll snapshot-authority checks passed.");
