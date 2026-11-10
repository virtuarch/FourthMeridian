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
 * operator TOTP is ENFORCED (S2 C1), and the user holds ANY active PlatformGrant (the same fail-closed count that
 * shows the Platform toggle, lib/platform/directory.server.ts), the rail words
 * the reminder for operators (lib/auth/operator-2fa-prompt.ts). Present only
 * when true. Admission and the Platform guard never read it.
 */

import "server-only";
import { withTenantDb } from "@/lib/db/tenant-context";
import { readMaintenanceNotice } from "./maintenance-notice";
import { readConnectInvitation } from "@/lib/onboarding/first-run";
import { hasActivePlatformGrants } from "@/lib/platform/directory.server";
import { env } from "@/lib/env";
import { operatorWordingApplies } from "@/lib/auth/operator-2fa-prompt";
import type { AppNoticeStatus } from "@/components/notices/notice-model";

export async function readAppNoticeStatus(userId: string): Promise<AppNoticeStatus> {
  const [maintenance, me, invite] = await Promise.all([
    readMaintenanceNotice(),
    withTenantDb(userId, (tx) => tx.user.findUnique({ where: { id: userId }, select: { totpEnabled: true } })).catch(() => null),
    readConnectInvitation(userId),
  ]);
  // S2 C1 — operator ("required") wording only while operator TOTP is ENFORCED.
  const enforced = env.isOperatorTotpEnforced;
  const operator = enforced && me && !me.totpEnabled
    ? operatorWordingApplies({ hasActiveGrant: await hasActivePlatformGrants(userId), totpEnabled: me.totpEnabled, enforced })
    : false;
  return { maintenance, twoFactorReminder: me ? !me.totpEnabled : false, ...(invite ? { connectInvitation: true } : {}), ...(operator ? { twoFactorOperator: true } : {}) };
}
