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
 */

import "server-only";
import { NextResponse } from "next/server";
import { withTenantDb } from "@/lib/db/tenant-context";
import { ENTITLEMENT_DIMENSIONS, type EntitlementDimensionKey } from "./catalogue";
import { explainEntitlement, loadEffectiveEntitlements, type EffectiveEntitlements } from "./resolve";

export type EntitlementLoader = (userId: string) => Promise<EffectiveEntitlements>;

/** The default loader: one tenant phase, the resolver's one read. */
export const tenantEntitlementLoader: EntitlementLoader = (userId) =>
  withTenantDb(userId, (tx) => loadEffectiveEntitlements(tx, userId));

/** The effective entitlements for the authenticated user. Injectable for tests. */
export function entitlementsForUser(userId: string, load: EntitlementLoader = tenantEntitlementLoader): Promise<EffectiveEntitlements> {
  return load(userId);
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * A 403 when a boolean dimension is off for this customer, else null. The body
 * names the surface in plain words and the dimension (so an operator can map
 * the refusal to the Policy Group), never the policy internals.
 */
export function refuseIfDisabled(
  e: EffectiveEntitlements,
  dimension: EntitlementDimensionKey,
  surfaceLabel: string,
): NextResponse | null {
  const d = e.dimensions[dimension];
  if (ENTITLEMENT_DIMENSIONS[dimension].kind !== "boolean" || d.value === true) return null;
  return NextResponse.json(
    { error: `${surfaceLabel} isn’t available on your plan.`, entitlement: dimension },
    { status: 403, headers: NO_STORE },
  );
}

/** A count dimension as the integer a rate limiter takes. Never below 1 (a zero would mean "always limited"; use a boolean dimension for off). */
export function countLimit(e: EffectiveEntitlements, dimension: EntitlementDimensionKey): number {
  const d = e.dimensions[dimension];
  if (ENTITLEMENT_DIMENSIONS[dimension].kind !== "count") throw new Error(`${dimension} is not a count dimension`);
  return Math.max(1, Math.floor(Number(d.value)));
}

/** The provenance sentence for one dimension — for a refusal body or an operator view. */
export function whyEntitlement(e: EffectiveEntitlements, dimension: EntitlementDimensionKey): string {
  return explainEntitlement(e.dimensions[dimension]);
}
