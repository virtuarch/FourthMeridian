/**
 * lib/platform/policies/policy-group-catalogue.ts  (POLICY EDITOR — the one read)
 *
 * THE ONE LOADER of the policy-group definitions in force: every PolicyGroup row
 * with its CURRENT PolicyGroupVersion, folded over the code catalogue by the
 * pure lib/entitlements/policy-groups.ts.
 *
 * WHY fm_system AND NOT THE TENANT PHASE. The definitions are deployment
 * configuration, not tenant data, and the migration grants fm_app NOTHING on the
 * two tables (least privilege: a customer never needs an operator's reason note
 * or version history). Product routes reach this through
 * `entitlementLoadOptions().loadCatalogue` (lib/entitlements/consume.ts); the
 * opening is one function that takes NO argument and returns definitions — no
 * user id, no selector, no customer row — the same "narrowest opening" rule as
 * lib/users/availability.ts.
 *
 * CHEAP ON HOT PATHS. An in-process cache with a 30 s TTL (one read per process
 * per TTL, concurrent misses share one in-flight read); every write in
 * policy-groups-write.ts invalidates it locally. Another instance sees an edit
 * within the TTL.
 *
 * NEVER THROWS. A failed read (an environment without the migration — relation
 * does not exist — or a transient error) serves the last good catalogue while
 * it is at most LAST_GOOD_MAX_AGE_MS (5 min) old, else the CODE catalogue,
 * marked CODE_FALLBACK and retried after 5 s. It never invents values, and a
 * fallback is never MORE permissive (review fix 2): under CODE_FALLBACK the
 * resolver fails closed every customer ASSIGNED to a key the code catalogue
 * does not hold (a DB-only group), whatever the rollout switch says.
 *
 * BETA LIFECYCLE (L1) — the per-group lifecycle / cost-freeze columns are read
 * by a SEPARATE query in the same load, so a database without migration
 * 20261031120000_policy_group_lifecycle (or a failed lifecycle read) still
 * resolves entitlement VALUES exactly as before; the catalogue is then marked
 * `lifecycleSource: "UNAVAILABLE"` and every BILLABLE decision fails closed.
 *
 * BILLABLE READS NEVER USE THE STALE PATHS. `loadFreshPolicyGroupCatalogue`
 * returns a catalogue only when it came from a SUCCESSFUL read (lifecycle
 * included) at most CATALOGUE_TTL_MS (30 s) ago — never the last-good copy
 * (marked `servedFromLastGood`) and never the code fallback; otherwise null,
 * which the billable gate turns into POLICY_UNAVAILABLE. Sign-in and reads keep
 * using `loadPolicyGroupCatalogue` and are unaffected.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import {
  buildPolicyGroupCatalogue, codeFallbackCatalogue, CODE_CATALOGUE,
  type PolicyGroupCatalogue, type PolicyGroupLifecycleFacts, type PolicyGroupRowFacts, type PolicyGroupVersionFacts,
} from "@/lib/entitlements/policy-groups";
import { isCatalogueFreshForBillable } from "@/lib/entitlements/billable-gate-core";
import { PlatformSettingKey } from "@/lib/platform-settings";
import { judgeGlobalCostFreeze, type GlobalCostFreezeVerdict } from "@/lib/platform/cost-freeze.core";

/**
 * L2 ENFORCEMENT — 20 s, stamped from the READ START (not its end). The bound,
 * measured honestly (review P3-4): a write landing just after a read's
 * lifecycle query is seen by the next read, which starts ≤ 20 s after that
 * read STARTED and sees it once its own lifecycle query runs (one read's
 * latency, L). A batch job may then reuse that decision for
 * BILLABLE_BATCH_MAX_AGE_MS (5 s). Worst case: 20 s + 5 s + L ≤ 30 s for any
 * read under 5 s (the three small catalogue queries take milliseconds).
 * Previously 30 s + L — an overrun by construction.
 */
export const CATALOGUE_TTL_MS = 20_000;

/** TEST-ONLY clock seam (the propagation bound is pinned with a pinned clock). Production: Date.now. */
let clock: () => number = Date.now;
export function setPolicyGroupCatalogueClockForTests(c: (() => number) | null): void { clock = c ?? Date.now; }
export const CATALOGUE_FAILURE_RETRY_MS = 5_000;
/** The oldest last-good catalogue a failed read may serve; past it, the code fallback (strict). */
export const LAST_GOOD_MAX_AGE_MS = 5 * 60_000;

