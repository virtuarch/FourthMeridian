/**
 * components/space/widgets/debt/debt-signals.ts
 *
 * S4 — the honest "Debt Signals" rows (plan §2 "Debt Health Score" row). The
 * mockup's composite 300–850 gauge stays the REAL manual FICO (FicoCard); a
 * *computed* debt-health score is not honestly buildable (no scoring model
 * exists anywhere — plan §1.10, stop condition 4). What survives is the
 * checkmark REASONS: deterministic rows from FOUR landed sources ONLY, each
 * citing landed math, no invented thresholds or weights:
 *
 *   1. Utilization level        — utilizationLevel() thresholds (via computeDebtKpis)
 *   2. Missing APR / minimum    — the debt_complete_info gap logic
 *   3. Promotional rate ending  — lensResult.metrics "promoEnds" (debt.core.ts:275)
 *   4. Minimums cover interest? — simulatePayoff() returning null over the aggregate
 *
 * Pure and DB-free. Nothing derivable (no debt accounts) ⇒ empty list, no filler.
 */

import { simulatePayoff } from "@/components/space/sections/DebtPayoffSection";
import { formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { computeDebtKpis, computePayoffAggregate } from "./debt-kpis";

export type DebtSignalTone = "ok" | "warn";

export interface DebtSignal {
  id: string;
  tone: DebtSignalTone;
  text: string;
}

export function buildDebtSignals({
  accounts,
  ctx,
  lensResult,
}: {
  accounts: DebtPerspectiveAccount[];
  ctx?: ConversionContext;
  lensResult?: LensResult | null;
}): DebtSignal[] {
  const debts = accounts.filter((a) => a.type === "debt");
  if (debts.length === 0) return []; // nothing derivable → empty, no filler

  const signals: DebtSignal[] = [];
  const kpis = computeDebtKpis(accounts, ctx);

  // 1. Utilization level (landed thresholds) — only when a revolving limit exists.
  if (kpis.utilizationPct != null && kpis.utilizationLevel != null) {
    const pct = Math.round(kpis.utilizationPct);
    switch (kpis.utilizationLevel) {
      case "over":
        signals.push({ id: "utilization", tone: "warn", text: `Credit utilization is over the limit (${pct}%)` });
        break;
      case "high":
        signals.push({ id: "utilization", tone: "warn", text: `Credit utilization is high at ${pct}%` });
        break;
      case "moderate":
        signals.push({ id: "utilization", tone: "ok", text: `Credit utilization is moderate at ${pct}%` });
        break;
      default:
        signals.push({ id: "utilization", tone: "ok", text: `Credit utilization is low at ${pct}%` });
    }
  }

  // 2. Minimums may not cover interest — simulatePayoff over the planner's SAME
  //    aggregate returns null. No known rate ⇒ simulatePayoff is never null, so
  //    no false alarm.
  const agg = computePayoffAggregate(accounts, ctx);
  if (agg.total > 0 && agg.minPayment > 0 && simulatePayoff(agg.total, agg.monthlyRate, agg.minPayment) === null) {
    signals.push({ id: "min-coverage", tone: "warn", text: "Minimum payments may not cover interest" });
  }

  // 3. Promotional rate ending — the lens's own metric, name-free and landed.
  if (lensResult && lensResult.status === "ok") {
    const promo = lensResult.metrics.find((m) => m.id === "promoEnds");
    if (promo && typeof promo.value === "string") {
      signals.push({ id: "promo", tone: "warn", text: `A promotional rate ends ${formatDate(promo.value)}` });
    }
  }

  // 4. Missing APR / minimum — the debt_complete_info gap logic (null-only, all rows).
  let missingApr = 0;
  let missingMin = 0;
  for (const a of debts) {
    if (a.interestRate == null) missingApr++;
    if (a.minimumPayment == null) missingMin++;
  }
  if (missingApr > 0 || missingMin > 0) {
    const parts: string[] = [];
    if (missingApr > 0) parts.push(`${missingApr} missing an APR`);
    if (missingMin > 0) parts.push(`${missingMin} missing a minimum payment`);
    signals.push({ id: "gaps", tone: "warn", text: `Debt details incomplete — ${parts.join(", ")}` });
  } else {
    signals.push({ id: "gaps", tone: "ok", text: "APR and minimum payment on file for every debt" });
  }

  return signals;
}
