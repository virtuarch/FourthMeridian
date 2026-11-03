/**
 * GET /api/platform/customer-success/incidents/[id]  (PB-1 Phase 2B — the CS incident detail)
 *
 * One incident: the verdict and why, the append-only SyncIssueEvent timeline
 * (rendered as stored), the evidence DIGEST (codes and counts), the affected
 * subjects (provider, institution, counts — and, on this tier only, the
 * attributed customer id), relation and recurrence links, archive state, and
 * the EXISTING recovery route that applies (the customer's Refresh all,
 * CUSTOMER_SUCCESS WRITE, fresh; guarded and audited by its own route).
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"); the accessor
 * verifies the minted token before any read. PRIVACY: projected at the "cs"
 * tier (investigation-dto.ts) — never `detail`, provider text or the stored
 * evidence.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { incidentAccessors } from "@/lib/platform/incidents/intelligence";
import { incidentDetailDTO, type IncidentDetailDTO } from "@/lib/platform/incidents/investigation-dto";

export const runtime = "nodejs";

export type CsIncidentDetailResponse = IncidentDetailDTO;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  const token = incidentAudienceFor(auth);
  if (!token || token.audience !== "CUSTOMER_SUCCESS") return NextResponse.json({ error: "Not authorized to read incidents." }, { status: 403 });
  const { id } = await ctx.params;
  const now = new Date();
  const inv = await incidentAccessors.investigate(token, id, { now });
  if (!inv) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
  return NextResponse.json(incidentDetailDTO(inv, "cs", now) satisfies CsIncidentDetailResponse);
}
