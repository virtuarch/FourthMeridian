/**
 * lib/platform/customer/overview-core.ts  (Platform Spaces 2.0 — Customer Success, pure)
 *
 * Folds the reader's row sets (ids are joins, never output) into the
 * CsOverviewResponse. The onboarding stage and cohorts reuse the ONE strict
 * funnel (lib/platform/growth/acquisition-core funnelThrough /
 * buildOnboardingCohorts), so Customer Success and Growth never disagree.
 */

import { FUNNEL_STAGE_LABELS, FUNNEL_STAGE_ORDER, dayOf } from "@/lib/platform/growth/product-analytics-core";
import { buildOnboardingCohorts } from "@/lib/platform/growth/acquisition-core";
import type { HealthState } from "@/lib/connections/health";
import { ATTENTION_LABELS, foldAttention, type AttentionFacts } from "./attention-core";
import type { CsOverviewResponse } from "./overview-types";

// PB-4 — the reasons live in attention-core.ts (shared with the Customers list); re-exported for existing callers.
export { ATTENTION_LABELS } from "./attention-core";

export interface CsOverviewFacts extends AttentionFacts {
  deactivatedCustomers: number;
  connections: { total: number; counts: Record<HealthState, number>; retired: { revoked: number; ownerInactive: number } };
  incidentDays: { day: string; opened: number; resolved: number }[];
  incidentsFloor: boolean;
  openByKind: readonly { kind: string; count: number }[];
  /** True when the active-incident scan hit its ceiling (open counts are a floor). */
  openFloor?: boolean;
}

const kindLabel = (k: string) => k.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

export function buildCsOverview(facts: CsOverviewFacts, now: Date, windowDays: 30 | 90): CsOverviewResponse {
  // PB-4 — the ONE attention fold (the Customers list's filter reads the same sets).
  const att = foldAttention(facts, now);
  const funnel = att.activeFunnel;
  const through = att.through;

  const stages = FUNNEL_STAGE_ORDER.map((key, i) => ({
    key, label: FUNNEL_STAGE_LABELS[key],
    count: [...through.values()].filter((t) => t === i).length,
  }));

  const openByKind = [...facts.openByKind].sort((a, b) => b.count - a.count).map((r) => ({ ...r, label: kindLabel(r.kind) }));
  return {
    checkedAt: now.toISOString(),
    windowDays,
    customers: { active: facts.activeCustomerIds.size, deactivated: facts.deactivatedCustomers },
    stages,
    attention: {
      customers: att.union.size,
      floor: att.floor,
      reasons: att.keys.map((key) => ({ key, label: ATTENTION_LABELS[key], count: att.sets[key].size })),
    },
    connections: facts.connections,
    incidents: { days: facts.incidentDays, floor: facts.incidentsFloor, openByKind, open: openByKind.reduce((a, r) => a + r.count, 0), openFloor: facts.openFloor === true },
    onboarding: buildOnboardingCohorts(funnel, dayOf(now)),
    notes: [
      "Customers are role-USER accounts; deactivated accounts are counted apart and never in a share.",
      "Onboarding stage is the strict funnel (the same one Growth uses), as of now.",
      "A customer can need help for several reasons; the headline counts each customer once. Each reason opens the Customers list filtered to it — the same rule, so the count and the list agree.",
      "Policy group: an assignment naming an unknown, invalid or retired group is flagged. A customer with no assignment resolves to the default and is flagged only while fail-closed enforcement is on (then access is restricted) — the same rule as the Platform Ops policy-assignment alert.",
      "\"Stalled before first connection\" follows the strict funnel: a customer who connected but skipped an earlier stage (verification, a first session) is counted here too.",
      "Open sync incidents are the canonical ACTIVE incidents (the Incidents workspace's read) — orphaned, superseded and event rows are excluded; resolved episodes are kept 90 days.",
      "The sync-issue trend counts the same canonical incident episodes: opened = first occurrence, resolved = the recovery's resolvedAt. Event rows (e.g. a provider-removed transaction) are evidence, not incidents, and are not counted.",
      "Not available: support tickets (no ticketing system) and customer health scores (no authoritative model).",
    ],
  };
}
