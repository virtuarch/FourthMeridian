/**
 * lib/investments/brokerage-cash.test.ts
 *
 * Pure tests for the derived brokerage-cash reconciliation core. Standalone tsx,
 * no DB. The DB write (idempotency, later-day append, no-derived-when-observed)
 * is covered by the real-data validation; here we pin the DECISION doctrine.
 *
 *     npx tsx lib/investments/brokerage-cash.test.ts
 */

import { reconcileBrokerageCash, type ReconHolding, type ReconInput } from "./brokerage-cash";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const CAPTURE = new Date("2026-07-11T00:00:00Z");
function h(p: Partial<ReconHolding>): ReconHolding {
  return {
    isCash: p.isCash ?? false, institutionValue: p.institutionValue ?? null,
    quantity: p.quantity ?? null, institutionPrice: p.institutionPrice ?? null,
    currency: p.currency ?? "USD", priceAsOf: p.priceAsOf ?? new Date("2026-07-10T00:00:00Z"),
  };
}
function input(p: Partial<ReconInput>): ReconInput {
  return {
    accountBalance: p.accountBalance ?? null, accountCurrency: p.accountCurrency ?? "USD",
    balanceAsOf: p.balanceAsOf ?? null, holdings: p.holdings ?? [],
    payloadComplete: p.payloadComplete ?? true, captureDate: p.captureDate ?? CAPTURE,
    tolerance: p.tolerance, staleDays: p.staleDays,
  };
}

console.log("1. explicit observed cash present → OBSERVED_CASH_PRESENT, no derive");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 4005.08, holdings: [
    h({ institutionValue: 3993.43 }), h({ isCash: true, institutionValue: 11.65 }),
  ]}));
  check("status OBSERVED_CASH_PRESENT", r.status === "OBSERVED_CASH_PRESENT");
  check("no derived cash", r.derivedCash === 0);
}

console.log("2. clean positive residual → DERIVED");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 1000, holdings: [ h({ institutionValue: 600 }), h({ institutionValue: 100 }) ]}));
  check("status DERIVED", r.status === "DERIVED");
  check("derivedCash = 300", Math.abs(r.derivedCash - 300) < 1e-6);
  check("completeness COMPLETE", r.completeness === "COMPLETE");
}

console.log("3. residual via quantity × price fallback → ESTIMATED");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 1000, holdings: [ h({ institutionValue: null, quantity: 10, institutionPrice: 60 }) ]}));
  check("status ESTIMATED", r.status === "ESTIMATED");
  check("derivedCash = 400", Math.abs(r.derivedCash - 400) < 1e-6);
  check("completeness PARTIAL", r.completeness === "PARTIAL");
}

console.log("4. zero residual → ZERO, no synthetic cash");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 700, holdings: [ h({ institutionValue: 600 }), h({ institutionValue: 100 }) ]}));
  check("status ZERO", r.status === "ZERO");
  check("no derived cash", r.derivedCash === 0);
}

console.log("5. small rounding difference → ZERO within tolerance");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 700.4, holdings: [ h({ institutionValue: 700 }) ]}));
  check("within tolerance → ZERO", r.status === "ZERO");
}

console.log("6. negative residual → NEGATIVE_RESIDUAL, no positive cash");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 500, holdings: [ h({ institutionValue: 600 }) ]}));
  check("status NEGATIVE_RESIDUAL", r.status === "NEGATIVE_RESIDUAL");
  check("derivedCash 0", r.derivedCash === 0);
  check("residual preserved", Math.abs((r.residual ?? 0) - (-100)) < 1e-6);
}

console.log("7. missing holding values → INCOMPLETE");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 1000, holdings: [ h({ institutionValue: null, quantity: null, institutionPrice: null }) ]}));
  check("status INCOMPLETE", r.status === "INCOMPLETE");
  check("no derived cash", r.derivedCash === 0);
}

console.log("8. mixed currencies without FX → CURRENCY_MISMATCH (refused)");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 1000, accountCurrency: "USD", holdings: [ h({ institutionValue: 600, currency: "USD" }), h({ institutionValue: 100, currency: "EUR" }) ]}));
  check("status CURRENCY_MISMATCH", r.status === "CURRENCY_MISMATCH");
  check("no derived cash", r.derivedCash === 0);
}

console.log("9. partial/incomplete payload → INCOMPLETE (no derived cash)");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 1000, payloadComplete: false, holdings: [ h({ institutionValue: 600 }) ]}));
  check("status INCOMPLETE", r.status === "INCOMPLETE");
  check("no derived cash despite positive residual", r.derivedCash === 0);
}

console.log("10. stale prices downgrade DERIVED → ESTIMATED");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 1000, staleDays: 4,
    holdings: [ h({ institutionValue: 600, priceAsOf: new Date("2026-06-01T00:00:00Z") }) ]}));
  check("stale price → ESTIMATED", r.status === "ESTIMATED");
}

console.log("11. no balance available → INCOMPLETE");
{
  const r = reconcileBrokerageCash(input({ accountBalance: null, holdings: [ h({ institutionValue: 600 }) ]}));
  check("status INCOMPLETE", r.status === "INCOMPLETE");
}

console.log("12. cash holding not counted in non-cash total (no double count)");
{
  // balance = nonCash(600) + observedCash(400); residual after both = 0.
  const r = reconcileBrokerageCash(input({ accountBalance: 1000, holdings: [ h({ institutionValue: 600 }), h({ isCash: true, institutionValue: 400 }) ]}));
  check("observed cash short-circuits (not added to nonCash)", r.status === "OBSERVED_CASH_PRESENT" && r.inputTotals.nonCash === 600 && r.inputTotals.observedCash === 400);
}

console.log("13. inputTotals reported for diagnostics");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 1000, holdings: [ h({ institutionValue: 600 }), h({ institutionValue: null, quantity: 2, institutionPrice: 50 }) ]}));
  check("computedValues counted", r.inputTotals.computedValues === 1);
  check("nonCash total = 700", Math.abs(r.inputTotals.nonCash - 700) < 1e-6);
}

console.log("14. real Schwab LLC shape reconciles to OBSERVED (validation only)");
{
  const r = reconcileBrokerageCash(input({ accountBalance: 4005.08, holdings: [
    h({ institutionValue: 3993.43 }), h({ isCash: true, institutionValue: 11.65 }),
  ]}));
  check("OBSERVED_CASH_PRESENT, residual ~0, no write", r.status === "OBSERVED_CASH_PRESENT" && Math.abs(r.residual ?? 1) < 0.01 && r.derivedCash === 0);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll brokerage-cash checks passed");
