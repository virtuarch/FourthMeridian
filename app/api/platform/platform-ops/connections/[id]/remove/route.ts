/**
 * POST /api/platform/platform-ops/connections/[id]/remove  (PB-5)
 *
 * A SYSTEM_ADMIN removes ONE customer connection (Plaid item or self-custody
 * wallet) from Platform Ops → Providers → Connections. `id` is the diagnostics
 * row id: PlaidItem.id for Plaid, Connection.id for a wallet.
 *
 * Body: { reason: "customer_request" | "abuse" | "cost" | "account_closure" | "other", note?: string ≤ 280 }
 *
 * AUTHORIZATION — requireFreshSystemAdmin(), the strictest gate this codebase
 * has for an operator action, and stricter than the Deny / Block family
 * (requireFreshPlatformAccess(area, "WRITE" | "CONTROL")):
 *   - the SYSTEM_ADMIN role is the authority — no Platform grant of any level
 *     reaches this route (a PLATFORM_OPS CONTROL holder → 403). Precedent: the
 *     Comms Center owner approval (owner decision O-18), the one other platform
 *     action reserved to the owner role;
 *   - FRESH: the session is re-checked live against UserSession, bypassing the
 *     30 s revocation cache, and the ROLE is re-read in that same check, so a
 *     just-revoked session or just-demoted admin cannot act inside the cache
 *     window (401 / 403);
 *   - the DISABLE_SYSTEM_ADMIN kill switch and pending-TOTP enrolment both
 *     refuse (decideAdminApiAccess), as on every admin route.
 * Removal is irreversible at the provider (Plaid /item/remove), which is why it
 * takes the owner role rather than an area grant.
 *
 * Then, in order: the per-operator rate limit (every accepted call emails a
 * customer — the request-reauth bound, SEC-PLAT-2 G), the reason (400 when
 * missing or invalid — BEFORE anything is read or changed), and
 * removeConnectionAsOperator, which runs the customer's own disconnect engine,
 * records an INTENT row (CONNECTION_REMOVAL_REQUESTED) before anything changes
 * and the outcome (CONNECTION_REMOVED_BY_OPERATOR) after, writes a
 * pre-provider owed marker before the Plaid call, adds the removal to the
 * customer's own Security History, and notifies the owner through the
 * notification chokepoint (email SHIPPED OFF). See
 * lib/platform/connections/operator-removal.ts.
 *
 *   200 removed   { ok, outcome, accountCount, notification }
 *   400 bad body · 401 / 403 auth · 404 unknown · 429 limited
 *   409 { code: "ALREADY_REMOVED" } — nothing live: idempotent, never a second itemRemove
 *   500 the disconnect failed (recorded as a FAILURE operator action)
 *
 * PRIVACY — the response and the audit row carry ids, the institution label,
 * counts and enum words. No email, no balances, no token.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshSystemAdmin } from "@/lib/session";
import { getRequestMeta } from "@/lib/api";
import { limitByUser } from "@/lib/rate-limit";
import { parseRemovalRequest, removeConnectionAsOperator } from "@/lib/platform/connections/operator-removal";
import type { RemovedOutcome } from "@/lib/platform/connections/removed-connections.core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every accepted call notifies a customer — bounded per operator. */
const REMOVE_PER_OPERATOR_PER_HOUR = 20;

export type RemoveConnectionResponse = {
  ok: true;
  connectionId: string;
  outcome: RemovedOutcome;
  accountCount: number;
  notification: "created" | "suppressed" | "skipped" | "error";
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [admin, err] = await requireFreshSystemAdmin();
  if (err) return err;

  const limited = await limitByUser(admin.id, "platform-connection-remove", { limit: REMOVE_PER_OPERATOR_PER_HOUR, windowSec: 3600 });
  if (limited) return limited;

  const parsed = parseRemovalRequest(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Missing connection id." }, { status: 400 });

  const meta = getRequestMeta(req);
  const result = await removeConnectionAsOperator({
    connectionId: id,
    // The SYSTEM_ADMIN role IS the authority (no grant) — attributed as such.
    actor: { userId: admin.id, via: "SYSTEM_ADMIN", area: "PLATFORM_OPS" },
    request: parsed.request,
    ipAddress: meta.ip,
    userAgent: req.headers.get("user-agent"),
  });

  switch (result.kind) {
    case "not_found":    return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    // IDEMPOTENT: a second call finds nothing live and never reaches Plaid again.
    case "already_removed": return NextResponse.json({ error: "This connection is already removed.", code: "ALREADY_REMOVED" }, { status: 409 });
    case "failed":       return NextResponse.json({ error: "The removal did not complete. It was recorded; nothing was reported to the customer." }, { status: 500 });
    case "removed":
      return NextResponse.json({
        ok: true, connectionId: result.connectionId, outcome: result.outcome,
        accountCount: result.accountCount, notification: result.notification,
      } satisfies RemoveConnectionResponse);
  }
}
