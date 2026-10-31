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
import type { LifecycleRestriction } from "./lifecycle";
import type { BillableDenialReason } from "./billable-gate-core";
import { RESTRICTION_CODES, restrictionMessage, restrictionStatus } from "./restriction-messages";
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
 * BETA LIFECYCLE — the ONE refusal for paid work under a lifecycle restriction:
 * the owner's wording (lib/entitlements/restriction-messages.ts), its code, 403
 * for a group state and 503 for an unreadable policy. Never "not on your plan".
 */
export function planRestrictedResponse(restriction: LifecycleRestriction, dimension: EntitlementDimensionKey | null = null): NextResponse {
  return NextResponse.json(
    { error: restrictionMessage(restriction), code: RESTRICTION_CODES[restriction], restriction, ...(dimension ? { entitlement: dimension } : {}) },
    { status: restrictionStatus(restriction), headers: NO_STORE },
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
  // BETA LIFECYCLE — off because the group is paused / ended / frozen (or unreadable): say so.
  if (e.lifecycleRestriction != null && d.source === "LIFECYCLE") return planRestrictedResponse(e.lifecycleRestriction, dimension);
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
  if (e.failClosed === true) return planNeedsAttentionResponse(surfaceLabel, null);
  // BETA LIFECYCLE (review fix 1/2) — every caller of this seam is a NEW costly
  // operation (manual refresh, Brief generation, Investments enable): a paused,
  // ended or cost-frozen group, or an unreadable lifecycle, refuses it
  // explicitly — never left to a cooldown that eventually passes or an
  // allowance check that may be switched off.
  if (e.lifecycleRestriction != null) return planRestrictedResponse(e.lifecycleRestriction);
  return null;
}

/**
 * L2 ENFORCEMENT — the HTTP refusal for a billable-gate denial
 * (lib/entitlements/billable-gate.ts). A lifecycle reason (frozen, paused,
 * ended, unreadable policy) gets the owner's lifecycle wording; a missing /
 * invalid assignment (NOT_ENTITLED) or no billing owner (NO_OWNER) gets the
 * "plan needs attention" sentence. Never "Connection limit reached".
 */
export function billableRefusalResponse(reason: BillableDenialReason, surfaceLabel: string, opts: { reassurance?: string } = {}): NextResponse {
  const res = reason === "NOT_ENTITLED" || reason === "NO_OWNER" ? planNeedsAttentionResponse(surfaceLabel, null) : planRestrictedResponse(reason);
  if (!opts.reassurance) return res;
  // A follow-up sentence after the owner's wording (the body keeps code / restriction unchanged).
  return NextResponse.json(
    { ...refusalBodyOf(reason, surfaceLabel), error: `${refusalBodyOf(reason, surfaceLabel).error} ${opts.reassurance}`, reassurance: opts.reassurance },
    { status: res.status, headers: NO_STORE },
  );
}

/** The plain body billableRefusalResponse sends (shared so a reassurance can extend it). */
function refusalBodyOf(reason: BillableDenialReason, surfaceLabel: string): { error: string; code: string; restriction?: LifecycleRestriction } {
  if (reason === "NOT_ENTITLED" || reason === "NO_OWNER") return { error: planNeedsAttentionSentence(surfaceLabel), code: PLAN_NEEDS_ATTENTION_CODE };
  return { error: restrictionMessage(reason), code: RESTRICTION_CODES[reason], restriction: reason };
}

/**
 * BETA LIFECYCLE L2 (owner ruling 2026-10-31) — a refused connect or REPAIR
 * never disconnects anyone: the copy says so.
 */
export const NOTHING_DISCONNECTED_SENTENCE = "Your existing connections stay connected — nothing has been disconnected.";

/** BETA LIFECYCLE — the same refusal under its precise name (new code should call this). */
export const refuseIfBillableRestricted = refuseIfFailClosed;

/**
 * A count dimension as the integer a rate limiter takes. Never below 1 (a zero
 * would mean "always limited"; use a boolean dimension for off) — EXCEPT in the
 * fail-closed state, where a 0 from FAIL_CLOSED_VALUES is the deliberate deny
 * (e.g. maxConnections 0 ⇒ the connection cap refuses every NEW connection),
 * and (BETA LIFECYCLE) under a lifecycle restriction (paused / ended /
 * cost-frozen group), where a 0 from READ_ONLY_VALUES is the same deliberate deny.
 */
export function countLimit(e: EffectiveEntitlements, dimension: EntitlementDimensionKey): number {
  const d = e.dimensions[dimension];
  if (ENTITLEMENT_DIMENSIONS[dimension].kind !== "count") throw new Error(`${dimension} is not a count dimension`);
  const deliberateZero = e.failClosed === true || (e.lifecycleRestriction != null && d.source === "LIFECYCLE");
  return Math.max(deliberateZero ? 0 : 1, Math.floor(Number(d.value)));
}

/** The provenance sentence for one dimension — for a refusal body or an operator view. */
export function whyEntitlement(e: EffectiveEntitlements, dimension: EntitlementDimensionKey): string {
  return explainEntitlement(e.dimensions[dimension]);
}
