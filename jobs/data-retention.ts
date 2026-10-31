/**
 * jobs/data-retention.ts  (PRIV-003 · DB-001 · OBS-007 · PRIV-012)
 *
 * THE RETENTION SCHEDULE, executed. Nine operational ledgers and two
 * identity-bearing tables grew without bound (DB-001); the waitlist kept
 * denied applicants' e-mail and free-text notes forever (PRIV-012). This job
 * deletes rows past their window, in bounded batches, through the system
 * principal (fm_system holds DELETE on every table below — verified against
 * the RLS migration's grants).
 *
 * It runs as the body of the registered `purge-trash` job (07:30 UTC daily):
 * that registration's own header reserved the slot for "a future retention
 * arm", and every scheduler/health/operations surface already knows the name,
 * so no registry entry is added (lib/jobs/purge-trash.ts delegates here).
 *
 * Each rule is (table, the instant column, the window, an optional extra
 * predicate). Deletion is id-batched — select ≤ BATCH ids oldest-first, then
 * delete those ids WITH the predicate repeated, so a row that changed between
 * the two statements (a session un-revoked, a job still running) is never
 * deleted. At most MAX_BATCHES per table per run; a table with more is
 * reported `exhausted: false` and continues tomorrow. One table's failure
 * never stops the others.
 *
 * Children: RefreshExecution's RefreshEndpointResult, ProviderCall and
 * RefreshEndpointAccountCoverage, and SyncIssue's SyncIssueOccurrence, are
 * onDelete: Cascade — they go with their parent. ProviderCall also has its
 * own rule so an orphan-free but long-lived execution cannot pin them.
 *
 * COMMS CENTER A-2a — CommsDelivery is NOT a plain delete rule: its rows are
 * ROLLED into CommsDeliveryDaily (counts only) and deleted in the same
 * transaction after 90 days (lib/notifications/delivery/rollup.ts). It runs
 * after the rules, through the same system principal, and its failure never
 * affects them (reported as `commsDelivery`).
 *
 * NOT here, by decision: AuditLog (security evidence; product events already
 * have their own 13-month job), Notification (lib/notifications/cleanup.ts),
 * RateLimit (sweep-rate-limits), financial data of any kind.
 */

import { runCommsDeliveryRollup, type CommsRollupResult, type RollupClient } from "@/lib/notifications/delivery/rollup";

const DAY_MS = 86_400_000;
export const RETENTION_BATCH = 1000;
export const RETENTION_MAX_BATCHES = 20;

export type RetentionTable =
  | "userSession" | "aiInvocation" | "jobRun" | "refreshExecution" | "providerCall"
  | "plaidWebhookEvent" | "syncIssue" | "apiUsageCounter" | "betaAccessRequest"
  | "betaAccessRequestEvent" | "dailyBrief";

export interface RetentionRule {
  table: RetentionTable;
  /** Human-readable schedule line (the docs table is generated from these). */
  what: string;
  days: number;
  /** The predicate for rows past their window, given the cutoff instant. */
  where: (cutoff: Date) => Record<string, unknown>;
  /** The column the oldest-first batch order uses. */
  orderBy: string;
}

