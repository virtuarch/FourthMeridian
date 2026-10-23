/**
 * GET  /api/platform/platform-ops/connections/[id]/webhook   — dry run
 * POST /api/platform/platform-ops/connections/[id]/webhook   — repoint ONE Item
 *   (Release 2 — marketing/app domain split)
 *
 * Moves an existing Plaid Item's webhook to THIS deployment's own
 * `${NEXT_PUBLIC_APP_URL}/api/plaid/webhook` with Plaid's supported
 * /item/webhook/update, then reads the Item back to verify. Plaid answers with
 * ITEM / WEBHOOK_UPDATE_ACKNOWLEDGED at the new URL; the dry run reports the
 * newest one received so delivery is provable, not assumed.
 *
 * Every rule lives in lib/plaid/webhook-migration(.core).ts:
 *   - the target is SERVER-derived, never caller-supplied; the POST must echo
 *     the target the operator reviewed (`expectedTarget`) or it is refused;
 *   - one Item per request, selected explicitly by id — no bulk loop;
 *   - already-current ⇒ no provider write (idempotent);
 *   - REVOKED ⇒ refused before any provider call.
 *
 * AUTHORIZATION: CONTROL on PLATFORM_OPS for both verbs — this reads and then
 * changes where a customer's provider delivers, which is infrastructure policy,
 * not routine operational work. POST uses the fresh (revocation-checked) path.
 * AUDIT: PLAID_ITEM_WEBHOOK_UPDATED with a structured reason, before/after
 * webhook origin+path only. No admission check: this does not begin refresh
 * work (no provider DATA is fetched), so ingestion/maintenance facts do not
 * speak to it.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess, requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import { OperatorActionValidationError, parseOperatorReason, recordOperatorAction } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import {
  applyItemWebhook,
  defaultWebhookMigrationDeps,
  inspectItemWebhook,
} from "@/lib/plaid/webhook-migration";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const { id } = await ctx.params;

  const r = await inspectItemWebhook(id, defaultWebhookMigrationDeps());
  if (!r.ok && r.code === "NOT_FOUND") return NextResponse.json({ error: "Connection not found." }, { status: 404, headers: NO_STORE });
  if (!r.ok) return NextResponse.json({ error: "provider-error", providerError: r.providerError }, { status: 502, headers: NO_STORE });
  return NextResponse.json(r.view, { headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null) as { expectedTarget?: unknown; reason?: unknown } | null;
  if (!body || typeof body.expectedTarget !== "string") {
    return NextResponse.json({ error: "expectedTarget (the target shown by the dry run) is required." }, { status: 400, headers: NO_STORE });
  }
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) {
    return NextResponse.json({ error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." }, { status: 400, headers: NO_STORE });
  }

  const r = await applyItemWebhook(id, body.expectedTarget, defaultWebhookMigrationDeps());
  if (!r.ok && r.code === "NOT_FOUND") return NextResponse.json({ error: "Connection not found." }, { status: 404, headers: NO_STORE });

  const audit = (result: "SUCCESS" | "FAILURE" | "REFUSED", outcome: string, change: { before: string | null; after: string | null } | null, extra: Record<string, unknown> = {}) =>
    recordOperatorAction(db, {
      actor:     operatorActorFrom(auth, "PLATFORM_OPS"),
      action:    AuditAction.PLAID_ITEM_WEBHOOK_UPDATED,
      target:    { kind: "PLAID_ITEM", id },
      reason,
      change:    change ? { before: { webhook: change.before }, after: { webhook: change.after } } : undefined,
      result,
      detail:    { connectionId: id, provider: "PLAID", outcome, ...extra },
      ipAddress: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

  if (r.ok) {
    await audit("SUCCESS", r.outcome, { before: r.before, after: r.after });
    return NextResponse.json({ ok: true, outcome: r.outcome, before: r.before, after: r.after, target: r.target }, { headers: NO_STORE });
  }
  switch (r.code) {
    case "TARGET_MISMATCH":
    case "SKIP_STATUS":
    case "NO_TARGET":
      await audit("REFUSED", r.code, null);
      return NextResponse.json({ error: r.code, message: r.message }, { status: 409, headers: NO_STORE });
    case "PROVIDER_ERROR":
      await audit("FAILURE", r.code, { before: r.before, after: null }, { providerError: r.providerError });
      return NextResponse.json({ error: r.code, providerError: r.providerError }, { status: 502, headers: NO_STORE });
    case "NOT_VERIFIED":
      await audit("FAILURE", r.code, { before: r.before, after: r.after });
      return NextResponse.json({ error: r.code, before: r.before, after: r.after, target: r.target }, { status: 502, headers: NO_STORE });
  }
}
