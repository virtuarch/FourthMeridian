/**
 * POST /api/platform/customer-success/notifications/catalog/[key]/versions/[id]/ai-suggest  (Comms Center B1, contract v1.1 §4)
 *
 * Ask the AI to POLISH or CHECK version [id]: { body: { mode, tone? }, reason? }.
 * Only the template text and placeholder NAMES are sent. The output is checked
 * server-side and returned as a SUGGESTION (200), or rejected (422
 * SUGGESTION_REJECTED, issues only, no text). It never writes a version: the
 * operator accepts by saving a new draft (source AI_SUGGESTION).
 * 503 AI_UNAVAILABLE { reason: KILL_SWITCH | COST_FREEZE | ALLOWANCE | PROVIDER }.
 * 409 PROTECTED | NOT_EDITABLE; 404 when [id] is not a version of this key.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"), then the
 * cs-comms-ai bucket (10 per 10 min). The COMMS_TEMPLATE_AI_SUGGESTED audit row
 * and the CommsAiSuggestion row commit together.
 */

import type { NextRequest } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { WRITE_BODY_MAX_BYTES, aiSuggestHandler, readJsonBody, runContent } from "@/lib/notifications/content/http";
import { contentServices, csCommsAiLimit } from "@/lib/notifications/content/deps";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string; id: string }> }): Promise<Response> {
  return runContent({ guard: () => requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE"), rateLimit: csCommsAiLimit }, async (auth, now) => {
    const body = await readJsonBody(req, WRITE_BODY_MAX_BYTES);
    if (!body.ok) return body.res;
    const { key, id } = await ctx.params;
    return aiSuggestHandler(key, id, body.value, auth, getRequestMeta(req), now, contentServices);
  });
}
