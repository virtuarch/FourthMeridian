"use client";

/**
 * components/platform/leads/MerchantLead.tsx  (Platform Spaces 2.0 — Merchant Operations)
 *
 * THE MERCHANT OPERATIONS DEFAULT SCREEN, redesigned around what the Space
 * actually does today: transaction-merchant IDENTITY (resolution coverage,
 * where categories come from, aliases and customer rules) and the operator
 * MERGE REVIEW. Fourth Meridian processes no payments, settles no funds and
 * onboards no merchants — so there are no payment, settlement or processing
 * charts, and the page says so plainly.
 *
 *   every width (review first — it is the Space's one action)
 *     1  scope line + period + hero (share of live transactions linked) · 4 KPIs
 *     2  merge review: decisions per day (8) · by evidence tier + Open review (4)
 *     3  category provenance (7) · aliases by source (5, ≥ lg only)
 *     4  identity growth: aliases and customer rules per day (≥ lg only)
 *     5  how measured
 */

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Block, Surface } from "@/components/atlas/Surface";
import { BreakdownWidget } from "@/components/space/widgets/BreakdownWidget";
import { useSharedWidgetFetch } from "../workspace-session";
import type { MerchantOverviewResponse } from "@/lib/platform/merchant/overview-types";
import type { PlatformViewLeadProps } from "./lead-contract";
import { LazyDisclosure } from "./lead-kit";
import { Caption, ChartMessage, Segmented, goToSection } from "./visual-kit";
import { HealthHero } from "../ops-visual/HealthHero";
import { DayBars, DayBarsLegend } from "../ops-visual/DayBars";
import type { Fetched } from "../ops-visual/ops-visual-model";
import { ShareBars } from "../charts/ShareBars";
import {
  GROWTH_PALETTE, MERGE_PALETTE, REVIEW_HREF, aliasItems, decisionBars, growthBars, merchantHero, sourceBars, type MerchantWindow,
} from "./merchant-model";

const n = (v: number) => v.toLocaleString("en-US");
const GRID = "grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8";

function Loading({ f, what }: { f: Fetched<unknown>; what: string }) {
  return <ChartMessage>{f.loading ? `Reading ${what}…` : `${what[0].toUpperCase()}${what.slice(1)} unavailable${f.error ? ` — ${f.error}` : ""}`}</ChartMessage>;
}

export interface MerchantLeadSurfaceProps {
  f: Fetched<MerchantOverviewResponse>;
  period: MerchantWindow;
  onPeriod: (w: MerchantWindow) => void;
  /** The review doorway follows its section row (enabled ⇒ shown), as the hosted link card did. */
  reviewAvailable?: boolean;
}

