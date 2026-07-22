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

  const body = await req.json().catch(() => ({}));
  const next = (body as { status?: unknown }).status;
  if (!isProductStatus(next)) {
    return NextResponse.json(
      { error: `status must be one of: ${PRODUCT_STATUSES.join(", ")}.` },
      { status: 400 },
    );
  }

  const previous = await getProductStatus();
  await setSetting(PlatformSettingKey.PRODUCT_STATUS, next, auth.user.id);

  await db.auditLog.create({
    data: {
      userId:             auth.user.id,
      performedByAdminId: auth.user.id,
      action:             AuditAction.PRODUCT_STATUS_CHANGED,
      metadata:           { previous, new: next },
    },
  });

  return NextResponse.json({ success: true, previous, status: next });
}
