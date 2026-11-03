/**
 * GET /api/platform/platform-ops/incidents  (PB-1 Phase 2B — the Ops incidents list)
 *
 * The Platform Ops incidents workspace and the Operations "broken now" KPI read
 * this ONE route: a status preset (broken-now | needs-verification | history |
 * all — each exactly one intelligence accessor's filter) plus validated filters
 * (severity, provider, operation, code, from/to UTC days within the 13-month
 * archive retention), paged. Parsed by search-core.ts `parseIncidentSearch` —
 * the same parser the URL mirror uses.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"). The audience
 * token is minted from that guard result; the accessor refuses anything else
 * before reading. PRIVACY: rows are projected through investigation-dto.ts at
 * the "ops" tier — identity-free (no customer id, no detail, no evidence JSON).
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { incidentAccessors } from "@/lib/platform/incidents/intelligence";
import { parseIncidentSearch } from "@/lib/platform/incidents/intelligence/search-core";
import { incidentListDTO, type IncidentListDTO } from "@/lib/platform/incidents/investigation-dto";

export const runtime = "nodejs";

export type OpsIncidentListResponse = IncidentListDTO;

export async function GET(req: Request) {
  const [auth, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const token = incidentAudienceFor(auth);
  if (!token) return NextResponse.json({ error: "Not authorized to read incidents." }, { status: 403 });
  const now = new Date();
  const { fromClamped, ...query } = parseIncidentSearch(new URL(req.url).searchParams, now.getTime());
  const result = await incidentAccessors.search(token, query, { now });
  return NextResponse.json(incidentListDTO(result, "ops", now, fromClamped) satisfies OpsIncidentListResponse);
}
