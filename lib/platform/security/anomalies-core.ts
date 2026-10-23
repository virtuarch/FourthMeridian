/**
 * lib/platform/security/anomalies-core.ts  (BETA V2 · Workstream W4)
 *
 * PURE projection of a SECURITY_ANOMALY_DETECTED audit row into what the
 * Security Ops posture surface shows for a detector trip.
 *
 * ── THE KEY (the first of V2's two honesty fixes) ────────────────────────────
 * The detector (lib/security/anomaly-alerts.ts) records `metadata.key` as its
 * dedupe identity: `identifier:<login identifier>`, `ip:<address>`,
 * `recovery:<login identifier>` or the literal `system_admin_disabled`. The
 * login identifier is the RAW email or username the attempt was made against
 * and the IP is a full address — neither may cross the Security Ops boundary,
 * whose doctrine is "no email, no IP, no user-agent, no userId". The old widget
 * solved that by not rendering the key at all, which left two trips on two
 * different accounts indistinguishable. What the operator actually needs from
 * the key is (a) its KIND and (b) whether two trips share it. So the projection
 * renders the kind in words and an OPAQUE correlation handle — a short FNV-1a
 * digest of the recorded key, prefixed "…" like every other opaque reference on
 * the platform surfaces. Stable for the same key, never resolvable here, never
 * the raw value. The route calls this so the raw key never leaves the server.
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
  /** "…a1b2c3" — an opaque digest of the detector's key; "" when the row recorded no key. */
  keyRef: string;
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

/**
 * FNV-1a (32-bit) over the key's UTF-16 code units, last six hex digits, with
 * the platform's opaque-reference prefix. A correlation handle (same key ⇒ same
 * handle), not a secret and not a lookup key: nothing on the surface resolves it.
 */
export function opaqueKeyRef(key: string): string {
  if (!key) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `…${h.toString(16).padStart(8, "0").slice(-6)}`;
}

export function projectAnomalyTrip(row: AnomalyTripRowLike, defaultWindowMinutes: number): AnomalyTripProjection {
  const m = isRecord(row.metadata) ? row.metadata : {};
  const key = typeof m.key === "string" ? m.key : "";
  return {
    id: row.id,
    type: typeof m.type === "string" ? m.type : "unknown",
    keyKind: key ? anomalyKeyKind(key) : "unknown",
    keyRef: opaqueKeyRef(key),
    count: typeof m.count === "number" ? m.count : 0,
    threshold: typeof m.threshold === "number" ? m.threshold : null,
    windowMinutes: typeof m.windowMinutes === "number" ? m.windowMinutes : defaultWindowMinutes,
    at: row.createdAt.toISOString(),
  };
}
