/**
 * lib/email/index.ts  (OPS-1 S1)
 *
 * Public surface of the email seam. Callers import from here; they never reach
 * into providers/* or templates/* directly.
 *
 * OPS-1 ships this with ZERO production callers — the substrate is
 * behavior-neutral until a later slice wires a real flow to sendEmail().
 */

export { sendEmail } from "@/lib/email/send";
export type {
  EmailMessage,
  EmailResult,
  EmailProvider,
  EmailTemplateName,
} from "@/lib/email/types";
