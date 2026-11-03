/**
 * GET /api/platform/platform-ops/convergence  (OPS-5 S9)
 *
 * The read surface for Off-ledger Convergence — the operational story across the
 * independent ledgers (lib/platform/convergence). Read-only, aggregate +
 * non-monetary (dates, kinds, subjects, narratives). Accepts `asOf` and `from`
 * (YYYY-MM-DD) window params.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getConvergence } from "@/lib/platform/convergence/convergence";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import type { ConvergenceResult } from "@/lib/platform/convergence/types";

export const runtime = "nodejs";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request): Promise<Response> {
  const [auth, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  // PB-1 R3 — the incident tier follows THIS guard result (PLATFORM_OPS ⇒ identity-free).
  const incidentToken = incidentAudienceFor(auth);
  if (!incidentToken) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const asOfParam = url.searchParams.get("asOf");
  const fromParam = url.searchParams.get("from");
  const asOf = asOfParam && YMD.test(asOfParam) ? asOfParam : undefined;
  const from = fromParam && YMD.test(fromParam) ? fromParam : undefined;

  const result = await getConvergence({ asOf, from, incidentToken });
  return NextResponse.json(result satisfies ConvergenceResult);
}
