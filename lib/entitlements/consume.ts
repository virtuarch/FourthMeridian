/**
 * lib/entitlements/consume.ts  (P1 HUMAN OPERABILITY — the product-route seam)
 *
 * HOW A PRODUCT ROUTE ASKS WHAT THIS CUSTOMER MAY USE. One loader, one refusal
 * shape, one way to turn a dimension into a rate-limit count — so the chat,
 * Brief and export routes read the SAME authority instead of carrying a literal
 * each and a `role !== "SYSTEM_ADMIN"` exemption that exempted nobody who can
 * reach the product (the role wall keeps SYSTEM_ADMIN off /dashboard).
 *
 * AUTHORITY: the read runs on the TENANT role inside one short `withTenantDb`
 * phase — the customer may SELECT their own CustomerPolicyAssignment under RLS
 * (migration 20261008000000), and that phase spans no network round trip. The
 * resolver itself is pure (lib/entitlements/resolve.ts); the platform ceilings
 * are already applied by the time a value reaches a route, so no value a route
 * reads here can exceed them.
 *
 * POLICY EDITOR — the group DEFINITIONS (not the customer's row) come from the
 * cached, never-throwing catalogue loader (lib/platform/policies/
 * policy-group-catalogue.ts) through `entitlementLoadOptions().loadCatalogue`:
 * deployment configuration on fm_system, so the tenant role needs no grant on
 * the definition tables. Every production caller already passes
 * entitlementLoadOptions(), so every surface resolves the same definitions.
 */

import "server-only";
import { planNeedsAttentionSentence, planUnavailableSentence } from '@/lib/ai/conversation/refusal-sentences';
import { NextResponse } from "next/server";
import { withTenantDb } from "@/lib/db/tenant-context";
import { env } from "@/lib/env";
import { ENTITLEMENT_DIMENSIONS, type EntitlementDimensionKey } from "./catalogue";
import { explainEntitlement, loadEffectiveEntitlements, type EffectiveEntitlements, type ResolveOptions } from "./resolve";
import { loadPolicyGroupCatalogue } from "@/lib/platform/policies/policy-group-catalogue";

export type EntitlementLoader = (userId: string) => Promise<EffectiveEntitlements>;

/**
 * FAIL CLOSED (owner ruling, 2026-10-30) — the ONE place the rollout switch
 * (and, POLICY EDITOR, the group-definition loader) reaches the resolver. Every production caller of `loadEffectiveEntitlements`
 * passes this, so enforcement and every operator view resolve the same way.
 */
export function entitlementLoadOptions(): ResolveOptions {
  return { failClosed: env.isPolicyAssignmentFailClosed, loadCatalogue: loadPolicyGroupCatalogue };
}

/** The default loader: one tenant phase, the resolver's one read. */
export const tenantEntitlementLoader: EntitlementLoader = (userId) =>
  withTenantDb(userId, (tx) => loadEffectiveEntitlements(tx, userId, entitlementLoadOptions()));

/** The effective entitlements for the authenticated user. Injectable for tests. */
export function entitlementsForUser(userId: string, load: EntitlementLoader = tenantEntitlementLoader): Promise<EffectiveEntitlements> {
  return load(userId);
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The refusal code a fail-closed refusal carries (the customer sees the sentence; operators map the code). */
export const PLAN_NEEDS_ATTENTION_CODE = "PLAN_NEEDS_ATTENTION" as const;

/** The 403 body every fail-closed refusal shares: honest, non-alarming, no policy internals. */
function planNeedsAttentionResponse(surfaceLabel: string, dimension: EntitlementDimensionKey | null): NextResponse {
  return NextResponse.json(
    { error: planNeedsAttentionSentence(surfaceLabel), code: PLAN_NEEDS_ATTENTION_CODE, ...(dimension ? { entitlement: dimension } : {}) },
    { status: 403, headers: NO_STORE },
  );
}

/**
 * A 403 when a boolean dimension is off for this customer, else null. The body
 * names the surface in plain words and the dimension (so an operator can map
 * the refusal to the Policy Group), never the policy internals. When the
 * customer is FAIL CLOSED (missing/invalid assignment), the sentence says the
 * plan needs attention instead of "not on your plan" — same status.
 */
export function refuseIfDisabled(
  e: EffectiveEntitlements,
  dimension: EntitlementDimensionKey,
  surfaceLabel: string,
): NextResponse | null {
  const d = e.dimensions[dimension];
  if (ENTITLEMENT_DIMENSIONS[dimension].kind !== "boolean" || d.value === true) return null;
  if (e.failClosed === true) return planNeedsAttentionResponse(surfaceLabel, dimension);
  return NextResponse.json(
    { error: planUnavailableSentence(surfaceLabel), entitlement: dimension },
    { status: 403, headers: NO_STORE },
  );
}

/**
 * FAIL CLOSED — a 403 for a NEW costly operation (AI generation, manual
 * refresh) when the customer's assignment is missing or invalid under the
 * rollout switch, else null. Reading existing records never calls this.
 * Explicit rather than relying on a 0 quota alone: the rate limiter is off in
 * dev/test, shadow-able and fails open on a store error, and a cooldown never
 * refuses a connection that was never manually refreshed — none of those may
 * be what stands between a broken assignment and a paid call.
 */
export function refuseIfFailClosed(e: EffectiveEntitlements, surfaceLabel: string): NextResponse | null {
  return e.failClosed === true ? planNeedsAttentionResponse(surfaceLabel, null) : null;
}

/**
 * A count dimension as the integer a rate limiter takes. Never below 1 (a zero
 * would mean "always limited"; use a boolean dimension for off) — EXCEPT in the
 * fail-closed state, where a 0 from FAIL_CLOSED_VALUES is the deliberate deny
 * (e.g. maxConnections 0 ⇒ the connection cap refuses every NEW connection).
 */
export function countLimit(e: EffectiveEntitlements, dimension: EntitlementDimensionKey): number {
  const d = e.dimensions[dimension];
  if (ENTITLEMENT_DIMENSIONS[dimension].kind !== "count") throw new Error(`${dimension} is not a count dimension`);
  return Math.max(e.failClosed === true ? 0 : 1, Math.floor(Number(d.value)));
}

/** The provenance sentence for one dimension — for a refusal body or an operator view. */
export function whyEntitlement(e: EffectiveEntitlements, dimension: EntitlementDimensionKey): string {
  return explainEntitlement(e.dimensions[dimension]);
}
