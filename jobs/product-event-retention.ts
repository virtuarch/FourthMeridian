/**
 * jobs/product-event-retention.ts  (BETA A6 — product-event retention)
 *
 * Deletes AuditLog rows whose action ∈ PRODUCT_EVENT_ACTIONS (lib/audit-actions.ts
 * — SESSION_ACTIVE_DAY, SPACE_VIEWED, BRIEF_VIEWED, TRANSACTIONS_VIEWED,
 * MANUAL_ASSET_VALUE_UPDATED) and whose createdAt is older than the owner's
 * 13-month rolling window (decision A6, 2026-10-15). NOTHING ELSE: security,
 * auth, operator and product-lifecycle actions (ACCOUNT_ADD, WALLET_ADD,
 * MANUAL_ASSET_ADD included) are never selected, by construction — every
 * statement names the action list AND the cutoff, so there is no code path that
 * can reach another row. Registered daily, fixed (lib/jobs/registry.core.ts).
 *
 * BOUNDED BATCHES. Each pass selects at most PRODUCT_EVENT_RETENTION_BATCH ids
 * (oldest first, on the (action, createdAt) index) and deletes exactly those,
 * re-stating the action and cutoff predicates on the DELETE so a row that no
 * longer qualifies is left alone. At most PRODUCT_EVENT_RETENTION_MAX_BATCHES
 * passes per run; what remains waits for tomorrow (`exhausted: false` in the
 * summary says so). Idempotent: a second run in the same instant deletes 0.
 *
 * AUTHORITY. fm_system (lazy import, so loading the module touches no database):
 * the tenant role has no DELETE on AuditLog, and the rows span every tenant.
 *
 * SUMMARY: counts and an ISO cutoff only — no id, no user, no metadata.
 */

import { PRODUCT_EVENT_ACTIONS } from "@/lib/audit-actions";

export const PRODUCT_EVENT_RETENTION_MONTHS = 13;
export const PRODUCT_EVENT_RETENTION_BATCH = 1000;
export const PRODUCT_EVENT_RETENTION_MAX_BATCHES = 20;

/** Exactly the two operations the job performs (injection seam for tests). */
export interface ProductEventRetentionClient {
  auditLog: {
    findMany(args: {
      where: { action: { in: string[] }; createdAt: { lt: Date } };
      orderBy: { createdAt: "asc" }; take: number; select: { id: true };
    }): Promise<{ id: string }[]>;
    deleteMany(args: {
      where: { id: { in: string[] }; action: { in: string[] }; createdAt: { lt: Date } };
    }): Promise<{ count: number }>;
  };
}

export interface ProductEventRetentionResult {
  /** Rows deleted this run. */
  deleted: number;
  /** The absolute cutoff applied (ISO): rows strictly older were eligible. */
  cutoff: string;
  /** Batches executed. */
  batches: number;
  /** True when the last batch was short — nothing eligible remains. False ⇒ more waits for the next run. */
  exhausted: boolean;
}

/** `now` minus the retention window, in UTC calendar months (overflow days roll forward per Date.UTC). */
export function retentionCutoff(now: Date, months: number = PRODUCT_EVENT_RETENTION_MONTHS): Date {
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate(),
    now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds(),
  ));
}

export async function retainProductEvents(
  client?: ProductEventRetentionClient,
  now: Date = new Date(),
): Promise<ProductEventRetentionResult> {
  const c = client ?? ((await import("@/lib/db")).systemDb as unknown as ProductEventRetentionClient);
  const cutoff = retentionCutoff(now);
  const actions = [...PRODUCT_EVENT_ACTIONS];

  let deleted = 0, batches = 0, exhausted = false;
  while (batches < PRODUCT_EVENT_RETENTION_MAX_BATCHES) {
    const rows = await c.auditLog.findMany({
      where: { action: { in: actions }, createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" }, take: PRODUCT_EVENT_RETENTION_BATCH, select: { id: true },
    });
    batches++;
    if (rows.length === 0) { exhausted = true; break; }
    const res = await c.auditLog.deleteMany({
      where: { id: { in: rows.map((r) => r.id) }, action: { in: actions }, createdAt: { lt: cutoff } },
    });
    deleted += res.count;
    if (rows.length < PRODUCT_EVENT_RETENTION_BATCH) { exhausted = true; break; }
  }

  if (deleted > 0) {
    console.log(`[product-event-retention] deleted ${deleted} product-event row(s) older than ${PRODUCT_EVENT_RETENTION_MONTHS} months in ${batches} batch(es)${exhausted ? "" : " (more remain)"}`);
  }
  return { deleted, cutoff: cutoff.toISOString(), batches, exhausted };
}
