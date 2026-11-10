/**
 * lib/platform/intelligence/ai/authz/subject-notice.ts  (Platform AI P5 — the customer-lookup notice, S2 09dp)
 *
 * S2 ruling 09dp (2026-11-10): there is NO name lookup or search anywhere, and NO heuristic name
 * scrub — a customer name an operator types in free text cannot be detected reliably, and a scrub
 * would give false confidence. Customers are looked up by EXACT identifier only (authz/subject.ts:
 * full email, `user #` reference, user ID — uniform response, timing floor, rate limit). The
 * residual risk (an operator typing a customer's name into a question) is covered by THIS notice
 * in the Platform AI composer and empty state wherever the customers pack is offered, and by the
 * owner privacy decision OI-1 (D-11) before any Production activation.
 *
 * The text is defined here, once, and pinned by components/platform/platform-ai-conversations.test.ts.
 * Pure and import-free (client-safe).
 */

export const PLATFORM_AI_SUBJECT_NOTICE = "Look customers up by their ID or email. Don't type customer names.";

/**
 * Show the notice when the customers pack is ON (the page reads the strict server flag) and the
 * operator holds Customer Success — the area whose questions the pack answers.
 */
export function showsSubjectNotice(input: { customersPackOn: boolean; areas: readonly string[] }): boolean {
  return input.customersPackOn === true && input.areas.includes("CUSTOMER_SUCCESS");
}
