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
 * NOT here, by decision: AuditLog DELETION (security evidence; product events
 * already have their own 13-month job), Notification (lib/notifications/
 * cleanup.ts), RateLimit (sweep-rate-limits), financial data of any kind.
 *
 * AuditLog MINIMISATION (R2 beta intake, owner decision 2026-10-31): the
 * public access-request intake writes BETA_ACCESS_REQUESTED rows carrying the
 * raw IP and user agent of an unauthenticated applicant. Those are retained
 * for 90 days (abuse forensics), then MINIMISED in place — never deleted:
 * ipAddress/userAgent are nulled and replaced in metadata by
 *   - networkDigest: HMAC-SHA256(ip) under a key derived from NEXTAUTH_SECRET
 *     (domain-separated, see networkDigestKey) — lets an operator see that two
 *     old submissions came from the same address without keeping the address.
 *     With no secret available NOTHING is stored (an unkeyed hash of an IPv4
 *     address is trivially reversible, so it would not be minimisation).
 *   - uaFamily: browser | script | headless | empty | other.
 * See runBetaIntakeNetworkMinimisation.
 */

import { createHmac } from "node:crypto";

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
export type RetentionClient = Record<RetentionTable, RetentionDelegate> & {
  /** Optional so a test client for the delete rules need not model AuditLog. */
  auditLog?: AuditMinimiseDelegate;
};

export interface RetentionTableResult { deleted: number; batches: number; exhausted: boolean; cutoff: string; error?: string }
export type DataRetentionResult = Record<RetentionTable, RetentionTableResult> & {
  totalDeleted: number;
  /** R2 — BETA_ACCESS_REQUESTED network-field minimisation (absent when the client has no auditLog). */
  betaIntakeNetwork?: MinimisationResult;
};

// ── R2 — BETA_ACCESS_REQUESTED network-field minimisation ─────────────────────

/** Days the raw IP + user agent of a beta-intake audit row are kept. */
export const BETA_INTAKE_NETWORK_DAYS = 90;
/** Rows per batch / batches per run (one update per row, so smaller than RETENTION_BATCH). */
export const MINIMISE_BATCH = 200;
export const MINIMISE_MAX_BATCHES = 10;
/** The audit action minimised (literal: lib/audit-actions AuditAction.BETA_ACCESS_REQUESTED). */
export const BETA_INTAKE_AUDIT_ACTION = "BETA_ACCESS_REQUESTED";
/** Identifies the digest key derivation, so a future rotation is detectable in the data. */
export const NETWORK_DIGEST_KEY_ID = "nextauth-hmac-v1";

export type UaFamily = "browser" | "script" | "headless" | "empty" | "other";

const HEADLESS_RE = /headlesschrome|phantomjs|puppeteer|playwright|selenium|webdriver|slimerjs|lighthouse/i;
const SCRIPT_RE = /curl|wget|python|aiohttp|httpx|go-http-client|node-fetch|undici|axios|okhttp|java\/|libwww|perl|ruby|php|httpie|postman|insomnia|scrapy|bot\b|bot\/|crawler|spider|^node$|deno|bun\//i;
const BROWSER_RE = /^mozilla\/5\.0 .*(chrome|crios|safari|firefox|fxios|edg|opr)\//i;

/** Coarse, non-identifying classification of a user-agent string. */
export function uaFamily(ua: string | null | undefined): UaFamily {
  const s = (ua ?? "").trim();
  if (!s) return "empty";
  if (HEADLESS_RE.test(s)) return "headless";
  if (SCRIPT_RE.test(s)) return "script";
  if (BROWSER_RE.test(s)) return "browser";
  return "other";
}

/**
 * The digest key: HMAC(NEXTAUTH_SECRET, purpose label). Domain-separated so the
 * digest can never be confused with (or help forge) anything else keyed on the
 * same secret. Null when no secret is configured — the caller then stores no
 * digest at all. Rotating NEXTAUTH_SECRET changes the key, so digests only
 * correlate within one key epoch (recorded via NETWORK_DIGEST_KEY_ID).
 */
export function networkDigestKey(secret: string | undefined | null = process.env.NEXTAUTH_SECRET): Buffer | null {
  if (!secret) return null;
  return createHmac("sha256", secret).update("fm:beta-intake:network-digest:v1").digest();
}

export function networkDigest(ip: string, key: Buffer): string {
  return createHmac("sha256", key).update(ip.trim().toLowerCase()).digest("hex");
}

export interface AuditNetworkRow {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
}

/**
 * PURE: the minimised form of one audit row. ipAddress/userAgent are always
 * nulled; metadata keeps every existing key and gains uaFamily, a networkDigest
 * (only when both an IP and a key exist) and networkMinimisedAt. Idempotent: a
 * row already minimised keeps its earlier digest/family.
 */
