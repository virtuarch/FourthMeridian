/**
 * lib/privacy/network-minimise.ts  (S2 P8 item 3 — IP / user-agent minimisation, engineering half)
 *
 * THE ONE minimisation function set for network identifiers. Pure: no I/O, no
 * env reads, no clock. Nothing calls it on a write path yet — the policy
 * (window, method, enabling it) is an OWNER DECISION, documented in
 * docs/operations/data-retention.md "Network identifiers". Today it is used
 * only by the dry-run census (jobs/network-identifier-minimisation.ts) and
 * its tests.
 *
 * IP — two selectable methods:
 *   DIGEST    keyed HMAC-SHA256, REUSING the beta-intake key material
 *             (BETA_INTAKE_HASH_KEY_<V>, resolved by jobs/data-retention.ts
 *             resolveNetworkDigestKey and passed in — NO new secret). It is
 *             domain-separated by its own versioned label
 *             (NETWORK_ID_DIGEST_LABEL): the HMAC key is
 *             HMAC(intake key, label), so a digest here never equals the
 *             beta-intake `networkDigest` of the same address, and bumping the
 *             label rotates every digest without a new secret.
 *             Stored form: `nim1-<keyVersion>:<32 hex>` (128 bits).
 *             No key ⇒ null. An unkeyed hash of an IPv4 address is a 2^32
 *             lookup away from the address, so it is never produced.
 *   TRUNCATE  IPv4 → /24, IPv6 → /48, printed with the prefix length
 *             (`192.0.2.0/24`, `2001:db8:1::/48`) so a truncated value can
 *             never be read as a host address.
 *   An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`, or its hex form) is the
 *   IPv4 address: it digests and truncates exactly as the dotted form.
 *
 * UA — UA_FAMILY reduces the string to the version-free browser and OS
 * families from lib/ua-parser (`Chrome on macOS`, `Unknown device`); NULL drops
 * it.
 *
 * INVARIANTS (pinned by network-minimise.test.ts):
 *   · invalid / empty / "unknown" / non-string input → null;
 *   · the output never contains the raw value;
 *   · deterministic for a given key; canonicalisation means one address never
 *     yields two digests (case, zero-suppression, `::` compression, brackets,
 *     zone id, IPv4-mapped forms).
 */

import { createHmac } from "node:crypto";
import { formatDevice, parseUserAgent } from "@/lib/ua-parser";

/** Domain-separation label of the DIGEST method. Bump the version to rotate every digest (no new secret). */
export const NETWORK_ID_DIGEST_LABEL = "fm:network-id-min:v1";
/** The short label stored in every digest (matches the label's version). */
export const NETWORK_ID_DIGEST_VERSION = "nim1";
/** Hex characters kept (128 bits) — the identifier-hash convention. */
const DIGEST_HEX = 32;

export const IPV4_TRUNCATE_BITS = 24;
export const IPV6_TRUNCATE_BITS = 48;

export type IpMinimisationMethod = "DIGEST" | "TRUNCATE";
export type UaMinimisationMethod = "UA_FAMILY" | "NULL";

/** The keyed-digest key, as jobs/data-retention.ts resolveNetworkDigestKey returns it. */
export interface DigestKey { key: Buffer; version: string }

/** A parsed address. IPv4-mapped IPv6 is reported as family 4. */
export type ParsedIp = { family: 4; bytes: number[] } | { family: 6; bytes: number[] };

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    // Decimal only; no leading zeros (an "010" octet is octal to some parsers — ambiguous, refuse).
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIpv6(s: string): number[] | null {
  if (s.length === 0 || s.length > 45) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): string[] | null => (part === "" ? [] : part.split(":"));
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (head === null || tail === null) return null;
  const all = [...head, ...tail];
  // An embedded dotted IPv4 is allowed only as the last group.
  let v4: number[] | null = null;
  const last = all[all.length - 1];
  if (last !== undefined && last.includes(".")) {
    v4 = parseIpv4(last);
    if (!v4) return null;
    if (tail.length > 0) tail.pop();
    else if (halves.length === 2) return null; // "a:1.2.3.4::" — the IPv4 part must end the address
    else head.pop();
  }
  const words = (gs: string[]): number[] | null => {
    const out: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const h = words(head), t = words(tail);
  if (!h || !t) return null;
  const v4Words = v4 ? [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]] : [];
  const explicit = h.length + t.length + v4Words.length;
  let w: number[];
  if (halves.length === 2) {
    if (explicit > 7) return null; // "::" must stand for at least one zero group
    w = [...h, ...Array(8 - explicit).fill(0), ...t, ...v4Words];
  } else {
    if (explicit !== 8) return null;
    w = [...h, ...v4Words];
  }
  return w.flatMap((x) => [x >> 8, x & 255]);
}

/**
 * Strict parse. Accepts dotted IPv4, IPv6 (any valid compression, upper or
 * lower case, optional [brackets], optional %zone which is dropped). Refuses
 * ports, CIDR suffixes, leading-zero octets, "unknown", empty and non-strings.
 */
export function parseIp(raw: unknown): ParsedIp | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.length === 0 || s.length > 64) return null;
  if (!s.includes(":")) {
    const v4 = parseIpv4(s);
    return v4 ? { family: 4, bytes: v4 } : null;
  }
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const bytes = parseIpv6(s);
  if (!bytes) return null;
  // IPv4-mapped (::ffff:0:0/96) — the IPv4 address itself.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return { family: 4, bytes: bytes.slice(12) };
  }
  return { family: 6, bytes };
}

