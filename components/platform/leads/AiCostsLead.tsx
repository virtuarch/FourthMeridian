"use client";

/**
 * components/platform/leads/AiCostsLead.tsx  (Platform Ops visual spec §5 — AI & Costs)
 *
 * THE AI & COSTS DEFAULT SCREEN — financial analytics in the accepted Operations
 * grammar (Personal Space language). It REPLACES the stacked AI / Costs widgets;
 * every one of them stays reachable in a drawer, hosted unchanged.
 *
 *   ≥ lg (12-col)
 *     A  AI spend hero (12)           ESTIMATED 30 d spend · billed Unknown · 4 KPIs
 *     B  Daily spend (7)              TrendChart, 7 d / 30 d calendar windows
 *        Cost by surface (5)          BreakdownWidget donut (invocation ledger)
 *     C  Tokens & invocations (6)     DayBars, Tokens / Invocations toggle
 *        Cost by provider (6)         BreakdownWidget bars, this cycle; others Unknown
 *     D  Budget utilisation (6)       fleet meter (rolling 24 h vs threshold)
 *        Customers & policy groups (6) top 3 by today's spend vs THEIR allowance
 *     E  Economics (12)               the Phase 3 slot — no numbers
 *     F  AI & Costs detail nav        five drawers hosting the former widgets
 *   < lg
 *     compact hero → 2×2 KPIs → ONE chart card (daily spend) → customers (3)
 *     → economics slot → detail nav.
 *
 * Drawers (registry-hosted, the operator's access, never re-gated):
 *   invocations → ops_ai_invocations · brief → ops_brief_ops · ledger →
 *   ops_ai_trend · budget → ops_ai_budget · costs → ops_plaid_usage + ops_cost.
 *
 * Presentation only. Words and figures come from ai-costs-model.ts (pure).
 */

import { useState, type ReactNode } from "react";
import { Block, Surface } from "@/components/atlas/Surface";
import { BreakdownWidget } from "@/components/space/widgets/BreakdownWidget";
import { TrendChart } from "@/components/space/widgets/charts/TrendChart";
import { DetailDrawer, ProvenanceChip } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";
import type { AiOperations } from "@/lib/platform/ai/invocations";
import type { AiBudgetUtilization } from "@/lib/platform/ai/cost-controls.types";
import type { AiSpendResponse } from "@/app/api/platform/platform-ops/ai-spend/route";
import type { ApiUsageResponse } from "@/app/api/platform/platform-ops/api-usage/route";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";
import type { PlatformViewLeadProps, RenderHosted } from "./lead-contract";
import { Caption, ChartMessage, Doorway, Meter, Segmented } from "./visual-kit";
import { HealthHero, type HeroModel } from "../ops-visual/HealthHero";
import { DayBars, DayBarsLegend } from "../ops-visual/DayBars";
import type { Fetched } from "../ops-visual/ops-visual-model";
import {
  BILLED_UNKNOWN,
  aiKpis,
  aiSpend30d,
  budgetMeter,
  costByProvider,
  invocationDays,
  moneyText,
  spendBySurface,
  spendSeries,
  tokenDays,
  topCustomers,
  usd,
} from "./ai-costs-model";

export type AiCostsDrawer = "invocations" | "brief" | "ledger" | "budget" | "costs";

/** The drawers, in nav order (≤ 5), each with the hosted keys it renders. */
export const AI_DRAWERS: readonly { key: AiCostsDrawer; label: string; keys: readonly string[] }[] = [
  { key: "invocations", label: "Invocations", keys: ["ops_ai_invocations"] },
  { key: "brief", label: "Daily Brief", keys: ["ops_brief_ops"] },
  { key: "ledger", label: "Usage ledger", keys: ["ops_ai_trend"] },
  { key: "budget", label: "Budget & controls", keys: ["ops_ai_budget"] },
  { key: "costs", label: "Plaid & operational cost", keys: ["ops_plaid_usage", "ops_cost"] },
];

export const CUSTOMER_ROWS = 3;
type Window = "7" | "30";
type Series = "tokens" | "invocations";

const n = (v: number) => v.toLocaleString("en-US");
const hhmm = (iso: string) => `Checked ${new Date(iso).toISOString().slice(11, 16)} UTC`;
const TOKEN_PALETTE = { succeeded: "color-mix(in srgb, var(--meridian-400) 75%, transparent)", other: "var(--brass-300)", failed: "var(--coral-400)" } as const;

