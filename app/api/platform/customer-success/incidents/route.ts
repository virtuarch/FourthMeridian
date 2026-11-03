/**
 * GET /api/platform/customer-success/incidents  (PB-1 Phase 2B — the CS incidents list)
 *
 * The Customer Success incidents workspace (Investigate / History views) reads
 * this ONE route: a status preset (broken-now | needs-verification | history |
 * all — each exactly one intelligence accessor's filter) plus validated filters
 * (severity, provider, operation, code, from/to UTC days within the 13-month
 * archive retention), paged. Parsed by search-core.ts `parseIncidentSearch` —
 * the same parser the URL mirror uses.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"). The audience
 * token is minted from that guard result; the accessor refuses anything else
 * before reading. PRIVACY: rows are projected through investigation-dto.ts at
 * the "cs" tier — the attributed customer id (D4) is the ONLY identity, and only
 * because this route is CUSTOMER_SUCCESS READ; never detail or evidence JSON.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { incidentAccessors } from "@/lib/platform/incidents/intelligence";
import { parseIncidentSearch } from "@/lib/platform/incidents/intelligence/search-core";
import { incidentListDTO, type IncidentListDTO } from "@/lib/platform/incidents/investigation-dto";

export const runtime = "nodejs";

export type CsIncidentListResponse = IncidentListDTO;

export async function GET(req: Request) {
  const [auth, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  const token = incidentAudienceFor(auth);
  if (!token || token.audience !== "CUSTOMER_SUCCESS") return NextResponse.json({ error: "Not authorized to read incidents." }, { status: 403 });
  const now = new Date();
  const { fromClamped, ...query } = parseIncidentSearch(new URL(req.url).searchParams, now.getTime());
  const result = await incidentAccessors.search(token, query, { now });
  return NextResponse.json(incidentListDTO(result, "cs", now, fromClamped) satisfies CsIncidentListResponse);
}
