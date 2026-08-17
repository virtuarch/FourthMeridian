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

if (failures > 0) {
  console.error(`\nsnapshot.authority: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll snapshot-authority checks passed.");
