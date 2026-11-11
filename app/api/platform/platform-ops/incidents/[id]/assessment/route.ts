/**
 * POST /api/platform/platform-ops/incidents/[id]/assessment  (Incident drawer PR-D — the Platform AI assessment; S2 09gg (d))
 *
 * One manual "Assess" on one incident ⇒ five server-written answers (+ at most one checked framing
 * sentence from the model). The design and every rule: lib/platform/intelligence/ai/assessment/incident.ts.
 *
 * GATE CHAIN (in this order; every refusal before any provider call):
 *   0. the incidents pack flag (PLATFORM_AI_ENABLED + PLATFORM_AI_PACK_INCIDENTS_ENABLED) off ⇒ 404
 *      NOT_AVAILABLE (nothing else runs: no session read, no ledger read, no provider)
 *   1. requireFreshPlatformAccess("PLATFORM_OPS", "READ") — READ is enough to assess (it changes nothing)
 *   2. the #352 per-operator limiter (it is a POST that spends)
 *   3. the Ops token from THIS guard, at the Ops tier (atOpsTier: break-glass never reaches identity)
 *   4. the incident is visible to that token (the drawer's own read) ⇒ else 404
 *   5. kill switch → cost freeze (503, one quiet code) → daily turn cap (429) → $ caps (429 / 503)
 *   6. investigate_incident (identity-free, OPS tier) through the turn boundary, for THIS incident id
 *   7. the ONE model call (one turn) — framing only
 *
 * NEVER changes incident state; persists nothing (render-only). The ledger rows are the turn's own.
 */

import { NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { env } from "@/lib/env";
import { atOpsTier, incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { incidentAccessors } from "@/lib/platform/incidents/intelligence";
import { recoveryActionsFor } from "@/lib/platform/incidents/investigation-dto";
import { NOT_AVAILABLE_BODY } from "@/lib/platform/intelligence/ai/core";
import { handleIncidentAssessment } from "@/lib/platform/intelligence/ai/assessment/incident";
import { incidentAssessmentDeps } from "@/lib/platform/intelligence/ai/assessment/incident.server";
import { conversationAreaAccess } from "@/app/api/platform/ai/conversations/area-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  // 0. The pack flag: OFF ⇒ nothing else runs.
  if (!env.isPlatformAiPackIncidentsEnabled) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 404, headers: NO_STORE });
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "READ");
  if (err) { err.headers.set("Cache-Control", "no-store"); return err; }
  const limited = await limitPlatformMutation(auth.user.id, "incident-ai-assessment");
  if (limited) return limited;
  const token = atOpsTier(incidentAudienceFor(auth));
  if (!token) return NextResponse.json({ error: "Not authorized to read incidents." }, { status: 403, headers: NO_STORE });
  const { id } = await ctx.params;
  const res = await handleIncidentAssessment(incidentAssessmentDeps({
    tier: "ops", operatorId: auth.user.id, incidentId: id,
    recovery: async () => {
      const inv = await incidentAccessors.investigate(token, id, { now: new Date() });
      return inv ? recoveryActionsFor(inv, "ops").map((a) => a.kind) : null;
    },
    access: () => conversationAreaAccess("PLATFORM_OPS", auth.user.id),
  }));
  return NextResponse.json(res.body, { status: res.status, headers: { ...NO_STORE, ...(res.headers ?? {}) } });
}
