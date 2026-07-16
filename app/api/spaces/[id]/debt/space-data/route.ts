/**
 * GET /api/spaces/[id]/debt/space-data?asOf=YYYY-MM-DD[&target=CUR]
 *
 * SD-6A — the runtime binding that activates the canonical Debt workspace contract
 * (DebtSpaceData, lib/debt-space-data.ts). It computes the debt lens AT `asOf` and
 * returns it; the CLIENT hook (useDebtSpaceData) is the composer — it injects the
 * host's already-loaded snapshot series + FICO and runs the PURE
 * assembleDebtSpaceData. This route therefore serves ONLY the one thing the client
 * cannot compute itself: the as-of lens (a DB read through the KD-19 visibility
 * path). It performs NO history clipping, NO KPI math, NO composition.
 *
 * WHY a dedicated route (not the batch /perspectives): closing the Debt temporal
 * gap needs `asOf` threaded into the debt lens, and the batch route is shared with
 * Liquidity + drives the shell trust envelope for every perspective — widening it
 * would move the whole batch. This narrow route keeps the change domain-local: only
 * the debt lens moves onto the as-of path, and only for the Debt workspace.
 *
 * The debt lens already supports as-of (options.asOf ⇒ getAccountsAsOf +
 * buildDebtCompleteness); passing asOf here is what makes it real end-to-end. When
 * asOf is set the result carries a `completeness` envelope (the as-of trust
 * pointer); a present-day asOf simply yields the byte-identical present branch.
 *
 * Membership-gated exactly like /perspectives (ACTIVE member, perspective:read).
 * The engine scope's userId is ALWAYS the requester (visibility is the viewer's).
 * Lens failures never 500 — the engine returns a shaped, code-only error result.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSpaceAction } from "@/lib/spaces/authorize";
import { withApiHandler } from "@/lib/api";
import { computePerspective } from "@/lib/perspective-engine";
import type { LensResult } from "@/lib/perspective-engine";
import { parseReportingCurrencyInput } from "@/lib/spaces/reporting-currency";

// Lens registration — imported for module side effects (same house pattern as the
// batch /perspectives route). A lens is computable only once its module is loaded.
import "@/lib/perspective-engine/lenses/debt";

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

  // Optional display-currency override (MC1 "view as" preview) — same parse as the
  // batch route so the lede verdict/headline recompute in the requested currency.
  const parsedTarget = parseReportingCurrencyInput(req.nextUrl.searchParams.get("target"));
  const targetCurrency = parsedTarget.ok ? parsedTarget.value : undefined;

  // Compute the debt lens AS-OF, always as the requesting viewer. `asOf` puts the
  // lens on the as-of path (completeness envelope stamped); the client composes the
  // rest of DebtSpaceData (history clip, FICO) purely.
  const lens: LensResult = await computePerspective(
    "debt",
    { spaceId, userId },
    { asOf, targetCurrency },
  );

  return NextResponse.json({ lens });
}, "GET /api/spaces/[id]/debt/space-data");