export function minimiseAuditNetwork(row: AuditNetworkRow, key: Buffer | null, now: Date): {
  ipAddress: null; userAgent: null; metadata: Record<string, unknown>;
} {
  const m = row.metadata;
  const base: Record<string, unknown> =
    m && typeof m === "object" && !Array.isArray(m) ? { ...(m as Record<string, unknown>) }
    : m == null ? {} : { originalMetadata: m };
  if (row.userAgent != null || base.uaFamily === undefined) base.uaFamily = uaFamily(row.userAgent);
  if (row.ipAddress && key) {
    base.networkDigest = networkDigest(row.ipAddress, key);
    base.networkDigestKeyId = NETWORK_DIGEST_KEY_ID;
  }
  base.networkMinimisedAt ??= now.toISOString();
  return { ipAddress: null, userAgent: null, metadata: base };
}

/** Rows due for minimisation: the action, past the window, with a raw field left. */
export function betaIntakeMinimiseWhere(cutoff: Date): Record<string, unknown> {
  return {
    action: BETA_INTAKE_AUDIT_ACTION,
    createdAt: { lt: cutoff },
    OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
  };
}

export interface AuditMinimiseDelegate {
  findMany(args: {
    where: Record<string, unknown>; orderBy: { createdAt: "asc" }; take: number;
    select: { id: true; ipAddress: true; userAgent: true; metadata: true };
  }): Promise<AuditNetworkRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

export interface MinimisationResult {
  minimised: number; batches: number; exhausted: boolean; cutoff: string;
  dryRun: boolean; digestKeyAvailable: boolean; error?: string;
}

/**
 * Minimise BETA_ACCESS_REQUESTED network fields older than 90 days. Bounded
 * (MINIMISE_BATCH × MINIMISE_MAX_BATCHES per run, oldest first), idempotent
 * (minimised rows no longer match the predicate), never deletes. Each update
 * repeats the predicate beside the id, mirroring the delete rules. `dryRun`
 * only COUNTS the rows that would change.
 */
export async function runBetaIntakeNetworkMinimisation(
  client: { auditLog: AuditMinimiseDelegate },
  now: Date = new Date(),
  opts: { dryRun?: boolean; key?: Buffer | null } = {},
): Promise<MinimisationResult> {
  const cutoff = retentionCutoffFor({ days: BETA_INTAKE_NETWORK_DAYS }, now);
  const where = betaIntakeMinimiseWhere(cutoff);
  const key = opts.key === undefined ? networkDigestKey() : opts.key;
  const res: MinimisationResult = {
    minimised: 0, batches: 0, exhausted: false, cutoff: cutoff.toISOString(),
    dryRun: !!opts.dryRun, digestKeyAvailable: !!key,
  };
  try {
    if (opts.dryRun) {
      res.minimised = await client.auditLog.count({ where });
      res.exhausted = true;
      return res;
    }
    while (res.batches < MINIMISE_MAX_BATCHES) {
      const rows = await client.auditLog.findMany({
        where, orderBy: { createdAt: "asc" }, take: MINIMISE_BATCH,
        select: { id: true, ipAddress: true, userAgent: true, metadata: true },
      });
      res.batches++;
      if (rows.length === 0) { res.exhausted = true; break; }
      for (const row of rows) {
        const data = minimiseAuditNetwork(row, key, now);
        const upd = await client.auditLog.updateMany({ where: { AND: [{ id: row.id }, where] }, data });
        res.minimised += upd.count;
      }
      if (rows.length < MINIMISE_BATCH) { res.exhausted = true; break; }
    }
  } catch (err) {
    res.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    console.error("[data-retention] beta-intake network minimisation failed:", err);
  }
  if (res.minimised > 0) {
    console.log(`[data-retention] auditLog: minimised network fields on ${res.minimised} ${BETA_INTAKE_AUDIT_ACTION} row(s) older than ${BETA_INTAKE_NETWORK_DAYS} days${key ? "" : " (no digest key — digest omitted)"}${res.exhausted ? "" : " (more remain)"}`);
  }
  return res;
}

export function retentionCutoffFor(rule: Pick<RetentionRule, "days">, now: Date): Date {
  return new Date(now.getTime() - rule.days * DAY_MS);
}

export async function runDataRetention(client?: RetentionClient, now: Date = new Date()): Promise<DataRetentionResult> {
  const c = client ?? ((await import("@/lib/db")).systemDb as unknown as RetentionClient);
  const out = { totalDeleted: 0 } as DataRetentionResult;
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
  // R2 — minimise (never delete) beta-intake audit network fields past 90 days.
  if (c.auditLog) out.betaIntakeNetwork = await runBetaIntakeNetworkMinimisation({ auditLog: c.auditLog }, now);
  return out;
}
