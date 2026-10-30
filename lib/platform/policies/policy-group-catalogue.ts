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
 * does not exist — or a transient error) serves the last good catalogue, else
 * the CODE catalogue, marked CODE_FALLBACK and retried after 5 s: resolution
 * then behaves exactly as before the editor existed. It never invents values.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import {
  buildPolicyGroupCatalogue, codeFallbackCatalogue, CODE_CATALOGUE,
  type PolicyGroupCatalogue, type PolicyGroupRowFacts, type PolicyGroupVersionFacts,
} from "@/lib/entitlements/policy-groups";

export const CATALOGUE_TTL_MS = 30_000;
export const CATALOGUE_FAILURE_RETRY_MS = 5_000;

/** The narrow read surface (systemDb satisfies it; a fake without the delegates reads as the code catalogue). */
export interface PolicyGroupCatalogueReadClient {
  policyGroup?: {
    findMany(args: {
      select: { key: true; label: true; description: true; isDefault: true; builtIn: true; archivedAt: true; currentVersion: true };
    }): Promise<PolicyGroupRowFacts[]>;
  };
  policyGroupVersion?: {
    findMany(args: {
      where: { OR: { groupKey: string; version: number }[] };
      select: { groupKey: true; version: true; values: true; createdAt: true };
    }): Promise<PolicyGroupVersionFacts[]>;
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
  return buildPolicyGroupCatalogue(rows, versions, now);
}

let cached: { catalogue: PolicyGroupCatalogue; expiresAt: number } | null = null;
let lastGood: PolicyGroupCatalogue | null = null;
let inFlight: Promise<PolicyGroupCatalogue> | null = null;
let generation = 0;

/** Drop the cached catalogue (called after every local write, and by tests). */
export function invalidatePolicyGroupCatalogue(): void {
  cached = null;
  inFlight = null;
  generation++;
}

/** CACHED, NEVER THROWS — the definitions in force for this process. */
export function loadPolicyGroupCatalogue(): Promise<PolicyGroupCatalogue> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.catalogue);
  if (inFlight) return inFlight;
  const gen = generation;
  const p = (async () => {
    try {
      const catalogue = await readPolicyGroupCatalogue(systemDb as unknown as PolicyGroupCatalogueReadClient);
      if (gen === generation) { cached = { catalogue, expiresAt: Date.now() + CATALOGUE_TTL_MS }; lastGood = catalogue; }
      return catalogue;
    } catch (error) {
      console.error("[policy-group-catalogue] read failed; serving", lastGood ? "the last good catalogue" : "the code catalogue", "—",
        error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "unknown error");
      const fallback = lastGood ?? codeFallbackCatalogue();
      if (gen === generation) cached = { catalogue: fallback, expiresAt: Date.now() + CATALOGUE_FAILURE_RETRY_MS };
      return fallback;
    } finally {
      if (gen === generation) inFlight = null;
    }
  })();
  inFlight = p;
  return p;
}
