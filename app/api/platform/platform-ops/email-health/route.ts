/**
 * GET /api/platform/platform-ops/email-health  (PO-5A)
 *
 * Email-delivery health for the `ops_email_delivery` widget.
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 * Thin over lib/platform/email-health.ts — counts + recent error details only,
 * no recipient addresses or message bodies.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getEmailDeliveryHealth, type EmailDeliveryHealth } from "@/lib/platform/email-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type EmailHealthResponse = EmailDeliveryHealth;

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  return NextResponse.json(await getEmailDeliveryHealth() satisfies EmailHealthResponse);
}