/** The narrow read surface (systemDb satisfies it; a fake without the delegates reads as the code catalogue). */
export interface PolicyGroupCatalogueReadClient {
  policyGroup?: {
    findMany(args: {
      select: { key: true; label: true; description: true; isDefault: true; builtIn: true; archivedAt: true; currentVersion: true };
    }): Promise<PolicyGroupRowFacts[]>;
    /** BETA LIFECYCLE — the separate lifecycle read. */
    findMany(args: {
      select: { key: true; lifecycle: true; costFrozen: true; endedTransition: true; lifecycleVersion: true };
    }): Promise<PolicyGroupLifecycleFacts[]>;
  };
  policyGroupVersion?: {
    findMany(args: {
      where: { OR: { groupKey: string; version: number }[] };
      select: { groupKey: true; version: true; values: true; createdAt: true };
    }): Promise<PolicyGroupVersionFacts[]>;
  };
  /**
   * L2 — the GLOBAL cost freeze row (lib/platform/cost-freeze.core.ts). systemDb
   * always has it; a narrow test fake without the delegate reads as "not frozen".
   */
  platformSetting?: {
    findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null>;
  };
}

/** UNCACHED — the catalogue through `client`. THROWS on a read failure (the cached loader catches). */
export async function readPolicyGroupCatalogue(client: PolicyGroupCatalogueReadClient, now: Date = new Date()): Promise<PolicyGroupCatalogue> {
  if (!client.policyGroup || !client.policyGroupVersion) return CODE_CATALOGUE;
  const rows = await client.policyGroup.findMany({
    select: { key: true, label: true, description: true, isDefault: true, builtIn: true, archivedAt: true, currentVersion: true },
  });
  const versions = rows.length === 0 ? [] : await client.policyGroupVersion.findMany({
    where: { OR: rows.map((r) => ({ groupKey: r.key, version: r.currentVersion })) },
    select: { groupKey: true, version: true, values: true, createdAt: true },
  });
  // BETA LIFECYCLE — a failure here never fails the VALUES read (see the header).
  let lifecycle: PolicyGroupLifecycleFacts[] | null;
  try {
    lifecycle = await client.policyGroup.findMany({
      select: { key: true, lifecycle: true, costFrozen: true, endedTransition: true, lifecycleVersion: true },
    });
  } catch (error) {
    console.error("[policy-group-catalogue] lifecycle read failed; billable operations fail closed —",
      error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "unknown error");
    lifecycle = null;
  }
  const built = buildPolicyGroupCatalogue(rows, versions, now, lifecycle);
  return applyGlobalCostFreeze(built, await readGlobalFreeze(client));
}

/** L2 — the global flag's verdict for this read (never throws: a failure is UNAVAILABLE, i.e. frozen). */
async function readGlobalFreeze(client: PolicyGroupCatalogueReadClient): Promise<GlobalCostFreezeVerdict> {
  if (!client.platformSetting) return judgeGlobalCostFreeze(null);
  try {
    const row = await client.platformSetting.findUnique({ where: { key: PlatformSettingKey.PLATFORM_COST_FROZEN }, select: { value: true } });
    return judgeGlobalCostFreeze(row?.value ?? null);
  } catch (error) {
    console.error("[policy-group-catalogue] global cost-freeze read failed; billable operations fail closed —",
      error instanceof Error ? error.message.slice(0, 200) : "unknown error");
    return judgeGlobalCostFreeze(null, true);
  }
}

/**
 * PURE (L2) — fold the GLOBAL cost freeze into a catalogue. Declared ON: every
 * group reads `costFrozen: true` (Cost Freeze then beats the group's own state,
 * the Founder overlay and every allowance, by the resolver's precedence).
 * Unreadable / invalid: the lifecycle facts are UNAVAILABLE (billable work
 * fails closed as POLICY_UNAVAILABLE). Off / absent: unchanged.
 */
