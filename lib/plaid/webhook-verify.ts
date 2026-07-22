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
}

export interface VerifyPlaidWebhookOptions {
  /** Injectable key fetcher (tests). Default: /webhook_verification_key/get. */
  fetchKey?: (kid: string) => Promise<PlaidJwk>;
  /** Max age (seconds) of the token's `iat` before it's rejected. Default 300. */
  maxAgeSec?: number;
}

export interface VerifyResult {
  ok:      boolean;
  reason?: string;
}

const b64urlToBuf = (s: string): Buffer => Buffer.from(s, "base64url");
function b64urlToJson(s: string): unknown {
  return JSON.parse(b64urlToBuf(s).toString("utf8"));
}

// Verification keys rarely rotate; cache the imported KeyObject by kid to avoid
// a Plaid round-trip on every webhook.
const keyCache = new Map<string, crypto.KeyObject>();

async function defaultFetchKey(kid: string): Promise<PlaidJwk> {
  // Lazy import so this module (and its tests) don't load lib/plaid/client,
  // which validates PLAID_* env at import time.
  const { plaidClient } = await import("./client");
  const res = await plaidClient.webhookVerificationKeyGet({ key_id: kid });
  return res.data.key as PlaidJwk;
}

/**
 * Verify a Plaid webhook. Returns { ok } — never throws for an invalid webhook
 * (an invalid one is a 401, not a 500). `rawBody` MUST be the exact bytes Plaid
 * sent (read via req.text() BEFORE JSON.parse).
 */
export async function verifyPlaidWebhook(
  rawBody:             string,
  verificationHeader:  string | null | undefined,
  opts:                VerifyPlaidWebhookOptions = {},
): Promise<VerifyResult> {
  const fetchKey  = opts.fetchKey ?? defaultFetchKey;
  const maxAgeSec = opts.maxAgeSec ?? 300;

  if (!verificationHeader) return { ok: false, reason: "missing Plaid-Verification header" };

  const parts = verificationHeader.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed JWT (expected 3 segments)" };
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  try { header = b64urlToJson(headerB64) as typeof header; } catch { return { ok: false, reason: "unparseable JWT header" }; }
  if (header.alg !== "ES256") return { ok: false, reason: `unexpected alg "${header.alg}" (only ES256 accepted)` };
  if (!header.kid) return { ok: false, reason: "missing kid" };

  // Resolve + import the public key.
  let publicKey = keyCache.get(header.kid);
  if (!publicKey) {
    let jwk: PlaidJwk;
    try {
      jwk = await fetchKey(header.kid);
    } catch (e) {
      return { ok: false, reason: `key fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (jwk?.kty !== "EC" || jwk?.crv !== "P-256") return { ok: false, reason: "unexpected key type (want EC P-256)" };
    try {
      publicKey = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    } catch (e) {
      return { ok: false, reason: `key import failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    keyCache.set(header.kid, publicKey);
  }

  // Verify the signature. JWS ES256 uses raw R||S (IEEE P1363), not DER.
  const signingInput = `${headerB64}.${payloadB64}`;
  let sigValid = false;
  try {
    sigValid = crypto.verify(
      "sha256",
      Buffer.from(signingInput, "ascii"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      b64urlToBuf(sigB64),
    );
  } catch { sigValid = false; }
  if (!sigValid) return { ok: false, reason: "signature verification failed" };

  // Payload claims.
  let payload: { iat?: number; request_body_sha256?: string };
  try { payload = b64urlToJson(payloadB64) as typeof payload; } catch { return { ok: false, reason: "unparseable JWT payload" }; }

  if (typeof payload.iat !== "number") return { ok: false, reason: "missing iat" };
  const ageSec = Math.floor(Date.now() / 1000) - payload.iat;
  if (ageSec > maxAgeSec) return { ok: false, reason: `stale token (iat ${ageSec}s old > ${maxAgeSec}s)` };

  // The signed token must commit to THIS body.
  const expected = payload.request_body_sha256;
  const actual   = crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
  if (typeof expected !== "string" || !timingSafeEqualHex(expected, actual)) {
    return { ok: false, reason: "request body sha256 mismatch" };
  }

  return { ok: true };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
