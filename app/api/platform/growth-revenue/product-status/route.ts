/**
 * PUT /api/platform/growth-revenue/product-status  (PO-3C · launch axis)
 *
 * Set the product maturity (development | beta | live) — the LAUNCH axis, kept
 * deliberately separate from registration_mode (who may sign up). Framing only;
 * it gates no signup behavior by itself.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE").
 * AUDIT: PRODUCT_STATUS_CHANGED { previous, new }.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import { OperatorActionValidationError, parseOperatorReason, recordOperatorAction } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import {
  getProductStatus,
  setSetting,
  PlatformSettingKey,
  PRODUCT_STATUSES,
  type ProductStatus,
} from "@/lib/platform-settings";

export const runtime = "nodejs";

function isProductStatus(v: unknown): v is ProductStatus {
  return typeof v === "string" && (PRODUCT_STATUSES as readonly string[]).includes(v);
}

export async function PUT(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const body = (await req.json().catch(() => ({}))) as { status?: unknown; reason?: unknown };
  const next = body.status;
  if (!isProductStatus(next)) {
    return NextResponse.json(
      { error: `status must be one of: ${PRODUCT_STATUSES.join(", ")}.` },
      { status: 400 },
    );
  }

  // SEC-PLAT-2 — a platform-wide switch: the structured reason is required and
  // parsed before anything is written.
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) {
    if (e instanceof OperatorActionValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  const previous = await getProductStatus();
  await setSetting(PlatformSettingKey.PRODUCT_STATUS, next, auth.user.id);

  // SEC-PLAT-2 — through the operator-action envelope (actor, target, result, reason);
  // the legacy metadata keys ride in `detail` so existing readers keep working.
  await recordOperatorAction(db, {
    actor:  operatorActorFrom(auth, "GROWTH_REVENUE"),
    action: AuditAction.PRODUCT_STATUS_CHANGED,
    target: { kind: "PLATFORM_SETTING", id: PlatformSettingKey.PRODUCT_STATUS },
    reason,
    change: { before: { value: previous }, after: { value: next } },
    result: "SUCCESS",
    detail: { previous, new: next },
    ipAddress: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json({ success: true, previous, status: next });
}
