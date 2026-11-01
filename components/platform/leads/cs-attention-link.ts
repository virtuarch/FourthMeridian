/**
 * components/platform/leads/cs-attention-link.ts  (PB-4 — "who needs help" → the Customers list)
 *
 * The one hand-off between the Customer Success dashboard's "Who needs help,
 * and why" rows and the hosted Customers list (cs_customers). The list is
 * hosted through the section registry, not imported, so the dashboard cannot
 * set its state directly: it announces the filter on `window`, and the list —
 * the audited, identity-resolving read — applies it through its own route
 * (`attention=<key|any>`, CUSTOMER_SUCCESS READ). No identity crosses here:
 * the message is a reason key.
 *
 * The dashboard offers the link only when the list is hosted for this viewer
 * (the section's access decides), so an operator without Customers READ sees
 * the counts and no control.
 */

import type { AttentionFilter } from "@/lib/platform/customer/overview-types";

export const CS_ATTENTION_FILTER_EVENT = "fm:cs-attention-filter";

/** Ask the hosted Customers list to show the customers needing help for `filter`. */
export function requestCustomerAttentionFilter(filter: AttentionFilter): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AttentionFilter>(CS_ATTENTION_FILTER_EVENT, { detail: filter }));
}

/** The filter a received event carries, or null when it is not one (a stray or malformed event). */
export function attentionFilterOf(e: Event): AttentionFilter | null {
  const d = (e as CustomEvent<unknown>).detail;
  return d === "any" || d === "reconnect" || d === "incident" || d === "policy" || d === "stalled" ? d : null;
}
