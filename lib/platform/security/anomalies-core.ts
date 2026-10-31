/**
 * lib/platform/security/anomalies-core.ts  (BETA V2 · Workstream W4)
 *
 * PURE projection of a SECURITY_ANOMALY_DETECTED audit row into what the
 * Security Ops posture surface shows for a detector trip.
 *
 * ── THE KEY (the first of V2's two honesty fixes; reworked by Comms Center A-2b) ──
 * The detector (lib/security/anomaly-alerts.ts) records `metadata.key` as its
 * dedupe identity: `identifier:<login identifier>`, `ip:<address>`,
 * `recovery:<login identifier>`, `platform-denied:<area>:<userId>` or the
 * literal `system_admin_disabled`. The raw identifier, IP or user id may not
 * cross the Security Ops boundary ("no email, no IP, no user-agent, no userId").
 * What the operator needs is (a) the key's KIND and (b) whether two trips share
 * it — and (c), since A-2b, a way to match a trip to the Security Ops bell.
 *
 * `keyRef` is therefore derived ONLY from `metadata.keyHash` — the SALTED hash
 * the writers store beside the raw key (lib/security/identifier-hash.ts; the
 * bell's anomalyKey carries the same value): "h" + the first 8 hex of the hash
 * part, i.e. a literal prefix of the stored keyHash, so an operator can find
 * the bell and the audit row by it. The old unsalted 24-bit FNV digest of the
 * raw key (brute-forceable for IPv4) is gone. A legacy row with no keyHash gets
 * `keyRef: ""` and `legacy: true` — NOTHING is ever derived from the raw key.
 * The kind still comes from the raw key's prefix (a word, not a value).
 *
 * PURE: no DB, no clock, no I/O.
 */

export type AnomalyKeyKind = "account" | "ip" | "recovery" | "admin" | "unknown";

export interface AnomalyTripRowLike {
  id: string;
  createdAt: Date;
  metadata: unknown;
}

export interface AnomalyTripProjection {
  id: string;
  /** The detector's type word ("failed_login_identifier", …); "unknown" when unrecorded. */
  type: string;
  keyKind: AnomalyKeyKind;
  /** "h1a2b3c4d" — the first 8 hex of the row's salted keyHash; "" when it has none (legacy or value-free key). */
  keyRef: string;
  /**
   * True when the row predates keyHash (A-2b): no correlation handle exists and
   * none is invented. Always set by projectAnomalyTrip; optional only so view
   * fixtures need not spell it.
   */
  legacy?: boolean;
  count: number;
  /** The threshold that tripped, when the row recorded one; null for rows that predate it. */
  threshold: number | null;
  windowMinutes: number;
  /** ISO instant of the trip row. */
  at: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function anomalyKeyKind(key: string): AnomalyKeyKind {
  if (key.startsWith("identifier:")) return "account";
  if (key.startsWith("ip:")) return "ip";
  if (key.startsWith("recovery:")) return "recovery";
  if (key === "system_admin_disabled") return "admin";
  return "unknown";
}

/** A stored keyHash in the writers' hashed form: `<kind>:h<32 hex>`. */
const KEY_HASH = /^[a-z][a-z_-]*:h([0-9a-f]{32})$/;

/**
 * The correlation handle: "h" + the first 8 hex of the salted hash — a literal
 * prefix of the hash part of the stored keyHash. "" for anything else (absent,
 * malformed, or the value-free admin key). Never derived from the raw key.
 */
export function keyRefFromKeyHash(keyHash: unknown): string {
  if (typeof keyHash !== "string") return "";
  const m = KEY_HASH.exec(keyHash);
  return m ? `h${m[1].slice(0, 8)}` : "";
}

export function projectAnomalyTrip(row: AnomalyTripRowLike, defaultWindowMinutes: number): AnomalyTripProjection {
  const m = isRecord(row.metadata) ? row.metadata : {};
  const key = typeof m.key === "string" ? m.key : "";
  return {
    id: row.id,
    type: typeof m.type === "string" ? m.type : "unknown",
    keyKind: key ? anomalyKeyKind(key) : "unknown",
    keyRef: keyRefFromKeyHash(m.keyHash),
    legacy: typeof m.keyHash !== "string",
    count: typeof m.count === "number" ? m.count : 0,
    threshold: typeof m.threshold === "number" ? m.threshold : null,
    windowMinutes: typeof m.windowMinutes === "number" ? m.windowMinutes : defaultWindowMinutes,
    at: row.createdAt.toISOString(),
  };
}
