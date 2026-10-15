/**
 * GET /api/accounts/manual/[id]/valuations   (RWA-2A)
 *
 * One manual asset's valuation history: the user's recorded anchors (one per
 * date, the same-day rule applied), the same-day rows they replaced, the
 * acquisition facts, and a bounded chart series whose every point names its
 * basis — `recorded` (a value the user entered for that date), `modeled`
 * (straight-line between two recorded values — NOT an observed price) or
 * `carried` (the latest estimate carried forward, never projected).
 *
 * Authorization: the caller's tenant transaction (RLS) AND the owner-or-FULL
 * rule in lib/assets/valuations.ts — a BALANCE_ONLY viewer, a non-member and a
 * missing asset all get the same 404, so the route discloses nothing about an
 * asset the caller may not see in full.
 *
 * Read-only: nothing modeled is ever written anywhere.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser }               from "@/lib/session";
import { withTenantDb }              from "@/lib/db/tenant-context";
import { withApiHandler }            from "@/lib/api";
import { loadValuationHistory }      from "@/lib/assets/valuations";
import { isoDateOf }                 from "@/lib/assets/valuation-series.core";

export const GET = withApiHandler(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const today = isoDateOf(new Date());
  const result = await withTenantDb(user.id, (tx) =>
    loadValuationHistory(tx, { financialAccountId: id, viewerUserId: user.id, today }));
  if (result.kind === "forbidden") {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  const h = result.history;
  return NextResponse.json({
    accountId: h.accountId,
    currency:  h.currency,
    today,
    acquisition: h.profile ? {
      acquisitionDate:              h.profile.acquisitionDate,
      purchasePrice:                h.profile.purchasePrice,
      purchasePriceIsStartingValue: h.profile.purchasePriceIsStartingValue,
    } : null,
    startDate: h.resolved.startDate,
    anchors:   h.resolved.anchors.map((a) => ({
      date: a.date, value: a.value, kind: a.kind, recordedAt: a.recordedAt ?? null,
    })),
    superseded: h.resolved.superseded.map((s) => ({
      date: s.effectiveDate, value: s.value, recordedAt: s.recordedAt,
    })),
    excluded: h.resolved.excluded,
    series:   h.series,
    modeled:  h.modeled,
  });
}, "GET /api/accounts/manual/[id]/valuations");
