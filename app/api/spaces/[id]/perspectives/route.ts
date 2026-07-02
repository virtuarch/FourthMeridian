/**
 * GET /api/spaces/[id]/perspectives
 *
 * Batch-computes every registered Perspective lens for this Space, for the
 * requesting viewer, and returns the shaped LensResult[] (commit 4 of the
 * approved plan in docs/investigations/
 * PERSPECTIVE_ENGINE_FOUNDATION_INVESTIGATION.md).
 *
 * This route is a thin CONSUMER of the Perspective Engine — auth, membership
 * gating, and JSON framing only. All computation, visibility redaction, and
 * result shaping live in lib/perspective-engine (which itself reads only
 * through the KD-19-enforced data layer). Future consumers (Daily Brief, D4
 * context, Meridian Analyst) call computePerspectives() directly and do not
 * go through this route.
 *
 * Security (mirrors app/api/spaces/[id]/activity/route.ts):
 *   - Caller must be an ACTIVE member of the space → 403 otherwise.
 *   - The engine scope's userId is ALWAYS the authenticated requester
 *     (investigation §5.9) — visibility is computed for the viewer, never a
 *     stored or elevated identity. Batch shape avoids N per-lens fetch
 *     waterfalls from the dashboards.
 *   - Results are per-viewer; nothing here may be cached without a
 *     userId-scoped key.
 *   - Lens failures never 500 the batch: the engine returns shaped,
 *     code-only error results per lens (no raw error text).
 */

import { NextRequest, NextResponse } from "next/server";
import { db }                        from "@/lib/db";
import { requireUser }               from "@/lib/session";
import { withApiHandler }            from "@/lib/api";
import { SpaceMemberStatus }         from "@prisma/client";
import { computePerspectives }       from "@/lib/perspective-engine";
import type { LensResult }           from "@/lib/perspective-engine";

// Lens registrations — imported for module side effects (house pattern:
// lib/ai/assemblers/* register the same way). A lens is computable only
// once its module has been imported somewhere in the server graph.
import "@/lib/perspective-engine/lenses/liquidity";
import "@/lib/perspective-engine/lenses/debt";

export const GET = withApiHandler(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  const { id: spaceId } = await params;
  if (!spaceId) return NextResponse.json({ error: "Missing space id" }, { status: 400 });

  // ── Membership guard (same shape as the activity route) ───────────────────
  const membership = await db.spaceMember.findUnique({
    where:  { spaceId_userId: { spaceId, userId } },
    select: { status: true },
  });
  if (!membership || membership.status !== SpaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Compute — always as the requesting viewer ──────────────────────────────
  const results: LensResult[] = await computePerspectives({ spaceId, userId });

  return NextResponse.json({ results });
}, "GET /api/spaces/[id]/perspectives");