export function MerchantLeadSurface(p: MerchantLeadSurfaceProps) {
  const m = p.f.data;
  return (
    <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-merchant-dashboard>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-[11px] text-[var(--text-muted)]" data-scope-line>Merchant identity for customers&apos; transactions — Fourth Meridian processes no payments.</p>
          <span className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--text-muted)]">Period</span>
            <Segmented label="Period" value={p.period} onChange={p.onPeriod} options={[{ id: "30", label: "30 d" }, { id: "90", label: "90 d" }]} />
          </span>
        </div>
        <HealthHero model={{ ...merchantHero(p.f), actions: {
          merchants: { label: "Show merchant aliases", onSelect: () => goToSection("mo-aliases") },
          unresolved: { label: "Show where categories come from", onSelect: () => goToSection("mo-provenance") },
          merged: { label: "Show the merge review", onSelect: () => goToSection("mo-decisions") },
          dismissed: { label: "Show the merge review", onSelect: () => goToSection("mo-decisions") },
        } }} />
      </div>

      {/* Review first at every width — it is the Space's one action. With no
          decisions in the window there is nothing to chart: one compact row, never an empty chart. */}
      {m && m.decisions.merged + m.decisions.dismissed === 0 && m.decisions.byTier.length === 0 ? (
        <Block id="mo-decisions" label="Merge review" className="min-w-0">
          <Surface className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3" data-review-empty>
            <p className="min-w-0 text-xs text-[var(--text-secondary)]">{`No merge decisions yet · candidates are detected on the review page; a merge rewrites identity for every tenant and is audited.`}</p>
            {p.reviewAvailable !== false && <Link href={REVIEW_HREF} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-3 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-9" data-review-link>
              Open merge review <ChevronRight size={12} aria-hidden />
            </Link>}
          </div>
          </Surface>
        </Block>
      ) : (
      <div className={GRID}>
        <Block id="mo-decisions" label="Merge review" className="min-w-0 lg:col-span-8">
          <Surface className="flex-1 p-4 sm:p-5">
            {m ? (
              <>
                {m.decisions.merged + m.decisions.dismissed === 0 ? (
                  <ChartMessage>{`No merge decisions in the last ${m.windowDays} days`}</ChartMessage>
                ) : (
                  <DayBars days={decisionBars(m)} height={200} noun="decision" palette={MERGE_PALETTE} ariaLabel="Merge-review decisions per UTC day: merged and dismissed" />
                )}
                <div className="mt-2"><DayBarsLegend items={[{ label: "Merged", color: MERGE_PALETTE.succeeded }, { label: "Dismissed (kept apart)", color: MERGE_PALETTE.other }]} /></div>
                <Caption>{`${n(m.decisions.merged)} merged · ${n(m.decisions.dismissed)} dismissed · ${m.windowDays} UTC days`}</Caption>
              </>
            ) : <Loading f={p.f} what="merge decisions" />}
          </Surface>
        </Block>
        <Block id="mo-tiers" label="Decisions by evidence tier" className="min-w-0 lg:col-span-4" hint={<span className="text-[11px] text-[var(--text-faint)]">All time</span>}>
          <Surface className="flex flex-1 flex-col gap-3 p-4 sm:p-5">
            {!m ? <Loading f={p.f} what="tiers" /> : m.decisions.byTier.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)]">No merge decisions yet.</p>
            ) : (
              <table className="w-full text-xs" aria-label="Merge decisions by evidence tier">
                <thead><tr className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]"><th className="py-1 text-left font-medium">Tier</th><th className="py-1 text-right font-medium">Merged</th><th className="py-1 text-right font-medium">Dismissed</th></tr></thead>
                <tbody className="divide-y divide-[var(--border-hairline)]">
                  {m.decisions.byTier.map((t) => (
                    <tr key={t.tier}><td className="py-2 text-[var(--text-primary)]">{t.tier}</td><td className="py-2 text-right tabular-nums text-[var(--text-secondary)]">{n(t.merged)}</td><td className="py-2 text-right tabular-nums text-[var(--text-secondary)]">{n(t.dismissed)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {p.reviewAvailable !== false && <Link href={REVIEW_HREF} className="mt-auto inline-flex min-h-11 items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-3 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-9" data-review-link>
              Open merge review <ChevronRight size={12} aria-hidden />
            </Link>}
            <p className="text-[10px] text-[var(--text-muted)]">Candidates are detected on the review page; a merge rewrites identity for every tenant and is audited.</p>
          </Surface>
        </Block>
      </div>
      )}

      <div className={`${GRID} lg:items-start`}>
        <Block id="mo-provenance" label="Where categories come from" className="min-w-0 lg:col-span-7">
          <Surface className="flex-1 p-4 sm:p-5">
            {m ? (m.transactions.total === 0 ? <ChartMessage>No transactions</ChartMessage> : (
              <ShareBars items={sourceBars(m)} ariaLabel="Transactions by category provenance" noun="transaction" denominator={`of ${n(m.transactions.total)} transactions, all tenants`} />
            )) : <Loading f={p.f} what="category provenance" />}
          </Surface>
        </Block>
        <Block id="mo-aliases" label="Merchant aliases by source" className="min-w-0 lg:col-span-5">
          <Surface className="flex-1 p-4 sm:p-5">
            {m ? (
              <>
                <BreakdownWidget items={aliasItems(m)} viewMode="donut" itemNoun="alias" formatValue={n}
                  centerTotal={{ value: m.merchants.aliases.reduce((a, x) => a + x.count, 0), label: "aliases" }} centerTone="neutral" emptyHeadline="No merchant aliases yet" />
                <Caption>{`${n(m.merchants.total)} canonical merchants · ${n(m.merchants.userRules)} customer merchant rules`}</Caption>
              </>
            ) : <Loading f={p.f} what="aliases" />}
          </Surface>
        </Block>
      </div>

      <Block id="mo-growth" label="Identity growth" className="min-w-0 max-lg:hidden">
        <Surface className="p-4 sm:p-5">
          {m ? (
            <>
              <DayBars days={growthBars(m)} height={160} noun="new identity fact" palette={GROWTH_PALETTE} ariaLabel="New merchant aliases and customer merchant rules per UTC day" />
              <div className="mt-2"><DayBarsLegend items={[{ label: "New aliases", color: GROWTH_PALETTE.succeeded }, { label: "New customer rules", color: GROWTH_PALETTE.other }]} /></div>
            </>
          ) : <Loading f={p.f} what="identity growth" />}
        </Surface>
      </Block>

      {m && (
        <LazyDisclosure title="How these figures are measured" hint="scope, sources and what is not charted">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[11px] text-[var(--text-muted)]">{m.notes.map((t) => <li key={t}>{t}</li>)}</ul>
        </LazyDisclosure>
      )}
    </div>
  );
}

export function MerchantLead({ hasHosted }: PlatformViewLeadProps) {
  const [period, setPeriod] = useState<MerchantWindow>("30");
  const f = useSharedWidgetFetch<MerchantOverviewResponse>(`/api/platform/merchant-ops/overview?window=${period}`);
  return <MerchantLeadSurface f={f} period={period} onPeriod={setPeriod} reviewAvailable={hasHosted("merchant_review")} />;
}
