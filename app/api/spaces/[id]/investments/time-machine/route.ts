/**
 * GET /api/spaces/[id]/investments/time-machine?asOf=YYYY-MM-DD[&compareTo=YYYY-MM-DD]
 *
 * A10 — the canonical Investments Time Machine read path, proven end-to-end.
 * Membership-gated (ACTIVE member, any role) exactly like GET
 * /api/spaces/[id]/investments. Visibility is enforced inside the read (KD-21a):
 * getInvestmentsTimeMachine scopes positions AND period flows to the Space's
 * detail-eligible (FULL) account links via the canonical TRANSACTION_DETAIL_VISIBILITY
 * predicate, so a BALANCE_ONLY / SUMMARY_ONLY account never exposes its positions
 * or investment events here.
 *
 * The Perspective Shell owns preset/asOf/compareTo and passes RESOLVED dates
 * here as query params; this route resolves no time state of its own. Returns the
 * canonical InvestmentsTimeMachineResult (holdings + valued portfolio at asOf,
 * plus period flows and a change reconciliation when compareTo is supplied). No
 * access tokens, cursors, or credentials are ever returned.
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole } from "@prisma/client";
import { requireSpaceRole } from "@/lib/session";
import { getInvestmentsTimeMachine } from "@/lib/investments/investments-time-machine";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: spaceId } = await params;

  const [ctx, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  const asOf = req.nextUrl.searchParams.get("asOf");
  const compareToRaw = req.nextUrl.searchParams.get("compareTo");
  if (!asOf || !ISO_DATE.test(asOf)) {
    return NextResponse.json({ error: "asOf query param (YYYY-MM-DD) is required" }, { status: 400 });
  }
  if (compareToRaw != null && !ISO_DATE.test(compareToRaw)) {
    return NextResponse.json({ error: "compareTo must be YYYY-MM-DD" }, { status: 400 });
  }
  if (compareToRaw && compareToRaw >= asOf) {
    return NextResponse.json({ error: "compareTo must be earlier than asOf" }, { status: 400 });
  }

  // ctx.user is unused here — visibility is enforced inside the read via the
  // Space's ACTIVE account links; membership above is the gate.
  void ctx;
  const result = await getInvestmentsTimeMachine({ spaceId, asOf, compareTo: compareToRaw ?? null });
  return NextResponse.json(result);
}