// ── Cards with their own window / series toggle ──────────────────────────────

function SpendTrendCard({ trend, nowMs, onOpenLedger }: { trend: Fetched<AiUsageTrend>; nowMs: number; onOpenLedger?: () => void }) {
  const [win, setWin] = useState<Window>("30");
  const days = Number(win);
  const s = spendSeries(trend.data, nowMs, days);
  return (
    <Block id="ai-spend-trend" label="Daily spend" className="min-w-0 lg:col-span-7"
      hint={<ProvenanceChip kind={trend.data?.pricingConfigured ? "ESTIMATED" : "UNKNOWN"} />}
      action={<Segmented label="Spend window" value={win} onChange={setWin} options={[{ id: "7", label: "7 d" }, { id: "30", label: "30 d" }]} />}>
      <Surface className="flex-1 p-4 sm:p-5">
        {!trend.data ? (
          <ChartMessage>{trend.loading ? "Reading AI usage…" : `AI usage unavailable${trend.error ? ` — ${trend.error}` : ""}`}</ChartMessage>
        ) : !trend.data.pricingConfigured ? (
          <ChartMessage>Spend Unknown — no AI rate card configured</ChartMessage>
        ) : (
          <>
            <TrendChart points={s.points} currency="USD" ariaLabel={`Estimated AI spend per UTC day, last ${days} days`} emptyMessage="No priced AI usage in this window." />
            <Caption>
              {`${s.usd === null ? "Unknown" : usd(s.usd)} est. · ${days} UTC days${s.gaps ? ` · ${s.gaps} without data` : ""}`}
              {onOpenLedger && <> · <button type="button" onClick={onOpenLedger} aria-haspopup="dialog" className="underline-offset-2 hover:underline">ledger</button></>}
            </Caption>
          </>
        )}
      </Surface>
    </Block>
  );
}

function TokensCard({ trend, inv30, nowMs }: { trend: Fetched<AiUsageTrend>; inv30: Fetched<AiOperations>; nowMs: number }) {
  const [series, setSeries] = useState<Series>("tokens");
  const src = series === "tokens" ? trend : inv30;
  const days = series === "tokens" ? tokenDays(trend.data, nowMs, 30) : invocationDays(inv30.data, nowMs, 30);
  const observed = days.filter((d) => d.observed);
  const total = observed.reduce((a, d) => a + d.succeeded + d.other, 0);
  const gaps = days.length - observed.length;
  return (
    <Block id="ai-tokens" label="Tokens & invocations" className="min-w-0 max-lg:hidden lg:col-span-6"
      action={<Segmented label="Series" value={series} onChange={setSeries} options={[{ id: "tokens", label: "Tokens" }, { id: "invocations", label: "Invocations" }]} />}>
      <Surface className="flex-1 p-4 sm:p-5">
        {src.data ? (
          <>
            <DayBars days={days} height={160} palette={TOKEN_PALETTE}
              ariaLabel={series === "tokens" ? "Prompt and completion tokens per UTC day" : "Returned AI invocations per UTC day"}
              noun={series === "tokens" ? "token" : "invocation"} />
            <Caption>
              {series === "tokens"
                ? <>{`${n(total)} tokens · measured · 30 UTC days${gaps ? ` · ${gaps} without data` : ""}`}</>
                : <>{`${n(total)} returned invocations · measured · 30 UTC days${gaps ? ` · ${gaps} without data` : ""}`}</>}
            </Caption>
            {series === "tokens" && <div className="mt-2"><DayBarsLegend items={[{ label: "Prompt", color: TOKEN_PALETTE.succeeded }, { label: "Completion", color: TOKEN_PALETTE.other }]} /></div>}
          </>
        ) : (
          <ChartMessage>{src.loading ? "Reading usage…" : `Usage unavailable${src.error ? ` — ${src.error}` : ""}`}</ChartMessage>
        )}
      </Surface>
    </Block>
  );
}

// ── The surface (prop-driven, fetch-free — every state renders in a test) ────

