/**
 * components/platform/leads/cs-open-customer.ts  (PB-7 — "Recently joined" → the audited profile)
 *
 * The Customer Success dashboard's "Recently joined" rows open a customer's
 * profile in the hosted Customers list (cs_customers). The list is hosted
 * through the section registry, not imported, so the panel cannot set its
 * state directly: it announces the customer on `window` (the same hand-off
 * PB-4's cs-attention-link.ts uses for a filter), and the list opens the
 * profile through its own AUDITED detail route (customers/[userId] records
 * CUSTOMER_PROFILE_VIEWED before returning it).
 *
 * The id came from a CUSTOMER_SUCCESS READ route in the same page; the event
 * carries nothing else.
 */

export const CS_OPEN_CUSTOMER_EVENT = "fm:cs-open-customer";

/** Ask the hosted Customers list to open this customer's (audited) profile. */
export function requestOpenCustomer(userId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(CS_OPEN_CUSTOMER_EVENT, { detail: userId }));
}

/** The customer id a received event carries, or null when it is not one. */
export function openCustomerIdOf(e: Event): string | null {
  const d = (e as CustomEvent<unknown>).detail;
  return typeof d === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(d) ? d : null;
}
