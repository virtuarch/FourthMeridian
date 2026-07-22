/**
 * lib/merchant-ops-access.ts
 *
 * Merchant Operations — MI2 S2 authorization gate (the ratified refinement).
 *
 * Access to the merchant-merge review surface is NOT `role === SYSTEM_ADMIN`.
 * It is membership in the designated Merchant Operations Space. SYSTEM_ADMIN
 * remains the AUTHORITY — it creates that Space, sets MERCHANT_OPS_SPACE_ID, and
 * grants membership — but day-to-day merge review is done by ordinary members of
 * that Space. This is pure authorization orchestration: it holds NO merchant
 * logic and NO merge logic (those live in Merchant Intelligence and the engine).
 *
 * Fails CLOSED: if MERCHANT_OPS_SPACE_ID is unset, nobody is a member of "no
 * space", so the gate denies — access is a deliberate act of configuring the
 * Space and granting membership, never a default-open surface.
 *
 * Reuses the existing membership primitive (requireSpaceRole) so no new
 * authorization model is introduced — internal operations authorize exactly the
 * way customer Spaces already do.
 */

import "server-only";

import type { NextResponse } from "next/server";
import { SpaceMemberRole } from "@prisma/client";
import { env } from "@/lib/env";
import { requireSpaceRole, forbidden, type SessionUser } from "@/lib/session";

/** The configured Merchant Operations Space id, or null when unset (gate closed). */
export function merchantOpsSpaceId(): string | null {
  return env.merchantOpsSpaceId;
}

/**
 * Require that the caller is an ACTIVE member (≥ MEMBER by default) of the
 * designated Merchant Operations Space. Returns the same Go-style tuple the
 * session guards use: `[user, null]` on success, `[null, errorResponse]`
 * otherwise. Denies (403) when the Space is unconfigured — fail closed.
 */
export async function requireMerchantOpsMember(
  minRole: SpaceMemberRole = SpaceMemberRole.MEMBER,
): Promise<[SessionUser, null] | [null, NextResponse]> {
  const spaceId = merchantOpsSpaceId();
  if (!spaceId) return [null, forbidden()];

  const [auth, err] = await requireSpaceRole(spaceId, minRole);
  if (err) return [null, err];
  return [auth.user, null];
}
