/**
 * lib/platform/ops/access-denied.ts  (OBS-009)
 *
 * Authorisation refusals were not collected: `requirePlatformAccess` answered
 * 403 and wrote nothing, so a mis-grant or an enumeration of platform areas
 * was invisible in-app. This records one bounded, rate-limited audit row per
 * (user, area) per window, OFF the request's critical path.
 *
 * ── Vocabulary: SECURITY_ANOMALY_DETECTED with type "platform_access_denied" ──
 * The audit-action canon (lib/audit-actions.ts) is not owned by this slice, so
 * no new action is added. A refused platform read IS a security anomaly in the
 * canon's own sense (something the inline detectors should surface), and the
 * existing Security Ops Detections surface already renders every
 * SECURITY_ANOMALY_DETECTED row as a trip with its `type`, an opaque digest of
 * its `key`, a count and a window — so the refusal appears there with no route
 * or view change. Promoting it to a dedicated PLATFORM_ACCESS_DENIED action is
 * one canon line plus one constant here (reported to the orchestrator).
 *
 * ── Bounded and best-effort ──────────────────────────────────────────────────
 *   • one row per (user, area) per ACCESS_DENIED_WINDOW_MINUTES (in-process
 *     throttle; a second lambda instance may write its own row — bounded, not
 *     exact, by design: an audit of refusals must never become a write
 *     amplifier for the caller it refuses);
 *   • at most ACCESS_DENIED_PROCESS_BUDGET rows per process per window;
 *   • the throttle map is capped (oldest keys evicted);
 *   • the write is fired and forgotten after the 403 is already decided; a
 *     failure is a console line, never a second failure on the request.
 *
 * ── No PII ───────────────────────────────────────────────────────────────────
 * The key carries the area and the user's OPAQUE id (never an email or name);
 * the Security Ops route projects the key to a digest before it leaves the
 * server. Metadata holds enum words only: area, needed level, grant posture.
 */

import type { Prisma } from "@prisma/client";
import type { PlatformArea, PlatformAccessLevel } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { buildAuditData } from "@/lib/audit";

export const ACCESS_DENIED_ANOMALY_TYPE = "platform_access_denied";
export const ACCESS_DENIED_WINDOW_MINUTES = 60;
/** Rows one process may write per window, across every key. */
export const ACCESS_DENIED_PROCESS_BUDGET = 50;
/** Keys the throttle remembers; beyond this the oldest is evicted. */
export const ACCESS_DENIED_THROTTLE_KEYS = 500;

export type GrantPosture = "none" | "insufficient" | "revoked" | "mfa_required" | "break_glass_refused";

export function accessDeniedKey(userId: string, area: PlatformArea): string {
  return `platform-denied:${area}:${userId}`;
}

export interface DenialAdmission {
  /** True when a row should be written now. */
  write: boolean;
  /** Refusals seen in-process for this key inside the window (including this one). */
  count: number;
}

/**
 * PURE, clock-injected throttle. `admit` returns whether THIS refusal earns a
 * row: the first refusal of a key per window does; later ones in the window
 * only raise the count. A per-window process budget caps the total.
 */
export class DenialThrottle {
  private readonly seen = new Map<string, { windowStartMs: number; count: number }>();
  private budgetWindowStartMs = -Infinity;
  private budgetUsed = 0;

  constructor(
    private readonly windowMs: number = ACCESS_DENIED_WINDOW_MINUTES * 60_000,
    private readonly budget: number = ACCESS_DENIED_PROCESS_BUDGET,
    private readonly maxKeys: number = ACCESS_DENIED_THROTTLE_KEYS,
  ) {}

  admit(key: string, nowMs: number): DenialAdmission {
    if (nowMs - this.budgetWindowStartMs >= this.windowMs) {
      this.budgetWindowStartMs = nowMs;
      this.budgetUsed = 0;
    }
    const entry = this.seen.get(key);
    if (entry && nowMs - entry.windowStartMs < this.windowMs) {
      entry.count += 1;
      return { write: false, count: entry.count };
    }
    if (this.seen.size >= this.maxKeys && !entry) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(key, { windowStartMs: nowMs, count: 1 });
    if (this.budgetUsed >= this.budget) return { write: false, count: 1 };
    this.budgetUsed += 1;
    return { write: true, count: 1 };
  }
}

export interface AccessDeniedFacts {
  userId: string;
  area: PlatformArea;
  needed: PlatformAccessLevel;
  grant: GrantPosture;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** PURE — the audit row for one refusal, in the anomaly trip shape the Security Ops route projects. */
export function buildAccessDeniedAudit(f: AccessDeniedFacts, count: number): Prisma.AuditLogUncheckedCreateInput {
  return buildAuditData({
    actorId: f.userId,
    actorType: "USER",
    action: AuditAction.SECURITY_ANOMALY_DETECTED,
    result: "FAILURE",
    target: { type: "platform-area", id: f.area },
    metadata: {
      key: accessDeniedKey(f.userId, f.area),
      type: ACCESS_DENIED_ANOMALY_TYPE,
      count,
      threshold: 1,
      windowMinutes: ACCESS_DENIED_WINDOW_MINUTES,
      area: f.area,
      needed: f.needed,
      grant: f.grant,
    },
    ipAddress: f.ipAddress ?? null,
    userAgent: f.userAgent ?? null,
  });
}

// ── The best-effort writer (one process-wide throttle) ───────────────────────

const throttle = new DenialThrottle();

export interface AccessDeniedWriter {
  auditLog: { createMany(args: { data: Prisma.AuditLogUncheckedCreateInput[] }): Promise<unknown> };
}

/**
 * Record a refusal, bounded and off the critical path. Returns the admission
 * decision synchronously (tests); the write itself is never awaited by the
 * caller and never throws into it.
 */
export function recordPlatformAccessDenied(
  f: AccessDeniedFacts,
  deps: { client: AccessDeniedWriter; nowMs?: number; throttle?: DenialThrottle },
): DenialAdmission {
  const t = deps.throttle ?? throttle;
  const decision = t.admit(accessDeniedKey(f.userId, f.area), deps.nowMs ?? Date.now());
  if (!decision.write) return decision;
  try {
    const data = buildAccessDeniedAudit(f, decision.count);
    void Promise.resolve(deps.client.auditLog.createMany({ data: [data] })).catch((err: unknown) => {
      console.warn("[platform/access-denied] audit write failed (non-fatal):", err);
    });
  } catch (err) {
    console.warn("[platform/access-denied] audit build failed (non-fatal):", err);
  }
  return decision;
}
