/**
 * PATCH /api/credit/update-fico
 * Creates a new CreditScore record for the current user.
 * Body: { score: number, source?: string }
 *
 * CreditScore is user-scoped (not space-scoped) because it is personal
 * identity data. Each call appends a new time-series row — scores are never
 * mutated in place.
 *
 * RLS-PREP-C — the insert runs on the tenant role. `CreditScore` is a
 * user-scoped table (`"userId" = current_fm_user_id()`), so the policy's WITH
 * CHECK is the same statement as the application rule: a row may only be
 * written for the caller. An INSERT the policy refuses RAISES — it cannot
 * return a false success — and the catch below turns it into the 500 it is.
 */

import { NextRequest, NextResponse } from "next/server";
import { withTenantDb } from "@/lib/db/tenant-context";
import { getSpaceContext } from "@/lib/space";
import { requireUser } from "@/lib/session";

export async function PATCH(req: NextRequest) {
  try {
    // SEC-FIX-1 — this route authenticates via getSpaceContext(); add the
    // shared guard so a forced-TOTP-enrolment-pending session is denied at
    // the API layer (the page middleware never runs on /api/*).
    const [, authErr] = await requireUser();
    if (authErr) return authErr;

    const { score, source = "manual" } = await req.json();

    if (typeof score !== "number" || score < 300 || score > 850) {
      return NextResponse.json({ error: "Score must be 300–850" }, { status: 400 });
    }

    const { userId } = await getSpaceContext();

    const record = await withTenantDb(userId, (tx) => tx.creditScore.create({
      data: { userId, score, source },
    }));

    return NextResponse.json({ success: true, score: record.score, recordedAt: record.recordedAt });
  } catch (err) {
    console.error("[credit] update-fico error:", err);
    return NextResponse.json({ error: "Failed to update score" }, { status: 500 });
  }
}
