/**
 * lib/ai/privacy/scrub.ts  (SEC-AI-005 — one scrub for every descriptor that leaves the server)
 *
 * A RAW TRANSACTION DESCRIPTOR IS NOT A MERCHANT NAME. The provider string a
 * bank files a row under ("CHECK 1052", "AMZN Mktp US*2K4Q1 #1234567",
 * "VISA DDA PUR 4111111111111111") carries cheque numbers, reference ids and
 * partial card or account numbers. The Daily Brief has scrubbed those before
 * sending a row to the model since it shipped (lib/ai/brief/recent-activity.ts
 * `safeMerchant`); the Conversations tools sent the raw string. This is that
 * same rule, extracted so both paths — and every tool row that carries a
 * merchant, descriptor or name derived from one — use ONE function.
 *
 * THE RULE, UNCHANGED FROM THE BRIEF'S:
 *   · runs of FOUR OR MORE digits are removed (a 16-digit card number, a
 *     4–7 digit cheque or reference number, a store number); shorter runs
 *     stay ("7-Eleven", "3M", "Terminal 2");
 *   · `#` and `*` runs become a space (they introduce reference ids);
 *   · whitespace is collapsed; the result is clipped to MAX_SCRUBBED_CHARS;
 *   · a string that is nothing but digits and symbols yields `undefined` —
 *     the caller omits the field or uses UNNAMED_DESCRIPTOR, never sends "".
 *
 * PURE. No I/O, no server-only, importable from a test or a client.
 */

export const MAX_SCRUBBED_CHARS = 40;
/** What a tool says when a descriptor scrubbed to nothing but the field is required. */
export const UNNAMED_DESCRIPTOR = 'unnamed';

/** A merchant / descriptor string fit to leave the server, or undefined. */
export function scrubDescriptor(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\d{4,}/g, '').replace(/[#*]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_SCRUBBED_CHARS ? `${cleaned.slice(0, MAX_SCRUBBED_CHARS - 1)}…` : cleaned;
}

/** The same scrub where the field is a required string: the placeholder stands in for nothing. */
export function scrubDescriptorText(value: string | null | undefined): string {
  return scrubDescriptor(value) ?? UNNAMED_DESCRIPTOR;
}
