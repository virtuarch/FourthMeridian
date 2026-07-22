/**
 * POST /api/spaces/[id]/wealth/amend  (Wealth-timeline amendment system — Phase 2)
 *
 * Deliberately rebuild an already-written historical SpaceSnapshot range for a
 * PERSONAL space. Two modes on one endpoint:
 *   • { preview: true }  → READ-ONLY. Returns the per-day before→after diff so
 *                          the UI can show it before the user commits. No writes.
 *   • { consent: true }  → the consented commit: applies the amendment
 *                          (PENDING→APPLIED), rewrites the rows, stores the
 *                          per-day breakdown, writes an AuditLog entry.
 *
 * OWNER-only (a personal space's sole owner is its OWNER). SHARED spaces are
 * rejected — their two-tier approval flow is Phase 3. All amendment logic lives
 * in lib/snapshots/snapshot-amendment.ts; this route is thin: auth + parse +
 * delegate.
 *
 * Body: { accountId, kind, fromDate: "YYYY-MM-DD", toDate: "YYYY-MM-DD",
 *         preview?: boolean, consent?: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSpaceRole } from "@/lib/session";
import { SpaceMemberRole, SnapshotAmendmentKind } from "@prisma/client";
import { withApiHandler } from "@/lib/api";
import { previewAmendment, applyAmendment, SharedSpaceAmendmentError } from "@/lib/snapshots/snapshot-amendment";

const VALID_KINDS = new Set<string>(Object.values(SnapshotAmendmentKind));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  // Personal space's sole owner is its OWNER; SHARED gating is Phase 3 (also
  // rejected defensively by the library).
  const [auth, err] = await requireSpaceRole(id, SpaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountId = body.accountId;
  const kind = body.kind;
  const fromDate = body.fromDate;
  const toDate = body.toDate;

  if (typeof accountId !== "string" || accountId.length === 0) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
    return NextResponse.json({ error: `kind must be one of ${[...VALID_KINDS].join(", ")}` }, { status: 400 });
  }
  if (typeof fromDate !== "string" || !ISO_DATE.test(fromDate) || typeof toDate !== "string" || !ISO_DATE.test(toDate)) {
    return NextResponse.json({ error: "fromDate and toDate must be YYYY-MM-DD" }, { status: 400 });
  }
  if (fromDate > toDate) {
    return NextResponse.json({ error: "fromDate must be ≤ toDate" }, { status: 400 });
  }

  const request = {
    spaceId: id,
    financialAccountId: accountId,
    kind: kind as SnapshotAmendmentKind,
    fromDate,
    toDate,
    requestedByUserId: user.id,
  };

  try {
    // Apply only on explicit consent; every other call is a read-only preview.
    if (body.consent === true) {
      const result = await applyAmendment(request);
      return NextResponse.json(result);
    }
    const preview = await previewAmendment(request);
    return NextResponse.json(preview);
  } catch (e) {
    if (e instanceof SharedSpaceAmendmentError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    const message = e instanceof Error ? e.message : "amendment failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}, "POST /api/spaces/[id]/wealth/amend");
