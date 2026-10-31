/**
 * POST /api/platform/customer-success/notifications/automations/[id]/activate  (Comms Center B2, contract v1 §4.9; v1.1 §6.3)
 *
 * { reason, expectedVersion, body: {} }. The §6.3 checks, in order — the first
 * failure is 409 with its code (and every blocker), nothing written:
 *   state (INVALID_STATE) → token (CONFLICT) → PROTECTED → definition / trigger
 *   AVAILABLE (INVALID_STATE) → no MARKETING (INVALID_STATE) → customer-facing ⇒
 *   a CURRENT owner approval (OWNER_APPROVAL_REQUIRED) → a successful dry run of
 *   THIS version within 7 days (DRY_RUN_REQUIRED).
 * Then ACTIVE, activatedVersion, and a trigger cursor at now (nothing earlier fires).
 *
 * AUTHORIZATION (owner decision O-1): requireFreshPlatformAccess("CUSTOMER_SUCCESS",
 * "CONTROL") — increasing reach is CONTROL. Then the cs-comms-control bucket. The
 * reason-required audit row (COMMS_AUTOMATION_ACTIVATED) commits in the same transaction.
 */

import type { NextRequest } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { readJsonBody, runContent } from "@/lib/notifications/content/http";
import { csCommsControlLimit } from "@/lib/notifications/content/deps";
import { AUTOMATION_BODY_MAX_BYTES, transitionHandler } from "@/lib/notifications/automations/http";
import { automationServices } from "@/lib/notifications/automations/deps";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return runContent({ guard: () => requireFreshPlatformAccess("CUSTOMER_SUCCESS", "CONTROL"), rateLimit: csCommsControlLimit }, async (auth, now) => {
    const body = await readJsonBody(req, AUTOMATION_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    return transitionHandler("ACTIVATE", (await ctx.params).id, body.value, auth, getRequestMeta(req), now, automationServices);
  });
}
