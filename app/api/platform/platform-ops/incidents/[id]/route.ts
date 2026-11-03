/**
 * GET /api/platform/platform-ops/incidents/[id]  (PB-1 Phase 2B — the Ops incident detail)
 *
 * One incident: the verdict and why, the append-only SyncIssueEvent timeline
 * (rendered as stored), the evidence DIGEST (codes and counts), the affected
 * subjects (provider, institution, counts — identity-free), relation and
 * recurrence links, archive state, and the EXISTING recovery routes that apply
 * (resync / request-reauth; each guarded and audited by its own route).
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"); the accessor
 * verifies the minted token before any read. PRIVACY: projected at the "ops"
 * tier (investigation-dto.ts) — never a customer id, `detail`, provider text
 * or the stored evidence.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { incidentAccessors } from "@/lib/platform/incidents/intelligence";
import { incidentDetailDTO, type IncidentDetailDTO } from "@/lib/platform/incidents/investigation-dto";

export const runtime = "nodejs";

export type OpsIncidentDetailResponse = IncidentDetailDTO;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const token = incidentAudienceFor(auth);
  if (!token) return NextResponse.json({ error: "Not authorized to read incidents." }, { status: 403 });
  const { id } = await ctx.params;
  const now = new Date();
  const inv = await incidentAccessors.investigate(token, id, { now });
  if (!inv) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
  return NextResponse.json(incidentDetailDTO(inv, "ops", now) satisfies OpsIncidentDetailResponse);
}
