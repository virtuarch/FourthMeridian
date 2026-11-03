/**
 * lib/platform/economics/providers-entitlements.ts  (Platform Economics — PR B readers)
 *
 * The server readers behind Economics › Providers and › Entitlements, their
 * drilldowns and the HYPOTHETICAL scenario. They extend the Overview's ONE read
 * (loadEconomicsFacts — the AI ledger groups, the Plaid census, PB-10 engagement)
 * with existing reads only:
 *
 *   providerCalls      ApiUsageCounter calls per provider since the cycle start
 *                      (the counter the api-usage route reads)
 *   readUserSpendGroups  lib/platform/ai/spend-health.ts — RETURNED customer-surface
 *                      AI per (user, model, UTC day): the allowance / alert read
 *   itemOwners         PlaidItem id → owner id (a join key only; never returned)
 *   assignments        CustomerPolicyAssignment for the costed customers (current group,
 *                      overlay, individual allowance override)
 *   catalogue          loadPolicyGroupCatalogue (labels, default, allowance values)
 *
 * READ-ONLY: nothing here writes, assigns, or changes a policy or an allowance —
 * the scenario included (static pin in entitlements.test.ts). fm_system / db reads,
 * identity-free output: every customer leaves as an opaque reference.
 */

import "server-only";
import { db, systemDb } from "@/lib/db";
import { readUserSpendGroups, type UserSpendGroup } from "@/lib/platform/ai/spend-health";
import { OVERLAYS } from "@/lib/entitlements/catalogue";
import { POLICY_GROUP_KEY_PATTERN, resolvableGroupKeys, type PolicyGroupCatalogue } from "@/lib/entitlements/policy-groups";
import { loadPolicyGroupCatalogue } from "@/lib/platform/policies/policy-group-catalogue";
import { opaqueUserRef } from "@/lib/platform/opaque-user-ref";
import { itemMonths } from "@/lib/platform/plaid/item-months";
import type { PlaidBillableProduct } from "@/lib/usage/pricing";
import { loadEconomicsFacts, type EconomicsDeps } from "@/lib/platform/economics/snapshot";
import {
  buildEconomicsDrill, cycleOf, isOverviewFigure, plaidCaveats, rowsTotal,
  type EconomicsDrillQuery, type EconomicsDrillResponse,
} from "@/lib/platform/economics/snapshot-core";
import {
  buildProvidersView, openAiCostFigure, plaidCostFigure, providerDrillRows,
  type EconomicsProvidersView, type ProviderCallsFact,
} from "@/lib/platform/economics/providers-core";
import {
  buildEntitlementsView, buildScenario, groupCostFigure, groupRows, parseScenarioQuery, unattributedFigure, unattributedRows,
  type EconomicsEntitlementsView, type EconomicsScenario, type EntitlementCustomer, type EntitlementInputs,
} from "@/lib/platform/economics/entitlements-core";

export interface AssignmentFact { userId: string; policyGroup: string; overlay: string | null; aiDailyUsdAllowanceOverride: unknown }

export interface ProvidersEntitlementsDeps extends EconomicsDeps {
  providerCalls?: (since: Date) => Promise<ProviderCallsFact[] | null>;
  userGroups?: (since: Date, until: Date) => Promise<UserSpendGroup[]>;
  itemOwners?: () => Promise<{ id: string; userId: string | null }[]>;
  assignments?: (userIds: readonly string[]) => Promise<AssignmentFact[]>;
  catalogue?: () => Promise<PolicyGroupCatalogue>;
}

async function readProviderCalls(since: Date): Promise<ProviderCallsFact[] | null> {
  try {
    const rows = await db.apiUsageCounter.groupBy({ by: ["provider"], where: { day: { gte: since }, unit: "calls" }, _sum: { count: true } });
    return rows.map((r) => ({ provider: r.provider, calls: Number(r._sum.count ?? 0) }));
  } catch {
    return null; // the counter is unavailable — calls say so, never 0
  }
}

const readItemOwners = () => db.plaidItem.findMany({ select: { id: true, userId: true } });
const readAssignments = (userIds: readonly string[]) => userIds.length === 0 ? Promise.resolve([] as AssignmentFact[])
  : systemDb.customerPolicyAssignment.findMany({
      where: { userId: { in: [...userIds] } },
      select: { userId: true, policyGroup: true, overlay: true, aiDailyUsdAllowanceOverride: true },
    });

// ── Providers ───────────────────────────────────────────────────────────────────

export async function getEconomicsProviders(nowMs: number = Date.now(), deps: ProvidersEntitlementsDeps = {}): Promise<EconomicsProvidersView> {
  const since = new Date(`${cycleOf(nowMs).start}T00:00:00Z`);
  const [facts, calls] = await Promise.all([loadEconomicsFacts(nowMs, deps), (deps.providerCalls ?? readProviderCalls)(since)]);
  return buildProvidersView({ ...facts.inputs, providerCalls: calls });
}

// ── Entitlements ────────────────────────────────────────────────────────────────

