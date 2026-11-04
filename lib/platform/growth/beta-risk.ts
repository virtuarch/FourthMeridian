/**
 * lib/platform/growth/beta-risk.ts  (Beta-request risk — THE READER)
 *
 * Loads the facts lib/platform/growth/beta-risk-core.ts folds, on fm_system
 * (`systemDb` — an operator reading the fleet's intake is outside every
 * tenancy; lib/platform/ is the allowlisted neighbourhood). Read-only.
 *
 * NETWORK GROUPING IS KEYED (S2 ruling on PR #374). The forensic
 * BETA_ACCESS_REQUESTED audit rows yield a network GROUP KEY — the beta-intake
 * keyed digest (HMAC-SHA256 under BETA_INTAKE_HASH_KEY_<V>), see
 * ./beta-risk-network.ts:
 *   · a raw row's ipAddress is selected (as `ip`, ONLY when a digest key is
 *     configured — otherwise SQL returns NULL in its place) and digested at
 *     the row boundary, in the same loop that reads it; the address is never
 *     kept in any structure, returned or logged;
 *   · a minimised row's stored metadata.networkDigest is taken as-is, so
 *     grouping survives the 90-day minimisation.
 * No key ⇒ no grouping signal (fail closed) — never an unkeyed hash. HMAC is
 * computed in JS because pgcrypto is installed by no migration. (Before this,
 * the key was md5(<per-read random salt> || ipAddress) in SQL: never stored or
 * returned, but an MD5 of the address, and blind to minimised rows.)
 * The user agent is still reduced IN SQL to a FAMILY (browser / script /
 * headless / empty / other) by a CASE over case-insensitive regexes — the
 * UA_*_PATTERN constants of the core, bound as parameters, so the tested
 * patterns are the ones that run; userAgent never appears in a SELECT list.
 * The privacy scan (lib/platform/observability-privacy.test.ts) pins this file.
 *
 * ADDRESSES stay inside this module. Request e-mails are read (the queue is
 * about addresses) only to derive opaque keys — the md5 the event SQL uses, the
 * sha256 the audit row already carries (lib/audit.ts auditEmailHash, computed
 * here in JS: pgcrypto is not installed by any migration), the folded mailbox
 * and the domain — and none of them is returned.
 *
 * BOUNDED. Every read carries a row cap and a look-back equal to the waitlist
 * retention; a capped read is reported as a note ("at least"), never hidden.
 */

import "server-only";
import { createHash } from "node:crypto";
import { systemDb } from "@/lib/db";
import { resolveNetworkDigestKey, type NetworkDigestKey } from "@/jobs/data-retention";
import { AuditAction } from "@/lib/audit-actions";
import { auditEmailHash } from "@/lib/audit";
import { boundAcquisitionSource } from "@/lib/marketing/acquisition";
import { DISPOSABLE_EMAIL_DOMAINS } from "@/lib/marketing/disposable-domains";
import { operatorDisplayName } from "@/lib/platform/customer/identity-label";
import {
  UA_BROWSER_PATTERN, UA_HEADLESS_PATTERN, UA_SCRIPT_PATTERN,
  assessBetaRisk, canonicalEmailKey, emailDomain, noteFingerprint, tally,
  type BetaRiskAuditFact, type BetaRiskRequestFacts, type UaFamily,
} from "./beta-risk-core";
import { networkGroupKeyer } from "./beta-risk-network";
import { BETA_RISK_REVIEW_STATUSES, type BetaRequestRisk, type BetaRiskReviewStatusValue, type BetaRiskReviewSummary } from "./beta-risk-types";

export type BetaRiskDb = typeof systemDb;

/** Look-back for fleet facts — the waitlist / event retention (180 d). */
export const BETA_RISK_LOOKBACK_DAYS = 180;
/** BetaAccessRequest rows read for alias / duplicate-note folding. */
export const BETA_RISK_REQUEST_CAP = 5_000;
/** BetaAccessRequestEvent rows read for bursts and per-request submissions. */
export const BETA_RISK_EVENT_CAP = 20_000;
/** BETA_ACCESS_REQUESTED audit rows read for network / user-agent facts. */
export const BETA_RISK_AUDIT_CAP = 20_000;
/** Review rows read to find each listed request's latest verdict. */
export const BETA_RISK_REVIEW_READ_CAP = 5_000;

const UA_FAMILIES: ReadonlySet<string> = new Set<UaFamily>(["browser", "script", "headless", "empty", "other"]);
/** Requester-ADDRESS join key; matches the SQL md5(lower(trim("email"))). Never applied to a network identifier. */
const emailKey = (s: string) => createHash("md5").update(s).digest("hex");

