/**
 * components/space/widgets/debt/debt-kpis.test.ts
 *
 * S2 — pure tests for computeDebtKpis (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx components/space/widgets/debt/debt-kpis.test.ts
 *
 * Locks: the four KPI sums, all-unrated ⇒ null interest signal (ratedCount 0),
 * no-limit ⇒ null utilization, missing-minimum accounting, level mapping
 * (moderate / over), and mixed-currency taint ⇒ estimated (identityContext with
 * a non-target currency takes convertMoney's RateMiss → estimated branch).
 */

import { identityContext } from "@/lib/money/convert";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { computeDebtKpis } from "./debt-kpis";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

let uid = 0;
function debt(over: Partial<DebtPerspectiveAccount>): DebtPerspectiveAccount {
  return {
    id: `d${uid++}`, name: "Card", type: "debt", institution: "Bank",
    balance: 0, currency: "USD", ...over,
  };
}

console.log("1. Totals — balance / interest / utilization / minimums");
{
  const accounts: DebtPerspectiveAccount[] = [
    debt({ balance: 1000, interestRate: 20, minimumPayment: 50, creditLimit: 2000 }),
    debt({ balance: 500,  interestRate: 10, minimumPayment: 25, creditLimit: 1000 }),
    // V25-SIDE-1 — a paid-off card contributes NO debt but is still a member:
    // it keeps its row, and its credit LIMIT still counts toward utilization.
    debt({ balance: 0,    interestRate: 30, minimumPayment: 99, creditLimit: 500 }),
    { id: "chk", name: "Checking", type: "checking", institution: "Bank", balance: 9999, currency: "USD" }, // non-debt ignored
  ];
  const k = computeDebtKpis(accounts);
  check("totalDebt = 1500", k.totalDebt === 1500, `${k.totalDebt}`);
  check("estMonthlyInterest = 1000·20%/12 + 500·10%/12", approx(k.estMonthlyInterest, 1000 * 0.2 / 12 + 500 * 0.1 / 12), `${k.estMonthlyInterest}`);
  check("ratedCount = 2 (indebted rows only)", k.ratedCount === 2, `${k.ratedCount}`);
  check("unratedCount = 0", k.unratedCount === 0, `${k.unratedCount}`);
  check("accountCount = 3 — membership is structural", k.accountCount === 3, `${k.accountCount}`);
  check("owingCount = 2", k.owingCount === 2, `${k.owingCount}`);
  // V25-SIDE-1 behavioural change (a CORRECTION, not a regression): the paid-off
  // card's $500 limit now sits in the denominator — 1500/3500, not 1500/3000.
  // Available credit on a settled card is real available credit, which is also
  // how credit bureaus compute utilization. Previously the card was dropped
  // entirely, overstating utilization.
  check("utilizationPct = 1500/3500 (paid-off card's limit counts)",
    approx(k.utilizationPct ?? -1, (1500 / 3500) * 100), `${k.utilizationPct}`);
  check("utilizationLevel = moderate", k.utilizationLevel === "moderate", `${k.utilizationLevel}`);
  check("minPayments = 75", k.minPayments === 75, `${k.minPayments}`);
  check("missingMinCount = 0", k.missingMinCount === 0, `${k.missingMinCount}`);
  check("not estimated (all USD)", k.estimated === false);
}

console.log("2. All-unrated ⇒ zero interest, ratedCount 0 (strip shows the dash)");
{
  const k = computeDebtKpis([debt({ balance: 800, minimumPayment: 20 })]);
  check("estMonthlyInterest = 0", k.estMonthlyInterest === 0, `${k.estMonthlyInterest}`);
  check("ratedCount = 0", k.ratedCount === 0);
  check("unratedCount = 1", k.unratedCount === 1);
  // APR of exactly 0 is treated as unrated (renderDebtCost uses > 0).
  const z = computeDebtKpis([debt({ balance: 800, interestRate: 0 })]);
  check("APR 0 counts as unrated", z.ratedCount === 0 && z.unratedCount === 1, `${z.ratedCount}/${z.unratedCount}`);
}

console.log("3. No credit limits ⇒ utilization is null (never a fake 0%)");
{
  const k = computeDebtKpis([debt({ balance: 800, interestRate: 15 })]);
  check("utilizationPct = null", k.utilizationPct === null);
  check("utilizationLevel = null", k.utilizationLevel === null);
}

console.log("4. Missing minimums — excluded from sum, counted");
{
  const k = computeDebtKpis([
    debt({ balance: 500, minimumPayment: 30 }),
    debt({ balance: 700 }), // no minimum
  ]);
  check("minPayments = 30", k.minPayments === 30, `${k.minPayments}`);
  check("missingMinCount = 1", k.missingMinCount === 1, `${k.missingMinCount}`);
}

console.log("5. Utilization level mapping — over 100%");
{
  const k = computeDebtKpis([debt({ balance: 1500, creditLimit: 1000 })]);
  check("utilizationPct = 150", approx(k.utilizationPct ?? -1, 150), `${k.utilizationPct}`);
  check("utilizationLevel = over", k.utilizationLevel === "over", `${k.utilizationLevel}`);
}

console.log("6. Mixed-currency ⇒ estimated taint (identityContext USD + EUR row)");
{
  const ctx = identityContext("USD");
  const k = computeDebtKpis([
    debt({ balance: 1000, currency: "USD", interestRate: 20, minimumPayment: 40, creditLimit: 2000 }),
    debt({ balance: 500,  currency: "EUR", interestRate: 10, minimumPayment: 20, creditLimit: 1000 }),
  ], ctx);
  check("estimated = true (EUR row missed the rate)", k.estimated === true);
  // V25-FINAL-1 — an unavailable EUR balance is EXCLUDED (never blended in as
  // native-labelled-USD), so the total is the honest USD-only figure.
  check("totalDebt = 1000 (EUR excluded, not relabeled to USD)", k.totalDebt === 1000, `${k.totalDebt}`);
  const pure = computeDebtKpis([debt({ balance: 1000, currency: "USD", interestRate: 20 })]);
  check("no-ctx result is never estimated", pure.estimated === false);
}

if (failures > 0) { console.error(`\n${failures} debt-kpis check(s) failed`); process.exit(1); }
console.log("\nAll debt-kpis checks passed");
