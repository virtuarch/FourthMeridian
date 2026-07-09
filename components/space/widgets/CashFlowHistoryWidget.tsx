"use client";

/**
 * components/space/widgets/CashFlowHistoryWidget.tsx
 *
 * Cash Flow History as a multi-mode time lens (UX-PER-3 refinement). Two modes:
 *
 *   • Calendar — daily net as compact month grid(s) (1 / 3 / 12 mini calendars
 *                by scale); preferred default for month/quarter/year periods.
 *   • Cards    — a dense, scannable grid of period-bucket cards (one per active
 *                day / week / month, granularity following the period), each
 *                showing net, income and spending. Only mode for week-scale.
 *
 * It computes nothing new: bucketCashFlow / dailyCashFlow (lib/transactions/
 * cash-flow) supply FlowType-aware numbers using the exact same doctrine as the
 * summary. Mode availability + default come from the pure helpers
 * getCashFlowHistoryModes / getDefaultCashFlowHistoryMode.
 *
 * The widget also hosts its own Month / Quarter / Year historical selectors —
 * populated only with periods that have data — which call `onSelectPeriod` to
 * move the WHOLE Cash Flow Perspective to that explicit period. Local state
 * (mode) is never persisted; controls stop pointerdown so they can't perturb a
 * future section drag source.
 */

import { useState } from "react";
import { CalendarDays, LayoutGrid } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { CashFlowCalendar } from "@/components/space/widgets/CashFlowCalendar";
import { TransactionSliceDrawer, type TransactionSlice } from "@/components/space/widgets/TransactionSliceDrawer";
import {
  filterByPeriod,
  bucketCashFlow,
  transactionsInBucket,
  availableHistoricalPeriods,
  periodKey,
  isExplicitPeriod,
  getCashFlowHistoryModes,
  getDefaultCashFlowHistoryMode,
  type CashFlowPeriod,
  type ExplicitCashFlowPeriod,
  type CashFlowHistoryMode,
} from "@/lib/transactions/cash-flow";

function fmtMoney(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}

function EmptyCard({ sub }: { sub: string }) {
  return (
    <div className="text-center py-8">
      <p className="text-sm text-[var(--text-muted)]">No money moved in this period</p>
      <p className="text-xs text-[var(--text-faint)] mt-1">{sub}</p>
    </div>
  );
}

// ─── Mode toggle ──────────────────────────────────────────────────────────────

const MODE_META: Record<CashFlowHistoryMode, { label: string; Icon: typeof CalendarDays }> = {
  calendar: { label: "Calendar", Icon: CalendarDays },
  cards:    { label: "Cards",    Icon: LayoutGrid },
};

