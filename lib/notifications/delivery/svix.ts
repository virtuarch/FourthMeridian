/**
 * lib/notifications/delivery/svix.ts  (Comms Center Phase C)
 *
 * SVIX SIGNATURE VERIFICATION for the Resend delivery webhook (contract v1.1
 * §10.1), with node:crypto and no new dependency. Pure: no I/O, no clock of its
 * own (the caller passes `now`), no logging.
 *
 * The scheme, exactly as Resend / svix specify it:
 *   1. headers `svix-id`, `svix-timestamp` (unix SECONDS), `svix-signature`;
 *   2. the timestamp must be within ±TOLERANCE (5 min) of now — replay window;
 *   3. key = base64decode(secret without its "whsec_" prefix);
 *      expected = base64(HMAC-SHA256(key, `${id}.${timestamp}.${rawBody}`));
 *   4. `svix-signature` is a SPACE-separated list of `<version>,<base64>`
 *      entries (several during a secret rotation); it verifies when ANY `v1`
 *      entry equals `expected`, compared in CONSTANT TIME. Other versions are
 *      ignored.
 *
 * The raw body is the exact request text: it must be read with `req.text()`
 * before any JSON parse, or a re-serialised body would never match.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** ±5 minutes (svix's default tolerance). */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SvixRejection =
  | "MISSING_HEADERS"      // any of the three headers absent or empty
  | "BAD_TIMESTAMP"        // not an integer of seconds
  | "TIMESTAMP_TOO_OLD"    // older than now − tolerance (replay)
  | "TIMESTAMP_TOO_NEW"    // later than now + tolerance
  | "NO_V1_SIGNATURE"      // the header carries no v1 entry
  | "SIGNATURE_MISMATCH";  // no v1 entry matches

export type SvixVerdict = { ok: true } | { ok: false; reason: SvixRejection };

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * The HMAC key of a `whsec_…` secret, or null when the secret is unusable
 * (empty, or not base64 after the prefix). A bare base64 secret (no prefix) is
 * accepted, as svix's own libraries do.
 */
export function svixKey(secret: string | undefined | null): Buffer | null {
  if (typeof secret !== "string") return null;
  const raw = secret.trim().startsWith("whsec_") ? secret.trim().slice("whsec_".length) : secret.trim();
  if (raw.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64");
  return key.length > 0 ? key : null;
}

/** base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)). Exported for tests that sign fixtures. */
export function svixSign(key: Buffer, id: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Unequal lengths cannot match; compare y with itself so the call still takes constant time for this length.
  if (x.length !== y.length) { timingSafeEqual(y, y); return false; }
  return timingSafeEqual(x, y);
}

/** Verify one request. Pure. */
export function verifySvix(args: {
  key: Buffer;
  headers: SvixHeaders;
  rawBody: string;
  now: Date;
  toleranceSeconds?: number;
}): SvixVerdict {
  const { key, headers, rawBody, now } = args;
  const tolerance = args.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS;
  const id = headers.id?.trim() ?? "";
  const ts = headers.timestamp?.trim() ?? "";
  const sig = headers.signature?.trim() ?? "";
  if (!id || !ts || !sig) return { ok: false, reason: "MISSING_HEADERS" };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: "BAD_TIMESTAMP" };
  const nowSec = Math.floor(now.getTime() / 1000);
  const tsSec = Number(ts);
  if (tsSec < nowSec - tolerance) return { ok: false, reason: "TIMESTAMP_TOO_OLD" };
  if (tsSec > nowSec + tolerance) return { ok: false, reason: "TIMESTAMP_TOO_NEW" };

  const expected = svixSign(key, id, ts, rawBody);
  const v1 = sig.split(" ").map((e) => e.trim()).filter(Boolean)
    .map((e) => { const i = e.indexOf(","); return i > 0 ? { v: e.slice(0, i), s: e.slice(i + 1) } : null; })
    .filter((e): e is { v: string; s: string } => e !== null && e.v === "v1" && e.s.length > 0);
  if (v1.length === 0) return { ok: false, reason: "NO_V1_SIGNATURE" };
  // Every entry is compared (no early exit), so timing does not reveal which entry matched.
  let match = false;
  for (const e of v1) if (constantTimeEqual(e.s, expected)) match = true;
  return match ? { ok: true } : { ok: false, reason: "SIGNATURE_MISMATCH" };
}
