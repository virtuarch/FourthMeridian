/**
 * components/space/widgets/debt/debt-signals.ts
 *
 * S4 — the honest "Debt Signals" rows (plan §2 "Debt Health Score" row). The
 * mockup's composite 300–850 gauge stays the REAL manual FICO (FicoCard); a
 * *computed* debt-health score is not honestly buildable (no scoring model
 * exists anywhere — plan §1.10, stop condition 4). What survives is the
 * checkmark REASONS: deterministic rows from THREE landed sources ONLY, each
 * citing landed math, no invented thresholds or weights:
 *
 *   1. Utilization level        — utilizationLevel() thresholds (via computeDebtKpis)
 *   2. Promotional rate ending  — lensResult.metrics "promoEnds" (debt.core.ts:275)
 *   3. APR on file?             — an owing debt with no APR has an UNKNOWN cost
 *
 * Minimum payments are not a signal: this experience is driven by balance + APR
 * + the payment the user chooses, so neither "missing a minimum" nor "minimums
 * may not cover interest" is reported. (Whether a CHOSEN payment covers interest
 * is answered where the payment is chosen — the Payoff Strategy planner.)
 *
 * Pure and DB-free. Nothing derivable (no debt accounts) ⇒ empty list, no filler.
 */

import { formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { computeDebtKpis } from "./debt-kpis";

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

  // 2. Promotional rate ending — the lens's own metric, name-free and landed.
  if (lensResult && lensResult.status === "ok") {
    const promo = lensResult.metrics.find((m) => m.id === "promoEnds");
    if (promo && typeof promo.value === "string") {
      signals.push({ id: "promo", tone: "warn", text: `A promotional rate ends ${formatDate(promo.value)}` });
    }
  }

  // 3. APR on file — `kpis.unratedCount` is scoped to accounts that OWE (a
  //    paid-off card accrues nothing, so its missing rate is not a gap). An
  //    explicit 0% is a rate on file.
  if (kpis.unratedCount > 0) {
    signals.push({
      id: "gaps", tone: "warn",
      text: `${kpis.unratedCount} debt${kpis.unratedCount === 1 ? "" : "s"} with no APR — interest cost unknown. Add it in Interest cost.`,
    });
  } else if (kpis.owingCount > 0) {
    signals.push({ id: "gaps", tone: "ok", text: "APR on file for every debt with a balance" });
  }

  return signals;
}
