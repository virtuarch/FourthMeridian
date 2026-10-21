/**
 * lib/security/client-ip.ts — ARCH-003 / CQ-004: THE one client-IP extractor.
 *
 * THE DEFECT THIS CLOSES. Three extractors with two header orders:
 * lib/rate-limit.ts keyed limiter buckets on the FIRST `x-forwarded-for` entry
 * and ignored `cf-connecting-ip`; lib/api.ts (audit metadata) and lib/auth.ts
 * (login audit) preferred `cf-connecting-ip` FIRST. So a request could be
 * limited under one address and audited under another, the limiter bucket was
 * a pure function of a client-writable header (runtime-confirmed: rotating
 * `x-forwarded-for` rotated the bucket), and — with no Cloudflare in front —
 * `cf-connecting-ip` was a client-writable header the audit trail trusted.
 *
 * TRUST MODEL (deliberate, conservative). An IP is taken only from a header the
 * PLATFORM in front of this process sets or overwrites; a header any client can
 * write is used only in the position a trusted proxy would have written.
 *
 *   1. `cf-connecting-ip` — ONLY when CLIENT_IP_TRUST_CLOUDFLARE=true declares
 *      that Cloudflare fronts every request (Cloudflare overwrites it; without
 *      Cloudflare it is a plain client header). Off by default: Production is
 *      Vercel-direct today (03-SECURITY.md open question), so trusting it would
 *      be trusting the client.
 *   2. `x-vercel-forwarded-for` — set by Vercel's edge from the connecting
 *      socket; a client-supplied value is replaced. Platform-trusted on Vercel.
 *   3. `x-real-ip` — set by Vercel (and nginx) from the connecting socket.
 *   4. `x-forwarded-for` — LAST entry. Each proxy APPENDS the address it saw;
 *      the last entry is the one the nearest trusted proxy wrote and the only
 *      one a client could not choose (the earlier entries are whatever the
 *      client sent). On a platform that overwrites the header the last entry is
 *      the only entry, so the rule is correct in both topologies. The FIRST
 *      entry — the previous limiter key — is the client-chosen one.
 *   5. "unknown" — no usable header (local dev, direct connection). Every
 *      unknown shares ONE limiter bucket, which degrades to "stricter", never
 *      to "unlimited".
 *
 * Every candidate is shape-checked (IPv4/IPv6 characters, bounded length,
 * optional IPv6 brackets / port stripped) so a limiter key or audit column can
 * never carry arbitrary client bytes.
 *
 * Pure: no imports; accepts a WHATWG `Headers` or the plain header object the
 * NextAuth credentials callback receives.
 */

export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

export const UNKNOWN_CLIENT_IP = "unknown";

/** The raw chain header, exported for LOGGING only — never for identification. */
export const FORWARDED_FOR_HEADER = "x-forwarded-for";

/** The header order above, in the order it is consulted. */
export const CLIENT_IP_HEADER_ORDER = [
  "cf-connecting-ip",          // only when CLIENT_IP_TRUST_CLOUDFLARE=true
  "x-vercel-forwarded-for",
  "x-real-ip",
  "x-forwarded-for",           // LAST entry
] as const;

export interface ClientIpOptions {
  /** Trust `cf-connecting-ip`. Defaults to CLIENT_IP_TRUST_CLOUDFLARE === "true". */
  trustCloudflare?: boolean;
}

const MAX_IP_LENGTH = 45; // longest textual IPv6 (incl. IPv4-mapped)
const IP_SHAPE = /^[0-9A-Fa-f:.]+$/;

function headerValue(source: HeaderSource, name: string): string | null {
  if (!source) return null;
  if (typeof (source as Headers).get === "function") {
    return (source as Headers).get(name);
  }
  const rec = source as Record<string, string | string[] | undefined>;
  const raw = rec[name] ?? rec[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" ? raw : null;
}

/**
 * Normalise one candidate: trim, strip IPv6 brackets and a trailing `:port`
 * on IPv4, then shape-check. Returns null when it is not an IP literal.
 */
export function normaliseIpCandidate(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.length === 0 || s.length > MAX_IP_LENGTH + 8) return null;
  // "[2001:db8::1]:443" → "2001:db8::1"
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (bracketed) s = bracketed[1];
  // "203.0.113.9:51234" → "203.0.113.9"
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  if (s.length > MAX_IP_LENGTH || !IP_SHAPE.test(s)) return null;
  // Must look like a dotted quad or contain an IPv6 colon.
  if (!s.includes(":") && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return null;
  return s;
}

function defaultTrustCloudflare(): boolean {
  return process.env.CLIENT_IP_TRUST_CLOUDFLARE === "true";
}

/** The client IP by the trust model above, or UNKNOWN_CLIENT_IP. */
export function getClientIp(source: HeaderSource, opts: ClientIpOptions = {}): string {
  const trustCloudflare = opts.trustCloudflare ?? defaultTrustCloudflare();

  if (trustCloudflare) {
    const cf = normaliseIpCandidate(headerValue(source, "cf-connecting-ip"));
    if (cf) return cf;
  }

  const vercel = headerValue(source, "x-vercel-forwarded-for");
  if (vercel) {
    const first = normaliseIpCandidate(vercel.split(",")[0]);
    if (first) return first;
  }

  const real = normaliseIpCandidate(headerValue(source, "x-real-ip"));
  if (real) return real;

  const fwd = headerValue(source, "x-forwarded-for");
  if (fwd) {
    const entries = fwd.split(",");
    // LAST entry — see the trust model. Walk back over empty/garbage tails so a
    // trailing comma cannot blank the result, but never past a valid entry.
    for (let i = entries.length - 1; i >= 0; i--) {
      const ip = normaliseIpCandidate(entries[i]);
      if (ip) return ip;
      if (entries[i].trim().length > 0) break; // a non-empty, non-IP tail is garbage: stop
    }
  }

  return UNKNOWN_CLIENT_IP;
}
