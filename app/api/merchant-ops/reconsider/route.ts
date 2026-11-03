/**
 * POST /api/merchant-ops/reconsider  (PB-9 — reconsider a dismissed merge candidate)
 *
 * Removes one DISMISSED decision so the detector may propose the pair again.
 * Thin orchestration only, the same shape as /api/merchant-ops/decide:
 *   • gate on a FRESH MERCHANT_OPS platform grant at WRITE — reconsidering
 *     changes platform-wide merchant-identity review state, like a dismissal;
 *   • parse/validate the body and the REQUIRED operator reason;
 *   • delegate to Merchant Intelligence (reconsiderDismissedPair), which deletes
 *     the decision and records MERCHANT_MERGE_RECONSIDERED in one transaction.
 * Nothing is merged; no merchant is touched.
 *
 * Body: { pairKey: string, reason: { code, note? } }
 */

import { NextRequest, NextResponse } from "next/server";
// RLS-C-S6 — fm_system: MerchantMergeDecision is revoked from the tenant role
// and the decision is deployment-wide. Gated by the MERCHANT_OPS grant below.
import { systemDb as db } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { reconsiderDismissedPair, ReconsiderIneligibleError } from "@/lib/transactions/merchant-merge-reconsider";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";

export async function POST(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("MERCHANT_OPS", "WRITE");
  if (err) return err;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const pairKey = body.pairKey;
  if (typeof pairKey !== "string" || pairKey.length === 0 || pairKey.length > 1000) {
    return NextResponse.json({ error: "pairKey is a required string" }, { status: 400 });
  }
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) {
    if (e instanceof OperatorActionValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  try {
    const result = await reconsiderDismissedPair(db, pairKey, {
      actor: operatorActorFrom(auth, "MERCHANT_OPS"),
      reason,
      ipAddress: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json(result);
  } catch (e) {
    // SEC-013: only the domain refusal's own sentence reaches the client.
    if (e instanceof ReconsiderIneligibleError) return NextResponse.json({ error: e.message }, { status: 422 });
    console.error("[merchant-ops/reconsider] reconsider failed", e);
    return NextResponse.json({ error: "The decision could not be reconsidered. Refresh and try again." }, { status: 409 });
  }
}
