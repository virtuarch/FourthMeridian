/**
 * GET /api/platform/platform-ops/activity  (UX-P1 · D6)
 *
 * The Platform Operations activity feed: the last 20 operator actions whose
 * targets are platform-operations objects (jobs, connections, platform
 * settings, operator Refresh All). Security events — grants, sessions, 2FA,
 * break-glass, beta and customer decisions — are NOT here; they stay under
 * Security Operations (`security-ops/operator-actions`, SECURITY_OPS READ).
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ"), first. Pure
 * projection over AuditLog (lib/platform/activity/operator-feed*.ts): no write,
 * no new permission, no customer identity (targets are opaque), no reason note,
 * no email / IP / user-agent, never metadata verbatim. Depth is stated on the
 * payload (`depth`, `note`).
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { loadOperatorFeed } from "@/lib/platform/activity/operator-feed";
import type { OperatorFeedItem, OperatorFeedResponse } from "@/lib/platform/activity/operator-feed-core";

export const runtime = "nodejs";

export type { OperatorFeedItem, OperatorFeedResponse };

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  return NextResponse.json((await loadOperatorFeed()) satisfies OperatorFeedResponse);
}
