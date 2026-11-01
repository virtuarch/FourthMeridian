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
import { parseAttentionFilter } from "@/lib/platform/customer/attention-keys";

/**
 * S2 ruling — the Customers list mirrors its filter into the Space URL as
 * `?attention=` (REPLACE: a filter refines the current entry, like a customer
 * Space's view change — never a Back/Forward step), so a filtered list survives
 * a refresh and is linkable. The event only SETS that state.
 */
export const CS_ATTENTION_PARAM = "attention";

export const CS_ATTENTION_FILTER_EVENT = "fm:cs-attention-filter";

/** Ask the hosted Customers list to show the customers needing help for `filter`. */
export function requestCustomerAttentionFilter(filter: AttentionFilter): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AttentionFilter>(CS_ATTENTION_FILTER_EVENT, { detail: filter }));
}

/** The filter a received event carries, or null when it is not one (a stray or malformed event). */
export function attentionFilterOf(e: Event): AttentionFilter | null {
  return parseAttentionFilter((e as CustomEvent<unknown>).detail) ?? null;
}

/** The filter a `?attention=` value names (the SAME parser the route uses); anything else ⇒ no filter. */
export function attentionFromSearch(search: string): AttentionFilter | null {
  return parseAttentionFilter(new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(CS_ATTENTION_PARAM)) ?? null;
}

/** The URL update for a filter: null deletes the param (the unfiltered list keeps a clean URL). */
export function attentionUrlUpdate(filter: AttentionFilter | null): Record<string, string | null> {
  return { [CS_ATTENTION_PARAM]: filter };
}