export async function loadEntitlementInputs(untilMs: number, deps: ProvidersEntitlementsDeps = {}): Promise<EntitlementInputs> {
  const cycle = cycleOf(untilMs);
  const since = new Date(`${cycle.start}T00:00:00Z`);
  const until = new Date(untilMs);
  const [facts, userGroups, owners, catalogue] = await Promise.all([
    loadEconomicsFacts(untilMs, deps),
    (deps.userGroups ?? readUserSpendGroups)(since, until),
    (deps.itemOwners ?? readItemOwners)(),
    (deps.catalogue ?? loadPolicyGroupCatalogue)(),
  ]);
  const ref = deps.ref ?? opaqueUserRef;
  const today = until.toISOString().slice(0, 10);

  // Per user id (a join key here only): their customer-surface AI and their Items' Item-months.
  const spendBy = new Map<string, UserSpendGroup[]>();
  const userless: UserSpendGroup[] = [];
  for (const g of userGroups) {
    if (!g.userId) { userless.push(g); continue; }
    spendBy.set(g.userId, [...(spendBy.get(g.userId) ?? []), g]);
  }
  const ownerOf = new Map(owners.map((o) => [o.id, o.userId] as const));
  const monthsBy = new Map<string, PlaidBillableProduct[]>();
  const ownerless: PlaidBillableProduct[] = [];
  for (const m of itemMonths(facts.items, facts.transitions, cycle, today)) {
    const owner = ownerOf.get(m.itemId) ?? null;
    if (!owner) { ownerless.push(m.product); continue; }
    monthsBy.set(owner, [...(monthsBy.get(owner) ?? []), m.product]);
  }

  const userIds = [...new Set([...spendBy.keys(), ...monthsBy.keys()])].sort();
  const rows = await (deps.assignments ?? readAssignments)(userIds);
  const byUser = new Map(rows.map((r) => [r.userId, r] as const));
  const resolvable = new Set(resolvableGroupKeys(catalogue));
  const customers: EntitlementCustomer[] = userIds.map((id) => {
    const a = byUser.get(id) ?? null;
    const overlaySets = a?.overlay ? OVERLAYS[a.overlay]?.values.aiDailyUsdAllowance !== undefined : false;
    return {
      ref: ref(id),
      // The resolver's own fallback: no row, or a group the catalogue no longer resolves ⇒ the default.
      groupKey: a && resolvable.has(a.policyGroup) ? a.policyGroup : catalogue.defaultKey,
      ownAllowance: (a?.aiDailyUsdAllowanceOverride ?? null) !== null || overlaySets,
      spend: spendBy.get(id) ?? [],
      plaidMonths: monthsBy.get(id) ?? [],
    };
  });

  const groups = Object.values(catalogue.groups)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label))
    .map((g) => ({
      key: g.key, label: g.label, isDefault: g.key === catalogue.defaultKey, archived: g.archived,
      allowanceUsd: g.valid && g.values ? Number(g.values.aiDailyUsdAllowance) : null,
    }));

  return {
    nowMs: untilMs,
    aiPricingConfigured: facts.inputs.aiPricingConfigured,
    plaidRates: facts.inputs.plaidRates,
    cycleStart: cycle.start,
    groups,
    customers,
    fleetSpend: facts.inputs.spendGroups.filter((g) => g.day >= cycle.start),
    userlessSpend: userless,
    ownerlessPlaidMonths: ownerless,
    plaidCaveats: plaidCaveats(facts.inputs),
  };
}

export async function getEconomicsEntitlements(nowMs: number = Date.now(), deps: ProvidersEntitlementsDeps = {}): Promise<EconomicsEntitlementsView> {
  return buildEntitlementsView(await loadEntitlementInputs(nowMs, deps));
}

/** HYPOTHETICAL and READ-ONLY. Null for an invalid query or an unknown group. */
export async function getEconomicsScenario(params: URLSearchParams, nowMs: number = Date.now(), deps: ProvidersEntitlementsDeps = {}): Promise<EconomicsScenario | null> {
  const q = parseScenarioQuery(params, POLICY_GROUP_KEY_PATTERN);
  if (!q) return null;
  return buildScenario(await loadEntitlementInputs(nowMs, deps), q);
}

// ── Every figure's records (the Overview's, the providers', the groups') ────────

export async function getAnyEconomicsDrill(q: EconomicsDrillQuery, deps: ProvidersEntitlementsDeps = {}): Promise<EconomicsDrillResponse | null> {
  const checkedAt = new Date(q.untilMs).toISOString();
  if (q.figure === "openai_cost" || q.figure === "plaid_cost") {
    const facts = await loadEconomicsFacts(q.untilMs, deps);
    const rows = providerDrillRows(facts.inputs, q.figure);
    const figure = q.figure === "openai_cost" ? openAiCostFigure(facts.inputs, checkedAt) : plaidCostFigure(facts.inputs, checkedAt);
    return { figure, rows, total: rowsTotal(rows), checkedAt };
  }
  if (q.figure === "group_cost") {
    const i = await loadEntitlementInputs(q.untilMs, deps);
    if (!q.group || !i.groups.some((g) => g.key === q.group)) return null;
    const rows = groupRows(i, q.group);
    return { figure: groupCostFigure(i, q.group, checkedAt), rows, total: rowsTotal(rows), checkedAt };
  }
  if (q.figure === "unattributed_cost") {
    const i = await loadEntitlementInputs(q.untilMs, deps);
    const rows = unattributedRows(i).filter((r) => r.value !== null);
    return { figure: unattributedFigure(i, checkedAt), rows, total: rowsTotal(rows), checkedAt };
  }
  if (!isOverviewFigure(q.figure)) return null;
  return buildEconomicsDrill((await loadEconomicsFacts(q.untilMs, deps)).inputs, q.figure, q.window);
}
