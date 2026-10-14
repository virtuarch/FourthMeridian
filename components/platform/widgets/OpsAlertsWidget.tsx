"use client";

/**
 * components/platform/widgets/OpsAlertsWidget.tsx  (OPS-5 S5 · ops_alerts · UX-P1 grain)
 *
 * Alert rules + history, over GET /api/platform/platform-ops/alerts
 * (requirePlatformAccess PLATFORM_OPS READ). One row per rule with its
 * Enabled / Disabled state, last trigger and severity; dormant rules (awaiting a
 * not-yet-shipped authority) are labelled as such. A short recent firing
 * history follows. READ-ONLY — there is no write lever for alert rules yet, and
 * this surface says so in its title ("Alert rules (read-only)") because it is
 * composed beside the Policies editor, where a reader would otherwise expect to
 * be able to change it. No PII: rule ids / states / times only.
 *
 * The section's DB label is coordinator business (lib/platform/policy.ts); the
 * surface title here is the one the operator reads.
 */

import { BellRing } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, timeAgo, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { BigStat, GroupLabel, SectionSurface, ToneBadge, type StatusTone } from "../platform-surface";
import type { PlatformAlertsResponse } from "@/app/api/platform/platform-ops/alerts/route";

export const ALERT_RULES_TITLE = "Alert rules (read-only)";

const FOOTNOTE =
  "Rules are code-owned; enabling or disabling one has no write lever on this surface yet. " +
  "\"Dormant\" means the rule awaits an authority that has not shipped. History is the last fires the evaluator delivered — a past fire is never shown as open.";

function ruleState(r: PlatformAlertsResponse["rules"][number]): { word: string; tone: StatusTone } {
  if (!r.live) return { word: "Awaiting authority", tone: "muted" };
  return r.enabled ? { word: "Enabled", tone: "ok" } : { word: "Disabled", tone: "muted" };
}

export function OpsAlertsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformAlertsResponse>("/api/platform/platform-ops/alerts");
  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={BellRing}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }
  const recent = data.history.slice(0, 5);
  return (
    <SectionSurface icon={BellRing} title={ALERT_RULES_TITLE} count={data.rules.length} footnote={FOOTNOTE}>
      <div className="mb-8 grid gap-6 sm:grid-cols-3">
        <BigStat label="Enabled" value={data.rules.filter((r) => r.enabled).length} qualifier={`of ${data.rules.length} rules`} />
        <BigStat label="Dormant" value={data.rules.filter((r) => !r.live).length} qualifier="awaiting an authority" />
        <BigStat label="Recent fires" value={data.history.length} qualifier={data.lastEvaluatedAt ? `last evaluated ${timeAgo(data.lastEvaluatedAt)} ago` : "never evaluated"} />
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <GroupLabel hint="Each rule's state comes from the alert settings and its registry definition; the time is its last recorded fire.">Rules</GroupLabel>
          <ul className="divide-y divide-[var(--border-hairline)]">
            {data.rules.map((r) => {
              const s = ruleState(r);
              return (
                <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5 text-xs">
                  <span className="min-w-0 text-[var(--text-primary)]">{r.title}</span>
                  <span className="flex items-center gap-2">
                    <ToneBadge word={s.word} tone={s.tone} />
                    <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{r.lastTriggeredAtISO ? `${timeAgo(r.lastTriggeredAtISO)} ago` : "never fired"}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-[var(--text-muted)]">Destination: {data.destinationConfigured ? "configured" : "not configured"}</p>
        </div>

        <div className="flex flex-col gap-2">
          <GroupLabel hint="The last five deliveries the evaluator recorded. A fire is history, not an open incident.">Recent fires</GroupLabel>
          {recent.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)]" role="status">No fires recorded in the retained evaluation runs.</p>
          ) : (
            <ul className="divide-y divide-[var(--border-hairline)]">
              {recent.map((h, i) => (
                <li key={`${h.dedupeKey}:${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5 text-xs">
                  <span className="min-w-0 text-[var(--text-secondary)]">
                    <ToneBadge word={h.severity} tone={h.severity === "critical" ? "bad" : h.severity === "error" ? "bad" : h.severity === "warning" ? "warn" : "info"} />{" "}
                    {h.summary}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{timeAgo(h.deliveredAtISO)} ago</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SectionSurface>
  );
}
