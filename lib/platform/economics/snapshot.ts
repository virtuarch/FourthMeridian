/**
 * lib/platform/economics/snapshot.ts  (Platform Economics — PR A: the Overview reader)
 *
 * THE ONE SERVER READER behind Economics › Overview and its drilldowns. It reads
 * through the EXISTING readers only — no new collection, no new query shape:
 *
 *   readSpendGroups           lib/platform/ai/spend-by-surface.ts (AI & Costs'
 *                             "Cost by surface" read), RETURNED rows, [since, until]
 *   realPlaidUsageReaders →   lib/platform/plaid/usage.ts (the AI & Costs Plaid
 *   buildPlaidUsage           census), current cycle, "present during" reading
 *   loadEngagedUserIdsSince   lib/platform/growth/product-analytics.ts (PB-10
 *                             engagement — never sessions)
 *   opaqueUserRef             lib/platform/opaque-user-ref.ts (ids never leave)
 *
 * and hands them to the pure fold (snapshot-core.ts). The snapshot and the drill
 * both call `loadEconomicsInputs` with the same window end, so a KPI and its
 * records come from the same query by construction.
 *
 * fm_system (AiInvocation is revoked from fm_app). Read-only. Identity-free:
 * engaged user ids are mapped to opaque references here and never returned.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { readSpendGroups } from "@/lib/platform/ai/spend-by-surface";
import type { SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import { loadEngagedUserIdsSince } from "@/lib/platform/growth/product-analytics";
import { opaqueUserRef } from "@/lib/platform/opaque-user-ref";
import { buildPlaidUsage, realPlaidUsageReaders, TRANSITIONS_LIMIT, type PlaidUsageReaders } from "@/lib/platform/plaid/usage";
import type { PlaidItemFact, PlaidItemTransition } from "@/lib/platform/plaid/item-months";
import { isPricingConfigured, PLAID_RATES, type PlaidRate } from "@/lib/usage/pricing";
import {
  buildEconomicsDrill, buildEconomicsSnapshot, cycleOf, readSince,
  type EconomicsDrillQuery, type EconomicsDrillResponse, type EconomicsInputs, type EconomicsSnapshot, type OverviewFigureKey,
} from "@/lib/platform/economics/snapshot-core";

export interface EconomicsDeps {
  groups?: (since: Date, until: Date) => Promise<SpendGroup[]>;
  plaidReaders?: Pick<PlaidUsageReaders, "items" | "transitions">;
  engagedSince?: (since: Date) => Promise<Set<string>>;
  aiPricingConfigured?: boolean;
  plaidRates?: readonly PlaidRate[];
  ref?: (userId: string) => string;
}

/** The inputs plus the raw Plaid census they were folded from (PR B attributes Items to customers). */
export interface EconomicsFacts {
  inputs: EconomicsInputs;
  items: PlaidItemFact[];
  transitions: PlaidItemTransition[];
}

/** Read every input once, at the window end `untilMs`. */
export async function loadEconomicsFacts(untilMs: number, deps: EconomicsDeps = {}): Promise<EconomicsFacts> {
  const until = new Date(untilMs);
  const plaid = deps.plaidReaders ?? realPlaidUsageReaders();
  const rates = deps.plaidRates ?? PLAID_RATES;
  const cycleStart = new Date(`${cycleOf(untilMs).start}T00:00:00Z`);
  const [groups, items, transitions, engaged] = await Promise.all([
    (deps.groups ?? readSpendGroups)(readSince(untilMs), until),
    plaid.items(),
    plaid.transitions(TRANSITIONS_LIMIT),
    (deps.engagedSince ?? ((s: Date) => loadEngagedUserIdsSince(systemDb, s)))(cycleStart),
  ]);
  const usage = buildPlaidUsage(items, transitions, until.toISOString().slice(0, 10), rates);
  const current = usage.cycles.find((c) => c.label === "current") ?? null;
  const ref = deps.ref ?? opaqueUserRef;
  return {
    items, transitions,
    inputs: {
      nowMs: untilMs,
      spendGroups: groups,
      aiPricingConfigured: deps.aiPricingConfigured ?? isPricingConfigured(),
      plaidCycle: current?.during ?? null,
      plaidReadingsAgree: current?.agree ?? true,
      plaidRates: rates,
      // Opaque references only — one per engaged user id; the id itself never leaves this reader.
      engagedCustomerRefs: [...engaged].map((id) => ref(id)).sort(),
    },
  };
}

export async function loadEconomicsInputs(untilMs: number, deps: EconomicsDeps = {}): Promise<EconomicsInputs> {
  return (await loadEconomicsFacts(untilMs, deps)).inputs;
}

export async function getEconomicsSnapshot(nowMs: number = Date.now(), deps: EconomicsDeps = {}): Promise<EconomicsSnapshot> {
  return buildEconomicsSnapshot(await loadEconomicsInputs(nowMs, deps));
}

/** The Overview's own figures; PR B figures drill through providers-entitlements.ts getAnyEconomicsDrill. */
export async function getEconomicsDrill(q: EconomicsDrillQuery & { figure: OverviewFigureKey }, deps: EconomicsDeps = {}): Promise<EconomicsDrillResponse> {
  return buildEconomicsDrill(await loadEconomicsInputs(q.untilMs, deps), q.figure, q.window);
}
