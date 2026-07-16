/**
 * lib/email/templates/platform-alert.ts  (OPS-5 S5)
 *
 * The Platform Operations alert email — the destination for OPS-5 S5 alerting.
 * Text-first, sends as the `platform-ops` identity (support@fourthmeridian.com,
 * the operational catch-all — see lib/email/senders.ts). Distinct from the
 * security-alert template (which is account-holder-facing and security-framed);
 * this one addresses the OPERATOR and lists platform breaches.
 *
 * PURE: renders subject + text from pre-resolved strings (the AlertEmailData
 * built by lib/alerts/evaluate.ts). No env, no DB. Carries only system-generated
 * summaries (counts/states/job & resource names) — never user content.
 */

import type { EmailTemplate } from "@/lib/email/types";
import type { AlertEmailData } from "@/lib/alerts/evaluate";

export const platformAlertTemplate: EmailTemplate<AlertEmailData> = {
  name: "platform-alert",
  sender: "platform-ops",
  render(data: AlertEmailData) {
    const n = data.alerts.length;
    const criticals = data.alerts.filter((a) => a.severity === "critical").length;
    const lead = criticals > 0 ? `${criticals} critical` : "degraded";

    const lines = data.alerts.map((a) => `  • [${a.severity.toUpperCase()}] ${a.summary}`);

    return {
      subject: `Fourth Meridian platform alert: ${n} issue(s) (${lead})`,
      text:
        `Platform Operations detected ${n} issue(s) at ${data.evaluatedAtISO}:\n\n` +
        `${lines.join("\n")}\n\n` +
        `Open Platform Operations → Alerts for the full state and history. ` +
        `This alert repeats at most once per re-notify window while the condition persists.\n`,
    };
  },
};
