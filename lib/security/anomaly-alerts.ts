/**
 * lib/security/anomaly-alerts.ts  (Wave 3 ⑧ — impure fan-out orchestrator)
 *
 * The impure side of the Security Ops anomaly detector. Called inline from
 * authorize() (lib/auth.ts) right after a LOGIN_FAILED audit write, for the
 * suspicious reasons only. Best-effort and NON-THROWING end to end: a detection
 * or delivery failure must never fail (or slow past its own try/catch) the
 * login response — the login already failed regardless.
 *
 * Pipeline per call:
 *   1. Fetch this identifier's + this IP's recent LOGIN_FAILED reasons (and, for
 *      a disabled-admin probe, the global count) over the detector's windows.
 *   2. Run the PURE threshold functions (lib/security/anomalies.ts).
 *   3. For each tripped anomaly, SUPPRESS-WHILE-OPEN: if a SECURITY_ANOMALY_
 *      DETECTED audit row with the same `metadata.key` already exists within the
 *      window, do nothing (the burst is already surfaced — one row, not one per
 *      attempt). Otherwise write the trip row and fan out THREE ways:
 *        (a) createNotification to every ACTIVE SECURITY_OPS grant holder +
 *            SYSTEM_ADMIN (IN_APP bell; its own suppress dedupe backstops races);
 *        (b) sendEmail("security-alert", SECURITY_ALERTS_EMAIL, …) — direct;
 *        (c) THE LOCKOUT HYBRID: when the trip is a resolvable-account failed-
 *            login burst, sendEmail("security-alert", <owner's real email>, …)
 *            with a password-reset link. Only ever reaches a real, resolved
 *            inbox — never sent on an unresolved identifier, so no enumeration.
 *
 * The audit row is BOTH the trip record the widget reads and the dedupe lock —
 * so "exactly one SECURITY_ANOMALY_DETECTED row per burst" and "exactly one of
 * each email" hold together. (A rare concurrent double-fire in a tight race is
 * tolerated for v1 — no lock; the per-recipient notification dedupe still
 * collapses the bells.)
 */

import "server-only";

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AuditAction } from "@/lib/audit-actions";
import { createNotification } from "@/lib/notifications/create";
import { sendEmail } from "@/lib/email/send";
import {
  detectIdentifierAnomalies,
  detectIpAnomaly,
  detectSystemAdminAnomaly,
  ANOMALY_THRESHOLDS,
  SYSTEM_ADMIN_DISABLED_REASON,
  type DetectedAnomaly,
} from "@/lib/security/anomalies";

/** Extract the `reason` strings from a set of LOGIN_FAILED metadata blobs. */
function reasonsOf(rows: { metadata: unknown }[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const reason = (r.metadata as { reason?: unknown } | null)?.reason;
    if (typeof reason === "string") out.push(reason);
  }
  return out;
}

