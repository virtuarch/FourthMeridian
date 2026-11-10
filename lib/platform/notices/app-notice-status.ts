/**
 * lib/platform/notices/app-notice-status.ts  (UNIFIED NOTICES)
 *
 * The notice rail's status for one signed-in user — read by the status route
 * (revalidation) and the dashboard layout (first paint), so both say the same
 * thing. Three facts, nothing else: is the platform in maintenance (as a customer
 * may know it), has this user not enabled 2FA (their own row, as them), and —
 * Connections pass PR 2 — should they be invited to add a first account
 * (lib/onboarding; present only when true, fail-quiet).
 *
 * Owner D4 (2026-11-10) — a fourth, DISPLAY-only fact: when the reminder applies
 * and the user holds ANY active PlatformGrant (the same fail-closed count that
 * shows the Platform toggle, lib/platform/directory.server.ts), the rail words
 * the reminder for operators (lib/auth/operator-2fa-prompt.ts). Present only
 * when true. Admission and the Platform guard never read it.
 */

import "server-only";
import { withTenantDb } from "@/lib/db/tenant-context";
import { readMaintenanceNotice } from "./maintenance-notice";
import { readConnectInvitation } from "@/lib/onboarding/first-run";
import { hasActivePlatformGrants } from "@/lib/platform/directory.server";
import type { AppNoticeStatus } from "@/components/notices/notice-model";

export async function readAppNoticeStatus(userId: string): Promise<AppNoticeStatus> {
  const [maintenance, me, invite] = await Promise.all([
    readMaintenanceNotice(),
    withTenantDb(userId, (tx) => tx.user.findUnique({ where: { id: userId }, select: { totpEnabled: true } })).catch(() => null),
    readConnectInvitation(userId),
  ]);
  const operator = me && !me.totpEnabled ? await hasActivePlatformGrants(userId) : false;
  return { maintenance, twoFactorReminder: me ? !me.totpEnabled : false, ...(invite ? { connectInvitation: true } : {}), ...(operator ? { twoFactorOperator: true } : {}) };
}
