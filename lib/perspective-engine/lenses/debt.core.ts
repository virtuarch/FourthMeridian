/**
 * lib/perspective-engine/lenses/debt.core.ts
 *
 * Debt lens — pure computation core (commit 3 of the approved plan in
 * docs/investigations/PERSPECTIVE_ENGINE_FOUNDATION_INVESTIGATION.md).
 *
 * Answers: "What does my debt cost, and what does it take to service it?"
 *
 * PURE module: no data access, no clock beyond options.now, no imports
 * beyond engine types and lib/format. Data binding lives in ./debt.ts;
 * fixture tests in lib/perspective-engine/debt.test.ts.
 *
 * ── Input privacy by construction ────────────────────────────────────────────
 * DebtAccountRow has NO name/institution fields (same discipline as
 * liquidity.core.ts). Rate/payment fields are mapped by the adapter for
 * FULL rows only — and this core additionally fail-closes: rate, payment,
 * and promo fields on a non-FULL row are IGNORED even if present, so a
 * future adapter bug over-supplying fields cannot widen exposure.
 *
 * ── Tier rules (mirrors lib/ai/assemblers/accounts.ts) ───────────────────────
 *   FULL         — balance counts; APR/minimum/promo feed the cost metrics;
 *                  missing-rate "knowledge gap" statements may count it.
 *   BALANCE_ONLY — balance counts toward total debt (that is what the tier
 *                  grants); rate/payment metadata never; NEVER counted in
 *                  knowledge-gap statements (a gap line would reveal it is
 *                  a debt account with unknown terms — assemblers' rule).
 *   SUMMARY_ONLY / unknown / legacy — no numeric contribution anywhere;
 *                  counted in tierCounts + a redaction line. Fails closed.
 *
 * ── Money semantics ──────────────────────────────────────────────────────────
 *   totalDebt       = Σ |balance| over countable (FULL + BALANCE_ONLY) debt rows
 *   monthlyInterest = Σ |balance| × APR/100/12 over FULL rows with a known
 *                     APR — always flagged estimated (issuer accrual varies)
 *   blendedApr      = balance-weighted mean APR over the same rows
 *   minPayments     = Σ minimumPayment over FULL rows that have one; flagged
 *                     estimated when any contributor is an estimate
 *                     (lib/debt.ts heuristic, resolved by the data layer)
 *   promoEnds       = earliest FUTURE DebtProfile.promoAprEndDate among
 *                     FULL rows (relative to options.now) — a promo that
 *                     already lapsed is not "ending"
 */

import { formatCurrency } from "@/lib/format";
import type {
  ComputeOptions,
  LensAssumption,
  LensMetric,
  LensResult,
  PerspectiveScope,
} from "../types";

// ── Version & static copy ─────────────────────────────────────────────────────

/** Bump whenever this lens's math or verdict semantics change. */
export const DEBT_LENS_VERSION = 1;

/** Static empty copy — safe whether accounts are absent or invisible (§5.8). */
export const DEBT_EMPTY = {
  headline: "Nothing to measure yet",
  subline:  "Link accounts to see debt across this Space.",
} as const;

// ── Input ─────────────────────────────────────────────────────────────────────

/**
 * The only account fields this lens may see. The adapter passes ALL visible
 * rows (any type) — the core needs non-debt rows only to distinguish
 * "Space has accounts but no debt" (an answer) from "Space has nothing"
 * (empty state). Rate/payment/promo fields are FULL-only by adapter
 * contract and re-gated here.
 */
export interface DebtAccountRow {
  id:      string;
  /** AccountType string: checking | savings | investment | crypto | debt | other */
  type:    string;
  balance: number;
  /** ISO timestamp of last balance write. */
  lastUpdated: string;
  /** SpaceAccountLink.visibilityLevel string (existing model). */
  visibilityLevel: string;
  /** Effective APR (user-entered preferred over provider) — FULL rows only. */
  interestRate?: number;
  /** Effective minimum payment — FULL rows only. */
  minimumPayment?: number;
  /** True when minimumPayment is the lib/debt.ts heuristic, not an issuer value. */
  minimumPaymentIsEstimated?: boolean;
  /** DebtProfile.promoAprEndDate as "YYYY-MM-DD" — FULL rows only. */
  promoAprEndDate?: string;
}

