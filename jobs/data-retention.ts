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
 * COMMS CENTER B2 (contract v1.1 §8.7) — AutomationRun is kept 90 days (parity with the
 * ledger, O-9); its AutomationRunItems go with it by cascade (onDelete: Cascade). A run
 * is deleted only once it is no longer RUNNING and holds no item that could still send
 * (SCHEDULED / SENDING / FAILED-awaiting-retry). The item's dedupeKey names a recipient,
 * so this window also bounds how long any DEDUPE_OPEN can hold (the engine never looks
 * further back than AUTOMATION_RETENTION_DAYS either — N6). AutomationDefinition is kept.
 *
 * COMMS CENTER C — CommsProviderEvent (verified webhook events; no PII) is a
 * plain 90-day rule on receivedAt (owner decision 2026-10-31; fm_system holds
 * DELETE — migration 20261031230000).
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
 *   - networkDigest + networkDigestKeyVersion: HMAC-SHA256(canonical ip) under
 *     the DEDICATED, VERSIONED secret BETA_INTAKE_HASH_KEY_<VERSION> selected
 *     by BETA_INTAKE_HASH_KEY_VERSION (default "v1") — lets an operator see
 *     that two old submissions came from the same address without keeping the
 *     address. Never NEXTAUTH_SECRET or any other secret. With no usable key
 *     NO digest is stored (an unkeyed hash of an IPv4 address is trivially
 *     reversible, so it would not be minimisation) — the raw fields are nulled
 *     regardless — and the absence is logged once per process.
 *     ROTATION: add BETA_INTAKE_HASH_KEY_V2, set BETA_INTAKE_HASH_KEY_VERSION=v2.
 *     Rows minimised from then on carry v2 digests; rows already minimised keep
 *     their v1 digest, labelled "v1" — digests correlate only within a version.
 *   - uaFamily: browser | script | headless | empty | other.
 * See runBetaIntakeNetworkMinimisation.
 */

import { createHmac } from "node:crypto";
import { AUTOMATION_RETENTION_DAYS } from "@/lib/notifications/automations/types";
import { rollupClientFrom, runCommsDeliveryRollup, type CommsRollupResult, type PrismaRollupLike, type RollupClient } from "@/lib/notifications/delivery/rollup";

const DAY_MS = 86_400_000;
export const RETENTION_BATCH = 1000;
export const RETENTION_MAX_BATCHES = 20;

export type RetentionTable =
  | "userSession" | "aiInvocation" | "jobRun" | "refreshExecution" | "providerCall"
  | "plaidWebhookEvent" | "syncIssue" | "apiUsageCounter" | "betaAccessRequest"
  | "betaAccessRequestEvent" | "dailyBrief" | "automationRun" | "commsProviderEvent";

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
  { table: "automationRun", what: "AutomationRun (+ its AutomationRunItems by cascade) started more than 90 days ago, finished, with no item still able to send", days: AUTOMATION_RETENTION_DAYS,
    where: (c) => ({ startedAt: { lt: c }, status: { not: "RUNNING" }, items: { none: { status: { in: ["SCHEDULED", "SENDING", "FAILED"] } } } }), orderBy: "startedAt" },
  // Comms Center C — owner decision 2026-10-31: verified provider (Resend) delivery events, 90 days.
  // The ledger rows they appended follow CommsDelivery's own 90-day rollup.
  { table: "commsProviderEvent", what: "CommsProviderEvent (verified Resend delivery events) received more than 90 days ago", days: 90,
    where: (c) => ({ receivedAt: { lt: c } }), orderBy: "receivedAt" },
];

export interface RetentionDelegate {
  findMany(args: { where: Record<string, unknown>; orderBy: Record<string, "asc">; take: number; select: { id: true } }): Promise<{ id: string }[]>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}
export type RetentionClient = Record<RetentionTable, RetentionDelegate> & {
  /** Optional so a test client for the delete rules need not model AuditLog. */
  auditLog?: AuditMinimiseDelegate;
};

