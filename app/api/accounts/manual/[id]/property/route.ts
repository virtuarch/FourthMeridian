/**
 * GET   /api/accounts/manual/[id]/property   (Mortgage F9 — owner 2026-11-08)
 * PATCH /api/accounts/manual/[id]/property
 *
 * A manual property's market value, the mortgage / HELOC debts the
 * user linked as secured by it, the DERIVED equity (value − linked secured debt),
 * its value basis, and the double-count prompt — plus the owner's three actions:
 *
 *   PATCH { valueBasis: "MARKET_VALUE" | "EQUITY_ENTERED" | "UNKNOWN" }
 *   PATCH { link:   "<debt account id>" }   — same-Space secured debt only
 *   PATCH { unlink: "<debt account id>" }
 *
 * Authorization: the caller's tenant transaction (RLS). GET = the owner or a
 * viewer with an ACTIVE FULL link (equity only when EVERY linked debt is
 * balance-visible to that viewer — S2 R2). PATCH = owner-only (the PATCH
 * /api/accounts/manual/[id] gate), audited in the same transaction (S2 R1). A debt from another Space or another user's
 * private account answers 404, indistinguishable from a missing one
 * (checkSecuredDebtLink). Net worth is never changed by anything here; nothing is
 * linked or restated without this explicit request.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser }               from "@/lib/session";
import { withTenantDb }              from "@/lib/db/tenant-context";
import { withApiHandler, getClientIp } from "@/lib/api";
import { applyPropertyLinkAction, loadPropertyEquityView } from "@/lib/assets/property-links";
import { parsePropertyAction }       from "@/lib/assets/property-equity";

const NOT_FOUND = () => NextResponse.json({ error: "Asset not found" }, { status: 404 });

export const GET = withApiHandler(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const r = await withTenantDb(user.id, (tx) => loadPropertyEquityView(tx, { propertyId: id, viewerUserId: user.id }));
  if (r.kind !== "ok") return NOT_FOUND();
  return NextResponse.json(r.view);
}, "GET /api/accounts/manual/[id]/property");

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const action = parsePropertyAction(await req.json().catch(() => null));
  if ("error" in action) return NextResponse.json({ error: action.error }, { status: 400 });

  const r = await withTenantDb(user.id, async (tx) => {
    const applied = await applyPropertyLinkAction(tx, { propertyId: id, viewerUserId: user.id, action, ipAddress: getClientIp(req) });
    if (applied.kind !== "ok") return applied;
    return loadPropertyEquityView(tx, { propertyId: id, viewerUserId: user.id });
  });
  if (r.kind === "notFound") return NOT_FOUND();
  if (r.kind === "invalid") return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r.view);
}, "PATCH /api/accounts/manual/[id]/property");
