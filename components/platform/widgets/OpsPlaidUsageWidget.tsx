"use client";

/**
 * components/platform/widgets/OpsPlaidUsageWidget.tsx  (PLATFORM OPS OBSERVABILITY · ops_plaid_usage)
 *
 * Plaid usage and economics over GET /api/platform/platform-ops/plaid-usage:
 * the Item population, then Item-months per product for the current and
 * previous billing cycle under BOTH invoice readings, and the estimated cost
 * from the invoice-derived rate card — usage and cost visibly apart.
 *
 * A cycle before the rate's evidence shows its usage and no dollar; with no
 * rate authority at all the widget says so. No daily allocation is invented.
 * Presentation only.
 */

import { Landmark } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { BigStat, GroupLabel, KeyRow, SectionSurface, Unavailable } from "../platform-surface";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";

const FOOTNOTE =
  "Usage is exact from the Item rows and their status transitions; the invoice's two readings (present during the cycle / present at cycle end) are both shown. Cost is ESTIMATED: Item-months × the invoice-derived rate, null before the rate's evidence. Seeded demo Items are excluded from billing.";

const usd = (v: number | null) => (v === null ? null : `$${v.toFixed(2)}`);

function Cycle({ c }: { c: PlaidUsage["cycles"][number] }) {
  const d = c.during; const a = c.atEnd;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <GroupLabel hint={`Billing cycle ${c.cycle.start} .. ${c.cycle.end}. "During" counts an Item present at any point of the cycle; "at end" only one present on the last day.`}>
        {c.label === "current" ? "Current cycle" : "Previous cycle"} · {c.cycle.start.slice(0, 7)}
      </GroupLabel>
      <div className="flex flex-col gap-1.5">
        <KeyRow label="Transactions Item-months" value={c.agree ? d.itemMonths.transactions : `${d.itemMonths.transactions} during · ${a.itemMonths.transactions} at end`} />
        <KeyRow label="Investments Item-months" value={c.agree ? d.itemMonths.investments : `${d.itemMonths.investments} during · ${a.itemMonths.investments} at end`} />
        <KeyRow label="Estimated cost" value={usd(d.usd) === null ? <Unavailable reason={d.unpricedItemMonths ? "before the rate's evidence" : "nothing billable"} /> : c.agree ? usd(d.usd) : `${usd(d.usd)} during · ${usd(a.usd)} at end`} />
        {d.unevidencedProductItemMonths > 0 && <KeyRow label="Product not evidenced" value={`${d.unevidencedProductItemMonths} Item-months`} />}
        <KeyRow label="Census coverage" value={d.coverage.incomplete ? "lower bound — evidence begins after the cycle started" : "complete"} />
        {d.byEnvironment.length > 0 && (
          <KeyRow label="By environment" value={d.byEnvironment.map((e) => `${e.environment} ${e.itemMonths}`).join(" · ")} />
        )}
      </div>
    </div>
  );
}

export function OpsPlaidUsageWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlaidUsage>("/api/platform/platform-ops/plaid-usage");
  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={Landmark}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }
  const p = data.population;
  const current = data.cycles[0];

  return (
    <SectionSurface icon={Landmark} title={section.label} footnote={FOOTNOTE}>
      <div className="mb-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <BigStat label="Billable Items" value={p.billable} qualifier={`${p.total} total · ${p.seeded} seeded excluded`} />
        <BigStat label="Active" value={p.byStatus.ACTIVE ?? 0} qualifier={Object.entries(p.byStatus).filter(([k]) => k !== "ACTIVE").map(([k, v]) => `${v} ${k.toLowerCase().replace(/_/g, " ")}`).join(" · ") || "no other status"} />
        <BigStat label="Item-months this cycle" value={`${current.during.itemMonths.transactions} + ${current.during.itemMonths.investments}`} qualifier="transactions + investments" />
        <BigStat
          label="Estimated cost this cycle"
          value={data.priceAuthority.configured ? (usd(current.during.usd) ?? <Unavailable reason="unpriced" />) : <Unavailable reason="cost authority not configured" />}
          qualifier={data.priceAuthority.configured ? `${data.priceAuthority.tier.toLowerCase()} · invoice-derived rate` : "usage only"}
        />
      </div>

      <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-3">
        {data.cycles.map((c) => <Cycle key={c.cycle.start} c={c} />)}
        <div className="flex min-w-0 flex-col gap-2">
          <GroupLabel hint={data.priceAuthority.note}>Price authority</GroupLabel>
          {data.priceAuthority.configured ? (
            <div className="flex flex-col gap-1.5">
              {data.priceAuthority.rates.map((r) => (
                <KeyRow key={r.product} label={`${r.product} · from ${r.effectiveFrom}`} value={`$${r.usdPerItemMonth.toFixed(2)} / Item-month`} />
              ))}
              <p className="text-[10px] text-[var(--text-faint)]">{data.priceAuthority.rates[0]?.source}</p>
            </div>
          ) : (
            <Unavailable reason="no Plaid price authority is configured — usage is shown, cost is not" />
          )}
          <div className="mt-2 flex flex-col gap-1.5">
            <KeyRow label="Investments consented" value={p.investmentsConsented} />
            <KeyRow label="Items with status transitions" value={p.withTransitions} />
            <KeyRow label="By environment" value={Object.entries(p.byEnvironment).map(([k, v]) => `${k} ${v}`).join(" · ")} />
          </div>
        </div>
      </div>
    </SectionSurface>
  );
}
