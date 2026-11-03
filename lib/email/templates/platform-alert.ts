/**
 * lib/email/templates/platform-alert.ts  (OPS-5 S5 → email design system, internal variant)
 *
 * The Platform Operations alert email — the destination for OPS-5 S5 alerting.
 * Sends as the `platform-ops` identity (support@fourthmeridian.com, the
 * operational catch-all — see lib/email/senders.ts). Distinct from the
 * security-alert template (account-holder-facing); this one addresses the
 * OPERATOR and lists platform breaches.
 *
 * PURE: renders from pre-resolved strings (the AlertEmailData built by
 * lib/alerts/evaluate.ts). No env, no DB. Carries only system-generated
 * summaries (counts/states/job & resource names) — never user content. No link:
 * the alert never carried one (the copy names the Platform Operations → Alerts
 * surface instead).
 */

import type { EmailTemplate } from "@/lib/email/types";
import type { AlertEmailData } from "@/lib/alerts/evaluate";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import { formatUtcDateTimeLabelled } from "@/lib/email/design/datetime";

/** "Saturday, … UTC" for a valid ISO instant; the raw string otherwise (never throw on a label). */
function evaluatedLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? formatUtcDateTimeLabelled(d) : iso;
}

export function renderPlatformAlert(
  data: AlertEmailData & { preview?: boolean },
  opts: { brand?: EmailBrandConfig } = {},
): RenderedEmail {
  // ALERT RECOVERY — the "resolved" variant: one recovered breach per email.
  if (data.resolved) return renderResolved(data as AlertEmailData & { preview?: boolean; resolved: NonNullable<AlertEmailData["resolved"]> }, opts);
  // FLAP PROTECTION — the "flapping" variant: one email when an alert starts flapping.
  if (data.flapping) return renderFlapping(data as AlertEmailData & { preview?: boolean; flapping: NonNullable<AlertEmailData["flapping"]> }, opts);
  const n = data.alerts.length;
  const criticals = data.alerts.filter((a) => a.severity === "critical").length;
  const lead = criticals > 0 ? `${criticals} critical` : "degraded";
  const when = evaluatedLabel(data.evaluatedAtISO);
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}Fourth Meridian platform alert: ${n} issue(s) (${lead})`,
    preheader: `Platform Operations detected ${n} issue(s).`,
    blocks: [
      { kind: "hero", heading: `Platform alert: ${n} issue(s)` },
      { kind: "paragraph", text: `Platform Operations detected ${n} issue(s) at ${when}:` },
      { kind: "info", items: data.alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.summary}`) },
      {
        kind: "paragraph",
        text:
          "Open Platform Operations → Alerts for the full state and history. " +
          "This alert repeats at most once per re-notify window while the condition persists.",
      },
    ],
    footer: { reason: "Internal Fourth Meridian operations email, sent to the configured platform-alerts inbox." },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

/**
 * The resolved variant: names the rule, when the breach first fired, when it
 * cleared and how long it lasted. Same sender, same footer, same surface
 * pointer; no link, system-generated strings only.
 */
function renderResolved(
  data: AlertEmailData & { preview?: boolean; resolved: NonNullable<AlertEmailData["resolved"]> },
  opts: { brand?: EmailBrandConfig },
): RenderedEmail {
  const r = data.resolved;
  const stable = r.variant === "stable";
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}Fourth Meridian platform alert ${stable ? "stable again" : "resolved"}: ${r.ruleTitle}`,
    preheader: stable ? `${r.ruleTitle} has stopped flapping.` : `${r.ruleTitle} has cleared after ${r.durationLabel}.`,
    blocks: [
      { kind: "hero", heading: `${stable ? "Stable again" : "Resolved"}: ${r.ruleTitle}` },
      {
        kind: "paragraph",
        text: stable
          ? `This alert was flapping; it has now stayed clear for consecutive evaluations and its notifications resume (${r.dedupeKey}).`
          : `Platform Operations no longer detects this issue (${r.dedupeKey}).`,
      },
      {
        kind: "info",
        items: [
          `Rule: ${r.ruleTitle} (${r.ruleId})`,
          `${stable ? "Flapping since" : "First fired"}: ${evaluatedLabel(r.firstFiredAtISO)}`,
          `Cleared: ${evaluatedLabel(r.clearedAtISO)}`,
          `Duration: ${r.durationLabel}`,
        ],
      },
      {
        kind: "paragraph",
        text:
          "Open Platform Operations → Alerts for the full state and history. " +
          "A recovery is sent once, after the issue has been absent for consecutive evaluations; it must fire again before another is sent.",
      },
    ],
    footer: { reason: "Internal Fourth Meridian operations email, sent to the configured platform-alerts inbox." },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

/** The flapping variant: the alert keeps firing and clearing; its emails are paused until it is stable. */
function renderFlapping(
  data: AlertEmailData & { preview?: boolean; flapping: NonNullable<AlertEmailData["flapping"]> },
  opts: { brand?: EmailBrandConfig },
): RenderedEmail {
  const f = data.flapping;
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}Fourth Meridian platform alert flapping: ${f.ruleTitle}`,
    preheader: `${f.ruleTitle} keeps firing and clearing; its emails are paused until it is stable.`,
    blocks: [
      { kind: "hero", heading: `Flapping: ${f.ruleTitle}` },
      { kind: "paragraph", text: `This alert has fired and cleared ${f.recoveries} times in ${f.windowHours} hours (${f.dedupeKey}).` },
      {
        kind: "info",
        items: [
          `Rule: ${f.ruleTitle} (${f.ruleId})`,
          `Detected: ${evaluatedLabel(data.evaluatedAtISO)}`,
          `Further firing and recovery emails for it are paused until it stays clear for ${f.stableAfterEvaluations} consecutive evaluations; one "stable again" email follows.`,
        ],
      },
      { kind: "paragraph", text: "Open Platform Operations → Alerts for the live state; the rule keeps being evaluated while its emails are paused." },
    ],
    footer: { reason: "Internal Fourth Meridian operations email, sent to the configured platform-alerts inbox." },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const platformAlertTemplate: EmailTemplate<AlertEmailData> = {
  name: "platform-alert",
  sender: "platform-ops",
  render(data: AlertEmailData) {
    return renderPlatformAlert(data);
  },
};
