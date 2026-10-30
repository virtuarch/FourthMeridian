/**
 * lib/platform/ai/ai-budget.ts  (AI COST CONTROLS — the Economics budget utilization)
 *
 * HOW MUCH OF THE AI BUDGET IS USED, BY WHOM, AGAINST WHAT. One read model over
 * the AiInvocation ledger and the seven controls, for the `ops_ai_budget`
 * section of Economics:
 *
 *   fleet       rolling-24 h estimated USD on CUSTOMER surfaces (chat + brief)
 *               against the fleet alert threshold — the same fold the
 *               `ai-spend-fleet-high` rule judges (spend-health.ts). Harness
 *               and unattributed traffic are OVERHEAD, reported beside, never
 *               fleet.
 *   customers   the top customers by rolling-24 h spend (opaque refs, capped),
 *               each with today's spend since midnight UTC (what the allowance
 *               judges), their EFFECTIVE allowance through the ONE precedence
 *               function (override / overlay / platform / policy, ceiling
 *               last) and the two utilization percentages.
 *   bySurface   chat / brief / harness / other with invocations and unpriced.
 *   unpriced    what the rate card could not price — counted, never $0.
 *   recentAlerts the two spend rules' recent deliveries.
 *   controls    the summary of the controls in force.
 *
 * TWO grouped reads of the same SQL shape (readUserSpendGroups): the rolling
 * window and the UTC day. The assignment rows for the listed customers come in
 * ONE findMany; the platform allowance from the ONE controls read. Every dollar
 * is an ESTIMATE (ESTIMATE_NOT_BILLING). fm_system reads only; opaque refs only.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { resolveEffectiveEntitlements } from "@/lib/entitlements/resolve";
import { CUSTOMER_SURFACES, isCustomerSurface, priceSpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import { buildAiSpendHealth, opaqueUserRef, readUserSpendGroups, type UserSpendGroup } from "@/lib/platform/ai/spend-health";
import { utcDayStart } from "@/lib/platform/ai/customer-spend-today";
import {
  loadRecentAlertSummaries, loadResolvedControls, recentTriggersFor, type CostControlsReadClient,
} from "@/lib/platform/ai/cost-controls";
import {
  AI_SPEND_RULE_IDS, ESTIMATE_NOT_BILLING,
  type AiBudgetUtilization, type CustomerBudgetView, type SurfaceBudgetView,
} from "@/lib/platform/ai/cost-controls.types";

/** Top customers listed, by rolling-24 h spend. */
export const BUDGET_CUSTOMERS_CAP = 20;
export const BUDGET_WINDOW_HOURS = 24;
/** Recent alert triggers (both rules together), newest first. */
export const BUDGET_RECENT_ALERTS_CAP = 10;

export interface AssignmentReadClient {
  customerPolicyAssignment: {
    findMany(args: {
      where: { userId: { in: string[] } };
      select: { userId: true; policyGroup: true; overlay: true; assignedAt: true; assignedById: true; aiDailyUsdAllowanceOverride: true };
    }): Promise<{ userId: string; policyGroup: string; overlay: string | null; assignedAt: Date; assignedById: string | null; aiDailyUsdAllowanceOverride?: number | null }[]>;
  };
}

export interface AiBudgetDeps {
  now?: Date;
  windowHours?: number;
  /** The grouped read (since, until) — the rolling window AND the UTC day use it. */
  groups?: (since: Date, until: Date) => Promise<UserSpendGroup[]>;
  controls?: CostControlsReadClient;
  assignments?: AssignmentReadClient;
}

/** PURE — per-customer priced USD from user groups (null userId rows are fleet-only). */
export function sumPerUser(groups: readonly UserSpendGroup[]): Map<string, number> {
  const perUser = new Map<string, number>();
  for (const g of groups) {
    if (!g.userId || !isCustomerSurface(g.surface)) continue;
    const priced = priceSpendGroup(g);
    if (priced.unpriced || priced.usd === null) continue;
    perUser.set(g.userId, (perUser.get(g.userId) ?? 0) + priced.usd);
  }
  return perUser;
}

/** PURE — the by-surface table from the rolling-window groups. */
export function surfacesOf(groups: readonly UserSpendGroup[]): SurfaceBudgetView[] {
  const buckets = new Map<string, SurfaceBudgetView>();
  const bucketOf = (surface: string | null): string => (surface === "chat" || surface === "brief" || surface === "harness") ? surface : "other";
  for (const name of [...CUSTOMER_SURFACES, "harness", "other"]) buckets.set(name, { surface: name, customer: isCustomerSurface(name), estimatedUsd: null, invocations: 0, unpricedInvocations: 0 });
  for (const g of groups) {
    const b = buckets.get(bucketOf(g.surface))!;
    b.invocations += g.invocations;
    const priced = priceSpendGroup(g);
    if (priced.unpriced) { b.unpricedInvocations += g.invocations; continue; }
    if (priced.usd !== null) b.estimatedUsd = (b.estimatedUsd ?? 0) + priced.usd;
  }
  return [...buckets.values()];
}

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

