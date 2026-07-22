/**
 * POST /api/merchant-ops/decide  (MI2 S2 — merge review)
 *
 * Records a human verdict on one candidate pair. Thin orchestration only:
 *   • gate on Merchant Operations Space membership (NOT role === SYSTEM_ADMIN),
 *   • parse/validate the body,
 *   • delegate to Merchant Intelligence (applyMergeReviewDecision), which runs
 *     the merge ENGINE for MERGED and records the decision.
 * No merge logic, no detection logic, no persistence logic lives here.
 *
 * Body: { verdict: "MERGED" | "DISMISSED", survivorKey, absorbedKey,
 *         evidenceTier, evidenceSignal? }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireMerchantOpsMember } from "@/lib/merchant-ops-access";
import { applyMergeReviewDecision } from "@/lib/transactions/merchant-merge-review";

export async function POST(req: NextRequest) {
  const [user, err] = await requireMerchantOpsMember();
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
      user.id,
    );
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "merge review decision failed";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
