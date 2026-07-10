"use client";

/**
 * components/space/widgets/CashFlowFilterControls.tsx
 *
 * CF-3 — the ONE small perspective/measure control shared by the Cash Flow
 * Summary and History/Calendar (the prompt's "reuse a small perspective/filter
 * control"). It selects, from the two honest perspectives, WHICH canonical
 * measures a widget shows — it never classifies anything. Each filter maps to a
 * fixed, NON-OVERLAPPING measure set from CALENDAR_MEASURES, so no selection can
 * double-count (a measure is never combined with a measure it is a subset of).
 *
 *   LIQUIDITY  — spendable-cash movement. "Cash in & out" is the honest default;
 *                the rest narrow to a single reason group (Debt payments, Money
 *                invested, From investments, Payment apps) or to Cash withdrawals
 *                (a physical-cash form change, owned money — its own line).
 *   ECONOMIC   — real value, INCLUDING credit-card purchases. "Income & spending"
 *                is the default; "All spending" / "Credit-card spending" isolate
 *                what a credit-card-heavy user actually spent.
 */

import type { CalendarMeasureId, CashFlowPerspective } from "@/lib/transactions/cash-flow-projection";

export interface CalendarFilter {
  id:          string;
  label:       string;
  perspective: CashFlowPerspective;
  measures:    CalendarMeasureId[];
}

/** Fixed, non-overlapping filters. Order = display order within each perspective. */
export const CALENDAR_FILTERS: CalendarFilter[] = [
  // ── Cash Flow (liquidity) ──
  { id: "liq-net",        label: "Cash in & out",         perspective: "liquidity", measures: ["cashIn", "cashOut"] },
  { id: "liq-in",         label: "Cash in",               perspective: "liquidity", measures: ["cashIn"] },
  { id: "liq-out",        label: "Cash out",              perspective: "liquidity", measures: ["cashOut"] },
  { id: "liq-debt",       label: "Debt payments",         perspective: "liquidity", measures: ["debtPayments"] },
  { id: "liq-invested",   label: "Money invested",        perspective: "liquidity", measures: ["moneyInvested"] },
  { id: "liq-frominvest", label: "From investments",      perspective: "liquidity", measures: ["fromInvestments"] },
  { id: "liq-fromapps",   label: "From payment apps",     perspective: "liquidity", measures: ["fromPaymentApps"] },
  { id: "liq-toapps",     label: "Payments through apps", perspective: "liquidity", measures: ["paymentsThroughApps"] },
  { id: "liq-cash",       label: "Cash withdrawals",      perspective: "liquidity", measures: ["cashWithdrawals"] },
  // ── Spending (economic) ──
  { id: "eco-net",        label: "Income & spending",     perspective: "economic",  measures: ["income", "allSpending"] },
  { id: "eco-spend",      label: "Spending",              perspective: "economic",  measures: ["allSpending"] },
  { id: "eco-card",       label: "Credit-card spending",  perspective: "economic",  measures: ["creditCardSpending"] },
  { id: "eco-direct",     label: "Direct/debit spending", perspective: "economic",  measures: ["directDebitSpending"] },
  { id: "eco-income",     label: "Income",                perspective: "economic",  measures: ["income"] },
];

/** User-facing perspective names (NOT the internal "liquidity"/"economic"). */
export const PERSPECTIVE_LABEL: Record<CashFlowPerspective, string> = {
  liquidity: "Cash Flow",
  economic:  "Spending",
};

export const DEFAULT_FILTER_ID = "liq-net";

export function filterById(id: string): CalendarFilter {
  return CALENDAR_FILTERS.find((f) => f.id === id) ?? CALENDAR_FILTERS[0];
}

/** The default (net) filter for a perspective. */
export function defaultFilterFor(perspective: CashFlowPerspective): CalendarFilter {
  return perspective === "economic" ? filterById("eco-net") : filterById("liq-net");
}

// ─── Control ──────────────────────────────────────────────────────────────────

interface Props {
  perspective: CashFlowPerspective;
  filterId:    string;
  onChange:    (perspective: CashFlowPerspective, filterId: string) => void;
  /** Compact hides the measure dropdown (perspective toggle only) — for the Summary. */
  compact?:    boolean;
}

export function CashFlowFilterControls({ perspective, filterId, onChange, compact }: Props) {
  const options = CALENDAR_FILTERS.filter((f) => f.perspective === perspective);

  return (
    <div className="inline-flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
      {/* Perspective — the primary honest axis toggle. */}
      <div
        className="inline-flex items-center p-0.5 rounded-[var(--radius-full)] gap-0.5"
        style={{ background: "var(--glass-ultrathin)", border: "1px solid var(--border-hairline)" }}
        role="tablist"
        aria-label="Cash flow perspective"
      >
        {(["liquidity", "economic"] as const).map((p) => {
          const active = p === perspective;
          return (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={active}
              title={p === "liquidity" ? "Spendable cash movement" : "Real spending, incl. credit-card purchases"}
              onClick={() => onChange(p, defaultFilterFor(p).id)}
              className={[
                "rounded-[var(--radius-full)] px-2.5 py-1 text-[11px] font-semibold transition-colors",
                active ? "text-[var(--meridian-400)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
              ].join(" ")}
              style={active ? { background: "rgba(59,130,246,.14)", border: "1px solid rgba(125,168,255,.32)" } : { border: "1px solid transparent" }}
            >
              {PERSPECTIVE_LABEL[p]}
            </button>
          );
        })}
      </div>

      {/* Measure filter — scoped to the active perspective (non-overlapping sets). */}
      {!compact && (
        <select
          aria-label="Cash flow measure filter"
          value={filterId}
          onChange={(e) => onChange(perspective, e.target.value)}
          className={[
            "appearance-none cursor-pointer rounded-[var(--radius-full)] px-3 py-1 text-[11px] font-semibold",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] transition-colors",
            "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
          ].join(" ")}
          style={{ background: "var(--glass-ultrathin)", border: "1px solid var(--border-hairline)" }}
        >
          {options.map((f) => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
        </select>
      )}
    </div>
  );
}
