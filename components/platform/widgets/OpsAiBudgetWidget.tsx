"use client";

/**
 * components/platform/widgets/OpsAiBudgetWidget.tsx  (AI COST CONTROLS — budget utilization · ops_ai_budget)
 *
 * Economics → "AI Budget": the presentation of `AiBudgetUtilization` over
 * GET /api/platform/platform-ops/ai-budget (PLATFORM_OPS READ). ONE
 * SectionSurface in the Economics grammar:
 *
 *   Fleet · rolling 24 h     the estimated customer spend as the figure, its
 *                            utilization of the fleet alert threshold as a
 *                            percentage AND a bar (word + colour, never colour
 *                            alone), the threshold and whether the alert is on
 *   Controls in force        Paused / Admitting · Enforced / Not enforced · the
 *                            default allowance and the per-customer alert
 *   Customers                opaque refs: today vs allowance (with its source),
 *                            rolling 24 h vs the per-customer alert threshold
 *   By surface               customer vs overhead stated on every row
 *   Unpriced usage           counted and named, never priced at $0
 *   Recent spending alerts   past deliveries, newest first — never "open"
 *
 * Null figures render through `Unavailable` with their reason, never a fake 0.
 * The footnote is the one sentence every dollar here is governed by:
 * ESTIMATE_NOT_BILLING. Read-only; no control on this surface. Presentation
 * derives nothing — ai-budget-view.ts does, purely.
 */

import { Gauge } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { BigStat, GroupLabel, KeyRow, Provenance, SectionSurface, TONE_COLOR, ToneBadge, Unavailable } from "../platform-surface";
import { ESTIMATE_NOT_BILLING, type AiBudgetUtilization } from "@/lib/platform/ai/cost-controls.types";
import { formatUtc } from "./policies-view";
import {
  AI_BUDGET_SUBJECT, FLEET_NOTE, PAST_DELIVERIES_NOTE, controlsText, customerRowText, deliveryText, enforcementWord, fleetReading, overheadText,
  pausedWord, pctText, severityTone, surfaceRowText, thresholdText, unpricedWarning, utilizationFill, utilizationTone, windowText,
} from "./ai-budget-view";

/** A proportional bar whose meaning is ALSO the word beside it — never colour-only. */
function UtilizationBar({ label, pct }: { label: string; pct: number | null }) {
  const tone = utilizationTone(pct);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div role="img" aria-label={`${label}: ${pctText(pct)}`} className="h-1.5 w-full max-w-[160px] overflow-hidden rounded-full" style={{ background: "var(--surface-inset)" }}>
        <span className="block h-full" style={{ width: `${utilizationFill(pct)}%`, minWidth: pct !== null && pct > 0 ? 2 : 0, background: TONE_COLOR[tone] }} />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums" style={{ color: TONE_COLOR[tone] }}>{pctText(pct)}</span>
    </div>
  );
}