export interface BetaRiskResult {
  byId: Map<string, BetaRequestRisk>;
  /** Plain-language notes for the queue ("read cap reached …"). */
  notes: string[];
}

/**
 * Assess the given requests against the fleet. Unknown ids, and requests that
 * were never submitted through the public form (no event AND no forensic row —
 * a direct invitation), are skipped (no entry in `byId`). Never throws for a missing review table: the verdicts then
 * read as null with a note, and the signals still compute.
 */
export async function loadBetaRisk(
  requestIds: readonly string[],
  deps: { now?: Date; client?: BetaRiskDb; /** Injected digest key (tests); default resolveNetworkDigestKey(). */ digestKey?: NetworkDigestKey | null } = {},
): Promise<BetaRiskResult> {
  const client = deps.client ?? systemDb;
  const now = deps.now ?? new Date();
  const ids = [...new Set(requestIds)];
  const byId = new Map<string, BetaRequestRisk>();
  if (ids.length === 0) return { byId, notes: [] };

  const since = new Date(now.getTime() - BETA_RISK_LOOKBACK_DAYS * 86_400_000);
  // The beta-intake keyed digest; null ⇒ no network grouping (fail closed).
  const digestKey = deps.digestKey === undefined ? resolveNetworkDigestKey() : deps.digestKey;
  const groupKey = networkGroupKeyer(digestKey);
  const keyed = digestKey !== null;

  const [fleetRequests, eventRows, auditRows] = await Promise.all([
    client.betaAccessRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: BETA_RISK_REQUEST_CAP,
      select: { id: true, email: true, note: true },
    }),
    client.$queryRaw<{ k: string; at: Date; source: unknown }[]>`
      SELECT md5(lower(trim("email"))) AS k, "receivedAt" AS at, "source"
        FROM "BetaAccessRequestEvent"
       WHERE "receivedAt" >= ${since}
       ORDER BY "receivedAt" DESC
       LIMIT ${BETA_RISK_EVENT_CAP}`,
    client.$queryRaw<{ h: string | null; at: Date; ip: string | null; nd: string | null; ndv: string | null; ua: string | null }[]>`
      SELECT "metadata"->>'emailHash' AS h,
             "createdAt" AS at,
             CASE WHEN ${keyed}::boolean THEN "ipAddress" ELSE NULL END AS ip,
             "metadata"->>'networkDigest' AS nd,
             "metadata"->>'networkDigestKeyVersion' AS ndv,
             CASE WHEN "userAgent" IS NULL OR btrim("userAgent") = '' THEN 'empty'
                  WHEN "userAgent" ~* ${UA_SCRIPT_PATTERN} THEN 'script'
                  WHEN "userAgent" ~* ${UA_HEADLESS_PATTERN} THEN 'headless'
                  WHEN "userAgent" ~* ${UA_BROWSER_PATTERN} THEN 'browser'
                  ELSE 'other' END AS ua
        FROM "AuditLog"
       WHERE "action" = ${AuditAction.BETA_ACCESS_REQUESTED}
         AND "createdAt" >= ${since}
       ORDER BY "createdAt" DESC
       LIMIT ${BETA_RISK_AUDIT_CAP}`,
  ]);

  // Targets outside the capped fleet read are fetched by id so they are still assessed.
  const known = new Set(fleetRequests.map((r) => r.id));
  const missing = ids.filter((id) => !known.has(id));
  const extra = missing.length === 0 ? [] : await client.betaAccessRequest.findMany({
    where: { id: { in: missing } },
    select: { id: true, email: true, note: true },
  });
  const requests = [...fleetRequests, ...extra];

  const notes: string[] = [];
  const capped = [
    fleetRequests.length >= BETA_RISK_REQUEST_CAP ? "requests" : null,
    eventRows.length >= BETA_RISK_EVENT_CAP ? "submissions" : null,
    auditRows.length >= BETA_RISK_AUDIT_CAP ? "forensic rows" : null,
  ].filter((x): x is string => x !== null);
  if (capped.length > 0) notes.push(`Risk read cap reached for ${capped.join(", ")} — fleet counts are a floor.`);
  if (!keyed) notes.push("Shared-network grouping is off: no network digest key is configured.");

  // ── Fold to facts (addresses end here) ─────────────────────────────────────
  const canonical = new Map(requests.map((r) => [r.id, canonicalEmailKey(r.email)] as const));
  const fingerprint = new Map(requests.map((r) => [r.id, noteFingerprint(r.note)] as const));
  const aliasClusterSizes = tally(canonical.values());
  const noteCounts = tally(fingerprint.values());

  const eventsByKey = new Map<string, { at: Date; sourcePresent: boolean }[]>();
  for (const e of eventRows) {
    const src = boundAcquisitionSource(e.source);
    const sourcePresent = !!src && Object.keys(src).some((k) => k !== "country");
    const list = eventsByKey.get(e.k) ?? [];
    list.push({ at: e.at, sourcePresent });
    eventsByKey.set(e.k, list);
  }

  const auditByKey = new Map<string, BetaRiskAuditFact[]>();
  const network: { auditKey: string; networkDigest: string; at: Date }[] = [];
  for (const a of auditRows) {
    // The raw address (when selected) ends HERE: reduced to its keyed group key.
    const net = groupKey({ ip: a.ip, storedDigest: a.nd, storedVersion: a.ndv });
    a.ip = null;
    if (!a.h) continue;
    const fact: BetaRiskAuditFact = {
      at: a.at,
      networkDigest: net,
      uaFamily: a.ua && UA_FAMILIES.has(a.ua) ? (a.ua as UaFamily) : null,
    };
    const list = auditByKey.get(a.h) ?? [];
    list.push(fact);
    auditByKey.set(a.h, list);
    if (net) network.push({ auditKey: a.h, networkDigest: net, at: a.at });
  }

  const wanted = new Set(ids);
  const facts: BetaRiskRequestFacts[] = [];
  for (const r of requests) {
    if (!wanted.has(r.id)) continue;
    wanted.delete(r.id);
    const requesterKey = emailKey(r.email.trim().toLowerCase());
    const auditKey = auditEmailHash(r.email);
    const events = eventsByKey.get(requesterKey) ?? [];
    const audit = auditByKey.get(auditKey) ?? [];
    // Never submitted through the public form (a direct invitation, PO-3C):
    // there is nothing to assess, so the row carries NO risk block rather than
    // a misleading "insufficient evidence".
    if (events.length === 0 && audit.length === 0) continue;
    facts.push({
      requestId: r.id,
      requesterKey,
      auditKey,
      emailCanonicalKey: canonical.get(r.id)!,
      domain: emailDomain(r.email),
      noteHash: fingerprint.get(r.id) ?? null,
      eventTimes: events.map((e) => e.at),
      sourcePresent: events.some((e) => e.sourcePresent),
      audit,
    });
  }

  const assessed = assessBetaRisk(facts, {
    submissions: eventRows.map((e) => ({ requesterKey: e.k, at: e.at })),
    network,
    aliasClusterSizes,
    noteCounts,
    disposableDomains: DISPOSABLE_EMAIL_DOMAINS,
  });

  let reviews: Map<string, BetaRiskReviewSummary>;
  try {
    reviews = await loadLatestReviews(client, facts.map((f) => f.requestId));
  } catch (err) {
    console.error("[beta-risk] review history unavailable:", (err as Error).message);
    notes.push("Review history is unavailable; verdicts are not shown.");
    reviews = new Map();
  }

  for (const [id, a] of assessed) {
    byId.set(id, { level: a.level, reasons: a.reasons, review: reviews.get(id) ?? null });
  }
  return { byId, notes };
}

