/**
 * POST /api/platform/customer-success/notifications/automations/[id]/owner-approval  (Comms Center B2, contract v1.1 §6.4)
 *
 * { reason, expectedVersion, body: {} }. Records the OWNER's approval of THIS
 * automation version against THIS definition version (ownerApprovedVersion /
 * ownerApprovedDefinitionVersion). It does NOT activate: a CS CONTROL operator
 * activates afterwards. Any PATCH (version bump) or code change (definitionVersion
 * bump) voids it automatically. DRAFT or PAUSED only; customer-facing only.
 *
 * AUTHORIZATION (owner decision O-18): requireFreshSystemAdmin() — the owner acts
 * as SYSTEM_ADMIN; a CS CONTROL grant is NOT enough. Then the cs-comms-control
 * bucket. The reason-required audit row (COMMS_AUTOMATION_OWNER_APPROVED) commits
 * in the same transaction.
 */

import type { NextRequest } from "next/server";
import { requireFreshSystemAdmin } from "@/lib/session";
import { getRequestMeta } from "@/lib/api";
import { readJsonBody, runContent, type ContentAuth } from "@/lib/notifications/content/http";
import { csCommsControlLimit } from "@/lib/notifications/content/deps";
import { AUTOMATION_BODY_MAX_BYTES, transitionHandler } from "@/lib/notifications/automations/http";
import { automationServices } from "@/lib/notifications/automations/deps";

export const runtime = "nodejs";

/** The owner gate, in the handler's auth shape (no grant: the SYSTEM_ADMIN role IS the authority). */
async function ownerGate(): Promise<[ContentAuth, null] | [null, Response]> {
  const [user, err] = await requireFreshSystemAdmin();
  if (err) return [null, err];
  return [{ user: { id: user.id, role: user.role }, grant: null }, null];
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return runContent({ guard: () => ownerGate(), rateLimit: csCommsControlLimit }, async (auth, now) => {
    const body = await readJsonBody(req, AUTOMATION_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    return transitionHandler("OWNER_APPROVAL", (await ctx.params).id, body.value, auth, getRequestMeta(req), now, automationServices);
  });
}
