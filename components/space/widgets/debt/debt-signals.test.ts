/**
 * components/space/widgets/debt/debt-signals.test.ts
 *
 * S4 — pure tests for buildDebtSignals (house pattern: standalone tsx):
 *
 *   npx tsx components/space/widgets/debt/debt-signals.test.ts
 *
 * Locks: each of the four landed sources emits/withholds correctly and empty in
 * ⇒ empty out. No invented score, weight, or threshold is asserted — only the
 * landed classifications (utilization level, gap logic, lens promoEnds,
 * simulatePayoff null).
 */

import type { LensResult } from "@/lib/perspective-engine/types";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { buildDebtSignals, type DebtSignal } from "./debt-signals";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const byId = (rows: DebtSignal[], id: string) => rows.find((r) => r.id === id);

let uid = 0;
function debt(over: Partial<DebtPerspectiveAccount>): DebtPerspectiveAccount {
  return { id: `d${uid++}`, name: "Card", type: "debt", institution: "Bank", balance: 0, currency: "USD", ...over };
}

/** Minimal ok LensResult carrying a promoEnds metric. */
function lensWithPromo(date: string | null): LensResult {
  return {
    lensId: "debt",
    lensVersion: 1,
    scope: { spaceId: "s", userId: "u" },
    computedAt: "2026-07-12T00:00:00.000Z",
    status: "ok",
    metrics: date ? [{ id: "promoEnds", label: "Next promotional rate ends", value: date, format: "date" }] : [],
    assumptions: [],
    provenance: { accountIds: [], tierCounts: { full: 0, balanceOnly: 0, summaryOnly: 0 }, dataAsOf: null, redactions: [] },
  };
}

console.log("1. Empty in ⇒ empty out");
{
  check("no debt accounts ⇒ []", buildDebtSignals({ accounts: [] }).length === 0);
  check("only non-debt accounts ⇒ []", buildDebtSignals({ accounts: [{ id: "c", name: "Chk", type: "checking", institution: "B", balance: 100, currency: "USD" }] }).length === 0);
}

console.log("2. Utilization level (landed thresholds)");
{
  const high = buildDebtSignals({ accounts: [debt({ balance: 900, creditLimit: 1000, interestRate: 20, minimumPayment: 30 })] });
  check("90% ⇒ high warn", byId(high, "utilization")?.tone === "warn" && byId(high, "utilization")!.text.includes("high"), JSON.stringify(byId(high, "utilization")));
  const over = buildDebtSignals({ accounts: [debt({ balance: 1500, creditLimit: 1000, interestRate: 20, minimumPayment: 30 })] });
  check("150% ⇒ over warn", byId(over, "utilization")?.tone === "warn" && byId(over, "utilization")!.text.includes("over"));
  const low = buildDebtSignals({ accounts: [debt({ balance: 100, creditLimit: 1000, interestRate: 20, minimumPayment: 30 })] });
  check("10% ⇒ low ok", byId(low, "utilization")?.tone === "ok" && byId(low, "utilization")!.text.includes("low"));
  const noLimit = buildDebtSignals({ accounts: [debt({ balance: 900, interestRate: 20, minimumPayment: 30 })] });
  check("no limit ⇒ no utilization signal", byId(noLimit, "utilization") === undefined);
}

console.log("3. Missing APR / minimum (gap logic) vs all-set");
{
  const gaps = buildDebtSignals({ accounts: [debt({ balance: 900 })] }); // no APR, no minimum
  check("missing both ⇒ gaps warn", byId(gaps, "gaps")?.tone === "warn");
  check("gaps text names APR and minimum", byId(gaps, "gaps")!.text.includes("APR") && byId(gaps, "gaps")!.text.includes("minimum"));
  const set = buildDebtSignals({ accounts: [debt({ balance: 900, interestRate: 20, minimumPayment: 30, creditLimit: 5000 })] });
  check("all details on file ⇒ gaps ok", byId(set, "gaps")?.tone === "ok");
}

console.log("4. Promotional rate ending — from the lens metric only");
{
  const acct = [debt({ balance: 900, interestRate: 20, minimumPayment: 30 })];
  const withPromo = buildDebtSignals({ accounts: acct, lensResult: lensWithPromo("2026-09-01") });
  check("promoEnds metric ⇒ promo warn", byId(withPromo, "promo")?.tone === "warn");
  const noPromo = buildDebtSignals({ accounts: acct, lensResult: lensWithPromo(null) });
  check("no promoEnds metric ⇒ no promo signal", byId(noPromo, "promo") === undefined);
  const noLens = buildDebtSignals({ accounts: acct });
  check("no lensResult ⇒ no promo signal", byId(noLens, "promo") === undefined);
}

console.log("5. Minimums may not cover interest — simulatePayoff null over the aggregate");
{
  // 10000 @ 24% APR ⇒ 200/mo interest; a 150 minimum cannot cover it.
  const uncovered = buildDebtSignals({ accounts: [debt({ balance: 10000, interestRate: 24, minimumPayment: 150 })] });
  check("under-covering minimum ⇒ min-coverage warn", byId(uncovered, "min-coverage")?.tone === "warn");
  // A 300 minimum covers it ⇒ no signal.
  const covered = buildDebtSignals({ accounts: [debt({ balance: 10000, interestRate: 24, minimumPayment: 300 })] });
  check("covering minimum ⇒ no min-coverage signal", byId(covered, "min-coverage") === undefined);
  // No known rate ⇒ simulatePayoff is never null ⇒ no false alarm.
  const noRate = buildDebtSignals({ accounts: [debt({ balance: 10000, minimumPayment: 50 })] });
  check("no rate ⇒ no min-coverage signal", byId(noRate, "min-coverage") === undefined);
}

if (failures > 0) { console.error(`\n${failures} debt-signals check(s) failed`); process.exit(1); }
console.log("\nAll debt-signals checks passed");