const isStatus = (v: unknown): v is BetaRiskReviewStatusValue =>
  typeof v === "string" && (BETA_RISK_REVIEW_STATUSES as readonly string[]).includes(v);

/** Operator id → display label (username → name → opaque). Never an e-mail. */
export async function operatorLabels(client: BetaRiskDb, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === "string"))];
  if (wanted.length === 0) return new Map();
  const users = await client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, username: true, name: true } });
  return new Map(users.map((u) => [u.id, operatorDisplayName(u)] as const));
}

/** The LATEST verdict per request (the current state of an append-only history). */
export async function loadLatestReviews(client: BetaRiskDb, requestIds: readonly string[]): Promise<Map<string, BetaRiskReviewSummary>> {
  if (requestIds.length === 0) return new Map();
  // Newest first; the first row seen per request is its current state.
  const rows = await client.betaAccessRequestReview.findMany({
    where: { requestId: { in: [...requestIds] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: BETA_RISK_REVIEW_READ_CAP,
    select: { requestId: true, status: true, createdAt: true, operatorId: true },
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.requestId)) latest.set(r.requestId, r);
  const labels = await operatorLabels(client, [...latest.values()].map((r) => r.operatorId));
  const out = new Map<string, BetaRiskReviewSummary>();
  for (const r of latest.values()) {
    if (!isStatus(r.status)) continue;
    out.set(r.requestId, { status: r.status, at: r.createdAt.toISOString(), by: r.operatorId ? labels.get(r.operatorId) ?? null : null });
  }
  return out;
}