// ── Core computation ──────────────────────────────────────────────────────────

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function computeDebt(
  scope:   PerspectiveScope,
  options: ComputeOptions,
  rows:    DebtAccountRow[],
): LensResult {
  const computedAt = options.now().toISOString();
  const base = {
    lensId: "debt" as const,
    lensVersion: DEBT_LENS_VERSION,
    scope,
    computedAt,
  };

  if (rows.length === 0) {
    return {
      ...base,
      status: "empty",
      metrics: [],
      assumptions: [],
      provenance: {
        accountIds: [],
        tierCounts: { full: 0, balanceOnly: 0, summaryOnly: 0 },
        dataAsOf: null,
        redactions: [],
      },
      empty: { ...DEBT_EMPTY },
    };
  }

  // ── Debt rows, partitioned by tier (fail closed on unknown levels) ────────
  const debtRows = rows.filter((r) => r.type === "debt");
  const fullRows:    DebtAccountRow[] = [];
  const balanceRows: DebtAccountRow[] = [];
  let summaryOnly = 0;
  for (const r of debtRows) {
    if (r.visibilityLevel === "FULL") fullRows.push(r);
    else if (r.visibilityLevel === "BALANCE_ONLY") balanceRows.push(r);
    else summaryOnly++;
  }
  const countable = [...fullRows, ...balanceRows];

  // ── Provenance (over the debt rows this lens considered) ──────────────────
  const accountIds = countable.map((r) => r.id).sort();
  const dataAsOf = countable.length
    ? countable.map((r) => r.lastUpdated).sort()[0]
    : null;
  const redactions: string[] = [];
  if (summaryOnly > 0) {
    redactions.push(
      `${plural(summaryOnly, "debt account")} with summary-only sharing ${summaryOnly === 1 ? "is" : "are"} excluded from all totals.`,
    );
  }
  if (balanceRows.length > 0) {
    redactions.push(
      `Rate and payment detail withheld for ${plural(balanceRows.length, "shared account")}; ${balanceRows.length === 1 ? "its balance still counts" : "their balances still count"}.`,
    );
  }
  const provenance = {
    accountIds,
    tierCounts: { full: fullRows.length, balanceOnly: balanceRows.length, summaryOnly },
    dataAsOf,
    redactions,
  };

  // ── No-debt / withheld-only branches ──────────────────────────────────────
  if (countable.length === 0) {
    if (summaryOnly > 0) {
      // Debt accounts exist but every one is summary-only: never claim a
      // total (even zero) — that would misstate what the viewer may know.
      return {
        ...base,
        status: "ok",
        verdict: `Debt totals are withheld for the ${plural(summaryOnly, "summary-only shared account")} in this Space.`,
        metrics: [],
        assumptions: [],
        provenance,
      };
    }
    // Every visible account is a non-debt type — "no debt" is a real,
    // positive answer over the viewer's visible set, not an absence of data.
    return {
      ...base,
      status: "ok",
      verdict: "No debt accounts in this Space.",
      headline: { id: "totalDebt", label: "Total debt", value: 0, format: "currency", tone: "positive" },
      metrics: [
        { id: "totalDebt", label: "Total debt", value: 0, format: "currency", tone: "positive" },
      ],
      assumptions: [],
      provenance,
    };
  }

  // ── Sums (fail closed: metadata read from FULL rows only) ─────────────────
  const totalDebt = countable.reduce((s, r) => s + Math.abs(r.balance), 0);

  let monthlyInterest = 0;
  let rateWeighted = 0;
  let rateKnownBalance = 0;
  let unknownRateFullCount = 0;
  let minPayments = 0;
  let minPaymentsKnown = false;
  let anyMinEstimated = false;
  const futurePromos: string[] = [];
  const todayIsoDate = computedAt.slice(0, 10); // YYYY-MM-DD from the injected clock

  for (const r of fullRows) {
    const bal = Math.abs(r.balance);
    if (typeof r.interestRate === "number") {
      monthlyInterest  += bal * (r.interestRate / 100 / 12);
      rateWeighted     += bal * r.interestRate;
      rateKnownBalance += bal;
    } else {
      unknownRateFullCount++;
    }
    if (typeof r.minimumPayment === "number") {
      minPayments += r.minimumPayment;
      minPaymentsKnown = true;
      if (r.minimumPaymentIsEstimated) anyMinEstimated = true;
    }
    if (r.promoAprEndDate && r.promoAprEndDate > todayIsoDate) {
      futurePromos.push(r.promoAprEndDate);
    }
  }
  const blendedApr = rateKnownBalance > 0 ? rateWeighted / rateKnownBalance : null;
  const interestKnown = rateKnownBalance > 0;

  // ── Metrics ───────────────────────────────────────────────────────────────
  const headline: LensMetric = {
    id: "totalDebt",
    label: "Total debt",
    value: totalDebt,
    format: "currency",
    tone: totalDebt > 0 ? "neutral" : "positive",
  };
  const metrics: LensMetric[] = [headline];
  if (interestKnown) {
    metrics.push(
      { id: "monthlyInterest", label: "Estimated interest per month", value: monthlyInterest, format: "currency", tone: "warning", estimated: true },
      { id: "blendedApr", label: "Blended APR (balance-weighted, known rates)", value: blendedApr as number, format: "percent" },
    );
  }
  if (minPaymentsKnown) {
    metrics.push({
      id: "minPayments",
      label: "Minimum payments per month",
      value: minPayments,
      format: "currency",
      estimated: anyMinEstimated || undefined,
    });
  }
  if (futurePromos.length > 0) {
    metrics.push({
      id: "promoEnds",
      label: "Next promotional rate ends",
      value: futurePromos.sort()[0],
      format: "date",
      tone: "warning",
    });
  }

  // ── Assumptions ───────────────────────────────────────────────────────────
  const assumptions: LensAssumption[] = [];
  if (interestKnown) {
    assumptions.push(
      {
        id: "interest-simple-monthly",
        text: "Monthly interest is estimated as balance × APR ÷ 12 for accounts with a known rate; actual accrual varies by issuer.",
        source: "estimate",
      },
      {
        id: "rate-sources",
        text: "Rates come from your entries where provided, otherwise from the account provider.",
        source: "default",
      },
    );
  }
  if (anyMinEstimated) {
    assumptions.push({
      id: "estimated-minimums",
      text: "Some minimum payments are estimated (the greater of $35 or 1% of balance plus monthly interest); actual issuer minimums may differ.",
      source: "estimate",
    });
  }
  // Knowledge gap — FULL rows only, by the assemblers' rule: naming a gap on
  // a shared account would reveal that a withheld debt has unknown terms.
  if (unknownRateFullCount > 0) {
    assumptions.push({
      id: "unknown-rates",
      text: `${plural(unknownRateFullCount, "account")} ${unknownRateFullCount === 1 ? "has" : "have"} no interest rate on file and ${unknownRateFullCount === 1 ? "is" : "are"} excluded from interest estimates.`,
      source: "default",
    });
  }

  // ── Verdict (deterministic template — amounts and counts, never names) ────
  const n = countable.length;
  let verdict: string;
  if (totalDebt === 0) {
    verdict = "No outstanding debt balances in this Space.";
  } else if (interestKnown) {
    verdict = `You carry ${formatCurrency(totalDebt)} of debt across ${plural(n, "account")}, accruing an estimated ${formatCurrency(monthlyInterest)}/month in interest at known rates.`;
  } else {
    verdict = `You carry ${formatCurrency(totalDebt)} of debt across ${plural(n, "account")}; no interest rates are on file yet.`;
  }

  return {
    ...base,
    status: "ok",
    verdict,
    headline,
    metrics,
    assumptions,
    provenance,
  };
}
