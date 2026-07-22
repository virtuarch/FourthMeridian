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
import { requireSpaceAction }        from "@/lib/spaces/authorize";
import { withApiHandler }            from "@/lib/api";
import { computePerspectives }       from "@/lib/perspective-engine";
import type { LensResult }           from "@/lib/perspective-engine";
import { parseReportingCurrencyInput } from "@/lib/spaces/reporting-currency";
import { resolveSpaceSyncCompleteness } from "@/lib/spaces/sync-completeness";

// Lens registrations — imported for module side effects (house pattern:
// lib/ai/assemblers/* register the same way). A lens is computable only
// once its module has been imported somewhere in the server graph.
import "@/lib/perspective-engine/lenses/liquidity";
import "@/lib/perspective-engine/lenses/debt";

export const GET = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id: spaceId } = await params;
  if (!spaceId) return NextResponse.json({ error: "Missing space id" }, { status: 400 });

  // ── Membership guard (any ACTIVE member) ──────────────────────────────────
  const [auth, err] = await requireSpaceAction(spaceId, "perspective:read");
  if (err) return err;
  const userId = auth.user.id;

  // ── Optional display-currency override (MC1 "view as" preview) ─────────────
  // Read-only: when a valid supported currency is requested, lenses recompute
  // in it (headline + verdict + sums consistently). Absent or invalid ⇒
  // undefined ⇒ the Space's saved reporting currency — today's behavior.
  const parsedTarget = parseReportingCurrencyInput(req.nextUrl.searchParams.get("target"));
  const targetCurrency = parsedTarget.ok ? parsedTarget.value : undefined;

  // ── Compute — always as the requesting viewer ──────────────────────────────
  const results: LensResult[] = await computePerspectives({ spaceId, userId }, { targetCurrency });

  // ── Space-scoped sync completeness (PRE-BETA-OPS-CLOSE) ───────────────────
  // Rides THIS route rather than a new one: it is per-Space, membership-gated,
  // and already the trust/perspective seam the envelope resolves from — the
  // same request that carries the lens verdicts should carry the caveat that
  // qualifies them. A boolean only; no item id, institution, or error detail
  // crosses to a customer surface. `null` means "could not determine" and is
  // NOT downgraded to "fully synced" (see resolveSpaceSyncCompleteness).
  const syncIncomplete = await resolveSpaceSyncCompleteness(spaceId);

  return NextResponse.json({ results, syncIncomplete });
}, "GET /api/spaces/[id]/perspectives");