/** Prop-driven and fetch-free. */
export function AiBudgetSurface({ section, data }: { section: PlatformSection; data: AiBudgetUtilization }) {
  const fleet = fleetReading(data);
  const paused = pausedWord(data.controls.paused);
  const enforced = enforcementWord(data.controls.allowanceEnforced);
  const unpriced = unpricedWarning(data.unpriced);
  const footnote = data.estimateNote && data.estimateNote !== ESTIMATE_NOT_BILLING ? `${ESTIMATE_NOT_BILLING} ${data.estimateNote}` : ESTIMATE_NOT_BILLING;
  return (
    <SectionSurface
      icon={Gauge}
      title={section.label}
      actions={<Provenance source="invocation ledger · rate card">{windowText(data, formatUtc)}</Provenance>}
      footnote={footnote}
    >
      <div className="flex flex-col gap-8">
        <div className="grid gap-6 @min-[42rem]:grid-cols-2 [&>*]:min-w-0">
          <div className="flex flex-col gap-3">
            <BigStat
              label="Fleet · rolling 24 h estimate"
              value={fleet.kind === "figure" ? fleet.value : <Unavailable reason={fleet.reason} />}
              qualifier={fleet.qualifier}
              derivation={thresholdText(data.fleet, data.windowHours)}
              hint={FLEET_NOTE}
            />
            <UtilizationBar label="Fleet utilization of the alert threshold" pct={data.fleet.utilizationPct} />
            <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{overheadText(data.overhead)}</p>
          </div>
          <div className="flex flex-col gap-2 border-t border-[var(--border-hairline)] pt-5 @min-[42rem]:border-t-0 @min-[42rem]:border-l @min-[42rem]:pl-6 @min-[42rem]:pt-0">
            <GroupLabel hint="The controls as the Policies surface declares them; changed there, never here.">Controls in force</GroupLabel>
            <KeyRow label="Paid AI requests" value={<ToneBadge word={paused.word} tone={paused.tone} />} />
            <KeyRow label="Daily allowance" value={<ToneBadge word={enforced.word} tone={enforced.tone} />} />
            <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{controlsText(data.controls, data.windowHours)}</p>
          </div>
        </div>

        <div className="grid gap-8 border-t border-[var(--border-hairline)] pt-6 @min-[42rem]:grid-cols-2 [&>*]:min-w-0">
          <div className="flex flex-col gap-2">
            <GroupLabel hint="Top customers by rolling-24 h estimate, as opaque references. Today is what the allowance judges; the rolling window is what the per-customer alert judges.">Customers</GroupLabel>
            {data.customers.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)]" role="status">No customer spend in the window.</p>
            ) : (
              <ul className="divide-y divide-[var(--border-hairline)]">
                {data.customers.map((c) => {
                  const r = customerRowText(c, data.controls.userAlertThresholdUsd);
                  return (
                    <li key={c.ref} className="flex flex-col gap-1 py-2 text-xs">
                      <span className="break-all font-mono text-[10px] text-[var(--text-primary)]">{c.ref}</span>
                      <KeyRow label="Today vs allowance" value={r.today} />
                      <UtilizationBar label={`${c.ref} today vs allowance`} pct={r.todayPct} />
                      <KeyRow label="Rolling 24 h vs alert" value={r.rolling} />
                      <UtilizationBar label={`${c.ref} rolling 24 h vs alert threshold`} pct={r.rollingPct} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-[var(--border-hairline)] pt-5 @min-[42rem]:border-t-0 @min-[42rem]:border-l @min-[42rem]:pl-6 @min-[42rem]:pt-0">
            <GroupLabel hint="Estimated spend by surface; customer surfaces and overhead are named on every row.">By surface</GroupLabel>
            {data.bySurface.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)]" role="status">No invocations in the window.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {data.bySurface.map((s) => {
                  const r = surfaceRowText(s);
                  return (
                    <li key={s.surface} className="flex flex-col gap-0.5">
                      <KeyRow label={r.label} value={r.value === null ? <Unavailable reason={r.unavailable} /> : r.value} />
                      <span className="text-[10px] text-[var(--text-faint)]">{r.meta}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {unpriced && (
              <p className="text-[11px] leading-relaxed" style={{ color: TONE_COLOR.warn }} role="alert">{unpriced}</p>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2 border-t border-[var(--border-hairline)] pt-6">
          <GroupLabel hint={PAST_DELIVERIES_NOTE}>Recent spending alerts</GroupLabel>
          {data.recentAlerts.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)]" role="status">No spending alert delivered in the retained evaluation runs.</p>
          ) : (
            <ul className="divide-y divide-[var(--border-hairline)]">
              {data.recentAlerts.map((a, i) => (
                <li key={`${a.dedupeKey}:${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5 text-xs">
                  <span className="min-w-0 break-words text-[var(--text-secondary)]"><ToneBadge word={a.severity} tone={severityTone(a.severity)} /> {a.summary}</span>
                  <span className="min-w-0 break-words text-[11px] tabular-nums text-[var(--text-muted)]">{deliveryText(a, formatUtc)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">{PAST_DELIVERIES_NOTE}</p>
        </div>
      </div>
    </SectionSurface>
  );
}

export function OpsAiBudgetWidget({ section }: { section: PlatformSection }) {
  // ONE literal url (the static-url contract, widget-fetch-static-url.test.ts): AI_BUDGET_URL in the types file spells the same path.
  const { data, loading, error } = useWidgetFetch<AiBudgetUtilization>("/api/platform/platform-ops/ai-budget");
  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={Gauge}>
        <WidgetMessage loading={loading} error={error ?? (loading ? null : `${AI_BUDGET_SUBJECT} unavailable`)} />
      </PlatformWidgetCard>
    );
  }
  return <AiBudgetSurface section={section} data={data} />;
}
