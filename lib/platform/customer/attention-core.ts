/**
 * lib/platform/customer/attention-core.ts  (PB-4 — Customer Success "who needs help", pure)
 *
 * THE ONE DEFINITION of why an active customer needs help. Both readers fold
 * the same facts through `foldAttention`:
 *
 *   • the overview (lib/platform/customer/overview-core.ts) — COUNTS per reason
 *     and the distinct-customer headline; no identity leaves it;
 *   • the audited Customers list (lib/platform/customer/customers.ts) — the
 *     reasons ON each row (`attention`) and the `attention=<key|any>` filter.
 *
 * So the panel's "3 need reconnecting" and the list filtered to that reason are
 * the same set by construction — there is no second definition to drift.
 *
 * Who is in scope: ACTIVE role-USER customers only (`activeCustomerIds`). An
 * owner fact about anyone else (a deactivated account, an operator) is dropped
 * here, once, for both readers.
 *
 * Pure: no I/O, no clock of its own (`now` is handed in).
 */

import { ABANDONMENT_HORIZON_DAYS, FUNNEL_STAGE_ORDER } from "@/lib/platform/growth/product-analytics-core";
import { funnelThrough, type CohortFunnelFacts } from "@/lib/platform/growth/acquisition-core";
import type { AttentionFilter, AttentionKey } from "./overview-types";

const DAY_MS = 86_400_000;

/** Display order of the reasons (the panel's rows and a row's chips). */
export const ATTENTION_KEYS: readonly AttentionKey[] = ["reconnect", "incident", "policy", "stalled"];

export const ATTENTION_LABELS: Readonly<Record<AttentionKey, string>> = {
  reconnect: "A connection needs reconnecting",
  incident: "An active sync incident",
  // PB-4 (owner, 2026-11-02) — a customer with NO assignment resolves to the
  // catalogue default and works; that is not "missing". Only an assignment that
  // names a group which is unknown, has an invalid stored definition, or is
  // retired (archived — no longer offered) is a reason to help.
  policy: "Assigned policy group is unknown, invalid or retired",
  stalled: `Stalled before first connection, ${ABANDONMENT_HORIZON_DAYS}+ days after registering`,
};

/** The chip word on a Customers-list row. */
export const ATTENTION_SHORT: Readonly<Record<AttentionKey, string>> = {
  reconnect: "Reconnect",
  incident: "Sync incident",
  policy: "Policy group",
  stalled: "Stalled",
};

/** The query value, parsed: null = absent / empty (no filter); undefined = not a reason (the route refuses it). */
export function parseAttentionFilter(raw: string | null | undefined): AttentionFilter | null | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const v = raw.trim();
  return v === "any" || (ATTENTION_KEYS as readonly string[]).includes(v) ? (v as AttentionFilter) : undefined;
}

export interface AttentionFacts {
  /** Active (not deactivated) role-USER accounts — the only population that can need help. */
  activeCustomerIds: ReadonlySet<string>;
  funnel: CohortFunnelFacts;
  /** Owners of a NEEDS_REAUTH / ERROR Plaid Item or live-provider Connection. */
  reconnectOwners: readonly string[];
  /** Owners of a canonical ACTIVE sync incident (the Incidents workspace's read). */
  incidentOwners: readonly string[];
  /** Customers whose assignment names an unknown, invalid or retired policy group (never the unassigned default). */
  policyIssueOwners: readonly string[];
}

export interface AttentionFold {
  /** Per reason, the active customers it applies to. */
  sets: Readonly<Record<AttentionKey, ReadonlySet<string>>>;
  /** Active customers with at least one reason. */
  union: ReadonlySet<string>;
  /** The funnel restricted to active customers, and its strict fold (the overview's stage distribution reuses both). */
  activeFunnel: CohortFunnelFacts;
  through: ReadonlyMap<string, number>;
}

export function foldAttention(facts: AttentionFacts, now: Date): AttentionFold {
  const active = facts.activeCustomerIds;
  const activeFunnel: CohortFunnelFacts = { ...facts.funnel, users: facts.funnel.users.filter((u) => active.has(u.id)) };
  const through = funnelThrough(activeFunnel);

  const connIdx = FUNNEL_STAGE_ORDER.indexOf("firstConnection");
  const horizon = now.getTime() - ABANDONMENT_HORIZON_DAYS * DAY_MS;
  const stalled = activeFunnel.users.filter((u) => (through.get(u.id) ?? 0) < connIdx && u.createdAt.getTime() <= horizon).map((u) => u.id);

  const only = (ids: readonly string[]) => new Set(ids.filter((id) => active.has(id)));
  const sets: Record<AttentionKey, Set<string>> = {
    reconnect: only(facts.reconnectOwners),
    incident: only(facts.incidentOwners),
    policy: only(facts.policyIssueOwners),
    stalled: only(stalled),
  };
  const union = new Set<string>();
  for (const k of ATTENTION_KEYS) for (const id of sets[k]) union.add(id);
  return { sets, union, activeFunnel, through };
}

/** One customer's reasons, in display order ([] = needs no help, or not an active customer). */
export function attentionOf(fold: AttentionFold, userId: string): AttentionKey[] {
  return ATTENTION_KEYS.filter((k) => fold.sets[k].has(userId));
}

/** The customers a filter selects: one reason's set, or the union for "any". */
export function idsForAttention(fold: AttentionFold, filter: AttentionFilter): ReadonlySet<string> {
  return filter === "any" ? fold.union : fold.sets[filter];
}
