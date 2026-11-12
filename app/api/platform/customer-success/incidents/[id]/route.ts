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
 *
 * "GO TO" NAVIGATION: resolved HERE through the navigation registry's accessor
 * only — `resolveNavigationTarget` with the literal surface "CUSTOMER_SUCCESS"
 * and a MetricAccessToken minted from this function's own guard result — and
 * built from the projected CS DTO itself, so a link names only an id that DTO
 * already exposes (lib/platform/incidents/related-navigation.ts
 * csIncidentNavigationLinks). Any failure ⇒ no links, never a hidden incident.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { env } from "@/lib/env";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { incidentAccessors } from "@/lib/platform/incidents/intelligence";
import { incidentDetailDTO, type IncidentDetailDTO } from "@/lib/platform/incidents/investigation-dto";
import { csIncidentNavigationLinks, navigationOrEmpty } from "@/lib/platform/incidents/related-navigation";
import { metricAccessFor } from "@/lib/platform/intelligence/metrics/access";
import { resolveNavigationTarget } from "@/lib/platform/intelligence/navigation/access";
import { opaqueUserRef } from "@/lib/platform/opaque-user-ref";

export const runtime = "nodejs";

/** Incident state (and, on the CS tier, customer ids): never cached — every response, errors included. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

export type CsIncidentDetailResponse = IncidentDetailDTO;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) { err.headers.set("Cache-Control", "no-store"); return err; }
  const token = incidentAudienceFor(auth);
  if (!token || token.audience !== "CUSTOMER_SUCCESS") return NextResponse.json({ error: "Not authorized to read incidents." }, { status: 403, headers: NO_STORE });
  const { id } = await ctx.params;
  const now = new Date();
  let inv: Awaited<ReturnType<typeof incidentAccessors.investigate>>;
  try { inv = await incidentAccessors.investigate(token, id, { now }); }
  catch { return NextResponse.json({ error: "Incident read failed." }, { status: 500, headers: NO_STORE }); }
  if (!inv) return NextResponse.json({ error: "Incident not found." }, { status: 404, headers: NO_STORE });
  // PRIV-ref (P3): the drawer shows the opaque customer reference, computed here (server-only key).
  const dto = incidentDetailDTO(inv, "cs", now, { subjectRefOf: opaqueUserRef });
  // A navigation failure never hides the incident: any throw (mint, registry, builder) ⇒ no links.
  const navigation = navigationOrEmpty(() => {
    const navToken = metricAccessFor(auth);
    return navToken
      ? csIncidentNavigationLinks(dto, (target, params) => resolveNavigationTarget("CUSTOMER_SUCCESS", navToken, target, params, { now }))
      : [];
  });
  // PR-D: the drawer learns whether the Platform AI assessment exists from the server (pack flag OFF ⇒ nothing renders).
  const body = { ...dto, navigation };
  return NextResponse.json({ ...body, aiAssessmentAvailable: env.isPlatformAiPackIncidentsEnabled } satisfies CsIncidentDetailResponse, { headers: NO_STORE });
}
