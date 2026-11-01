/**
 * lib/email/templates/security-alert.ts  (OPS-2 S2 → email design system)
 *
 * Generic security-alert email. Sends as the `security-alert` identity
 * (support@fourthmeridian.com — see lib/email/senders.ts).
 *
 * Deliberately GENERIC ({ title, message, … }) so every account-security event
 * reuses this one template. The per-event copy lives in ONE place —
 * lib/email/security-alerts.ts — which every call site and the preview tool
 * use, so a preview is the real email.
 *
 * Two audiences:
 *   "account"  (default) — the account holder. Design-system SECURITY variant:
 *              heading, the factual notice, a restrained guidance panel, and at
 *              most one action. No promotional blocks; never claims an incident.
 *   "internal" — the Security Operations inbox. The minimal internal variant of
 *              the same design: heading + facts, no account-holder guidance.
 *
 * PURE: renders from pre-resolved strings. No env, no DB.
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBlock } from "@/lib/email/design/blocks";
import type { EmailBrandConfig } from "@/lib/email/design/config";

/** The guidance every account alert carried before the design system (kept verbatim as the default). */
export const DEFAULT_SECURITY_GUIDANCE =
  "If this was you, no action is needed. If you don't recognize this activity, reset your password " +
  "immediately and review your active sessions in Settings.";

/** Data the security-alert template renders from. */
export interface SecurityAlertData {
  /** Short headline, also used in the subject (e.g. "Your password was changed"). */
  title: string;
  /** What happened and when. Blank lines separate paragraphs. */
  message: string;
  /** Replaces DEFAULT_SECURITY_GUIDANCE when the event needs different advice. */
  guidance?: string;
  /** Optional single action (absolute http(s) URL from the trusted app base). */
  action?: { label: string; url: string };
  /** Default "account". */
  audience?: "account" | "internal";
  /** Preview tool only: prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

export const SECURITY_ALERT_SUBJECT_PREFIX = "Fourth Meridian security alert: ";

function paragraphs(message: string): EmailBlock[] {
  return message
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((text) => ({ kind: "paragraph" as const, text }));
}

function preheaderOf(message: string): string {
  const first = message.split(/\n\s*\n/)[0]?.trim() ?? "";
  return first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first;
}

export function renderSecurityAlert(
  data: SecurityAlertData,
  opts: { brand?: EmailBrandConfig } = {},
): RenderedEmail {
  const subject = `${data.preview === true ? "[PREVIEW] " : ""}${SECURITY_ALERT_SUBJECT_PREFIX}${data.title}`;
  const brand = opts.brand ? { brand: opts.brand } : {};
  const action: EmailBlock[] = data.action ? [{ kind: "cta", label: data.action.label, url: data.action.url }] : [];

  if (data.audience === "internal") {
    return renderEmail({
      subject,
      preheader: preheaderOf(data.message),
      blocks: [{ kind: "hero", heading: data.title }, ...paragraphs(data.message), ...action],
      footer: { reason: "Internal Fourth Meridian security operations email, sent to the configured Security Operations inbox." },
      ...brand,
    });
  }

  return renderEmail({
    subject,
    preheader: preheaderOf(data.message),
    variant: "security",
    blocks: [
      { kind: "hero", heading: data.title },
      ...paragraphs(data.message),
      { kind: "security", text: data.guidance ?? DEFAULT_SECURITY_GUIDANCE },
      ...action,
    ],
    footer: { reason: "You're receiving this security notice because it concerns your Fourth Meridian account." },
    ...brand,
  });
}

export const securityAlertTemplate: EmailTemplate<SecurityAlertData> = {
  name: "security-alert",
  sender: "security-alert",
  render(data: SecurityAlertData) {
    return renderSecurityAlert(data);
  },
};
