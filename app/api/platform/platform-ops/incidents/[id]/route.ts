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
 *
 * RELATED NAVIGATION: the drawer's "Go to" links are resolved HERE, through
 * the navigation registry's accessor only (`resolveNavigationTarget` with the
 * string-literal surface "PLATFORM_OPS" and a MetricAccessToken minted from
 * this function's own guard result). A refused target is omitted
 * (lib/platform/incidents/related-navigation.ts); the client builds no href.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { incidentAccessors } from "@/lib/platform/incidents/intelligence";
import { incidentDetailDTO, type IncidentDetailDTO } from "@/lib/platform/incidents/investigation-dto";
import { incidentNavigationLinks, navigationOrEmpty } from "@/lib/platform/incidents/related-navigation";
import { metricAccessFor } from "@/lib/platform/intelligence/metrics/access";
import { resolveNavigationTarget } from "@/lib/platform/intelligence/navigation/access";

export const runtime = "nodejs";

/** Incident state (and, on the CS tier, customer ids): never cached — every response, errors included. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

export type OpsIncidentDetailResponse = IncidentDetailDTO;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) { err.headers.set("Cache-Control", "no-store"); return err; }
  const token = incidentAudienceFor(auth);
  if (!token) return NextResponse.json({ error: "Not authorized to read incidents." }, { status: 403, headers: NO_STORE });
  const { id } = await ctx.params;
  const now = new Date();
  let inv: Awaited<ReturnType<typeof incidentAccessors.investigate>>;
  try { inv = await incidentAccessors.investigate(token, id, { now }); }
  catch { return NextResponse.json({ error: "Incident read failed." }, { status: 500, headers: NO_STORE }); }
  if (!inv) return NextResponse.json({ error: "Incident not found." }, { status: 404, headers: NO_STORE });
  // A navigation failure never hides the incident: any throw (mint, registry, builder) ⇒ no links.
  const navigation = navigationOrEmpty(() => {
    const navToken = metricAccessFor(auth);
    return navToken
      ? incidentNavigationLinks(
        { verdict: inv.verdict, itemCount: inv.affected.itemCount, recurrences: inv.recurrences, component: inv.component ?? null },
        (target, params) => resolveNavigationTarget("PLATFORM_OPS", navToken, target, params, { now }),
      )
      : [];
  });
  return NextResponse.json({ ...incidentDetailDTO(inv, "ops", now), navigation } satisfies OpsIncidentDetailResponse, { headers: NO_STORE });
}
