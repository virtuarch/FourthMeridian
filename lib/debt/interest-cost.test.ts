/**
 * lib/debt/interest-cost.test.ts  (CQ-008)
 *
 * ONE monthly-interest formula. `estimatedMonthlyInterest` (owed × APR/100/12)
 * is the authority; `estimateMinimumPayment` in lib/debt.ts folds onto it
 * instead of carrying its own copy. Pure, DB-free.
 *
 *   npx tsx lib/debt/interest-cost.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeInterestCost, estimatedMonthlyInterest } from "./interest-cost";
import { estimateMinimumPayment } from "@/lib/debt";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

console.log("1. estimatedMonthlyInterest — the authority");
{
  check("1,000 owed at 12% APR costs 10.00 a month", close(estimatedMonthlyInterest(1000, 12) ?? NaN, 10));
  check("a rate of exactly 0 is KNOWN and costs 0.00", estimatedMonthlyInterest(1000, 0) === 0);
  check("an unknown rate (null / undefined) is null, never 0",
    estimatedMonthlyInterest(1000, null) === null && estimatedMonthlyInterest(1000, undefined) === null);
  check("a credit balance (negative) owes nothing and accrues nothing", estimatedMonthlyInterest(-250, 24) === 0);
  check("a settled balance accrues nothing", estimatedMonthlyInterest(0, 24) === 0);
}

console.log("2. estimateMinimumPayment folds onto it (CQ-008)");
{
  check("1,000 at 12%: 1% + interest = 20 < floor ⇒ 35", estimateMinimumPayment(1000, 12) === 35);
  check("10,000 at 24%: 100 + 200 = 300", close(estimateMinimumPayment(10000, 24), 300));
  check("negative inputs clamp to 0 ⇒ the floor", estimateMinimumPayment(-500, -5) === 35);
  const cases: Array<[number, number]> = [[0, 0], [1, 1], [999.99, 0], [5000, 19.99], [123456.78, 29.99], [50000, 0.5]];
  check("parity: max(35, 1% × owed + estimatedMonthlyInterest(owed, apr)) for every case",
    cases.every(([b, apr]) => close(estimateMinimumPayment(b, apr), Math.max(35, b * 0.01 + (estimatedMonthlyInterest(Math.max(0, b), Math.max(0, apr)) ?? 0)))));
  const src = readFileSync(join(process.cwd(), "lib/debt.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  check("lib/debt.ts imports the authority and carries NO inline APR/12 formula",
    /from "@\/lib\/debt\/interest-cost"/.test(src) && !/\/\s*100\s*\/\s*12/.test(src) && !/\/\s*12\b/.test(src));
}

console.log("3. computeInterestCost — unknown rates are excluded and counted");
{
  const r = computeInterestCost([
    { id: "a", balance: 1200, aprPct: 10 },
    { id: "b", balance: 600,  aprPct: null },
    { id: "c", balance: -40,  aprPct: 22 },   // issuer credit — owes nothing
    { id: "d", balance: 300,  aprPct: 0 },
  ]);
  check("rows = the owing ones only (credit excluded), costliest first, unknown last",
    r.rows.map((x) => x.id).join() === "a,d,b");
  check("totalMonthly sums KNOWN rates only (10.00)", close(r.totalMonthly, 10));
  check("unknownCount = 1", r.unknownCount === 1);
  check("the 0% row is reported as known 0, not unknown", r.rows.find((x) => x.id === "d")?.monthly === 0);
}

if (failures > 0) { console.error(`\n${failures} interest-cost check(s) failed`); process.exit(1); }
console.log("\nAll interest-cost checks passed");
