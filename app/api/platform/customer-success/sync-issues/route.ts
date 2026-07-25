/**
 * GET /api/platform/customer-success/sync-issues
 *
 * The Customer Success sync-incident PREVIEW (OPS-2D-5D-1).
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ") — unchanged.
 *
 * ── WHAT THIS ROUTE USED TO BE, AND WHY IT HAD TO CHANGE ─────────────────────
 * It scanned up to 500 unresolved `SyncIssue` rows, classified each in memory,
 * counted rows per kind, and reported that count as "unresolved sync issues".
 * That was defensible when one row meant one failed attempt. It has not meant
 * that since OPS-2D-5A-1: a row is now an EPISODE and repeated failures converge
 * onto it as OCCURRENCES. Under the old arithmetic a bank connection failing
 * forty times reported "1", and the stalled block's `unpersistedCount` — a count
 * of unresolved cursor-blocking ROWS, i.e. "transactions still unwritten" —
 * reported 1 for a held page containing forty of them. Both understated the
 * problem in the reassuring direction, which is the failure mode this whole
 * initiative exists to prevent.
 *
 * So the route no longer counts rows. It consumes the canonical incident
 * projection and returns presentation-ready incidents with their real occurrence
 * depth. It derives NOTHING: severity, domain, nature, state, label, description,
 * recovery and ordering all arrive already decided.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────
 * `SyncIssue.detail` is not reachable from here. `IncidentView` does not carry
 * it, so unlike the previous implementation — which selected `detail` to derive
 * semantics and relied on remembering not to echo it — the invariant is now
 * STRUCTURAL. Subject names (institution / account) are operator-appropriate and
 * are the only customer-adjacent strings returned.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getIncidentPreview, PREVIEW_LIMIT } from "@/lib/platform/incidents/preview";
import type { IncidentPreview } from "@/lib/platform/incidents/preview-core";

export const runtime = "nodejs";

export type PlatformSyncIssuesResponse = IncidentPreview;

export async function GET() {
  const [, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;

  const preview = await getIncidentPreview(PREVIEW_LIMIT);
  return NextResponse.json(preview satisfies PlatformSyncIssuesResponse);
}
