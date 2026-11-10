/**
 * lib/platform/intelligence/ai/authz/record-render.server.ts  (Platform AI P4 — the read-time render's area check)
 *
 * `platformAiRenderRecheck(area)` = requireFreshPlatformAccess(area, "READ", { probe: true }):
 * the SAME authoritative decision as the boundary's per-call recheck (authz/recheck.server.ts —
 * which stays NON-probe), but a refusal is not recorded as OBS-009: the operator asked to READ
 * an answer, not that area, so an area they no longer hold simply renders "[no longer
 * available]" (authz/record-render.ts). Every call re-reads the session, grant and 2FA rows;
 * nothing is cached. The CS tier is decided from THIS guard result (incidentAudienceFor — the
 * guard-provenance pin: the argument is destructured from the guard in this function).
 *
 * Passed ONLY to the record renderer (the ask route's live render, the conversations' area
 * access) — never to the turn boundary.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import type { FreshGuard } from "./recheck";

export async function platformAiRenderRecheck(area: PlatformArea): Promise<FreshGuard | null> {
  const [fresh, freshErr] = await requireFreshPlatformAccess(area, "READ", { probe: true });
  if (freshErr || !fresh) return null;
  const csTier = fresh.grant !== null && incidentAudienceFor(fresh)?.audience === "CUSTOMER_SUCCESS";
  return { auth: fresh, csTier };
}
