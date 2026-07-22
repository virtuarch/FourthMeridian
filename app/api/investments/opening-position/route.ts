/**
 * app/api/investments/opening-position/route.ts
 *
 * A7-2 — manual opening-position assertion endpoint. POST records the canonical
 * event + observation pair (lib/investments/opening-position.ts). Behind
 * INVESTMENT_IMPORTS_ENABLED: absent ⇒ 404, zero writes, no user-visible surface.
 *
 * Authorization is the single canonical import rule, enforced entirely by the
 * shared resolveImportableFinancialAccount guard (P1 closeout — import owner
 * doctrine convergence). This IS a detail-mutating write into an investment
 * account, so the guard requires: an ACTIVE, non-deleted SpaceAccountLink for
 * the account in the caller's Space, and either the account owner/creator
 * (inherent authority over their own account) OR a non-owner with FULL
 * visibility + a permitted Space role (OWNER/ADMIN). BALANCE_ONLY/SUMMARY_ONLY
 * non-owners, REVOKED/deleted links, and insufficient roles all fail closed
 * inside the guard. The previously-inlined redundant "FULL even for the owner"
 * check was removed here so this route can never disagree with the guard.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshUser } from "@/lib/session";
import { getSpaceContext } from "@/lib/space";
import { withApiHandler } from "@/lib/api";
import { resolveImportableFinancialAccount } from "@/lib/imports/authorize";
import { assertOpeningPosition, investmentImportsEnabled } from "@/lib/investments/opening-position";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireFreshUser();
  if (err) return err;

  // Feature-flag gate: absent ⇒ the endpoint does not exist.
  if (!investmentImportsEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const {
    financialAccountId, instrumentId, symbol, name, cusip, currency,
    date, quantity, costBasis,
  } = body as Record<string, unknown>;

  if (typeof financialAccountId !== "string" || !financialAccountId) {
    return NextResponse.json({ error: "financialAccountId is required" }, { status: 400 });
  }
  if (typeof date !== "string" || !YMD.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    return NextResponse.json({ error: "quantity must be a finite number" }, { status: 400 });
  }
  if (costBasis != null && (typeof costBasis !== "number" || !Number.isFinite(costBasis))) {
    return NextResponse.json({ error: "costBasis must be a finite number or omitted" }, { status: 400 });
  }
  const hasInstrumentId = typeof instrumentId === "string" && instrumentId.length > 0;
  const hasSymbol = typeof symbol === "string" && symbol.length > 0;
  if (!hasInstrumentId && !hasSymbol) {
    return NextResponse.json({ error: "Provide either instrumentId or symbol" }, { status: 400 });
  }

  // ── Authorize (canonical import rule — owner OR FULL non-owner + role) ──────
  const { spaceId } = await getSpaceContext();
  const access = await resolveImportableFinancialAccount(user.id, spaceId, financialAccountId);
  if (!access.ok) return access.response;

  // ── Write ──────────────────────────────────────────────────────────────────
  const result = await assertOpeningPosition({
    financialAccountId,
    instrument: hasInstrumentId
      ? { instrumentId: instrumentId as string }
      : { symbol: symbol as string, name: (name as string) ?? null, cusip: (cusip as string) ?? null, currency: (currency as string) ?? null },
    date,
    quantity,
    costBasis: (costBasis as number) ?? null,
    userId: user.id,
  });

  if (result.status === "disabled") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (result.status === "conflict") {
    return NextResponse.json(
      { error: "That symbol matches more than one instrument. Select an existing instrument to assert against." },
      { status: 409 },
    );
  }

  return NextResponse.json({
    status: "ok",
    instrumentId:       result.instrumentId,
    instrumentCreated:  result.instrumentCreated ?? false,
    eventId:            result.eventId,
    observationId:      result.observationId,
    supersededEvents:   result.supersededEventIds?.length ?? 0,
    supersededObservations: result.supersededObservationIds?.length ?? 0,
    repair:             result.repair ?? null,
  });
}, "POST /api/investments/opening-position");
