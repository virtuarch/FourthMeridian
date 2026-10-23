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
    provenance: { accountIds: [], tierCounts: { full: 0, balanceOnly: 0, summaryOnly: 0 }, dataAsOf: null, dataAsOfBasis: "INGESTION", redactions: [] },
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

console.log("3. APR on file (unknown stays unknown) — minimum payments are NOT a signal");
{
  const gaps = buildDebtSignals({ accounts: [debt({ balance: 900 })] }); // no APR
  check("owing debt with no APR ⇒ gaps warn", byId(gaps, "gaps")?.tone === "warn");
  check("gaps text names the APR and says the cost is unknown",
    byId(gaps, "gaps")!.text.includes("APR") && byId(gaps, "gaps")!.text.includes("unknown"), byId(gaps, "gaps")?.text);
  check("gaps text never mentions a minimum payment", !/minimum/i.test(byId(gaps, "gaps")!.text));
  // APR on file, NO minimum payment on file ⇒ still fully "ok": a minimum is not required.
  const set = buildDebtSignals({ accounts: [debt({ balance: 900, interestRate: 20, creditLimit: 5000 })] });
  check("APR on file + no minimum ⇒ gaps ok (a minimum is not required)", byId(set, "gaps")?.tone === "ok");
  // An explicit 0% is a rate ON FILE, not a gap.
  const zero = buildDebtSignals({ accounts: [debt({ balance: 900, interestRate: 0 })] });
  check("explicit 0% APR ⇒ gaps ok (0 is a rate, not missing)", byId(zero, "gaps")?.tone === "ok");
  // A paid-off card with no APR accrues nothing — not a gap.
  const settled = buildDebtSignals({ accounts: [debt({ balance: 0 })] });
  check("settled card with no APR ⇒ no gaps warn", byId(settled, "gaps")?.tone !== "warn");
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

console.log("5. No minimum-payment signal exists in this experience");
{
  // 10000 @ 24% with a 150 minimum used to raise "min-coverage". Whether a payment
  // covers interest is now answered where the payment is CHOSEN (the planner,
  // via planPayoff's non_amortizing status) — never from a stored minimum.
  const s5 = buildDebtSignals({ accounts: [debt({ balance: 10000, interestRate: 24, minimumPayment: 150 })] });
  check("no min-coverage signal", byId(s5, "min-coverage") === undefined);
  check("no signal text mentions a minimum", s5.every((x) => !/minimum/i.test(x.text)), s5.map((x) => x.text).join(" | "));
}

if (failures > 0) { console.error(`\n${failures} debt-signals check(s) failed`); process.exit(1); }
console.log("\nAll debt-signals checks passed");
