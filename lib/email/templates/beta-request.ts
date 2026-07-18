/**
 * lib/email/templates/beta-request.ts  (PO-3B)
 *
 * The beta-request INTAKE notification — sent to the configured operator/support
 * destination (env.BETA_REQUESTS_EMAIL) when someone requests beta access, so an
 * operator learns of the request without polling the queue. Operator-facing, so
 * it sends as the `platform-ops` identity (support@ — the operational catch-all),
 * exactly like platform-alert.
 *
 * PURE: subject + text from pre-resolved strings. Carries only the applicant's
 * email + optional note (the same minimal PII the operator queue already shows)
 * — never any customer financial content. The applicant NEVER receives this; the
 * approval invite (beta-invite) is the only applicant-facing beta email.
 */

import type { EmailTemplate } from "@/lib/email/types";

export interface BetaRequestEmailData {
  /** The applicant's email address. */
  applicantEmail: string;
  /** The applicant's optional "why" note, if the intake form captured one. */
  note?: string | null;
  /** Absolute URL to the Growth & Revenue queue (from the trusted env base). */
  queueUrl: string;
}

export const betaRequestTemplate: EmailTemplate<BetaRequestEmailData> = {
  name: "beta-request",
  sender: "platform-ops",
  render(data: BetaRequestEmailData) {
    return {
      subject: `New beta access request: ${data.applicantEmail}`,
      text:
        `A new beta access request was submitted.\n\n` +
        `Email: ${data.applicantEmail}\n` +
        (data.note ? `Note:  ${data.note}\n` : "") +
        `\nReview and approve or deny it in Growth & Revenue → Beta Access:\n${data.queueUrl}\n`,
    };
  },
};
