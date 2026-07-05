/**
 * lib/snapshots/backfill-core.test.ts
 *
 * D2.x Slice 4 — pure tests for the reconstruction math. Standalone (no DB, no
 * prisma generate). Runs as a cjs transpile + node, e.g.:
 *
 *   npx tsc lib/snapshots/backfill-core.ts lib/snapshots/backfill-core.test.ts \
 *     lib/account-classifier.ts \
 *     --outDir /tmp/bf --rootDir lib --module commonjs --target es2020 \
 *     --skipLibCheck --moduleResolution node && node /tmp/bf/snapshots/backfill-core.test.js
 */

import {
  reconstructDailyCashBalances,
  reconstructDailyLiabilityBalances,
  computeSnapshotFields,
  isoDate,
  addDaysUTC,
  fromISO,
} from "./backfill-core";
import { classifyAccounts } from "../account-classifier";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const today = fromISO("2026-07-04"); // UTC midnight

console.log("reconstructDailyCashBalances — delta walk");
{
  // Account "a": current balance 1000 (eod today).
  //   txns dated today: -50  → eod(today-1) = 1000 − (−50) = 1050
  //   txns dated today-1: +200 → eod(today-2) = 1050 − (+200) = 850
  const deltas = new Map<string, Map<string, number>>([
    ["a", new Map<string, number>([
      [isoDate(today), -50],
      [isoDate(addDaysUTC(today, -1)), 200],
    ])],
  ]);
  const out = reconstructDailyCashBalances([{ id: "a", balance: 1000 }], deltas, today, addDaysUTC(today, -3));

  check("today is excluded", !out.has(isoDate(today)));
  check("eod(today-1) = 1050", out.get(isoDate(addDaysUTC(today, -1)))?.get("a") === 1050);
  check("eod(today-2) = 850", out.get(isoDate(addDaysUTC(today, -2)))?.get("a") === 850);
  check("eod(today-3) = 850 (no txns → held flat)", out.get(isoDate(addDaysUTC(today, -3)))?.get("a") === 850);
  check("produced exactly 3 days (today-1..today-3)", out.size === 3);
  check("newest-first insertion order", [...out.keys()][0] === isoDate(addDaysUTC(today, -1)));
}

console.log("reconstructDailyCashBalances — missing deltas hold flat");
{
  const out = reconstructDailyCashBalances([{ id: "x", balance: 500 }], new Map(), today, addDaysUTC(today, -2));
  check("no txns → flat across window", out.get(isoDate(addDaysUTC(today, -1)))?.get("x") === 500 && out.get(isoDate(addDaysUTC(today, -2)))?.get("x") === 500);
}

console.log("computeSnapshotFields — parity with regenerate.ts formula");
{
  const f = computeSnapshotFields({
    totalInvestments:   1000,
    totalDigitalAssets: 200,
    totalChecking:      300,
    totalSavings:       100,
    totalLiabilities:   150,
    totalRealAssets:    500,
  });
  check("total = stocks+crypto = 1200", f.total === 1200);
  check("totalAssets = 1200+300+100+500 = 2100", f.totalAssets === 2100);
  check("netWorth = totalAssets − debt = 1950", f.netWorth === 1950);
  check("netLiquid = cash+savings−debt = 250", f.netLiquid === 250);
  check("cashOnHand = max(cash,0) = 300", f.cashOnHand === 300);
  check("cashOnHand floors at 0 for negative cash", computeSnapshotFields({
    totalInvestments: 0, totalDigitalAssets: 0, totalChecking: -40, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0,
  }).cashOnHand === 0);
}

console.log("date helpers");
{
  check("addDaysUTC crosses month boundary", isoDate(addDaysUTC(fromISO("2026-07-01"), -1)) === "2026-06-30");
  check("isoDate is date-only UTC", isoDate(fromISO("2026-07-04")) === "2026-07-04");
}

console.log("reconstructDailyLiabilityBalances — credit-card owed walk (ADD)");
{
  // Card owed today = 500. On July 2: purchase (FM −100). Reverse walk ADDS,
  // so owed BEFORE the July 2 purchase (July 1) = 500 + (−100) = 400.
  const deltas = new Map<string, Map<string, number>>([
    ["card", new Map<string, number>([[isoDate(addDaysUTC(today, -2)), -100]])], // July 2 purchase
  ]);
  const out = reconstructDailyLiabilityBalances([{ id: "card", balance: 500 }], deltas, today, addDaysUTC(today, -3));
  check("purchase → owed lower before the charge (400)", out.get(isoDate(addDaysUTC(today, -3)))?.get("card") === 400);
  check("today excluded", !out.has(isoDate(today)));
}
{
  // Payment on July 2 (FM +300) → owed BEFORE payment was higher: 500 + 300 = 800.
  const deltas = new Map<string, Map<string, number>>([
    ["card", new Map<string, number>([[isoDate(addDaysUTC(today, -2)), 300]])],
  ]);
  const out = reconstructDailyLiabilityBalances([{ id: "card", balance: 500 }], deltas, today, addDaysUTC(today, -3));
  check("payment → owed higher before the payment (800)", out.get(isoDate(addDaysUTC(today, -3)))?.get("card") === 800);
}
{
  // Refund on July 2 (FM +50, reduces owed) → owed before was higher: 500 + 50 = 550.
  const deltas = new Map<string, Map<string, number>>([
    ["card", new Map<string, number>([[isoDate(addDaysUTC(today, -2)), 50]])],
  ]);
  const out = reconstructDailyLiabilityBalances([{ id: "card", balance: 500 }], deltas, today, addDaysUTC(today, -3));
  check("refund → owed higher before the refund (550)", out.get(isoDate(addDaysUTC(today, -3)))?.get("card") === 550);
}
{
  // No deltas → owed holds flat across the window.
  const out = reconstructDailyLiabilityBalances([{ id: "card", balance: 500 }], new Map(), today, addDaysUTC(today, -2));
  check("no txns → owed flat", out.get(isoDate(addDaysUTC(today, -1)))?.get("card") === 500 && out.get(isoDate(addDaysUTC(today, -2)))?.get("card") === 500);
}

console.log("overpayment clamp — classifyAccounts treats negative owed as $0 liability");
{
  // A reconstructed negative owed (overpaid card) must not count as a liability
  // (or as an asset). classifyAccounts sums max(0, balance) for debt.
  const c = classifyAccounts([
    { id: "card", type: "debt", balance: -20 },   // overpaid → clamps to 0 owed
    { id: "card2", type: "debt", balance: 300 },  // normal owed
    { id: "chk", type: "checking", balance: 1000 },
  ]);
  check("negative owed clamped out of totalLiabilities (=300)", c.totalLiabilities === 300);
  check("overpaid card does not inflate assets", c.totalAssets === 1000);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll backfill-core checks passed");