export async function loadAiBudgetUtilization(deps: AiBudgetDeps = {}): Promise<AiBudgetUtilization> {
  const now = deps.now ?? new Date();
  const windowHours = deps.windowHours ?? BUDGET_WINDOW_HOURS;
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const groups = deps.groups ?? readUserSpendGroups;
  const controlsClient = deps.controls ?? (systemDb as unknown as CostControlsReadClient);
  const assignments = deps.assignments ?? (systemDb as unknown as AssignmentReadClient);

  const [controls, recent, windowGroups, todayGroups] = await Promise.all([
    loadResolvedControls(controlsClient),
    loadRecentAlertSummaries(controlsClient),
    groups(since, now),
    groups(utcDayStart(now), now),
  ]);

  const thresholds = { fleetUsd: controls["fleetAlert.thresholdUsd"].value, userUsd: controls["userAlert.thresholdUsd"].value };
  // The SAME fold the fleet alert judges — customer surfaces only; the reader already filters them, the fold prices them.
  const health = buildAiSpendHealth(windowGroups.filter((g) => isCustomerSurface(g.surface)), thresholds, windowHours, now);
  const surfaces = surfacesOf(windowGroups);
  const overhead = surfaces.filter((s) => !s.customer).reduce(
    (acc, s) => ({ estimatedUsd: s.estimatedUsd === null ? acc.estimatedUsd : (acc.estimatedUsd ?? 0) + s.estimatedUsd, invocations: acc.invocations + s.invocations }),
    { estimatedUsd: null as number | null, invocations: 0 },
  );

  const rolling = sumPerUser(windowGroups);
  const today = sumPerUser(todayGroups);
  const top = [...rolling.entries()].sort((a, b) => b[1] - a[1]).slice(0, BUDGET_CUSTOMERS_CAP);
  const ids = top.map(([id]) => id);
  const rows = ids.length > 0
    ? await assignments.customerPolicyAssignment.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, policyGroup: true, overlay: true, assignedAt: true, assignedById: true, aiDailyUsdAllowanceOverride: true },
      })
    : [];
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  const platformUsd = controls["allowance.usd"].origin === "SETTING" ? controls["allowance.usd"].value : null;

  const customers: CustomerBudgetView[] = top.map(([userId, rolling24hUsd]) => {
    const row = byUser.get(userId) ?? null;
    const e = resolveEffectiveEntitlements(row ? {
      policyGroup: row.policyGroup, overlay: row.overlay, assignedAt: row.assignedAt, assignedById: row.assignedById,
      aiDailyUsdAllowanceOverride: row.aiDailyUsdAllowanceOverride ?? null,
    } : null, { aiDailyUsdAllowanceUsd: platformUsd });
    const dim = e.dimensions.aiDailyUsdAllowance;
    const allowanceUsd = Number(dim.value);
    const todayUsd = today.get(userId) ?? 0;
    // This Economics view resolves WITHOUT the fail-closed option (it projects the plan's allowance, as before);
    // FAIL_CLOSED therefore cannot occur here and is folded with POLICY_DEFAULT only to satisfy the frozen union.
    const source: CustomerBudgetView["allowanceSource"] = dim.source === "POLICY_DEFAULT" || dim.source === "FAIL_CLOSED" ? "POLICY" : dim.source;
    return {
      ref: opaqueUserRef(userId),
      rolling24hUsd, todayUsd, allowanceUsd, allowanceSource: source,
      allowanceUtilizationPct: pct(todayUsd, allowanceUsd),
      alertUtilizationPct: pct(rolling24hUsd, thresholds.userUsd),
    };
  });

  const recentAlerts = [...recentTriggersFor(AI_SPEND_RULE_IDS.fleet, recent, BUDGET_RECENT_ALERTS_CAP), ...recentTriggersFor(AI_SPEND_RULE_IDS.user, recent, BUDGET_RECENT_ALERTS_CAP)]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, BUDGET_RECENT_ALERTS_CAP);

  return {
    checkedAt: now.toISOString(),
    windowHours,
    fleet: {
      estimatedUsd: health.fleetUsd,
      thresholdUsd: thresholds.fleetUsd,
      alertEnabled: controls["fleetAlert.enabled"].value,
      utilizationPct: health.fleetUsd === null ? null : pct(health.fleetUsd, thresholds.fleetUsd),
      invocations: health.customerInvocations,
      customers: health.customers,
    },
    overhead,
    customers,
    bySurface: surfaces,
    unpriced: { invocations: health.unpricedInvocations, models: health.unpricedModels },
    recentAlerts,
    controls: {
      allowanceEnforced: controls["allowance.enforced"].value,
      // The platform value in force, else the contract default (what the Policies panel shows as the allowance control).
      allowanceDefaultUsd: platformUsd ?? controls["allowance.usd"].defaultValue,
      userAlertEnabled: controls["userAlert.enabled"].value,
      userAlertThresholdUsd: thresholds.userUsd,
      paused: controls["killSwitch.paused"].value,
    },
    estimateNote: ESTIMATE_NOT_BILLING,
  };
}
