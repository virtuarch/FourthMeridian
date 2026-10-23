/**
 * GET /api/platform/platform-ops/plaid-webhooks  (Release 2 — domain split)
 *
 * The roster for the Plaid webhook migration panel: every Plaid Item whose
 * webhook can still be repointed (ACTIVE / NEEDS_REAUTH) — id, institution
 * label and status only. DATABASE ONLY: no provider call, no token read. The
 * per-Item dry run and apply live at connections/[id]/webhook.
 *
 * AUTHORITY: systemDb (fm_system) — the roster spans every customer.
 * AUTHORIZATION: CONTROL on PLATFORM_OPS — the same rank as the action it feeds.
 */

import { NextResponse } from "next/server";
import { PlaidItemStatus } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { expectedWebhookUrl } from "@/lib/plaid/webhook-migration.core";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export interface PlaidWebhookRosterResponse {
  target: string | null;
  items: { id: string; institution: string; status: string }[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;

  const items = await systemDb.plaidItem.findMany({
    where:   { status: { in: [PlaidItemStatus.ACTIVE, PlaidItemStatus.NEEDS_REAUTH] } },
    select:  { id: true, institutionName: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  const body: PlaidWebhookRosterResponse = {
    target: expectedWebhookUrl(env.NEXT_PUBLIC_APP_URL),
    items:  items.map((i) => ({ id: i.id, institution: i.institutionName, status: i.status })),
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