export function applyGlobalCostFreeze(c: PolicyGroupCatalogue, v: GlobalCostFreezeVerdict): PolicyGroupCatalogue {
  if (!v.frozen) return c;
  if (v.reason !== "COST_FREEZE") return { ...c, lifecycleSource: "UNAVAILABLE", globalCostFrozen: true };
  const groups = Object.fromEntries(Object.entries(c.groups).map(([k, g]) => [k, { ...g, costFrozen: true }]));
  return { ...c, groups, globalCostFrozen: true };
}

/** `fresh` = the entry came from a successful read (a failure entry is never fresh for billable). */
let cached: { catalogue: PolicyGroupCatalogue; expiresAt: number; fresh: boolean } | null = null;
let lastGood: { catalogue: PolicyGroupCatalogue; at: number } | null = null;
let inFlight: Promise<PolicyGroupCatalogue> | null = null;
let generation = 0;

/** TEST-ONLY — age the last good read (so the max-age path is provable without a clock seam). */
export function ageLastGoodPolicyGroupCatalogueForTests(ms: number): void {
  if (lastGood) lastGood = { ...lastGood, at: lastGood.at - ms };
}

/** TEST-ONLY — age the CACHED catalogue's read time (so the 30 s billable freshness is provable without a clock seam). */
export function ageCachedPolicyGroupCatalogueForTests(ms: number): void {
  if (cached?.catalogue.loadedAt) {
    cached = { ...cached, catalogue: { ...cached.catalogue, loadedAt: new Date(Date.parse(cached.catalogue.loadedAt) - ms).toISOString() } };
  }
}

/** Drop the cached catalogue (called after every local write, and by tests). */
export function invalidatePolicyGroupCatalogue(): void {
  cached = null;
  inFlight = null;
  generation++;
}

/** CACHED, NEVER THROWS — the definitions in force for this process. */
export function loadPolicyGroupCatalogue(): Promise<PolicyGroupCatalogue> {
  const now = clock();
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.catalogue);
  if (inFlight) return inFlight;
  const gen = generation;
  const p = (async () => {
    // L2 — the TTL and `loadedAt` both run from the READ START (see CATALOGUE_TTL_MS).
    const startedAt = clock();
    try {
      const catalogue = await readPolicyGroupCatalogue(systemDb as unknown as PolicyGroupCatalogueReadClient, new Date(startedAt));
      if (gen === generation) { cached = { catalogue, expiresAt: startedAt + CATALOGUE_TTL_MS, fresh: true }; lastGood = { catalogue, at: startedAt }; }
      return catalogue;
    } catch (error) {
      const recent = lastGood !== null && clock() - lastGood.at <= LAST_GOOD_MAX_AGE_MS ? lastGood.catalogue : null;
      console.error("[policy-group-catalogue] read failed; serving", recent ? "the last good catalogue" : "the code catalogue (strict fallback)", "—",
        error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "unknown error");
      // BETA LIFECYCLE — the last good copy is MARKED, so a billable decision can never use it.
      const fallback = recent ? { ...recent, servedFromLastGood: true } : codeFallbackCatalogue();
      if (gen === generation) cached = { catalogue: fallback, expiresAt: clock() + CATALOGUE_FAILURE_RETRY_MS, fresh: false };
      return fallback;
    } finally {
      if (gen === generation) inFlight = null;
    }
  })();
  inFlight = p;
  return p;
}

/**
 * BETA LIFECYCLE — the catalogue for a BILLABLE decision: a successful read at
 * most CATALOGUE_TTL_MS old, or null (⇒ POLICY_UNAVAILABLE, fail closed).
 * Shares the cache and the in-flight read with `loadPolicyGroupCatalogue`; a
 * cached successful read that has aged past 30 s (the read itself takes time
 * before the TTL starts) is dropped and re-read once. A cached FAILURE is not
 * retried here before its 5 s retry window, so an outage never turns every
 * billable call into a database read. Never throws.
 */
export async function loadFreshPolicyGroupCatalogue(): Promise<PolicyGroupCatalogue | null> {
  const first = await loadPolicyGroupCatalogue();
  if (isCatalogueFreshForBillable(first, clock())) return first;
  if (cached && !cached.fresh && cached.expiresAt > clock()) return null;
  if (cached?.fresh) cached = null;
  const second = await loadPolicyGroupCatalogue();
  return isCatalogueFreshForBillable(second, clock()) ? second : null;
}
