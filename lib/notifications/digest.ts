/**
 * lib/notifications/digest.ts  (Comms Center — DIGEST_SENT: BUILT, SHIPPED OFF)
 *
 * The digest PRODUCER, built so the catalog entry, template and preview are
 * real — and DISABLED. Two independent locks keep it from ever sending:
 *
 *   1. DIGEST_ENABLED is a code constant, false. sendDigest() returns
 *      "disabled" before it reads anything or calls the email chokepoint.
 *      Turning it on is a reviewed code change, not a setting.
 *   2. Nothing schedules it: no job (lib/jobs/registry.core.ts), cron
 *      (vercel.json) or route imports this module. digest.test.ts pins both.
 *
 * Frequency, content and the opt-in default await the owner's digest proposal
 * (O-14). Until then this is infrastructure only. When it is enabled, the
 * email goes through sendEmail under catalog key DIGEST_SENT (consent
 * AWARENESS: storm-limited) and folds only `digestable` registry types.
 */

import "server-only";
import { sendEmail as chokepointSendEmail, type SendEmailFn } from "@/lib/email/send";
import { buildAppLink, APP_PATHS } from "@/lib/email/app-link";

/** OFF. The digest sends nothing until the owner approves a digest proposal (O-14). */
export const DIGEST_ENABLED = false as boolean;

export interface DigestInput {
  userId: string;
  email: string;
  periodLabel: string;
  /** Rendered titles of the folded (digestable) notifications. */
  items: string[];
}

export type DigestOutcome = "disabled" | "empty" | "sent" | "not_sent" | "error";

/** Send one user's digest — refused while DIGEST_ENABLED is false. Never throws. */
export async function sendDigest(input: DigestInput, opts: { appUrl?: string; send?: SendEmailFn } = {}): Promise<DigestOutcome> {
  // THE gate. No parameter, setting or env var can bypass it.
  if (!DIGEST_ENABLED) return "disabled";
  // Named `sendEmail` on purpose: the catalog tests grep every sendEmail("…") site and its ledger key.
  const sendEmail = opts.send ?? chokepointSendEmail;
  if (input.items.length === 0) return "empty";
  try {
    const base = opts.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
    const result = await sendEmail("digest", input.email, {
      periodLabel: input.periodLabel,
      items: input.items,
      dashboardUrl: buildAppLink(base, "/dashboard"),
      preferencesUrl: buildAppLink(base, APP_PATHS.notificationSettings),
    }, { key: "DIGEST_SENT", recipientUserId: input.userId });
    if (result.status === "error") return "error";
    return result.status === "sent" || result.status === "captured" ? "sent" : "not_sent";
  } catch {
    return "error";
  }
}