/** In a dry run `deleted` is the number of rows a real run WOULD delete (bounded like a real run). */
export interface RetentionTableResult { deleted: number; batches: number; exhausted: boolean; cutoff: string; error?: string }
export type DataRetentionResult = Record<RetentionTable, RetentionTableResult> & {
  totalDeleted: number;
  /** True when nothing was written (counts are would-be). */
  dryRun: boolean;
  /** The delivery-ledger rollup; null when an injected client carried no comms client (unit tests of the rules). */
  commsDelivery: CommsRollupResult | null;
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
/** Default BETA_INTAKE_HASH_KEY_VERSION. */
export const NETWORK_DIGEST_DEFAULT_VERSION = "v1";
/** Shortest accepted hash key (characters). Generate with `openssl rand -hex 32`. */
export const NETWORK_DIGEST_MIN_KEY_LENGTH = 32;

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

/** A usable digest key and the version label stored beside every digest it makes. */
export interface NetworkDigestKey { key: Buffer; version: string }

let warnedKey: string | null = null;
function warnKeyOnce(msg: string): void {
  if (warnedKey === msg) return;
  warnedKey = msg;
  console.warn(`[data-retention] ${msg} — beta-intake network fields will be nulled WITHOUT a digest`);
}

/**
 * The digest key, from the DEDICATED versioned env vars (read from process.env
 * at call time, the house pattern for secrets used at one site; lib/env.ts
 * mirrors them for startup validation and the env report):
 *   BETA_INTAKE_HASH_KEY_VERSION  "v1" (default), "v2", …
 *   BETA_INTAKE_HASH_KEY_<V>      the secret for that version, ≥ 32 characters.
 * Null — and logged once — when the version label is malformed or its key is
 * unset/too short. NEVER falls back to NEXTAUTH_SECRET or any other secret.
 */
export function resolveNetworkDigestKey(source: Record<string, string | undefined> = process.env): NetworkDigestKey | null {
  const version = (source.BETA_INTAKE_HASH_KEY_VERSION || NETWORK_DIGEST_DEFAULT_VERSION).trim().toLowerCase();
  if (!/^v[1-9]\d{0,2}$/.test(version)) { warnKeyOnce(`BETA_INTAKE_HASH_KEY_VERSION "${version}" is not v1, v2, …`); return null; }
  const name = `BETA_INTAKE_HASH_KEY_${version.toUpperCase()}`;
  const secret = source[name];
  if (!secret) { warnKeyOnce(`${name} is not set`); return null; }
  if (secret.length < NETWORK_DIGEST_MIN_KEY_LENGTH) { warnKeyOnce(`${name} is shorter than ${NETWORK_DIGEST_MIN_KEY_LENGTH} characters`); return null; }
  return { key: Buffer.from(secret, "utf8"), version };
}

/**
 * Canonical text of an IP before digesting, so one address never yields two
 * digests: trimmed, lowercased (IPv6 hex), an IPv4-mapped IPv6 address
 * (`::ffff:203.0.113.9`) reduced to its IPv4 form, and IPv6 run through the
 * WHATWG URL parser (RFC 5952 compression, zero-suppression). Unparseable
 * input is digested as trimmed/lowercased text.
 */
export function canonicalIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1];
  if (s.includes(":")) {
    try {
      const host = new URL(`http://[${s}]/`).hostname.slice(1, -1);
      // The URL parser prints IPv4-mapped addresses in hex (::ffff:cb00:7109).
      const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
      if (hexMapped) {
        const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
        return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      }
      return host;
    } catch { return s; }
  }
  return s;
}

export function networkDigest(ip: string, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalIp(ip)).digest("hex");
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
export function minimiseAuditNetwork(row: AuditNetworkRow, key: NetworkDigestKey | null, now: Date): {
  ipAddress: null; userAgent: null; metadata: Record<string, unknown>;
} {
  const m = row.metadata;
  const base: Record<string, unknown> =
    m && typeof m === "object" && !Array.isArray(m) ? { ...(m as Record<string, unknown>) }
    : m == null ? {} : { originalMetadata: m };
  if (row.userAgent != null || base.uaFamily === undefined) base.uaFamily = uaFamily(row.userAgent);
  if (row.ipAddress && key) {
    base.networkDigest = networkDigest(row.ipAddress, key.key);
    base.networkDigestKeyVersion = key.version;
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
  dryRun: boolean; digestKeyAvailable: boolean; digestKeyVersion: string | null; error?: string;
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
  opts: { dryRun?: boolean; key?: NetworkDigestKey | null } = {},
): Promise<MinimisationResult> {
  const cutoff = retentionCutoffFor({ days: BETA_INTAKE_NETWORK_DAYS }, now);
  const where = betaIntakeMinimiseWhere(cutoff);
  const key = opts.key === undefined ? resolveNetworkDigestKey() : opts.key;
  const res: MinimisationResult = {
    minimised: 0, batches: 0, exhausted: false, cutoff: cutoff.toISOString(),
    dryRun: !!opts.dryRun, digestKeyAvailable: !!key, digestKeyVersion: key?.version ?? null,
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

export async function runDataRetention(
  client?: RetentionClient,
  now: Date = new Date(),
  comms?: RollupClient,
  opts: { dryRun?: boolean } = {},
): Promise<DataRetentionResult> {
  const c = client ?? ((await import("@/lib/db")).systemDb as unknown as RetentionClient);
  // An injected rules client never implies the real database for the rollup.
  const commsClient = comms ?? (client ? null : rollupClientFrom((await import("@/lib/db")).systemDb as unknown as PrismaRollupLike));
  const dryRun = !!opts.dryRun;
  const out = { totalDeleted: 0, dryRun, commsDelivery: null } as DataRetentionResult;
  for (const rule of RETENTION_RULES) {
    const cutoff = retentionCutoffFor(rule, now);
    const where = rule.where(cutoff);
    const res: RetentionTableResult = { deleted: 0, batches: 0, exhausted: false, cutoff: cutoff.toISOString() };
    try {
      if (dryRun) {
        // Read-only: the rows ONE real run would reach (same order, same bound).
        const cap = RETENTION_BATCH * RETENTION_MAX_BATCHES;
        const rows = await c[rule.table].findMany({ where, orderBy: { [rule.orderBy]: "asc" }, take: cap, select: { id: true } });
        res.deleted = rows.length;
        res.exhausted = rows.length < cap;
      }
      while (!dryRun && res.batches < RETENTION_MAX_BATCHES) {
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
    if (res.deleted > 0) console.log(`[data-retention] ${rule.table}: ${dryRun ? "DRY RUN — would delete" : "deleted"} ${res.deleted} row(s) older than ${rule.days} days${res.exhausted ? "" : " (more remain)"}`);
  }
  // R2 — minimise (never delete) beta-intake audit network fields past 90 days.
  if (c.auditLog) out.betaIntakeNetwork = await runBetaIntakeNetworkMinimisation({ auditLog: c.auditLog }, now, { dryRun });
  // runCommsDeliveryRollup never throws (its failure is reported in the result).
  // It has no dry-run mode (it writes rollups and deletes), so a dry run skips it.
  if (commsClient && !dryRun) out.commsDelivery = await runCommsDeliveryRollup(commsClient, now);
  return out;
}