export interface AiCostsLeadSurfaceProps {
  trend: Fetched<AiUsageTrend>;
  spend: Fetched<AiSpendResponse>;
  inv7: Fetched<AiOperations>;
  inv30: Fetched<AiOperations>;
  budget: Fetched<AiBudgetUtilization>;
  plaid: Fetched<PlaidUsage>;
  apiUsage: Fetched<ApiUsageResponse>;
  nowMs: number;
  hasHosted: (key: string) => boolean;
  onOpenDrawer: (d: AiCostsDrawer) => void;
}

export function aiHeroModel(trend: Fetched<AiUsageTrend>, kpis: HeroModel["kpis"]): HeroModel {
  const m = aiSpend30d(trend);
  return {
    title: "AI spend · 30 d",
    dot: false,
    provenance: m.kind === "ESTIMATED" ? "ESTIMATED" : "UNKNOWN",
    verdict: { word: moneyText(m), tone: "muted" },
    checked: trend.data ? hhmm(trend.data.checkedAt) : null,
    caption: m.kind === "ESTIMATED"
      ? `${m.partial ? "Partial estimate" : "Estimated"} · tokens × rate card · billed: ${BILLED_UNKNOWN}`
      : `Estimate ${m.reason} · billed: ${BILLED_UNKNOWN}`,
    kpis,
    kpiLabels: { first: "AI budget and volume", second: "AI reliability and unit cost", all: "AI spend figures" },
  };
}

