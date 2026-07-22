/**
 * GET /api/spaces/[id]/liquidity/space-data?asOf=YYYY-MM-DD[&compareTo=YYYY-MM-DD]
 *
 * SD-6B — the runtime binding that activates the canonical Liquidity workspace
 * contract (LiquiditySpaceData, lib/liquidity/space-data.ts) end-to-end. It serves
 * the WHOLE composed contract through the ONE historical-liquidity authority
 * (loadLiquiditySpaceData), so the Liquidity Workspace reads current + atAsOf +
 * atCompareTo + delta + trust from a single canonical envelope:
 *
 *   current     → computePerspective("liquidity")           — the LIVE lens (anchor)
 *   atAsOf      → splice engine @ asOf   (getAccountsAsOf + getInvestmentValueAsOf)
 *   atCompareTo → splice engine @ compareTo
 *   delta       → per-tier (atAsOf − atCompareTo), credit excluded from net
 *   trust       → the atAsOf completeness re-surfaced
 *
 * This route resolves NO time state and computes NOTHING itself — the loader is the
 * single authority (no valuation, no classifier, no liquidity math here). The client
 * hook (useLiquiditySpaceData) synthesizes the PRESENT-DAY contract from the host's
 * already-fetched lens without a round-trip; this route serves only the HISTORICAL
 * read (asOf < today, and/or a compareTo comparison) the client cannot compute.
 *
 * Crypto exactly once is a property of the engine (the splice REPLACES a wallet's
 * held-flat estimate with its A8 value; there is no parallel digital-asset bucket) —
 * this route inherits that guarantee unchanged.
 *
 * Membership-gated exactly like the batch /perspectives route (ACTIVE member,
 * perspective:read). The engine scope's userId is ALWAYS the requester (visibility
 * is the viewer's; enforced INSIDE the loaders).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSpaceAction } from "@/lib/spaces/authorize";
import { withApiHandler } from "@/lib/api";
import { loadLiquiditySpaceData } from "@/lib/liquidity/space-data";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id: spaceId } = await params;
  if (!spaceId) return NextResponse.json({ error: "Missing space id" }, { status: 400 });

  // ── Membership guard (any ACTIVE member) — same action as /perspectives ─────
  const [auth, err] = await requireSpaceAction(spaceId, "perspective:read");
  if (err) return err;
  const userId = auth.user.id;

  const asOf = req.nextUrl.searchParams.get("asOf");
  if (!asOf || !ISO_DATE.test(asOf)) {
    return NextResponse.json({ error: "asOf query param (YYYY-MM-DD) is required" }, { status: 400 });
  }
  const compareToRaw = req.nextUrl.searchParams.get("compareTo");
  if (compareToRaw != null && !ISO_DATE.test(compareToRaw)) {
    return NextResponse.json({ error: "compareTo must be YYYY-MM-DD" }, { status: 400 });
  }
  if (compareToRaw && compareToRaw >= asOf) {
    return NextResponse.json({ error: "compareTo must be earlier than asOf" }, { status: 400 });
  }

  // The whole composed contract, through the single canonical loader. It runs the
  // splice engine at asOf (and compareTo when given), reuses the live lens for
  // `current`, and assembles delta + trust — this route composes / clips NOTHING.
  const data = await loadLiquiditySpaceData(
    { spaceId, userId },
    { asOf, compareTo: compareToRaw ?? null },
  );

  return NextResponse.json(data);
}, "GET /api/spaces/[id]/liquidity/space-data");