/** RFC 5952 text: lower case, zero-suppressed, the longest (first on a tie) run of ≥ 2 zero groups as "::". */
function formatIpv6(bytes: number[]): string {
  const w: number[] = [];
  for (let i = 0; i < 16; i += 2) w.push((bytes[i] << 8) | bytes[i + 1]);
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (w[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = (xs: number[]) => xs.map((x) => x.toString(16)).join(":");
  if (bestLen < 2) return hex(w);
  return `${hex(w.slice(0, bestStart))}::${hex(w.slice(bestStart + bestLen))}`;
}

/** The canonical text of a parsed address (dotted IPv4, RFC 5952 IPv6). */
export function formatIp(p: ParsedIp): string {
  return p.family === 4 ? p.bytes.join(".") : formatIpv6(p.bytes);
}

/** Canonical text, or null when the input is not an IP address. */
export function canonicalIpStrict(raw: unknown): string | null {
  const p = parseIp(raw);
  return p ? formatIp(p) : null;
}

// ── IP methods ───────────────────────────────────────────────────────────────

/** IPv4 /24, IPv6 /48, with the prefix length. Null for invalid input. */
export function truncateIp(raw: unknown): string | null {
  const p = parseIp(raw);
  if (!p) return null;
  if (p.family === 4) return `${p.bytes[0]}.${p.bytes[1]}.${p.bytes[2]}.0/${IPV4_TRUNCATE_BITS}`;
  const keep = IPV6_TRUNCATE_BITS / 8;
  const bytes = p.bytes.map((b, i) => (i < keep ? b : 0));
  return `${formatIpv6(bytes)}/${IPV6_TRUNCATE_BITS}`;
}

/** The DIGEST method's HMAC key: the reused secret, domain-separated by this method's own label. */
function derivedKey(key: DigestKey): Buffer {
  return createHmac("sha256", key.key).update(NETWORK_ID_DIGEST_LABEL, "utf8").digest();
}

/** `nim1-<keyVersion>:<32 hex>`. Null for invalid input or no key (never an unkeyed hash). */
export function digestIp(raw: unknown, key: DigestKey | null): string | null {
  if (!key || key.key.length === 0) return null;
  const canonical = canonicalIpStrict(raw);
  if (canonical === null) return null;
  const hex = createHmac("sha256", derivedKey(key)).update(canonical, "utf8").digest("hex").slice(0, DIGEST_HEX);
  return `${NETWORK_ID_DIGEST_VERSION}-${key.version}:${hex}`;
}

/** THE IP minimisation. Null for invalid input (and for DIGEST without a key). */
export function minimiseIp(raw: unknown, method: IpMinimisationMethod, key: DigestKey | null = null): string | null {
  switch (method) {
    case "DIGEST": return digestIp(raw, key);
    case "TRUNCATE": return truncateIp(raw);
  }
}

/** True when a value is already in a minimised IP form (idempotence guard; the proposed WITH CHECK mirrors it). */
export function isMinimisedIp(value: string): boolean {
  return /^nim\d+-v[1-9]\d{0,2}:[0-9a-f]{32}$/.test(value)
    || /^\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24$/.test(value)
    || /^[0-9a-f:]+\/48$/.test(value);
}

// ── IP-bearing keys ──────────────────────────────────────────────────────────

/**
 * The two key shapes that embed a raw address:
 *   RATE_LIMIT  `ip:<limiter name>:<address>`  (lib/rate-limit.ts; the name has no ":")
 *   ANOMALY     `ip:<address>`                 (lib/security/anomalies.ts detectIpAnomaly)
 * The shape is explicit: `ip:2001:db8::1` is a valid ANOMALY key AND parses as a
 * RATE_LIMIT key named "2001", so it cannot be inferred.
 */
export type IpKeyShape = "RATE_LIMIT" | "ANOMALY";

/** The key with its address minimised, or null when it is not an IP key of that shape. */
export function minimiseIpKey(rawKey: unknown, shape: IpKeyShape, method: IpMinimisationMethod, key: DigestKey | null = null): string | null {
  if (typeof rawKey !== "string" || !rawKey.startsWith("ip:")) return null;
  const rest = rawKey.slice(3);
  let prefix: string, address: string;
  if (shape === "RATE_LIMIT") {
    const i = rest.indexOf(":");
    if (i <= 0) return null;
    prefix = "ip:" + rest.slice(0, i) + ":";
    address = rest.slice(i + 1);
  } else {
    prefix = "ip:";
    address = rest;
  }
  const min = minimiseIp(address, method, key);
  return min === null ? null : `${prefix}${min}`;
}

// ── User agent ───────────────────────────────────────────────────────────────

/** Drop a trailing version ("Chrome 120", "iOS 17.1", "Windows 10/11") — families only. */
function family(label: string): string {
  return label.replace(/\s+[\d._/]+$/, "").trim() || "Unknown";
}

/** `Chrome on macOS`, `Unknown browser on Linux`, `Unknown device`. Null for empty / non-string. */
export function userAgentFamily(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const p = parseUserAgent(raw);
  return formatDevice({ browser: family(p.browser), os: family(p.os), device: p.device });
}

/** THE UA minimisation. */
export function minimiseUserAgent(raw: unknown, method: UaMinimisationMethod): string | null {
  return method === "UA_FAMILY" ? userAgentFamily(raw) : null;
}
