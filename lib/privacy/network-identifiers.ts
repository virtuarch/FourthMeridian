/**
 * lib/privacy/network-identifiers.ts  (S2 P8 item 3 — IP / user-agent minimisation, engineering half)
 *
 * THE REGISTRY of every persisted place that holds a client IP address, a user
 * agent, or a key that embeds an IP. Inventory from a source + schema sweep
 * (2026-11-04); the census test (network-identifiers.census.test.ts) keeps it
 * complete: a new IP/UA-bearing column in prisma/schema.prisma, a new object
 * key fed from the request IP / user agent, a new IP-keyed template builder or a
 * new raw INSERT naming "ipAddress"/"userAgent" fails CI until it is
 * registered here.
 *
 * Not in scope, by inspection (the census guards the first two):
 *   · the forwarded-for chain in lib/api.ts RequestMeta — built, never persisted.
 *   · CAPTCHA verification receives the IP (lib/captcha.ts) — sent to the
 *     provider, never stored.
 *   · CommsDelivery / CommsProviderEvent / Notification — no IP or UA (the
 *     staff bell's anomalyKey is the SALTED hash, lib/security/identifier-hash.ts).
 *   · BetaAccessRequestEvent.source — allowlisted acquisition context, "never
 *     an IP" (schema comment); BetaAbuseEvidence's sealed payload holds no IP.
 *   · AuditLog.metadata.networkDigest on minimised BETA_ACCESS_REQUESTED rows
 *     — already a keyed digest, not a raw value.
 *
 * Changing an entry's retention or method is a privacy decision (OWNER).
 * docs/operations/data-retention.md "Network identifiers" renders this table.
 */

import type { IpKeyShape, IpMinimisationMethod, UaMinimisationMethod } from "@/lib/privacy/network-minimise";

export type NetworkIdentifierKind = "IP" | "UA" | "IP_KEY";

export type NetworkIdentifierModel = "AuditLog" | "UserSession" | "RateLimit";

/**
 * Why a real (non-dry-run) minimisation cannot run in this build.
 *   DB_010         AuditLog is append-only for fm_system (migration
 *                  20261103140000_db010_auditlog_append_only): its UPDATE
 *                  policy admits only aged BETA_ACCESS_REQUESTED rows. A wider
 *                  minimisation needs the policy extension designed in the doc.
 *   OWNER_DECISION No database barrier, but window and method are undecided —
 *                  dry-run only until the owner rules.
 */
export type ApplyBlocker = "DB_010" | "OWNER_DECISION";

export interface NetworkIdentifierField {
  /** Stable id: `<Model>.<column>` or `<Model>.<column>.<json path>`. */
  id: string;
  model: NetworkIdentifierModel;
  /** The Prisma field (= the database column). */
  field: string;
  /** For a value inside a Json column: its path. */
  jsonPath?: readonly string[];
  kind: NetworkIdentifierKind;
  /** For IP_KEY: the key shape (lib/privacy/network-minimise.ts minimiseIpKey). */
  keyShape?: IpKeyShape;
  /** Which rows carry it. */
  rows: string;
  /** Retention as the code stands (not as proposed). */
  currentRetention: string;
  /** Methods that would apply (the owner picks). */
  methods: readonly (IpMinimisationMethod | UaMinimisationMethod)[];
  /** The column the dry-run census bands by age. */
  ageColumn: "createdAt" | "windowStart";
  /** Source files that put the value there (the census pins IP_KEY builders and raw INSERTs). */
  writers: readonly string[];
  applyBlockedBy: ApplyBlocker;
}

