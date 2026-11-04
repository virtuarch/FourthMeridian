/**
 * lib/platform/growth/beta-risk-network.ts  (Beta-request risk — the SHARED_NETWORK grouping key)
 *
 * S2 ruling on PR #374: the risk reader grouped forensic BETA_ACCESS_REQUESTED
 * rows by `md5(<per-read random salt> || ipAddress)`, computed in SQL. Two
 * defects:
 *   · it is an MD5 of the raw address, keyed by nothing but a throwaway salt —
 *     the exact construction lib/security/identifier-hash.ts warns against;
 *   · it reads only the RAW column, so once jobs/data-retention.ts minimises a
 *     row at 90 days (ipAddress nulled, keyed `metadata.networkDigest` kept) the
 *     row silently drops out of grouping.
 *
 * THE ONE SCHEME. The grouping key is the BETA-INTAKE keyed digest — the value
 * the minimisation job already stores on aged rows:
 *     networkDigest(ip, key)  = HMAC-SHA256(BETA_INTAKE_HASH_KEY_<V>, canonicalIp(ip))
 * (jobs/data-retention.ts — the SAME function, imported, never re-implemented),
 * and the key is `<version>:<64 hex>`:
 *   · a RAW row (ipAddress present) is digested here, at read time, under the
 *     CURRENT key — the address is never stored, returned or logged; it exists
 *     only for the duration of this call;
 *   · a MINIMISED row contributes its stored `metadata.networkDigest` AS-IS,
 *     when its `networkDigestKeyVersion` is the current key's version.
 * Both therefore give the same key for the same address, so a raw row and a
 * minimised row of one address group together.
 *
 * Deliberately NOT lib/privacy/network-minimise.ts digestIp: that DIGEST method
 * is domain-separated by its own label (`nim1-…`) precisely so it never equals
 * a beta-intake digest — it could not match the rows that already exist.
 *
 * FAIL CLOSED:
 *   · no usable key (resolveNetworkDigestKey → null) ⇒ every key is null: no
 *     grouping signal at all, never an unkeyed hash;
 *   · a stored digest under ANOTHER key version is not used (it cannot match a
 *     current-version digest; and its "unknown"/"" sentinel digests could not be
 *     recognised — see below), so after a rotation older minimised rows simply
 *     stop contributing;
 *   · absent / empty / "unknown" addresses yield null. The minimisation job
 *     digests any non-empty ipAddress (including the extractor's "unknown"), so
 *     a stored digest equal to the digest of "unknown" or of "" is refused too.
 *
 * Pure: no I/O, no env reads (the key is passed in).
 */

import { networkDigest, type NetworkDigestKey } from "@/jobs/data-retention";

/** The network fields of one forensic audit row, as the reader selects them. */
export interface AuditNetworkFields {
  /** Raw ipAddress — selected only when a key is configured; null once minimised. */
  ip: string | null;
  /** metadata.networkDigest on a minimised row. */
  storedDigest: string | null;
  /** metadata.networkDigestKeyVersion on a minimised row. */
  storedVersion: string | null;
}

const DIGEST_HEX = /^[0-9a-f]{64}$/;

const isAbsent = (ip: string) => {
  const s = ip.trim().toLowerCase();
  return s === "" || s === "unknown";
};

/**
 * The grouping-key function for one read, or a function that always answers
 * null when no key is configured.
 */
export function networkGroupKeyer(key: NetworkDigestKey | null): (row: AuditNetworkFields) => string | null {
  if (!key || key.key.length === 0) return () => null;
  // Digests of the "no address" sentinels a minimised row may carry.
  const sentinels = new Set([networkDigest("unknown", key.key), networkDigest("", key.key)]);
  return (row) => {
    if (row.ip !== null && row.ip !== undefined) {
      if (isAbsent(row.ip)) return null;
      return `${key.version}:${networkDigest(row.ip, key.key)}`;
    }
    const d = row.storedDigest;
    if (typeof d !== "string" || !DIGEST_HEX.test(d)) return null;
    if (row.storedVersion !== key.version) return null;
    if (sentinels.has(d)) return null;
    return `${key.version}:${d}`;
  };
}
