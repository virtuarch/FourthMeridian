"use client";

/**
 * components/space/widgets/CashFlowFilterControls.tsx
 *
 * CF-3 — the heatmap's measure vocabulary + its one small control. It selects,
 * from the two honest axes, WHICH canonical measures the calendar shows — it
 * never classifies anything. Each filter maps to a
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

export const DEFAULT_FILTER_ID = "liq-net";

export function filterById(id: string): CalendarFilter {
  return CALENDAR_FILTERS.find((f) => f.id === id) ?? CALENDAR_FILTERS[0];
}

/** The default measure for a page: Cash Flow opens on "Cash in & out"; Spending on
 *  "Spending" (all purchases, any payment method). */
export function defaultFilterFor(perspective: CashFlowPerspective): CalendarFilter {
  return perspective === "economic" ? filterById("eco-spend") : filterById("liq-net");
}

/**
 * v2.7 (owner) — the measures each PAGE offers in its heatmap. Cash Flow offers
 * every liquidity measure; Spending's heatmap shows SPENDING by day, so it offers
 * only the spending measures (all · on credit cards · direct) — never income or a
 * cash measure. Pure selection over the fixed, non-overlapping table above.
 */
export function filtersForPage(page: "cashFlow" | "spending"): CalendarFilter[] {
  return page === "spending"
    ? (["eco-spend", "eco-card", "eco-direct"] as const).map(filterById)
    : CALENDAR_FILTERS.filter((f) => f.perspective === "liquidity");
}

// ─── Control ──────────────────────────────────────────────────────────────────

/**
 * The measure picker — ONE compact native select. v2.7 (owner): the Cash Flow ⇄
 * Spending perspective toggle that used to sit beside it is GONE — Cash Flow and
 * Spending are separate perspectives with their own page, so a page never offers
 * the other page's axis here.
 */
export function CashFlowMeasureSelect({ options, filterId, onChange }: {
  options:  CalendarFilter[];
  filterId: string;
  onChange: (filterId: string) => void;
}) {
  if (options.length < 2) return null;
  return (
    <select
      aria-label="Heatmap measure"
      value={filterId}
      onChange={(e) => onChange(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      className={[
        "appearance-none cursor-pointer rounded-[var(--radius-full)] px-3 py-1 text-[11px] font-semibold max-lg:min-h-10 max-w-full",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] transition-colors",
        "text-[var(--meridian-400)]",
      ].join(" ")}
      style={{ background: "var(--glass-ultrathin)", border: "1px solid rgba(125,168,255,.32)" }}
    >
      {options.map((f) => (
        <option key={f.id} value={f.id}>{f.label}</option>
      ))}
    </select>
  );
}