function windowStart(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

export interface LoginFailureAnomalyContext {
  identifier: string;
  ip: string | null;
  reason: string;
  /** Present only when the identifier resolved to a real user (never for
   *  user_not_found) — gates the owner-hybrid email against enumeration. */
  userId?: string | null;
  userEmail?: string | null;
}

/**
 * Detect and fan out login-failure anomalies. Best-effort; never throws.
 */
export async function reportLoginFailureAnomalies(ctx: LoginFailureAnomalyContext): Promise<void> {
  try {
    const anomalies: DetectedAnomaly[] = [];

    // Identifier-scoped signals (failed-login burst + recovery-code streak).
    const idRows = await db.auditLog.findMany({
      where: {
        action:    AuditAction.LOGIN_FAILED,
        createdAt: { gte: windowStart(ANOMALY_THRESHOLDS.identifierFailedLogin.windowMinutes) },
        metadata:  { path: ["identifier"], equals: ctx.identifier },
      },
      select: { metadata: true },
    });
    anomalies.push(...detectIdentifierAnomalies(reasonsOf(idRows), ctx.identifier));

    // Per-IP failed-login burst (only when we have an IP to key on).
    if (ctx.ip) {
      const ipRows = await db.auditLog.findMany({
        where: {
          action:    AuditAction.LOGIN_FAILED,
          createdAt: { gte: windowStart(ANOMALY_THRESHOLDS.ipFailedLogin.windowMinutes) },
          ipAddress: ctx.ip,
        },
        select: { metadata: true },
      });
      const ipAnomaly = detectIpAnomaly(reasonsOf(ipRows), ctx.ip);
      if (ipAnomaly) anomalies.push(ipAnomaly);
    }

    // Disabled-admin probe — only worth the extra count query on that reason.
    if (ctx.reason === SYSTEM_ADMIN_DISABLED_REASON) {
      const count = await db.auditLog.count({
        where: {
          action:    AuditAction.LOGIN_FAILED,
          createdAt: { gte: windowStart(ANOMALY_THRESHOLDS.systemAdminDisabled.windowMinutes) },
          metadata:  { path: ["reason"], equals: SYSTEM_ADMIN_DISABLED_REASON },
        },
      });
      const adminAnomaly = detectSystemAdminAnomaly(count);
      if (adminAnomaly) anomalies.push(adminAnomaly);
    }

    for (const anomaly of anomalies) {
      await fanOutIfFresh(anomaly, ctx);
    }
  } catch (err) {
    // Detection is a best-effort safety net — never let it affect the caller.
    console.warn("[security/anomaly-alerts] detection failed (non-fatal):", err);
  }
}

/**
 * Suppress-while-open gate + three-way fan-out for one anomaly. Each external
 * effect is individually guarded so a single failure doesn't skip the others.
 */
async function fanOutIfFresh(anomaly: DetectedAnomaly, ctx: LoginFailureAnomalyContext): Promise<void> {
  // Dedupe: a trip row for this key within the window means it's already open.
  const existing = await db.auditLog.findFirst({
    where: {
      action:    AuditAction.SECURITY_ANOMALY_DETECTED,
      createdAt: { gte: windowStart(anomaly.windowMinutes) },
      metadata:  { path: ["key"], equals: anomaly.key },
    },
    select: { id: true },
  });
  if (existing) return; // already surfaced — one row/email/bell per open window

  // The trip row: both the widget's history source and the dedupe lock.
  await db.auditLog.create({
    data: {
      action:    AuditAction.SECURITY_ANOMALY_DETECTED,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ipAddress: ctx.ip,
      metadata: {
        key:           anomaly.key,
        type:          anomaly.type,
        count:         anomaly.count,
        threshold:     anomaly.threshold,
        windowMinutes: anomaly.windowMinutes,
        title:         anomaly.title,
        message:       anomaly.message,
      },
    },
  });

  // (a) In-app bell to Security Ops staff + SYSTEM_ADMINs.
  try {
    const [grants, admins] = await Promise.all([
      db.platformGrant.findMany({ where: { area: "SECURITY_OPS", status: "ACTIVE" }, select: { userId: true } }),
      db.user.findMany({ where: { role: "SYSTEM_ADMIN" }, select: { id: true } }),
    ]);
    const recipientIds = new Set<string>([...grants.map((g) => g.userId), ...admins.map((a) => a.id)]);
    for (const userId of recipientIds) {
      await createNotification({
        userId,
        type: "SECURITY_ANOMALY_DETECTED",
        data: { anomalyKey: anomaly.key, title: anomaly.title, summary: anomaly.message },
      });
    }
  } catch (err) {
    console.warn("[security/anomaly-alerts] notification fan-out failed (non-fatal):", err);
  }

  // (b) Direct security-alert email to the Security Ops inbox.
  try {
    await sendEmail("security-alert", env.SECURITY_ALERTS_EMAIL, {
      title:   anomaly.title,
      message: `${anomaly.message}\n\nSignal: ${anomaly.key} — ${anomaly.count} in the last ${anomaly.windowMinutes} minutes (threshold ${anomaly.threshold}).`,
    });
  } catch (err) {
    console.warn("[security/anomaly-alerts] security@ email failed (non-fatal):", err);
  }

  // (c) The lockout hybrid — owner-facing email, ONLY for a resolvable account.
  if (anomaly.ownerEmailEligible && ctx.userEmail) {
    try {
      const resetUrl = `${env.NEXT_PUBLIC_APP_URL}/forgot-password`;
      await sendEmail("security-alert", ctx.userEmail, {
        title:   "Unusual sign-in activity on your account",
        message:
          `We noticed several failed sign-in attempts on your Fourth Meridian ` +
          `account. If this was you, no action is needed.\n\n` +
          `If it wasn't you, reset your password to secure your account:\n${resetUrl}`,
      });
    } catch (err) {
      console.warn("[security/anomaly-alerts] owner email failed (non-fatal):", err);
    }
  }
}