/** THE schedule. Changing a window is a privacy decision — say so in the commit. */
export const RETENTION_RULES: readonly RetentionRule[] = [
  { table: "userSession", what: "UserSession revoked more than 30 days ago (IP + user agent)", days: 30,
    where: (c) => ({ revokedAt: { not: null, lt: c } }), orderBy: "revokedAt" },
  { table: "aiInvocation", what: "AiInvocation older than 90 days", days: 90,
    where: (c) => ({ occurredAt: { lt: c } }), orderBy: "occurredAt" },
  { table: "jobRun", what: "JobRun finished, started more than 90 days ago", days: 90,
    where: (c) => ({ startedAt: { lt: c }, status: { not: "running" } }), orderBy: "startedAt" },
  { table: "refreshExecution", what: "RefreshExecution (+ endpoint results, provider calls, coverage by cascade) older than 60 days", days: 60,
    where: (c) => ({ startedAt: { lt: c } }), orderBy: "startedAt" },
  { table: "providerCall", what: "ProviderCall older than 60 days", days: 60,
    where: (c) => ({ startedAt: { lt: c } }), orderBy: "startedAt" },
  { table: "plaidWebhookEvent", what: "PlaidWebhookEvent older than 30 days", days: 30,
    where: (c) => ({ receivedAt: { lt: c } }), orderBy: "receivedAt" },
  { table: "syncIssue", what: "SyncIssue resolved more than 90 days ago (+ occurrences by cascade)", days: 90,
    where: (c) => ({ resolved: true, OR: [{ resolvedAt: { lt: c } }, { resolvedAt: null, updatedAt: { lt: c } }] }), orderBy: "updatedAt" },
  { table: "apiUsageCounter", what: "ApiUsageCounter day buckets older than 90 days", days: 90,
    where: (c) => ({ day: { lt: c } }), orderBy: "day" },
  { table: "betaAccessRequest", what: "BetaAccessRequest DENIED, or PENDING/APPROVED-and-unredeemed, untouched for 180 days (REDEEMED kept until account deletion)", days: 180,
    where: (c) => ({ OR: [
      { status: "DENIED", OR: [{ decidedAt: { lt: c } }, { decidedAt: null, createdAt: { lt: c } }] },
      { status: "PENDING", createdAt: { lt: c } },
      { status: "APPROVED", OR: [{ inviteExpiresAt: { lt: c } }, { inviteExpiresAt: null, createdAt: { lt: c } }] },
    ] }), orderBy: "createdAt" },
  { table: "betaAccessRequestEvent", what: "BetaAccessRequestEvent older than 180 days", days: 180,
    where: (c) => ({ receivedAt: { lt: c } }), orderBy: "receivedAt" },
  { table: "dailyBrief", what: "DailyBrief for days more than 90 days ago", days: 90,
    where: (c) => ({ briefDay: { lt: c } }), orderBy: "briefDay" },
];

export interface RetentionDelegate {
  findMany(args: { where: Record<string, unknown>; orderBy: Record<string, "asc">; take: number; select: { id: true } }): Promise<{ id: string }[]>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}
export type RetentionClient = Record<RetentionTable, RetentionDelegate>;

export interface RetentionTableResult { deleted: number; batches: number; exhausted: boolean; cutoff: string; error?: string }
export type DataRetentionResult = Record<RetentionTable, RetentionTableResult> & {
  totalDeleted: number;
  /** The delivery-ledger rollup; null when an injected client carried no comms client (unit tests of the rules). */
  commsDelivery: CommsRollupResult | null;
};

export function retentionCutoffFor(rule: Pick<RetentionRule, "days">, now: Date): Date {
  return new Date(now.getTime() - rule.days * DAY_MS);
}

export async function runDataRetention(client?: RetentionClient, now: Date = new Date(), comms?: RollupClient): Promise<DataRetentionResult> {
  const c = client ?? ((await import("@/lib/db")).systemDb as unknown as RetentionClient);
  // An injected rules client never implies the real database for the rollup.
  const commsClient = comms ?? (client ? null : ((await import("@/lib/db")).systemDb as unknown as RollupClient));
  const out = { totalDeleted: 0, commsDelivery: null } as DataRetentionResult;
  for (const rule of RETENTION_RULES) {
    const cutoff = retentionCutoffFor(rule, now);
    const where = rule.where(cutoff);
    const res: RetentionTableResult = { deleted: 0, batches: 0, exhausted: false, cutoff: cutoff.toISOString() };
    try {
      while (res.batches < RETENTION_MAX_BATCHES) {
        const rows = await c[rule.table].findMany({ where, orderBy: { [rule.orderBy]: "asc" }, take: RETENTION_BATCH, select: { id: true } });
        res.batches++;
        if (rows.length === 0) { res.exhausted = true; break; }
        const del = await c[rule.table].deleteMany({ where: { AND: [{ id: { in: rows.map((r) => r.id) } }, where] } });
        res.deleted += del.count;
        if (rows.length < RETENTION_BATCH) { res.exhausted = true; break; }
      }
    } catch (err) {
      res.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      console.error(`[data-retention] ${rule.table} failed (others continue):`, err);
    }
    out[rule.table] = res;
    out.totalDeleted += res.deleted;
    if (res.deleted > 0) console.log(`[data-retention] ${rule.table}: deleted ${res.deleted} row(s) older than ${rule.days} days${res.exhausted ? "" : " (more remain)"}`);
  }
  // runCommsDeliveryRollup never throws (its failure is reported in the result).
  if (commsClient) out.commsDelivery = await runCommsDeliveryRollup(commsClient, now);
  return out;
}
