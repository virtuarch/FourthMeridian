/**
 * lib/platform/intelligence/ai/authz/recheck.server.ts  (Platform AI P2 — THE injected per-call recheck)
 *
 * `platformAiFreshRecheck(area)` = requireFreshPlatformAccess(area, "READ") — NON-probe
 * (design §6.2: a mid-turn revocation is a real OBS-009 denial and is recorded). Every
 * call re-reads the live session row, the grant row and the holder's 2FA state; nothing
 * is cached here. The CS tier is decided from THIS guard result (incidentAudienceFor —
 * the guard-provenance pin: the argument is destructured from the guard in this function).
 *
 * Passed by the ask route and the conversations' turn runner into the turn boundary
 * (authz/boundary.ts → authz/recheck.ts createTurnScope). Not called anywhere else.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import type { FreshGuard } from "./recheck";

export async function platformAiFreshRecheck(area: PlatformArea): Promise<FreshGuard | null> {
  const [fresh, freshErr] = await requireFreshPlatformAccess(area, "READ");
  if (freshErr || !fresh) return null;
  // grant null (break-glass) is refused by the scope rule anyway; it never earns a tier here.
  const incidentToken = fresh.grant !== null ? incidentAudienceFor(fresh) : null;
  const csTier = incidentToken?.audience === "CUSTOMER_SUCCESS";
  // P5: the token rides with the guard it was minted from (a CS-tier pack reader needs it; never kept).
  return { auth: fresh, csTier, incidentToken };
}
