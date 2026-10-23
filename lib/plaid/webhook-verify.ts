/**
 * lib/plaid/webhook-verify.ts
 *
 * Plaid webhook signature verification (JWT / ES256), dependency-free — Node's
 * built-in `crypto` verifies the ES256 (P-256 ECDSA) signature, so no `jose` /
 * `jsonwebtoken` dependency is added.
 *
 * Plaid signs every webhook with a JWT in the `Plaid-Verification` header
 * (JWS compact, alg ES256). Verification (per Plaid's webhook-verification docs):
 *   1. Parse the JWT header; REQUIRE alg = "ES256" (blocks alg-confusion / "none").
 *   2. Resolve the public key for the header's `kid` via
 *      /webhook_verification_key/get (cached by kid — keys rotate rarely).
 *   3. Verify the signature over `header.payload` with that key.
 *   4. Confirm the payload's `request_body_sha256` equals SHA-256 of the RAW
 *      request body (so the signed token actually commits to THIS body).
 *   5. Reject a stale token (`iat` older than 5 minutes) to bound replay.
 *
 * ── THE KEY LOOKUP IS ATTACKER-REACHABLE, SO IT IS BOUNDED ───────────────────
 * Step 2 runs on a `kid` taken from an UNAUTHENTICATED header — nothing is
 * proven until step 3, and step 3 needs the key. The endpoint is public (Plaid
 * must reach it), so before 2026-10-07 any caller could make this server issue
 * one Plaid API request per arbitrary `kid`, with no limit, no memory of
 * failures, and an unbounded cache map (confirmed on Preview: a forged `kid`
 * reached the Plaid client). The lookup is now guarded, in this order:
 *
 *   a. Every check that needs no key runs FIRST, so garbage costs nothing:
 *      segment count, header/payload JSON, alg, a conservative `kid` shape
 *      (Plaid's kids are UUIDs; ≤ 64 URL-safe chars here), a 64-byte raw
 *      P-256 signature, a fresh `iat`, and the body hash. An attacker CAN
 *      satisfy all of them — they are a filter, not the bound.
 *   b. Positive cache (≤ KEY_CACHE_MAX keys, ≤ KEY_TTL_MS, never past the key's
 *      own `expired_at`): a known key verifies with no provider call.
 *   c. Negative cache (≤ NEG_CACHE_MAX kids): a kid Plaid rejected is refused
 *      locally for NEG_TTL_MS; a transient failure only for NEG_TRANSIENT_MS,
 *      so an outage can never pin a real key out for long.
 *   d. Single-flight: concurrent requests for the same unknown kid share ONE
 *      lookup.
 *   e. THE BOUND — a budget on cache-miss lookups: at most MISS_BUDGET per
 *      MISS_WINDOW_MS per instance, ALWAYS on (it cannot be switched off), plus
 *      the shared fail-closed limiter (lib/rate-limit, one global bucket) for a
 *      cross-instance bound when rate limiting is enabled. A flood of unique
 *      kids can cause at most that many Plaid calls per window, and every cache
 *      is size-capped, so attacker cardinality cannot grow memory.
 *
 * Rotation: a genuinely new Plaid kid is a cache miss that spends one unit of
 * budget, verifies, and is cached. Under a sustained flood a new kid can be
 * refused until a window frees budget — the webhook is answered 401 and the
 * Item still syncs via the scheduled sync and stale-import resume; it is never
 * refused permanently (every negative and budget state expires).
 *
 * The Plaid client is loaded lazily (dynamic import) inside the default key
 * fetcher, so importing this module never triggers lib/plaid/client's
 * env-validation — unit tests inject `fetchKey` and never touch the network.
 */

import crypto from "node:crypto";

/** Minimal EC public JWK shape (Plaid's JWKPublicKey). */
export interface PlaidJwk {
  kty: string;
  crv: string;
  x:   string;
  y:   string;
  kid?: string;
  alg?: string;
  use?: string;
  /** Unix seconds; non-null once Plaid has expired the key. */
  expired_at?: number | null;
}

export interface VerifyPlaidWebhookOptions {
  /** Injectable key fetcher (tests). Default: /webhook_verification_key/get. */
  fetchKey?: (kid: string) => Promise<PlaidJwk>;
  /** Max age (seconds) of the token's `iat` before it's rejected. Default 300. */
  maxAgeSec?: number;
  /**
   * Shared (cross-instance) admission for a cache-miss lookup, consulted AFTER
   * the always-on local budget. Default: the fail-closed global rate-limit
   * bucket. Tests inject a deterministic one.
   */
  admitKeyFetch?: () => Promise<boolean>;
  /** Clock seam (ms). Default Date.now. */
  now?: () => number;
}

