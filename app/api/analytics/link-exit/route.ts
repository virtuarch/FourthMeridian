/**
 * POST /api/analytics/link-exit  (S2-(a) — CONNECTION_LINK_EXITED)
 *
 * Plaid Link's `onExit` reports where the user left and the Plaid error code,
 * as enums only. Authenticated here, rate-limited per user, strictly validated,
 * 204 on success. The contract and the handler body live in lib/analytics/link-exit.ts.
 */

import { requireUser } from "@/lib/session";
import { limitByUser } from "@/lib/rate-limit";
import { withTenantDb } from "@/lib/db/tenant-context";
import { handleLinkExit } from "@/lib/analytics/link-exit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;
  return handleLinkExit(req, user, { limitByUser, withTenant: withTenantDb });
}