export const NETWORK_IDENTIFIER_FIELDS: readonly NetworkIdentifierField[] = [
  {
    id: "AuditLog.ipAddress", model: "AuditLog", field: "ipAddress", kind: "IP",
    rows: "Every audit row written with request metadata: LOGIN / LOGIN_FAILED / 2FA / session / operator actions / BETA_ACCESS_REQUESTED. Product events write NULL.",
    currentRetention: "Indefinite. Exceptions: BETA_ACCESS_REQUESTED nulled at 90 days (jobs/data-retention.ts, keyed digest kept in metadata); product events (NULL anyway) deleted at 13 months.",
    methods: ["DIGEST", "TRUNCATE"], ageColumn: "createdAt",
    writers: ["lib/audit.ts", "lib/events/emit.ts", "lib/auth.ts", "lib/auth/session-activity.ts", "app/api/access-request/route.ts", "(operator routes via lib/audit.ts)"],
    applyBlockedBy: "DB_010",
  },
  {
    id: "AuditLog.userAgent", model: "AuditLog", field: "userAgent", kind: "UA",
    rows: "As AuditLog.ipAddress.",
    currentRetention: "As AuditLog.ipAddress (BETA_ACCESS_REQUESTED: nulled at 90 days, uaFamily kept in metadata).",
    methods: ["UA_FAMILY", "NULL"], ageColumn: "createdAt",
    writers: ["lib/audit.ts", "lib/events/emit.ts", "lib/auth.ts", "lib/auth/session-activity.ts", "app/api/access-request/route.ts", "(operator routes via lib/audit.ts)"],
    applyBlockedBy: "DB_010",
  },
  {
    id: "AuditLog.metadata.key", model: "AuditLog", field: "metadata", jsonPath: ["key"], kind: "IP_KEY", keyShape: "ANOMALY",
    rows: "SECURITY_ANOMALY_DETECTED rows of type failed_login_ip: metadata.key = `ip:<address>` (raw; the row also carries the salted metadata.keyHash).",
    currentRetention: "Indefinite (security audit rows are not deleted, by decision).",
    methods: ["DIGEST", "TRUNCATE"], ageColumn: "createdAt",
    writers: ["lib/security/anomalies.ts", "lib/security/anomaly-alerts.ts"],
    applyBlockedBy: "DB_010",
  },
  {
    id: "UserSession.ipAddress", model: "UserSession", field: "ipAddress", kind: "IP",
    rows: "Every session row (set at sign-in).",
    currentRetention: "Live, then deleted 30 days after it ends: 30 days after revocation (DB-009), or 30 days after it expires (SEC-010 idle / absolute lifetime), whichever comes first (jobs/data-retention.ts sessionReapWhere).",
    methods: ["DIGEST", "TRUNCATE"], ageColumn: "createdAt",
    writers: ["lib/auth.ts"],
    applyBlockedBy: "OWNER_DECISION",
  },
  {
    id: "UserSession.userAgent", model: "UserSession", field: "userAgent", kind: "UA",
    rows: "As UserSession.ipAddress.",
    currentRetention: "As UserSession.ipAddress.",
    methods: ["UA_FAMILY", "NULL"], ageColumn: "createdAt",
    writers: ["lib/auth.ts"],
    applyBlockedBy: "OWNER_DECISION",
  },
  {
    id: "RateLimit.key", model: "RateLimit", field: "key", kind: "IP_KEY", keyShape: "RATE_LIMIT",
    rows: "IP-keyed limiter buckets: key = `ip:<limiter>:<address>`.",
    currentRetention: "24 hours (jobs/sweep-rate-limits.ts).",
    methods: ["DIGEST", "TRUNCATE"], ageColumn: "windowStart",
    writers: ["lib/rate-limit.ts"],
    applyBlockedBy: "OWNER_DECISION",
  },
];

/** The refusal a real AuditLog minimisation returns in this build. */
export const DB_010_REFUSAL =
  "AuditLog minimisation requires the DB-010 policy extension (owner + S2 review): fm_system may UPDATE only aged BETA_ACCESS_REQUESTED rows (migration 20261103140000_db010_auditlog_append_only). Design: docs/operations/data-retention.md, \"Network identifiers\".";

/** The refusal a real UserSession / RateLimit minimisation returns in this build. */
export const OWNER_DECISION_REFUSAL =
  "Minimisation is dry-run only in this build: the window, the method and enabling it are an OWNER DECISION (docs/operations/data-retention.md, \"Network identifiers\").";

export function applyRefusal(f: NetworkIdentifierField): string {
  return f.applyBlockedBy === "DB_010" ? DB_010_REFUSAL : OWNER_DECISION_REFUSAL;
}