export interface VerifyResult {
  ok:      boolean;
  reason?: string;
}

// ── Limits ───────────────────────────────────────────────────────────────────
export const KEY_CACHE_MAX     = 16;               // Plaid has a handful of live keys
export const KEY_TTL_MS        = 24 * 3_600_000;   // re-learn expiry at least daily
export const NEG_CACHE_MAX     = 256;
export const NEG_TTL_MS        = 10 * 60_000;      // Plaid said no
export const NEG_TRANSIENT_MS  = 30_000;           // could not ask — retry soon
export const MISS_BUDGET       = 6;                // provider lookups per window per instance
export const MISS_WINDOW_MS    = 10 * 60_000;
const KID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** Per-verifier state. Module default below; tests make isolated ones. */
export interface WebhookKeyState {
  keys:     Map<string, { key: crypto.KeyObject; until: number }>;
  negative: Map<string, number>;                              // kid → refuse until
  inflight: Map<string, Promise<KeyLookup>>;
  misses:   number[];                                         // lookup timestamps in window
}
type KeyLookup = { key: crypto.KeyObject; until: number } | { error: string; definitive: boolean };

export function newWebhookKeyState(): WebhookKeyState {
  return { keys: new Map(), negative: new Map(), inflight: new Map(), misses: [] };
}
const defaultState = newWebhookKeyState();

const b64urlToBuf = (s: string): Buffer => Buffer.from(s, "base64url");
function b64urlToJson(s: string): unknown {
  return JSON.parse(b64urlToBuf(s).toString("utf8"));
}

/** Insert with a size cap: the oldest entry goes first (Map keeps insertion order). */
function capSet<V>(m: Map<string, V>, k: string, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value as string);
}

async function defaultFetchKey(kid: string): Promise<PlaidJwk> {
  // Lazy import so this module (and its tests) don't load lib/plaid/client,
  // which validates PLAID_* env at import time.
  const { plaidClient } = await import("./client");
  const res = await plaidClient.webhookVerificationKeyGet({ key_id: kid });
  return res.data.key as PlaidJwk;
}

async function defaultAdmitKeyFetch(): Promise<boolean> {
  const { checkKeyLimitStrict } = await import("@/lib/rate-limit");
  const v = await checkKeyLimitStrict("global", "plaid-webhook-key-fetch",
    { limit: MISS_BUDGET, windowSec: MISS_WINDOW_MS / 1000 });
  return v.status === "ok";
}

