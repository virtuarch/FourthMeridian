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
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}Fourth Meridian platform alert resolved: ${r.ruleTitle}`,
    preheader: `${r.ruleTitle} has cleared after ${r.durationLabel}.`,
    blocks: [
      { kind: "hero", heading: `Resolved: ${r.ruleTitle}` },
      { kind: "paragraph", text: `Platform Operations no longer detects this issue (${r.dedupeKey}).` },
      {
        kind: "info",
        items: [
          `Rule: ${r.ruleTitle} (${r.ruleId})`,
          `First fired: ${evaluatedLabel(r.firstFiredAtISO)}`,
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

export const platformAlertTemplate: EmailTemplate<AlertEmailData> = {
  name: "platform-alert",
  sender: "platform-ops",
  render(data: AlertEmailData) {
    return renderPlatformAlert(data);
  },
};
