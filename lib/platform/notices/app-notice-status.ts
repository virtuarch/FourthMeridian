/**
 * lib/platform/notices/app-notice-status.ts  (UNIFIED NOTICES)
 *
 * The notice rail's status for one signed-in user — read by the status route
 * (revalidation) and the dashboard layout (first paint), so both say the same
 * thing. Two facts, nothing else: is the platform in maintenance (as a customer
 * may know it), and has this user not enabled 2FA (their own row, as them).
 */

import "server-only";
import { withTenantDb } from "@/lib/db/tenant-context";
import { readMaintenanceNotice } from "./maintenance-notice";
import type { AppNoticeStatus } from "@/components/notices/notice-model";

export async function readAppNoticeStatus(userId: string): Promise<AppNoticeStatus> {
  const [maintenance, me] = await Promise.all([
    readMaintenanceNotice(),
    withTenantDb(userId, (tx) => tx.user.findUnique({ where: { id: userId }, select: { totpEnabled: true } })).catch(() => null),
  ]);
  return { maintenance, twoFactorReminder: me ? !me.totpEnabled : false };
}
