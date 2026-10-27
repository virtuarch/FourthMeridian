/**
 * POST /api/merchant-ops/decide  (MI2 S2 — merge review)
 *
 * Records a human verdict on one candidate pair. Thin orchestration only:
 *   • gate on a FRESH MERCHANT_OPS platform grant at WRITE (MERCHANT-OPS
 *     AUTHORITY, 2026-10-06). It used to be MEMBER of an ordinary Space named by
 *     MERCHANT_OPS_SPACE_ID — anyone that Space's admins invited could rewrite
 *     merchant identity for every tenant. Space membership confers nothing here,
 *   • parse/validate the body,
 *   • delegate to Merchant Intelligence (applyMergeReviewDecision), which runs
 *     the merge ENGINE for MERGED and records the decision.
 * No merge logic, no detection logic, no persistence logic lives here.
 *
 * Body: { verdict: "MERGED" | "DISMISSED", survivorKey, absorbedKey,
 *         evidenceTier, evidenceSignal? }
 */

import { NextRequest, NextResponse } from "next/server";
// RLS-C-S6 — fm_system. MerchantMergeDecision is revoked from the tenant role,
// and a merge rewrites merchant identity for EVERY tenant that saw the absorbed
// name; neither is a tenant-scoped act. Gated by the MERCHANT_OPS platform grant
// above. The decision store and the merge engine take their client
// as a parameter, so the authority is chosen here, at the execution phase.
import { systemDb as db } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { applyMergeReviewDecision, MergeReviewIneligibleError } from "@/lib/transactions/merchant-merge-review";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";

export async function POST(req: NextRequest) {
  // Fresh: both verdicts change platform-wide merchant identity state (a merge
  // rewrites it; a dismissal suppresses a future candidate), so the grant is
  // re-read live and a just-revoked operator cannot act inside the session cache.
  const [auth, err] = await requireFreshPlatformAccess("MERCHANT_OPS", "WRITE");
  if (err) return err;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const verdict = body.verdict;
  const survivorKey = body.survivorKey;
  const absorbedKey = body.absorbedKey;
  const evidenceTier = body.evidenceTier;
  const evidenceSignal = body.evidenceSignal;

  if (verdict !== "MERGED" && verdict !== "DISMISSED") {
    return NextResponse.json({ error: "verdict must be MERGED or DISMISSED" }, { status: 400 });
  }
  if (typeof survivorKey !== "string" || typeof absorbedKey !== "string" || typeof evidenceTier !== "string") {
    return NextResponse.json({ error: "survivorKey, absorbedKey, evidenceTier are required strings" }, { status: 400 });
  }
  // SEC-PLAT-2 — both verdicts are consequential, deployment-wide decisions:
  // a structured reason is required before anything is decided.
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) {
    if (e instanceof OperatorActionValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  try {
    const result = await applyMergeReviewDecision(
      db,
      {
        verdict,
        survivorKey,
        absorbedKey,
        evidenceTier,
        evidenceSignal: typeof evidenceSignal === "string" ? evidenceSignal : null,
      },
      {
        actor: operatorActorFrom(auth, "MERCHANT_OPS"),
        reason,
        ipAddress: getClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
    );
    return NextResponse.json(result);
  } catch (e) {
    // SEC-013: only the domain refusal's own sentence reaches the client. Any other
    // error (a Prisma conflict names tables and columns) gets a fixed message.
    if (e instanceof MergeReviewIneligibleError) return NextResponse.json({ error: e.message }, { status: 422 });
    console.error("[merchant-ops/decide] merge review decision failed", e);
    return NextResponse.json(
      { error: "The decision could not be applied because the candidate changed. Refresh and try again." },
      { status: 409 },
    );
  }
}
