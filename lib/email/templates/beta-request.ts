/**
 * lib/email/templates/beta-request.ts  (PO-3B → email design system, internal variant)
 *
 * The beta-request INTAKE notification — sent to the configured operator/support
 * destination (env.BETA_REQUESTS_EMAIL) when someone requests beta access, so an
 * operator learns of the request without polling the queue. Operator-facing, so
 * it sends as the `platform-ops` identity (support@ — the operational catch-all),
 * exactly like platform-alert.
 *
 * Carries only the applicant's email + optional note (the same minimal PII the
 * operator queue already shows) — never any customer financial content. Both
 * are applicant-controlled: the design system escapes them in HTML, and
 * cleanText() keeps the note from forging extra lines in the text part. The
 * applicant NEVER receives this; the approval invite (beta-invite) is the only
 * applicant-facing beta email.
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import { cleanText } from "@/lib/email/design/escape";

export interface BetaRequestEmailData {
  /** The applicant's email address. */
  applicantEmail: string;
  /** The applicant's optional "why" note, if the intake form captured one. */
  note?: string | null;
  /** Absolute URL to the Growth & Revenue queue (from the trusted env base). */
  queueUrl: string;
  /** Preview tool only: prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

/** The intake route caps a note at 1,000 characters (access-request NOTE_MAX). */
const NOTE_MAX = 1000;

export function renderBetaRequest(data: BetaRequestEmailData, opts: { brand?: EmailBrandConfig } = {}): RenderedEmail {
  const email = cleanText(String(data.applicantEmail ?? ""), 320);
  const note = data.note ? cleanText(data.note, NOTE_MAX) : "";
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}New beta access request: ${email}`,
    preheader: "A new beta access request was submitted.",
    blocks: [
      { kind: "hero", heading: "New beta access request" },
      { kind: "paragraph", text: "A new beta access request was submitted." },
      { kind: "info", items: [`Email: ${email}`, ...(note ? [`Note: ${note}`] : [])] },
      { kind: "paragraph", text: "Review and approve or deny it in Growth → Beta Access." },
      { kind: "cta", label: "Open Beta Access queue", url: data.queueUrl },
    ],
    footer: { reason: "Internal Fourth Meridian operations email, sent to the configured beta-requests inbox." },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const betaRequestTemplate: EmailTemplate<BetaRequestEmailData> = {
  name: "beta-request",
  sender: "platform-ops",
  render(data: BetaRequestEmailData) {
    return renderBetaRequest(data);
  },
};
