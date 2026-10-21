"use client";

/**
 * components/platform/widgets/OpsAlertsWidget.tsx  (OPS-5 S5 · ops_alerts · UX-P1 grain)
 *
 * Alert rules + history, over GET /api/platform/platform-ops/alerts
 * (requirePlatformAccess PLATFORM_OPS READ). One row per rule with its
 * Enabled / Disabled state, last trigger and severity; dormant rules (awaiting a
 * not-yet-shipped authority) are labelled as such. A short recent firing
 * history follows. No PII: rule ids / states / times only.
 *
 * OBS-003 — THE LATEST EVALUATION'S DELIVERY OUTCOME IS RENDERED. "Recent fires"
 * is a delivery HISTORY; it cannot show a breach that never went anywhere. So
 * the surface now leads with the newest run's `deliveryStatus` and, when
 * breaches were due but undelivered (no RESEND_API_KEY ⇒ captured in memory;
 * no destination; a provider error; the OBS-015 circuit breaker), says so in
 * one loud sentence instead of a quiet "0 fires". The sentence comes from
 * lib/alerts/latest-evaluation.ts (pure) so every surface words it identically.
 *
 * UI-011 — the rules ARE partly editable now: the two `ai-spend-*` rules'
 * enable state and thresholds are set in the AI Cost Controls panel on this
 * same workspace (CONTROL). The footnote says exactly that instead of the
 * retired "no write lever yet".
 *
 * `AlertsSurface` is prop-driven so every state is renderable in a test; the
 * widget fetches.
 */

import { BellRing } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, timeAgo, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { BigStat, GroupLabel, SectionSurface, ToneBadge, type StatusTone } from "../platform-surface";
import type { PlatformAlertsResponse } from "@/app/api/platform/platform-ops/alerts/route";
import { undeliveredSentence, type AlertLatestEvaluation } from "@/lib/alerts/latest-evaluation";

export const ALERT_RULES_TITLE = "Alert rules";

export const ALERTS_FOOTNOTE =
  "Rules are code-owned. The two AI spend rules (enabled state and thresholds) are edited in the AI Cost Controls panel on this workspace; every other rule has no write lever. " +
  "\"Dormant\" means the rule awaits an authority that has not shipped. History is the last fires the evaluator delivered — a past fire is never shown as open, and a breach that was never delivered never appears there: read the delivery line.";

function ruleState(r: PlatformAlertsResponse["rules"][number]): { word: string; tone: StatusTone } {
  if (!r.live) return { word: "Awaiting authority", tone: "muted" };
  return r.enabled ? { word: "Enabled", tone: "ok" } : { word: "Disabled", tone: "muted" };
}

/** OBS-003 — the newest evaluation's delivery outcome as a word + tone. Pure. */
export function deliveryWord(latest: AlertLatestEvaluation | null): { word: string; tone: StatusTone; detail: string } {
  if (!latest) return { word: "Never evaluated", tone: "muted", detail: "No evaluate-alerts run has been recorded." };
  if (latest.undelivered) return { word: "Undelivered", tone: "bad", detail: undeliveredSentence(latest.undelivered) };
  switch (latest.deliveryStatus) {
    case "none":     return { word: "Nothing to send", tone: "ok", detail: `No breach was due for delivery in the latest evaluation (${latest.counts.firing} firing, ${latest.counts.suppressed} suppressed within the re-notify window).` };
    case "sent":     return { word: "Accepted by provider", tone: "ok", detail: `${latest.counts.delivered} breach${latest.counts.delivered === 1 ? "" : "es"} handed to the email provider, which accepted the message. Delivery to the mailbox is not observed by this product.` };
    case "captured": return { word: "Captured (dev)", tone: "warn", detail: `${latest.counts.delivered} breach${latest.counts.delivered === 1 ? "" : "es"} recorded by the in-memory capture transport — expected only in development or test.` };
    case "skipped":  return { word: "Skipped", tone: "bad", detail: "Breaches were due but nothing was sent." };
    case "error":    return { word: "Delivery error", tone: "bad", detail: "The email provider returned an error; the next evaluation retries." };
  }
}

export function AlertsSurface({ data }: { data: PlatformAlertsResponse }) {
  const recent = data.history.slice(0, 5);
  const delivery = deliveryWord(data.latest);
  return (
    <SectionSurface icon={BellRing} title={ALERT_RULES_TITLE} count={data.rules.length} footnote={ALERTS_FOOTNOTE}>
      <div className="mb-8 grid gap-6 sm:grid-cols-3">
        <BigStat label="Enabled" value={data.rules.filter((r) => r.enabled).length} qualifier={`of ${data.rules.length} rules`} />
        <BigStat label="Dormant" value={data.rules.filter((r) => !r.live).length} qualifier="awaiting an authority" />
        <BigStat label="Recent fires" value={data.history.length} qualifier={data.lastEvaluatedAt ? `last evaluated ${timeAgo(data.lastEvaluatedAt)} ago` : "never evaluated"} />
      </div>

      <div className="mb-8 flex flex-col gap-2" data-testid="alert-delivery">
        <GroupLabel hint="The newest evaluate-alerts run's delivery outcome. 'Accepted by provider' means the email API took the message; nothing here can see the mailbox.">Latest delivery</GroupLabel>
        <p className="flex flex-wrap items-baseline gap-2 text-xs" role={delivery.tone === "bad" ? "alert" : undefined}>
          <ToneBadge word={delivery.word} tone={delivery.tone} />
          <span className="text-[var(--text-secondary)]">{delivery.detail}</span>
        </p>
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
          <p className="text-[11px] text-[var(--text-muted)]">Destination: {data.destinationConfigured ? "configured" : "not configured — deliveries have nowhere to go"}</p>
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
                    <ToneBadge word={h.severity} tone={h.severity === "critical" ? "bad" : "warn"} />{" "}
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

export function OpsAlertsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformAlertsResponse>("/api/platform/platform-ops/alerts");
  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={BellRing}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }
  return <AlertsSurface data={data} />;
}
