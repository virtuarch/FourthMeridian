/**
 * lib/platform/customer/attention-keys.ts  (PB-4 — the reason keys, client-safe)
 *
 * The attention reason keys and the ONE parser for the `attention` filter,
 * shared by the Customers route (server), the Customers list's `?attention=`
 * URL param and the dashboard hand-off event (client). Import-free, so a
 * client component can use it without pulling in the attention fold.
 */

import type { AttentionFilter, AttentionKey } from "./overview-types";

/**
 * Display order of the reasons (the panel's rows and a row's chips).
 * `unassigned` is live only while POLICY_ASSIGNMENT_FAIL_CLOSED=enforce (S2 ruling, 2026-11-02).
 */
export const ATTENTION_KEYS: readonly AttentionKey[] = ["reconnect", "incident", "policy", "unassigned", "stalled"];

/** The query value, parsed: null = absent / empty (no filter); undefined = not a reason (the route refuses it). */
export function parseAttentionFilter(raw: unknown): AttentionFilter | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (v === "") return null;
  return v === "any" || (ATTENTION_KEYS as readonly string[]).includes(v) ? (v as AttentionFilter) : undefined;
}