export function AiCostsLeadSurface(p: AiCostsLeadSurfaceProps) {
  const kpis = aiKpis({ budget: p.budget, inv7: p.inv7 });
  const hero = aiHeroModel(p.trend, kpis);
  const surfaces = spendBySurface(p.spend.data);
  const providers = costByProvider({ trend: p.trend, plaid: p.plaid, apiUsage: p.apiUsage.data, nowMs: p.nowMs });
  const priced = providers.filter((x) => x.money.kind === "ESTIMATED");
  const unknown = providers.filter((x) => x.money.kind === "UNKNOWN");
  const meter = budgetMeter(p.budget.data);
  const customers = topCustomers(p.budget.data, CUSTOMER_ROWS);
  const drawers = AI_DRAWERS.filter((d) => d.keys.some(p.hasHosted));
  const can = (k: AiCostsDrawer) => drawers.some((d) => d.key === k);
  const open = (k: AiCostsDrawer) => (can(k) ? () => p.onOpenDrawer(k) : undefined);

  return (
    <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-ai-dashboard>
      {/* A — AI spend hero. */}
      <HealthHero model={{ ...hero, actions: {
        ...(can("budget") ? { budget: { label: "Open budget & controls", onSelect: () => p.onOpenDrawer("budget"), dialog: true } } : {}),
        ...(can("invocations") ? {
          calls: { label: "Open the invocation log", onSelect: () => p.onOpenDrawer("invocations"), dialog: true },
          errors: { label: "Open the invocation log", onSelect: () => p.onOpenDrawer("invocations"), dialog: true },
        } : {}),
        ...(can("ledger") ? { "per-call": { label: "Open the usage ledger", onSelect: () => p.onOpenDrawer("ledger"), dialog: true } } : {}),
      } }} />

      {/* B — Daily spend (7) · Cost by surface (5). */}
      <div className="grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8">
        <SpendTrendCard trend={p.trend} nowMs={p.nowMs} onOpenLedger={open("ledger")} />
        <Block id="ai-by-surface" label="Cost by surface" className="min-w-0 max-lg:hidden lg:col-span-5"
          hint={<ProvenanceChip kind={surfaces.items.length ? "ESTIMATED" : "UNKNOWN"} />}
          action={<span className="text-[11px] text-[var(--text-faint)]">{surfaces.windowDays ? `${surfaces.windowDays} UTC days` : ""}</span>}>
          <Surface className="flex-1 p-4 sm:p-5">
            <BreakdownWidget
              items={surfaces.items}
              viewMode="donut"
              itemNoun="surface"
              formatValue={usd}
              centerTotal={{ value: surfaces.total, label: "estimated" }}
              centerTone="neutral"
              emptyHeadline={p.spend.loading ? "Reading spend by surface…" : p.spend.error ? "Spend by surface unavailable" : "No priced invocations in the window"}
            />
            {surfaces.unpricedInvocations > 0 && <Caption>{`${n(surfaces.unpricedInvocations)} unpriced invocations — counted, never $0`}</Caption>}
          </Surface>
        </Block>
      </div>

      {/* C — Tokens & invocations (6) · Cost by provider (6). */}
      <div className="grid items-stretch gap-6 max-lg:hidden lg:grid-cols-12 lg:gap-8">
        <TokensCard trend={p.trend} inv30={p.inv30} nowMs={p.nowMs} />
        <Block id="ai-by-provider" label="Cost by provider" className="min-w-0 lg:col-span-6"
          hint={<span className="text-[11px] text-[var(--text-faint)]">This cycle</span>}
          action={can("costs") ? <Doorway label="Plaid & cost" onSelect={() => p.onOpenDrawer("costs")} dialog /> : undefined}>
          <Surface className="flex-1 p-4 sm:p-5">
            <BreakdownWidget
              items={priced.map((x) => ({ id: x.id, label: `${x.label}${x.money.kind === "ESTIMATED" && x.money.partial ? " · partial" : ""}`, value: x.money.kind === "ESTIMATED" ? x.money.usd : 0 }))}
              viewMode="bar"
              formatValue={usd}
              emptyHeadline="No provider has a priced estimate this cycle"
            />
            <ul aria-label="Providers without a cost estimate" className="mt-3 flex flex-col">
              {unknown.slice(0, 3).map((x) => (
                <li key={x.id} className="flex min-h-8 items-center justify-between gap-3 border-t border-[var(--border-hairline)] text-[11px]">
                  <span className="min-w-0 truncate text-[var(--text-secondary)]">{x.label}</span>
                  <ProvenanceChip kind="UNKNOWN" title={x.money.kind === "UNKNOWN" ? x.money.reason : undefined} />
                </li>
              ))}
            </ul>
            {unknown.length > 3 && <Caption>{`${n(unknown.length - 3)} more providers · cost Unknown`}</Caption>}
          </Surface>
        </Block>
      </div>

      {/* D — Budget utilisation (6) · Customers & policy groups (6). */}
      <div className="grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8">
        <Block id="ai-budget" label="Budget utilisation" className="min-w-0 max-lg:hidden lg:col-span-6"
          hint={<ProvenanceChip kind={meter?.spend.kind === "ESTIMATED" ? "ESTIMATED" : "UNKNOWN"} />}
          action={can("budget") ? <Doorway label="Budget & controls" onSelect={() => p.onOpenDrawer("budget")} dialog /> : undefined}>
          <Surface className="flex-1 p-4 sm:p-5">
            {meter ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]">{meter.pct === null ? "Unknown" : `${Math.round(meter.pct)}%`}</span>
                  <span className="truncate text-[11px] tabular-nums text-[var(--text-muted)]">{`${moneyText(meter.spend)} of ${usd(meter.thresholdUsd)} · ${meter.windowHours} h`}</span>
                </div>
                <div className="mt-3">{meter.pct === null ? <span className="block h-2 w-full rounded-full border border-dashed border-[var(--border-hairline-strong)]" /> : <Meter pct={meter.pct} tone={meter.tone} label="Fleet AI budget used" />}</div>
                <Caption>{`Fleet alert threshold (configured) · alert ${meter.alertEnabled ? "on" : "off"}`}</Caption>
              </>
            ) : (
              <ChartMessage>{p.budget.loading ? "Reading budget…" : `Budget unavailable${p.budget.error ? ` — ${p.budget.error}` : ""}`}</ChartMessage>
            )}
          </Surface>
        </Block>
        <Block id="ai-customers" label="Customers & policy groups" className="min-w-0 lg:col-span-6"
          action={can("budget") && customers.length > 0 ? <Doorway label="See all" onSelect={() => p.onOpenDrawer("budget")} dialog /> : undefined}>
          <Surface className="flex-1 px-4 py-2 sm:px-5">
            {p.budget.data ? (
              customers.length > 0 ? (
                <ul aria-label="Top customers by AI spend today" className="flex flex-col">
                  {customers.map((c) => (
                    <li key={c.ref} className="flex min-h-11 items-center gap-3 border-t border-[var(--border-hairline)] py-2 first:border-t-0">
                      <span className="w-24 shrink-0 truncate font-mono text-[11px] text-[var(--text-secondary)]">{c.ref}</span>
                      <span className="min-w-0 flex-1"><Meter pct={c.allowanceUtilizationPct} tone={c.allowanceUtilizationPct >= 100 ? "bad" : c.allowanceUtilizationPct >= 80 ? "warn" : "ok"} label={`${c.ref} allowance used today`} /></span>
                      <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{`${usd(c.todayUsd)} / ${usd(c.allowanceUsd)}`}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-3 text-xs text-[var(--text-muted)]">No customer AI spend recorded today</p>
              )
            ) : (
              <p className="py-3 text-xs text-[var(--text-muted)]">{p.budget.loading ? "Reading customers…" : "Customer spend unavailable"}</p>
            )}
            <p className="truncate border-t border-[var(--border-hairline)] py-2 text-[11px] text-[var(--text-muted)]" data-policy-groups-cost>Cost by policy group · not yet available</p>
          </Surface>
        </Block>
      </div>

      {/* E — Economics: the Phase 3 slot, deliberately without numbers. */}
      <Block id="ai-economics" label="Economics" hint={<span className="text-[11px] text-[var(--text-faint)]">Phase 3</span>}>
        <Surface tone="sunken" className="px-4 py-3 sm:px-5">
          <p className="truncate text-xs text-[var(--text-muted)]" data-economics-slot>Revenue, margin and cost per customer — not yet available</p>
        </Surface>
      </Block>

      {/* F — the former widgets, each in a drawer. */}
      {drawers.length > 0 && (
        <nav aria-label="AI & Costs detail" className="flex flex-wrap items-center gap-x-4">
          {drawers.map((d) => <Doorway key={d.key} label={d.label} onSelect={() => p.onOpenDrawer(d.key)} dialog />)}
        </nav>
      )}
    </div>
  );
}

/** A drawer's body: its hosted widgets through the registry (exported so hosting is provable without a DOM portal). */
export function AiCostsDrawerBody({ drawer, renderHosted, onOpenWorkspace }: { drawer: AiCostsDrawer; renderHosted: RenderHosted; onOpenWorkspace: (id: string) => void }) {
  const d = AI_DRAWERS.find((x) => x.key === drawer);
  if (!d) return null;
  return <div className="flex flex-col gap-8">{d.keys.map((k) => <div key={k} className="min-w-0">{renderHosted(k, onOpenWorkspace)}</div>)}</div>;
}

export function AiCostsLead({ renderHosted, hasHosted, onOpenWorkspace }: PlatformViewLeadProps) {
  const trend = useSharedWidgetFetch<AiUsageTrend>("/api/platform/platform-ops/ai-usage-trend");
  const spend = useSharedWidgetFetch<AiSpendResponse>("/api/platform/platform-ops/ai-spend");
  const inv7 = useSharedWidgetFetch<AiOperations>("/api/platform/platform-ops/ai-invocations?window=7d");
  const inv30 = useSharedWidgetFetch<AiOperations>("/api/platform/platform-ops/ai-invocations?window=30d");
  const budget = useSharedWidgetFetch<AiBudgetUtilization>("/api/platform/platform-ops/ai-budget");
  const plaid = useSharedWidgetFetch<PlaidUsage>("/api/platform/platform-ops/plaid-usage");
  const apiUsage = useSharedWidgetFetch<ApiUsageResponse>("/api/platform/platform-ops/api-usage");
  // One clock read per mount (calendar windows + the cycle), never during render.
  const [nowMs] = useState(() => Date.now());
  const [drawer, setDrawer] = useState<AiCostsDrawer | null>(null);
  // A doorway inside a drawer closes it, then moves the rail.
  const go = (id: string) => { setDrawer(null); onOpenWorkspace(id); };

  const d = drawer ? AI_DRAWERS.find((x) => x.key === drawer) : undefined;
  const body: ReactNode = drawer ? <AiCostsDrawerBody drawer={drawer} renderHosted={renderHosted} onOpenWorkspace={go} /> : null;

  return (
    <>
      <AiCostsLeadSurface trend={trend} spend={spend} inv7={inv7} inv30={inv30} budget={budget} plaid={plaid} apiUsage={apiUsage}
        nowMs={nowMs} hasHosted={hasHosted} onOpenDrawer={setDrawer} />
      <DetailDrawer open={drawer !== null} onClose={() => setDrawer(null)} eyebrow="AI & Costs" title={d?.label ?? ""} size="xl">
        {body}
      </DetailDrawer>
    </>
  );
}
