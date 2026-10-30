/**
 * lib/platform/customer/overview-core.ts  (Platform Spaces 2.0 — Customer Success, pure)
 *
 * Folds the reader's row sets (ids are joins, never output) into the
 * CsOverviewResponse. The onboarding stage and cohorts reuse the ONE strict
 * funnel (lib/platform/growth/acquisition-core funnelThrough /
 * buildOnboardingCohorts), so Customer Success and Growth never disagree.
 */

import {
  ABANDONMENT_HORIZON_DAYS, FUNNEL_STAGE_LABELS, FUNNEL_STAGE_ORDER, dayOf,
} from "@/lib/platform/growth/product-analytics-core";
import { buildOnboardingCohorts, funnelThrough, type CohortFunnelFacts } from "@/lib/platform/growth/acquisition-core";
import type { HealthState } from "@/lib/connections/health";
import type { AttentionKey, CsOverviewResponse } from "./overview-types";

const DAY_MS = 86_400_000;

export interface CsOverviewFacts {
  /** Active (not deactivated) role-USER accounts. */
  activeCustomerIds: ReadonlySet<string>;
  deactivatedCustomers: number;
  funnel: CohortFunnelFacts;
  /** Owners of a NEEDS_REAUTH / ERROR Plaid Item or live-provider Connection. */
  reconnectOwners: readonly string[];
  /** Owners of an unresolved sync-issue episode. */
  incidentOwners: readonly string[];
  /** Customers with no policy-group assignment, or one that does not resolve. */
  policyIssueOwners: readonly string[];
  connections: { total: number; counts: Record<HealthState, number>; retired: { revoked: number; ownerInactive: number } };
  incidentDays: { day: string; opened: number; resolved: number }[];
  incidentsFloor: boolean;
  openByKind: readonly { kind: string; count: number }[];
}

export const ATTENTION_LABELS: Readonly<Record<AttentionKey, string>> = {
  reconnect: "A connection needs reconnecting",
  incident: "An unresolved sync issue",
  policy: "Policy group missing or invalid",
  stalled: `Not connected ${ABANDONMENT_HORIZON_DAYS}+ days after registering`,
};

const kindLabel = (k: string) => k.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

export function buildCsOverview(facts: CsOverviewFacts, now: Date, windowDays: 30 | 90): CsOverviewResponse {
  const active = facts.activeCustomerIds;
  const funnel: CohortFunnelFacts = { ...facts.funnel, users: facts.funnel.users.filter((u) => active.has(u.id)) };
  const through = funnelThrough(funnel);

  const stages = FUNNEL_STAGE_ORDER.map((key, i) => ({
    key, label: FUNNEL_STAGE_LABELS[key],
    count: [...through.values()].filter((t) => t === i).length,
  }));

  const connIdx = FUNNEL_STAGE_ORDER.indexOf("firstConnection");
  const horizon = now.getTime() - ABANDONMENT_HORIZON_DAYS * DAY_MS;
  const stalled = funnel.users.filter((u) => (through.get(u.id) ?? 0) < connIdx && u.createdAt.getTime() <= horizon).map((u) => u.id);

  const only = (ids: readonly string[]) => new Set(ids.filter((id) => active.has(id)));
  const sets: Record<AttentionKey, Set<string>> = {
    reconnect: only(facts.reconnectOwners),
    incident: only(facts.incidentOwners),
    policy: only(facts.policyIssueOwners),
    stalled: only(stalled),
  };
  const union = new Set<string>();
  for (const s of Object.values(sets)) for (const id of s) union.add(id);

  const openByKind = [...facts.openByKind].sort((a, b) => b.count - a.count).map((r) => ({ ...r, label: kindLabel(r.kind) }));
  return {
    checkedAt: now.toISOString(),
    windowDays,
    customers: { active: active.size, deactivated: facts.deactivatedCustomers },
    stages,
    attention: {
      customers: union.size,
      reasons: (Object.keys(sets) as AttentionKey[]).map((key) => ({ key, label: ATTENTION_LABELS[key], count: sets[key].size })),
    },
    connections: facts.connections,
    incidents: { days: facts.incidentDays, floor: facts.incidentsFloor, openByKind, open: openByKind.reduce((a, r) => a + r.count, 0) },
    onboarding: buildOnboardingCohorts(funnel, dayOf(now)),
    notes: [
      "Customers are role-USER accounts; deactivated accounts are counted apart and never in a share.",
      "Onboarding stage is the strict funnel (the same one Growth uses), as of now.",
      "A customer can need help for several reasons; the headline counts each customer once.",
      "Sync issues are unresolved episodes; resolved episodes are kept 90 days after resolution.",
      "Not available: support tickets (no ticketing system) and customer health scores (no authoritative model).",
    ],
  };
}
