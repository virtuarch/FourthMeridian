"use client";

/**
 * components/space/widgets/liquidity/LiquidityPerspective.tsx
 *
 * The Liquidity Perspective workspace — a multi-panel composition of the SAME
 * four mounted Liquidity widgets, relocated from the generic single-column
 * SectionCard stack into a 2D grid. Mirrors the landed CashFlowPerspective
 * mechanics (grid-cols-1 lg:grid-cols-12, local non-exported Panel helper
 * reproducing the SectionCard solid-lede treatment, adapter renderers reused,
 * items-stretch). NOT a new layout abstraction — no registry, no schema, no grid
 * engine, no new card primitive.
 *
 * CURRENT-STATE ONLY (decided, not open for reinterpretation): this workspace
 * consumes NO as-of / compare-to / historical balance read. The four balance
 * widgets, the Reachability donut, and the lens lede are all point-in-time; the
 * shell's As Of / Compare To have zero effect here, exactly as today. There is no
 * historical account read anywhere in this composition — no point-in-time data
 * layer, no time-series balance API (locked by LiquidityPerspective.test.ts).
 *
 * This component owns NO state — everything is pass-through from the host.
 *
 * Layout (plan §3.3) — desktop is a 12-column grid; mobile/tablet stacks in
 * source order Lede → Accessible Cash → EFR → Ladder → Reachability → Concentration:
 *   xl (≥1280): ⓪ Lede 12 · ① KPI 4 · ② Ladder 8 · ③ Reachability 5 · ④ Concentration 7
 *   lg (1024):  ⓪ Lede 12 · ① KPI 5 · ② Ladder 7 · ③ Reachability 6 · ④ Concentration 6
 * (⑤ What Changed — S4; renders nothing here, the grid stays valid without it.)
 */

import type { ReactNode } from "react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { classifyAccounts } from "@/lib/account-classifier";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { LiquidityLadderTiers } from "./LiquidityLadderTiers";
import {
  renderAccessibleCash,
  renderEmergencyFundReadiness,
  renderLiquidityConcentration,
  type LiquidityAdapterAccount,
} from "@/components/space/widgets/liquidity-adapters";

// The card language is exactly the SectionCard solid-lede treatment reproduced by
// CashFlowPerspective's Panel helper. NOT a new card system.
function Panel({ title, subdued, children }: { title: string; subdued?: boolean; children: ReactNode }) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 h-full min-w-0">
      <p className={`text-sm font-semibold px-1 mb-2 ${subdued ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
        {title}
      </p>
      {children}
    </GlassPanel>
  );
}

function fmtMoney(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}

export function LiquidityPerspective({
  accounts,
  ctx,
  lensResult,
}: {
  accounts:   LiquidityAdapterAccount[];
  ctx?:       ConversionContext;
  /** The already-fetched current-state LensResult (lensResults["liquidity"]).
   *  Absent / empty / error ⇒ the lede strip is omitted entirely. NO new fetch,
   *  NO point-in-time read — the same result the shell envelope already consumes. */
  lensResult?: LensResult | null;
}) {
  // ⓪ Lens lede — the verdict SENTENCE only, never a second cashNow KPI (the lens
  // headline is the same figure Accessible Cash leads with — the duplicate-KPI
  // rule). Rendered only on status === "ok"; absent/empty/error ⇒ null (no cell,
  // no placeholder, no fabricated sentence).
  function renderLede(): ReactNode {
    if (!lensResult || lensResult.status !== "ok" || !lensResult.verdict) return null;
    const freshnessLabel = lensResult.provenance.dataAsOf ? formatDate(lensResult.provenance.dataAsOf) : null;
    const redactions = lensResult.provenance.redactions?.length ?? 0;
    return (
      <div className="min-w-0 lg:col-span-12">
        <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
          <p className="text-sm text-[var(--text-primary)] leading-snug">
            {lensResult.estimated ? "≈ " : ""}{lensResult.verdict}
          </p>
          {(freshnessLabel || redactions > 0) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
              {freshnessLabel && <span className="text-[11px] text-[var(--text-faint)]">as of {freshnessLabel}</span>}
              {redactions > 0 && (
                <span className="text-[11px] text-[var(--text-faint)]">{redactions} account detail{redactions === 1 ? "" : "s"} withheld</span>
              )}
            </div>
          )}
        </GlassPanel>
      </div>
    );
  }

  // ③ Reachability by Type — a donut over the five classifyAccounts type totals,
  // colored by reachability (cash greens → settlement blues → illiquid gray), with
  // a "top type" footnote. Current-state only; the donut mode already exists.
  function renderReachability(): ReactNode {
    const c = classifyAccounts(accounts, ctx);
    const items: BreakdownItem[] = [
      { id: "checking",    label: "Checking",    value: c.totalChecking,      color: "#22c55e" },
      { id: "savings",     label: "Savings",     value: c.totalSavings,       color: "#16a34a" },
      { id: "investments", label: "Investments", value: c.totalInvestments,   color: "#3b82f6" },
      { id: "crypto",      label: "Crypto",      value: c.totalDigitalAssets, color: "#60a5fa" },
      { id: "other",       label: "Other",       value: c.totalRealAssets,    color: "#6b7280" },
    ].filter((i) => i.value > 0);

    const total = items.reduce((s, i) => s + i.value, 0);
    const top = items.reduce<BreakdownItem | null>((best, i) => (best && best.value >= i.value ? best : i), null);
    const footer = top && total > 0
      ? <p className="text-[11px] text-[var(--text-faint)] text-center">Top type: {top.label} · {((top.value / total) * 100).toFixed(0)}%</p>
      : undefined;

    return (
      <BreakdownWidget
        items={items}
        viewMode="donut"
        itemNoun="type"
        formatValue={(v) => fmtMoney(v, ctx)}
        footer={footer}
        emptyHeadline="No assets yet"
        emptySubline="Connect asset accounts to see how reachable your money is by type."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch min-w-0">
      {/* ⓪ Lens lede — slim strip, present only on an ok LensResult. */}
      {renderLede()}

      {/* ① KPI column — Accessible Cash over its quiet sibling, Emergency Fund
           Readiness. A flex stack so panel heights stay content-defined. */}
      <div className="min-w-0 lg:col-span-5 xl:col-span-4 flex flex-col gap-4">
        <Panel title="Accessible Cash">
          {renderAccessibleCash(accounts, ctx)}
        </Panel>
        <Panel title="Emergency Fund Readiness" subdued>
          {renderEmergencyFundReadiness(accounts, ctx)}
        </Panel>
      </div>

      {/* ② Liquidity Ladder — the visually dominant panel (takes the deferred
           Trend slot's weight). Tier tiles + per-tier account rows. */}
      <div className="min-w-0 lg:col-span-7 xl:col-span-8">
        <Panel title="Liquidity Ladder">
          <LiquidityLadderTiers accounts={accounts} ctx={ctx} />
        </Panel>
      </div>

      {/* ③ Reachability by Type — donut over classifyAccounts type totals. */}
      <div className="min-w-0 lg:col-span-6 xl:col-span-5">
        <Panel title="Reachability by Type">
          {renderReachability()}
        </Panel>
      </div>

      {/* ④ Liquidity Concentration — ranked bars of reachable-now accounts. */}
      <div className="min-w-0 lg:col-span-6 xl:col-span-7">
        <Panel title="Liquidity Concentration">
          {renderLiquidityConcentration(accounts, ctx)}
        </Panel>
      </div>
    </div>
  );
}
