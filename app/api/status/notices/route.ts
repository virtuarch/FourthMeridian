/**
 * GET /api/status/notices  (UNIFIED NOTICES)
 *
 * The application notice rail's ONE status read — shared by every page of the
 * authenticated shell (components/notices/NoticeRail.tsx), never polled per page.
 *
 *   200 { maintenance: boolean | null, twoFactorReminder: boolean }
 *
 * - `maintenance`: whether the platform is in maintenance, as a customer may
 *   know it (lib/platform/notices/maintenance-notice.ts). null = could not tell.
 *   No key, value, version, writer, reason or other control-plane fact.
 * - `twoFactorReminder`: the caller has not enabled 2FA (their own row, as them).
 *
 * Any signed-in user may read it — no Platform Ops grant, no capability. It is
 * display state only: admission enforces maintenance whether or not this is read.
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { readAppNoticeStatus } from "@/lib/platform/notices/app-notice-status";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;
  return NextResponse.json(await readAppNoticeStatus(user.id), { headers: NO_STORE });
}
