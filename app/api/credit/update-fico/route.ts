/**
 * PATCH /api/credit/update-fico
 * Creates a new CreditScore record for the current user.
 * Body: { score: number, source?: string }
 *
 * CreditScore is user-scoped (not workspace-scoped) because it is personal
 * identity data. Each call appends a new time-series row — scores are never
 * mutated in place.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";

export async function PATCH(req: NextRequest) {
  try {
    const { score, source = "manual" } = await req.json();

    if (typeof score !== "number" || score < 300 || score > 850) {
      return NextResponse.json({ error: "Score must be 300–850" }, { status: 400 });
    }

    const { userId } = await getWorkspaceContext();

    const record = await db.creditScore.create({
      data: { userId, score, source },
    });

    return NextResponse.json({ success: true, score: record.score, recordedAt: record.recordedAt });
  } catch (err) {
    console.error("[credit] update-fico error:", err);
    return NextResponse.json({ error: "Failed to update score" }, { status: 500 });
  }
}