/** Plaid answered: this kid does not exist / is invalid (4xx). Anything else is transient. */
function isDefinitiveRejection(e: unknown): boolean {
  const status = (e as { response?: { status?: number } } | null)?.response?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

/**
 * Verify a Plaid webhook. Returns { ok } — never throws for an invalid webhook
 * (an invalid one is a 401, not a 500). `rawBody` MUST be the exact bytes Plaid
 * sent (read via req.text() BEFORE JSON.parse).
 */
export function verifyPlaidWebhook(
  rawBody:             string,
  verificationHeader:  string | null | undefined,
  opts:                VerifyPlaidWebhookOptions = {},
): Promise<VerifyResult> {
  return verifyWithState(defaultState, rawBody, verificationHeader, opts);
}

export async function verifyWithState(
  state:               WebhookKeyState,
  rawBody:             string,
  verificationHeader:  string | null | undefined,
  opts:                VerifyPlaidWebhookOptions = {},
): Promise<VerifyResult> {
  const fetchKey  = opts.fetchKey ?? defaultFetchKey;
  const admit     = opts.admitKeyFetch ?? defaultAdmitKeyFetch;
  const now       = (opts.now ?? Date.now)();
  const maxAgeSec = opts.maxAgeSec ?? 300;

  // ── a. Everything that needs no key ─────────────────────────────────────────
  if (!verificationHeader) return { ok: false, reason: "missing Plaid-Verification header" };
  if (verificationHeader.length > 4096) return { ok: false, reason: "oversized JWT" };

  const parts = verificationHeader.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed JWT (expected 3 segments)" };
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: unknown; kid?: unknown };
  try { header = b64urlToJson(headerB64) as typeof header; } catch { return { ok: false, reason: "unparseable JWT header" }; }
  if (!header || typeof header !== "object") return { ok: false, reason: "unparseable JWT header" };
  if (header.alg !== "ES256") return { ok: false, reason: "unexpected alg (only ES256 accepted)" };
  if (typeof header.kid !== "string" || !KID_SHAPE.test(header.kid)) return { ok: false, reason: "missing or malformed kid" };
  const kid = header.kid;

  const signature = b64urlToBuf(sigB64);
  if (signature.length !== 64) return { ok: false, reason: "malformed ES256 signature" };

  let payload: { iat?: unknown; request_body_sha256?: unknown };
  try { payload = b64urlToJson(payloadB64) as typeof payload; } catch { return { ok: false, reason: "unparseable JWT payload" }; }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "unparseable JWT payload" };
  if (typeof payload.iat !== "number") return { ok: false, reason: "missing iat" };
  const ageSec = Math.floor(now / 1000) - payload.iat;
  if (ageSec > maxAgeSec) return { ok: false, reason: `stale token (iat ${ageSec}s old > ${maxAgeSec}s)` };

  // The signed token must commit to THIS body. Checked before the key lookup
  // because it is free; it is re-trusted only once the signature verifies.
  const expected = payload.request_body_sha256;
  const actual   = crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
  if (typeof expected !== "string" || !timingSafeEqualHex(expected, actual)) {
    return { ok: false, reason: "request body sha256 mismatch" };
  }

  // ── b–e. Resolve the key, bounded ──────────────────────────────────────────
  const resolved = await resolveKey(state, kid, now, fetchKey, admit);
  if ("error" in resolved) return { ok: false, reason: resolved.error };

  // Verify the signature. JWS ES256 uses raw R||S (IEEE P1363), not DER.
  let sigValid = false;
  try {
    sigValid = crypto.verify(
      "sha256",
      Buffer.from(`${headerB64}.${payloadB64}`, "ascii"),
      { key: resolved.key, dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch { sigValid = false; }
  if (!sigValid) return { ok: false, reason: "signature verification failed" };

  return { ok: true };
}

async function resolveKey(
  state:    WebhookKeyState,
  kid:      string,
  now:      number,
  fetchKey: (kid: string) => Promise<PlaidJwk>,
  admit:    () => Promise<boolean>,
): Promise<KeyLookup> {
  // b. Known key.
  const known = state.keys.get(kid);
  if (known && known.until > now) return known;
  if (known) state.keys.delete(kid);

  // c. Recently refused.
  const refusedUntil = state.negative.get(kid);
  if (refusedUntil !== undefined && refusedUntil > now) return { error: "unknown signing key", definitive: true };
  if (refusedUntil !== undefined) state.negative.delete(kid);

  // d. Someone is already asking.
  const pending = state.inflight.get(kid);
  if (pending) return pending;

  // e. The budget. Local first (always on, and free); the shared bucket only if
  // the local one admits, so a flood does not become a flood of DB writes.
  // Everything from here to `inflight.set` is SYNCHRONOUS: an await before the
  // registration would let concurrent requests for the same kid all miss the
  // in-flight check and each spend budget and call Plaid (caught by the test).
  state.misses = state.misses.filter((t) => now - t < MISS_WINDOW_MS);
  if (state.misses.length >= MISS_BUDGET) return { error: "key lookup budget exhausted", definitive: false };
  state.misses.push(now);

  const lookup = (async (): Promise<KeyLookup> => {
    let admitted = false;
    try { admitted = await admit(); } catch { admitted = false; }
    if (!admitted) return { error: "key lookup not admitted", definitive: false };

    let jwk: PlaidJwk;
    try {
      jwk = await fetchKey(kid);
    } catch (e) {
      const definitive = isDefinitiveRejection(e);
      capSet(state.negative, kid, now + (definitive ? NEG_TTL_MS : NEG_TRANSIENT_MS), NEG_CACHE_MAX);
      return { error: definitive ? "unknown signing key" : "key lookup failed", definitive };
    }
    if (jwk?.kty !== "EC" || jwk?.crv !== "P-256") {
      capSet(state.negative, kid, now + NEG_TTL_MS, NEG_CACHE_MAX);
      return { error: "unexpected key type (want EC P-256)", definitive: true };
    }
    const expiredAtMs = typeof jwk.expired_at === "number" ? jwk.expired_at * 1000 : null;
    if (expiredAtMs !== null && expiredAtMs <= now) {
      capSet(state.negative, kid, now + NEG_TTL_MS, NEG_CACHE_MAX);
      return { error: "signing key expired", definitive: true };
    }
    let key: crypto.KeyObject;
    try {
      key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    } catch {
      capSet(state.negative, kid, now + NEG_TTL_MS, NEG_CACHE_MAX);
      return { error: "key import failed", definitive: true };
    }
    const entry = { key, until: Math.min(now + KEY_TTL_MS, expiredAtMs ?? Number.POSITIVE_INFINITY) };
    capSet(state.keys, kid, entry, KEY_CACHE_MAX);
    return entry;
  })();

  state.inflight.set(kid, lookup);
  try { return await lookup; } finally { state.inflight.delete(kid); }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
