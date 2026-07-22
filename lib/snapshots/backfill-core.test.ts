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
  computeAccountFloors,
  isHeldFlatBalanceAccount,
  isoDate,
  addDaysUTC,
  fromISO,
} from "./backfill-core";
import { classifyAccounts, isDigitalAssetAccountType, DIGITAL_ASSET_ACCOUNT_TYPES } from "../account-classifier";

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

console.log("REG-2 — isHeldFlatBalanceAccount (held-flat cash inclusion predicate)");
{
  check("checking with balance + no tx → held flat",
    isHeldFlatBalanceAccount({ type: "checking", balance: 9000 }, false) === true);
  check("savings with balance + no tx → held flat",
    isHeldFlatBalanceAccount({ type: "savings", balance: 500 }, false) === true);
  check("debt with balance + no tx → held flat",
    isHeldFlatBalanceAccount({ type: "debt", balance: 2000 }, false) === true);
  check("cash WITH tx → NOT held flat (walk-back reconstructs it)",
    isHeldFlatBalanceAccount({ type: "checking", balance: 9000 }, true) === false);
  check("zero-balance cash + no tx → NOT held flat (nothing to hold)",
    isHeldFlatBalanceAccount({ type: "checking", balance: 0 }, false) === false);
  check("investment + no tx → NOT held flat (valued from holdings)",
    isHeldFlatBalanceAccount({ type: "investment", balance: 5000 }, false) === false);
  check("crypto + no tx → NOT held flat",
    isHeldFlatBalanceAccount({ type: "crypto", balance: 5000 }, false) === false);
  check("other/real-asset + no tx → NOT held flat",
    isHeldFlatBalanceAccount({ type: "other", balance: 5000 }, false) === false);
}

console.log("REG-1/REG-2 — a balance-bearing cash account is always in total assets / net worth");
{
  // Validation #1 — totalAssets includes liquid cash; a $9,000 checking account
  // with zero transactions still reaches cash → totalAssets → netWorth.
  const c = classifyAccounts([{ id: "chk", type: "checking", balance: 9000 }]);
  const f = computeSnapshotFields(c);
  check("cash reaches totalAssets ($9,000)", f.totalAssets === 9000);
  check("cash reaches netWorth ($9,000)", f.netWorth === 9000);
  check("cash reaches the cash field ($9,000)", f.cash === 9000);
  check("depository-only space is a positive asset point (validation #2)", f.totalAssets > 0);

  // Validation #3 — adding an investment position must not remove the cash.
  const c2 = classifyAccounts([
    { id: "chk", type: "checking", balance: 9000 },
    { id: "inv", type: "investment", balance: 4000 },
  ]);
  const f2 = computeSnapshotFields(c2);
  check("adding investments keeps cash in totalAssets (13,000)", f2.totalAssets === 13000);
  check("adding investments leaves cash unchanged (9,000)", f2.cash === 9000);
}

console.log("BTC double-count fix — digital-asset account boundary (canonical authority)");
{
  check("crypto is a digital-asset account type", isDigitalAssetAccountType("crypto") === true);
  check("investment is NOT a digital-asset type", isDigitalAssetAccountType("investment") === false);
  check("checking/savings/debt/other are NOT digital-asset types",
    !isDigitalAssetAccountType("checking") && !isDigitalAssetAccountType("savings") &&
    !isDigitalAssetAccountType("debt") && !isDigitalAssetAccountType("other"));
  check("DIGITAL_ASSET_ACCOUNT_TYPES contains crypto", (DIGITAL_ASSET_ACCOUNT_TYPES as readonly string[]).includes("crypto"));
}

