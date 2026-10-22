/**
 * components/marketing/access-request-consent.ts — PRIV-012: the privacy notice
 * a beta-access applicant is shown, and the consent contract the server checks.
 *
 * Pure constants, inside the marketing seam (lib/marketing-boundary.test.ts) so
 * the RequestAccessForm island can import them; app/api/access-request/route.ts
 * imports the same module, so the form and the server cannot disagree about
 * what was consented to.
 */

/** Bump whenever ACCESS_REQUEST_NOTICE changes; recorded on the audit row. */
export const ACCESS_REQUEST_NOTICE_VERSION = "2026-10-22";

/** The notice shown above the consent checkbox. Plain, factual, no promises the code does not keep. */
export const ACCESS_REQUEST_NOTICE =
  "We use your email address to review your request and, if it is approved, to send your invitation. " +
  "Anything you write in the note is read by the Fourth Meridian team. " +
  "We do not sell this information or use it for marketing.";

/** The consent checkbox label. */
export const ACCESS_REQUEST_CONSENT_LABEL =
  "I have read the privacy notice above and the Privacy Policy, and I agree to Fourth Meridian processing my request.";

/** The server's refusal when consent is absent. */
export const CONSENT_REQUIRED_ERROR = "Please confirm you have read the privacy notice.";
