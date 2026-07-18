/**
 * lib/email/templates/index.ts  (OPS-1 S1)
 *
 * The typed template registry. Maps each EmailTemplateName to its template
 * object. Grows one entry per real template as later slices land; OPS-1 S1
 * ships exactly one: the generic smoke template.
 *
 * Pure config — no I/O, no SDK. lib/email/send.ts is the only reader.
 */

import type { EmailTemplate, EmailTemplateName } from "@/lib/email/types";
import { smokeTemplate } from "@/lib/email/templates/smoke";
import { passwordResetTemplate } from "@/lib/email/templates/password-reset";
import { emailVerificationTemplate } from "@/lib/email/templates/email-verification";
import { spaceInviteTemplate } from "@/lib/email/templates/space-invite";
import { securityAlertTemplate } from "@/lib/email/templates/security-alert";
import { emailChangeTemplate } from "@/lib/email/templates/email-change";
import { notificationTemplate } from "@/lib/email/templates/notification";
import { betaInviteTemplate } from "@/lib/email/templates/beta-invite";
import { betaRequestTemplate } from "@/lib/email/templates/beta-request";
import { platformAlertTemplate } from "@/lib/email/templates/platform-alert";

/**
 * name -> template. Typed so `send.ts` can look up a template by name and get a
 * compile-time-checked entry. `unknown` data param: each template narrows its
 * own data shape internally; the chokepoint passes the caller's data through.
 */
export const EMAIL_TEMPLATES: Record<EmailTemplateName, EmailTemplate<never>> = {
  smoke:                smokeTemplate as EmailTemplate<never>,
  "password-reset":     passwordResetTemplate as EmailTemplate<never>,
  "email-verification": emailVerificationTemplate as EmailTemplate<never>,
  "space-invite":       spaceInviteTemplate as EmailTemplate<never>,
  "security-alert":     securityAlertTemplate as EmailTemplate<never>,
  "email-change":       emailChangeTemplate as EmailTemplate<never>,
  "notification":       notificationTemplate as EmailTemplate<never>,
  "beta-invite":        betaInviteTemplate as EmailTemplate<never>,
  "beta-request":       betaRequestTemplate as EmailTemplate<never>,
  "platform-alert":     platformAlertTemplate as EmailTemplate<never>,
};

export function getTemplate(name: EmailTemplateName): EmailTemplate<never> {
  return EMAIL_TEMPLATES[name];
}
