/**
 * GET /api/merchant-ops/candidates  (MI2 S2 — merge review)
 *
 * Returns the still-PENDING merge candidates for the review surface. Thin: it
 * gates on Merchant Operations Space membership (the ratified refinement — NOT
 * role === SYSTEM_ADMIN) and delegates ALL logic to Merchant Intelligence
 * (getPendingMergeCandidates). No detection, decision, or merge logic here.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireMerchantOpsMember } from "@/lib/merchant-ops-access";
import { getPendingMergeCandidates } from "@/lib/transactions/merchant-merge-review";

export async function GET() {
  const [, err] = await requireMerchantOpsMember();
  if (err) return err;

  const candidates = await getPendingMergeCandidates(db);
  return NextResponse.json({ candidates });
}