function ModeToggle({
  modes, value, onChange,
}: { modes: CashFlowHistoryMode[]; value: CashFlowHistoryMode; onChange: (m: CashFlowHistoryMode) => void }) {
  return (
    <div
      className="inline-flex items-center p-0.5 rounded-[var(--radius-full)] gap-0.5"
      style={{ background: "var(--glass-ultrathin)", border: "1px solid var(--border-hairline)" }}
      role="tablist"
      aria-label="Cash flow history view"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {modes.map((m) => {
        const { label, Icon } = MODE_META[m];
        const active = m === value;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={active}
            title={label}
            onClick={() => onChange(m)}
            className={[
              "flex items-center gap-1 rounded-[var(--radius-full)] px-2.5 py-1 text-[11px] font-semibold transition-colors",
              active ? "text-[var(--meridian-400)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
            ].join(" ")}
            style={active ? { background: "rgba(59,130,246,.14)", border: "1px solid rgba(125,168,255,.32)" } : { border: "1px solid transparent" }}
          >
            <Icon size={12} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Historical selectors (Month · Quarter · Year) ────────────────────────────

function HistorySelect({
  label, options, value, onPick,
}: {
  label:   string;
  options: ExplicitCashFlowPeriod[];
  value:   string;                                   // periodKey of active, or ""
  onPick:  (p: ExplicitCashFlowPeriod) => void;
}) {
  if (options.length === 0) return null;
  const active = value !== "";
  return (
    <select
      aria-label={`Cash flow — ${label.toLowerCase()}`}
      value={value}
      onChange={(e) => {
        const picked = options.find((o) => periodKey(o) === e.target.value);
        if (picked) onPick(picked);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={[
        "appearance-none cursor-pointer rounded-[var(--radius-full)] px-3 py-1 text-[11px] font-semibold",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] transition-colors",
        active ? "text-[var(--meridian-400)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
      ].join(" ")}
      style={{
        background: "var(--glass-ultrathin)",
        border: active ? "1px solid rgba(125,168,255,.32)" : "1px solid var(--border-hairline)",
      }}
    >
      <option value="">{label}</option>
      {options.map((p) => (
        <option key={periodKey(p)} value={periodKey(p)}>{labelFor(p)}</option>
      ))}
    </select>
  );
}

function labelFor(p: ExplicitCashFlowPeriod): string {
  switch (p.kind) {
    case "month":   return new Date(p.year, p.month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    case "quarter": return `Q${p.quarter} ${p.year}`;
    case "year":    return `${p.year}`;
  }
}

// ─── Cards mode ───────────────────────────────────────────────────────────────

/** Dense, object-like grid replacing the old bars. One card per active period
 *  bucket (day for month/week, week for quarter, month for year — granularity
 *  from bucketCashFlow), showing net + income + spending. */
function CardsView({
  rows, period, ctx, onOpenBucket,
}: {
  rows: Transaction[]; period: CashFlowPeriod; ctx?: ConversionContext;
  onOpenBucket: (label: string, key: string) => void;
}) {
  const buckets = bucketCashFlow(rows, period, ctx);
  if (buckets.length === 0) return <EmptyCard sub="Cash-flow history appears as transactions accumulate." />;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
      {buckets.map((b) => {
        const positive = b.net >= 0;
        const rgb = positive ? "34,197,94" : "239,68,68";
        return (
          <button
            key={b.key}
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onOpenBucket(b.label, b.key)}
            className="text-left rounded-xl p-2.5 flex flex-col gap-1.5 border transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)]"
            style={{ background: "var(--surface-inset)", borderColor: `rgba(${rgb},.22)` }}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] font-medium text-[var(--text-secondary)] truncate">{b.label}</span>
              <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: `rgb(${rgb})` }} />
            </div>
            <span
              className="text-sm font-semibold tabular-nums leading-none"
              style={{ color: positive ? "var(--accent-positive)" : "var(--accent-negative)" }}
            >
              {positive ? "+" : "−"}{fmtMoney(Math.abs(b.net), ctx)}
            </span>
            <div className="flex items-center justify-between text-[10px] tabular-nums text-[var(--text-faint)]">
              <span className="text-[var(--accent-positive)]">+{fmtMoney(b.income, ctx)}</span>
              <span className="text-[var(--accent-negative)]">−{fmtMoney(b.spend, ctx)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Widget ───────────────────────────────────────────────────────────────────

interface Props {
  transactions:   Transaction[] | null | undefined;
  period:         CashFlowPeriod;
  ctx?:           ConversionContext;
  /** Move the whole Cash Flow Perspective to an explicit historical period. */
  onSelectPeriod?: (period: CashFlowPeriod) => void;
}

/** Multi-mode Cash Flow History (Calendar · Cards) with in-widget history. */
export function CashFlowHistoryWidget({ transactions, period, ctx, onSelectPeriod }: Props) {
  const modes       = getCashFlowHistoryModes(period);
  const defaultMode = getDefaultCashFlowHistoryMode(period);

  // Reset the mode to the period's default when the period changes — React's
  // "adjust state during render when a prop changes" pattern (no effect, no flash).
  const key = periodKey(period);
  const [prevKey, setPrevKey] = useState(key);
  const [mode, setMode] = useState<CashFlowHistoryMode>(defaultMode);
  if (key !== prevKey) {
    setPrevKey(key);
    setMode(defaultMode);
  }
  const effectiveMode = modes.includes(mode) ? mode : defaultMode;

  // Drill-down slice drawer (local, in-place — never navigates away).
  const [slice, setSlice] = useState<TransactionSlice | null>(null);

  const historical = availableHistoricalPeriods(transactions ?? []);
  const activeKey  = isExplicitPeriod(period) ? key : "";
  const valFor = (group: ExplicitCashFlowPeriod[]) =>
    group.some((o) => periodKey(o) === activeKey) ? activeKey : "";

  const controls = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {onSelectPeriod ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <HistorySelect label="Month"   options={historical.months}   value={valFor(historical.months)}   onPick={onSelectPeriod} />
          <HistorySelect label="Quarter" options={historical.quarters} value={valFor(historical.quarters)} onPick={onSelectPeriod} />
          <HistorySelect label="Year"    options={historical.years}    value={valFor(historical.years)}    onPick={onSelectPeriod} />
        </div>
      ) : <span />}
      {modes.length > 1 && <ModeToggle modes={modes} value={effectiveMode} onChange={setMode} />}
    </div>
  );

  if (transactions == null) {
    return (
      <div className="space-y-3">
        {controls}
        <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>
      </div>
    );
  }
  const rows = filterByPeriod(transactions, period);

  const openDay = (iso: string, label: string) =>
    setSlice({ title: label, subtitle: "Cash flow for this day", rows: rows.filter((t) => t.date === iso) });
  const openBucket = (label: string, bucketKeyValue: string) =>
    setSlice({ title: label, subtitle: "Cash flow for this period", rows: transactionsInBucket(rows, period, bucketKeyValue) });

  return (
    <div className="space-y-3">
      {controls}
      {rows.length === 0
        ? <EmptyCard sub="Cash-flow history appears as transactions accumulate." />
        : effectiveMode === "calendar"
          ? <CashFlowCalendar transactions={rows} period={period} ctx={ctx} onSelectDay={openDay} />
          : <CardsView rows={rows} period={period} ctx={ctx} onOpenBucket={openBucket} />}

      {slice && <TransactionSliceDrawer slice={slice} ctx={ctx} onClose={() => setSlice(null)} />}
    </div>
  );
}
