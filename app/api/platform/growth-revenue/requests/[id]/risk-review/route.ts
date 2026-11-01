/**
 * /api/platform/growth-revenue/requests/[id]/risk-review  (Beta-request risk)
 *
 * An operator's verdict on a request's ADVISORY risk signals
 * (lib/platform/growth/beta-risk-core.ts).
 *
 *   GET   the request's verdict history, newest first.
 *         requirePlatformAccess("GROWTH_REVENUE", "READ").
 *   POST  append one verdict.
 *         requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE"), rate limited.
 *         Body: { status: "LEGITIMATE" | "SUSPICIOUS" | "UNREVIEWED",
 *                 reason: { code, note? }, note? }
 *
 * The verdict row and its BETA_REQUEST_RISK_REVIEWED operator-action audit row
 * (reason-required) commit in ONE transaction. The request's status, decision
 * fields and invite token are never touched, and the heuristic evidence is
 * never stored over — a verdict is advisory bookkeeping, not a decision.
 *
 * ONE ENFORCED EFFECT (owner ruling 2026-11-01, the suspected-abuse lock): on a
 * DENIED request, a latest verdict of SUSPICIOUS makes the denial final for every
 * issuance path (single approve, bulk, direct invite) — lib/platform/growth/
 * invitation-issue.ts. Recording a newer LEGITIMATE or UNREVIEWED verdict here
 * (fresh GROWTH_REVENUE WRITE, reason required, audited) is the deliberate clear.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess, requirePlatformAccess } from "@/lib/platform/authorize";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { limitByUser } from "@/lib/rate-limit";
import { isBetaRiskReviewStatus, loadBetaRiskReviewHistory, recordBetaRiskReview } from "@/lib/platform/growth/beta-risk-review";
import { BETA_RISK_REVIEW_STATUSES, type BetaRiskReviewHistoryResponse } from "@/lib/platform/growth/beta-risk-types";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;
  const { id } = await ctx.params;
  const history = await loadBetaRiskReviewHistory(id);
  if (!history) return NextResponse.json({ error: "Request not found." }, { status: 404, headers: NO_STORE });
  return NextResponse.json(history satisfies BetaRiskReviewHistoryResponse, { headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "growth-beta-risk-review", { limit: 30, windowSec: 60 });
  if (limited) return limited;

  // Parsed FIRST, so a malformed verdict never reaches the database.
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be { status, reason: { code, note? }, note? }." }, { status: 400, headers: NO_STORE });
  }
  if (!isBetaRiskReviewStatus(body.status)) {
    return NextResponse.json({ error: `Status must be one of ${BETA_RISK_REVIEW_STATUSES.join(", ")}.` }, { status: 400, headers: NO_STORE });
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return NextResponse.json({ error: "Note must be a string." }, { status: 400, headers: NO_STORE });
  }
  const { id } = await ctx.params;

  try {
    const reason = parseOperatorReason(body.reason);
    const outcome = await recordBetaRiskReview({
      requestId: id,
      status: body.status,
      reason,
      note: typeof body.note === "string" ? body.note : null,
      actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
      ipAddress: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    if (!outcome.ok) return NextResponse.json({ error: "Request not found." }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ success: true, review: outcome.review }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof OperatorActionValidationError) return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE });
    throw e;
  }
}