console.log("BTC counted EXACTLY ONCE in the snapshot (totalInvestments ≠ totalDigitalAssets bucket)");
{
  // A Space with a brokerage account + a BTC wallet + cash + debt.
  const c = classifyAccounts([
    { id: "brk", type: "investment", balance: 5000 },  // brokerage → totalInvestments
    { id: "btc", type: "crypto",     balance: 15000 }, // BTC wallet → totalDigitalAssets
    { id: "chk", type: "checking",   balance: 6000 },
    { id: "card", type: "debt",      balance: 8000 },
  ]);
  // Invariant: totalInvestments = brokerage only; totalDigitalAssets = crypto only.
  check("totalInvestments = brokerage only (5,000)", c.totalInvestments === 5000);
  check("totalDigitalAssets = BTC only (15,000)", c.totalDigitalAssets === 15000);
  check("BTC is NOT in totalInvestments", c.totalInvestments === 5000);

  const f = computeSnapshotFields(c);
  // Invariant #5 — totalAssets includes BTC exactly once (= inv + BTC + cash).
  check("totalAssets = investments + digital + cash (26,000) — BTC once", f.totalAssets === 26000);
  check("stocks (totalInvestments) excludes BTC (5,000)", f.stocks === 5000);
  check("crypto (totalDigitalAssets) is BTC (15,000)", f.crypto === 15000);
  // Invariant #6 — netWorth reconciles: totalAssets − debt.
  check("netWorth = totalAssets − debt (18,000)", f.netWorth === f.totalAssets - f.debt && f.netWorth === 18000);
}

console.log("Invariant #7 — a crypto balance cannot inflate BOTH investments and digital assets");
{
  const base = classifyAccounts([{ id: "brk", type: "investment", balance: 5000 }, { id: "btc", type: "crypto", balance: 10000 }]);
  const more = classifyAccounts([{ id: "brk", type: "investment", balance: 5000 }, { id: "btc", type: "crypto", balance: 25000 }]);
  check("raising crypto raises totalDigitalAssets", more.totalDigitalAssets > base.totalDigitalAssets);
  check("raising crypto leaves totalInvestments UNCHANGED (never both)", more.totalInvestments === base.totalInvestments);
  check("totalAssets rises by exactly the crypto delta (counted once)",
    Math.abs((more.totalAssets - base.totalAssets) - 15000) < 0.001);
}

console.log("HIST-2A — computeAccountFloors (single floor authority shared by M2 + M3)");
{
  const link = fromISO("2026-06-15"); // shared-space link floor
  const entries = [
    { id: "tx",    linkCreatedAt: link }, // has an earliest tx
    { id: "notx",  linkCreatedAt: link }, // no tx, not held-flat
    { id: "flat",  linkCreatedAt: link }, // no tx, held-flat (REG-2)
  ];
  const earliestTx = new Map([["tx", fromISO("2026-06-01")]]);
  const heldFlat = new Set(["flat"]);
  const EPOCH_MS = new Date(0).getTime();

  // PERSONAL space — no link floor; tx floor wins, no-tx → today, held-flat → EPOCH.
  const personal = computeAccountFloors(entries, earliestTx, heldFlat, false, today);
  check("tx account floors to its earliest transaction", isoDate(personal.get("tx")!) === "2026-06-01");
  check("no-tx, non-held-flat account floors to today", personal.get("notx")!.getTime() === today.getTime());
  check("no-tx held-flat account floors to EPOCH (spans window, REG-2)", personal.get("flat")!.getTime() === EPOCH_MS);

  // SHARED space — the link floor (2026-06-15) is the LATER bound for the tx account.
  const shared = computeAccountFloors(entries, earliestTx, heldFlat, true, today);
  check("shared space takes max(txFloor, linkFloor) — link 06-15 beats tx 06-01", isoDate(shared.get("tx")!) === "2026-06-15");
  check("shared space: no-tx account still floors to max(today, link)=today", shared.get("notx")!.getTime() === today.getTime());
  check("shared space: held-flat floors to max(EPOCH, link)=link", isoDate(shared.get("flat")!) === "2026-06-15");

  // ignoreFloors (dev-seed) collapses every floor to EPOCH.
  const ignored = computeAccountFloors(entries, earliestTx, heldFlat, true, today, true);
  check("ignoreFloors collapses every floor to EPOCH", [...ignored.values()].every((d) => d.getTime() === EPOCH_MS));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll backfill-core checks passed");
