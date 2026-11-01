/**
 * lib/notifications/platform-access.ts  (owner-approved 2026-10-31)
 *
 * Tell an operator that their Platform access changed. Called by the two
 * SYSTEM_ADMIN grant routes AFTER their grant write + audit transaction commits:
 *
 *   app/api/admin/platform-grants/route.ts            POST  create · reinstate · level change
 *   app/api/admin/platform-grants/[grantId]/route.ts  PATCH revoke
 *
 * Each change produces BOTH legs of a security event, the house pattern for
 * ACCOUNT_SECURITY (registry.ts SECURITY partial):
 *   - the in-app notice through the chokepoint (PLATFORM_ACCESS_GRANTED /
 *     PLATFORM_ACCESS_REVOKED — locked, no preference can mute it), and
 *   - the security-alert email, sent directly (SECURITY_CRITICAL: never
 *     preference-suppressible, exempt from the storm limit — lib/email/send.ts),
 *     recorded in the delivery ledger under the same catalog key.
 *
 * WHAT IT SAYS: which area, which level, and that a system administrator made
 * the change. Never the grantor's name or address — the role is the fact the
 * grantee needs, and every grant mutation is SYSTEM_ADMIN-only.
 *
 * WHEN IT FIRES: once per audited grant mutation. The POST route's idempotent
 * no-op (already ACTIVE at the same level) writes no audit row and calls
 * nothing here, so a repeated grant notifies nobody; a revoke of a grant that
 * is not ACTIVE is refused (400) before any write.
 *
 * Best-effort and NON-THROWING: the grant is already committed; a notification
 * failure must never turn the admin's request into an error.
 */

import "server-only";
import type { PlatformAccessLevel, PlatformArea } from "@prisma/client";
import { createNotification } from "@/lib/notifications/create";
import { sendSecurityAlert } from "@/lib/email/send-security-alert";
import { sendEmail } from "@/lib/email/send";
import { platformAccessGrantedAlert, platformAccessRemovedAlert } from "@/lib/email/security-alerts";
import { PLATFORM_AREAS } from "@/lib/platform/policy";

/** How each level reads in the notice. */
export const PLATFORM_LEVEL_LABEL: Record<PlatformAccessLevel, string> = {
  READ:    "read-only",
  WRITE:   "read and write",
  CONTROL: "control",
};

export type PlatformAccessChangeKind = "granted" | "reinstated" | "level_changed" | "revoked";

export interface PlatformAccessChangeInput {
  kind: PlatformAccessChangeKind;
  /** The grantee. */
  userId: string;
  /** The grantee's address (the route's own select of the grant's user). */
  email: string | null;
  area: PlatformArea;
  /** The level now held (granted) or the level that was removed (revoked). */
  level: PlatformAccessLevel;
  /** The AuditLog row of the mutation, when the route has it (F5 soft ref). */
  auditLogId?: string | null;
}

export interface PlatformAccessNotifyDeps {
  create?: typeof createNotification;
  /** The email chokepoint the security alert goes through (tests inject a capture). */
  send?: typeof sendEmail;
  appUrl?: string;
  now?: () => Date;
}

/** Notify the grantee of a Platform access change. Never throws. */
export async function notifyPlatformAccessChange(input: PlatformAccessChangeInput, deps: PlatformAccessNotifyDeps = {}): Promise<void> {
  const create = deps.create ?? createNotification;
  const send = deps.send ?? sendEmail;
  const appUrl = deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
  const at = (deps.now ?? (() => new Date()))();
  const change = {
    area: input.area,
    areaLabel: PLATFORM_AREAS[input.area]?.label ?? "a Platform area",
    levelLabel: PLATFORM_LEVEL_LABEL[input.level] ?? "a",
  };
  const audit = input.auditLogId ? { auditLogId: input.auditLogId } : {};

  try {
    if (input.kind === "revoked") {
      await create({ type: "PLATFORM_ACCESS_REVOKED", userId: input.userId, ...audit, data: { ...change, level: input.level } });
      if (input.email) {
        const res = await sendSecurityAlert(input.email, () => platformAccessRemovedAlert(change, at), { key: "PLATFORM_ACCESS_REVOKED", recipientUserId: input.userId }, send);
        if (res.status === "error") console.warn("[platform-access] revoke alert email failed (non-fatal):", res.error);
      }
      return;
    }
    const kind = input.kind;
    await create({ type: "PLATFORM_ACCESS_GRANTED", userId: input.userId, ...audit, data: { ...change, level: input.level, change: kind } });
    if (input.email) {
      const res = await sendSecurityAlert(input.email, () => platformAccessGrantedAlert({ ...change, kind }, at, appUrl), { key: "PLATFORM_ACCESS_GRANTED", recipientUserId: input.userId }, send);
      if (res.status === "error") console.warn("[platform-access] grant alert email failed (non-fatal):", res.error);
    }
  } catch (err) {
    // createNotification throws only on a programmer error (unknown type / bad data).
    console.warn(`[platform-access] notification failed for a ${input.kind} change (non-fatal): ${err instanceof Error ? err.name : typeof err}`);
  }
}
