/**
 * lib/email/providers/capture.ts  (OPS-1 S1)
 *
 * The dev/test email transport. Records messages to an in-memory buffer instead
 * of sending them, so local development and CI need NO email credentials — the
 * same philosophy as the in-memory rate-limit backend (lib/rate-limit.ts).
 *
 * This is the default transport whenever RESEND_API_KEY is absent, and the
 * MANDATORY transport in test mode (send.ts refuses a real send under test).
 *
 * Implements EmailProvider. NON-THROWING. Imports no SDK.
 */

import type { EmailMessage, EmailProvider, EmailResult } from "@/lib/email/types";

const PROVIDER_NAME = "capture";

/** In-memory record of every captured message (most-recent last). */
const _captured: EmailMessage[] = [];

export const captureAdapter: EmailProvider = {
  name: PROVIDER_NAME,

  async send(message: EmailMessage): Promise<EmailResult> {
    _captured.push(message);
    return { status: "captured", provider: PROVIDER_NAME };
  },
};

/** All messages captured so far (read-only snapshot). Test/dev use only. */
export function capturedEmails(): readonly EmailMessage[] {
  return _captured;
}

/** The most recently captured message, or undefined. Test/dev use only. */
export function lastCapturedEmail(): EmailMessage | undefined {
  return _captured[_captured.length - 1];
}

/** Clear the capture buffer. Test/dev use only. */
export function clearCapturedEmails(): void {
  _captured.length = 0;
}
