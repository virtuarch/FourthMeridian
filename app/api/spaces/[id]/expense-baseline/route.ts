/**
 * GET /api/spaces/[id]/expense-baseline
 *
 * v2.6-ASSESS-4 — the Space's RESOLVED monthly-expense baseline. SPACE-LEVEL,
 * deliberately: it is a shared UNIT, not one surface's input.
 *
 * ── Different questions, one unit ───────────────────────────────────────────
 *
 * Two surfaces express an answer in "months of my expenses" while asking
 * genuinely different financial questions:
 *
 *   Overview EF hero      "How much of my emergency-fund TARGET have I built?"
 *                         — goal progress over a DEDICATED savings buffer
 *                           (emergency_fund_progress: requires accountTypes
 *                           ["savings"], tab GOALS, targetMonths 3/6/9/12)
 *
 *   Liquidity workspace   "If income stopped, how long could I last on money I
 *                          can reach RIGHT NOW?" — runway over ALL reachable
 *                          cash, graded CRITICAL → EXCELLENT
 *
 * Those questions keep separate authorities: different populations, different
 * numerators, different verdicts. What they must NOT keep separate is the unit
 * they are both denominated in. "A month of my expenses" has to mean one amount
 * on a Space, whichever question is asking — otherwise the two figures are not
 * merely different answers, they are answers in different currencies.
 *
 * Hence: Space-level route, one authority, both consumers. It lived under
 * /liquidity/ when only one surface used it; that path implied ownership the
 * figure never had.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * v2.6-ASSESS-2 gave the baseline one authority — DECLARED (the user's
 * `emergency_fund_progress` figure) outranks MEASURED (the reliable-month
 * average), and a non-positive figure is a refusal. The assessment engine
 * consumed it immediately; the client surfaces could not, because the two
 * candidate figures live on opposite sides of the client/server boundary: the
 * declared one arrives with the section config, and the measured one requires
 * the transactions assembler.
 *
 * ⚠️ The MEASURED rung is not an invention of this arc. The widget's own config
 * hint has always said the declared figure "will auto-populate from the
 * monthly_expenses widget when that widget is built" — a derived monthly-expense
 * source was always the intent; it simply never existed until
 * `computeAverageMonthlySpending` did.
 *
 * So the workspace showed NOTHING whenever a Space had only a measurement —
 * every Space on the corpus — while the engine graded the same position and told
 * the AI about it (Chris' Space: "1.6 months", a WARNING, that no product surface
 * mentioned).
 *
 * This route closes that: it resolves the baseline SERVER-side, through the one
 * authority, and hands back the answer plus WHICH rung produced it. The client
 * renders it. Nothing is re-derived in React.
 *
 * ── Why a route and not the mount payload ───────────────────────────────────
 *
 * The mount hydration doctrine (lib/space/mount-payload-boundary.test.ts) rejects
 * "workspace analytics / perspectives (computed projections)" from the initial
 * payload and says they stay "a workspace responsibility (lazy, canonical
 * loader)". A transaction-derived average is exactly that, so it is fetched
 * lazily — only when a surface that needs it is actually on screen — rather than
 * loaded on every Space mount for every Space type.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * No numerator, no classification, no thresholds. It returns a denominator and
 * its provenance. Coverage months are still `cashNow / baseline.amount` in the
 * workspace, over the reachable-cash numerator that surface has always used, and
 * the CRITICAL/WARNING/SAFE grading remains the assessment engine's alone.
 *
 * Security: caller must be an ACTIVE member (VIEWER+), like every other
 * Space-scoped read. The measured figure is derived from the caller's own
 * visibility-gated transaction population by the assembler.
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole } from "@prisma/client";

import { requireSpaceRole } from "@/lib/session";
import { db } from "@/lib/db";
import { resolveSpaceContext } from "@/lib/space";
import { computeAverageMonthlySpending } from "@/lib/ai/intelligence";
import { resolveExpenseBaseline } from "@/lib/liquidity/expense-baseline";
import { getAssembler } from "@/lib/ai/assembler-registry";
import { FinanceDomains } from "@/lib/ai/types";
import type { TransactionsSummaryData } from "@/lib/ai/types";

// Side-effect registration of the ONE assembler this route needs — the same
// house pattern the perspectives route uses for its lenses. Deliberately not the
// barrel: this route needs the transactions summary and nothing else.
import "@/lib/ai/assemblers/transactions";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: spaceId } = await params;

  const [viewer, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  // The DECLARED figure — the same `emergency_fund_progress` config the
  // workspace has always divided by.
  const section = await db.spaceDashboardSection.findFirst({
    where:  { spaceId, key: "emergency_fund_progress" },
    select: { config: true },
  });
  const rawDeclared = Number(
    (section?.config as { monthlyExpenses?: unknown } | null)?.monthlyExpenses,
  );
  const declared = Number.isFinite(rawDeclared) ? rawDeclared : null;

  // The MEASURED figure — the assessment engine's own call, through the real
  // assembler, so the two surfaces divide by the same number rather than by two
  // implementations of the same idea.
  const spaceCtx = await resolveSpaceContext(viewer.user.id, spaceId);
  const assemble = getAssembler(FinanceDomains.TRANSACTIONS_SUMMARY);
  const txnSection = assemble ? await assemble(spaceCtx, { scopeHint: "full" }) : null;
  const measured = computeAverageMonthlySpending(
    txnSection ? (txnSection.data as TransactionsSummaryData) : null,
  );

  // THE authority decides. Precedence and the positive-or-refuse rule live there,
  // not here — this route supplies evidence and serializes the verdict.
  const baseline = resolveExpenseBaseline({ declared, measured });

  return NextResponse.json({ baseline });
}
