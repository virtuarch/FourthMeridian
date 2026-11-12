/**
 * POST /api/platform/customer-success/incidents/[id]/assessment  (Incident drawer PR-D — the Platform AI assessment; S2 09gg (d))
 *
 * The Customer Success twin of …/platform-ops/incidents/[id]/assessment. The design and every rule:
 * lib/platform/intelligence/ai/assessment/incident.ts.
 *
 * GATE CHAIN (in this order; every refusal before any provider call):
 *   0. the incidents pack flag off ⇒ 404 NOT_AVAILABLE (nothing else runs)
 *   1. requireFreshPlatformAccess("CUSTOMER_SUCCESS", "READ") — READ is enough to assess
 *   2. the #352 per-operator limiter
 *   3. the CS token from THIS guard, required to be the CUSTOMER_SUCCESS tier
 *   4. the incident is visible to that token (the drawer's own read) ⇒ else 404
 *   5. kill switch → cost freeze (503, one quiet code) → daily turn cap (429) → $ caps (429 / 503)
 *   6. investigate_incident_cs through the turn boundary, for THIS incident id — the boundary writes the
 *      PLATFORM_AI_RECORD_VIEWED audit row (fail closed) before any record data leaves; the model sees
 *      the customer only as the keyed T1 "user #…" ref, never a name or email
 *   7. the ONE model call (one turn) — framing only
 *
 * NEVER changes incident state; persists nothing (render-only). The ledger rows are the turn's own.
 */

import { NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { env } from "@/lib/env";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
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
  const [auth, err] = await requireFreshPlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) { err.headers.set("Cache-Control", "no-store"); return err; }
  const limited = await limitPlatformMutation(auth.user.id, "cs-incident-ai-assessment");
  if (limited) return limited;
  const token = incidentAudienceFor(auth);
  if (!token || token.audience !== "CUSTOMER_SUCCESS") return NextResponse.json({ error: "Not authorized to read incidents." }, { status: 403, headers: NO_STORE });
  const { id } = await ctx.params;
  const res = await handleIncidentAssessment(incidentAssessmentDeps({
    tier: "cs", operatorId: auth.user.id, incidentId: id,
    recovery: async () => {
      const inv = await incidentAccessors.investigate(token, id, { now: new Date() });
      return inv ? recoveryActionsFor(inv, "cs").map((a) => a.kind) : null;
    },
    access: () => conversationAreaAccess("CUSTOMER_SUCCESS", auth.user.id),
  }));
  return NextResponse.json(res.body, { status: res.status, headers: { ...NO_STORE, ...(res.headers ?? {}) } });
}
