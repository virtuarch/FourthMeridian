/**
 * lib/plaid/webhook-verify.test.ts
 *
 * Plaid webhook JWT verification. Standalone tsx script — constructs a REAL
 * ES256 JWT with an ephemeral P-256 keypair (Node crypto) and injects the
 * matching public JWK via the fetchKey seam, so there is no network and no
 * Plaid env dependency.
 *
 *     npx tsx lib/plaid/webhook-verify.test.ts
 */

import crypto from "node:crypto";
import { verifyPlaidWebhook, type PlaidJwk } from "./webhook-verify";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" }) as unknown as PlaidJwk;
const fetchKey = async (kid: string): Promise<PlaidJwk> => ({ ...jwk, kid, alg: "ES256", use: "sig" });

/** Build a Plaid-style verification JWT over `body`, with overridable claims/header. */
function makeJwt(
  body: string,
  opts: { iat?: number; bodyHash?: string; alg?: string; kid?: string; badSig?: boolean } = {},
): string {
  const header  = { alg: opts.alg ?? "ES256", kid: opts.kid ?? "kid-1", typ: "JWT" };
  const payload = {
    iat:                 opts.iat ?? Math.floor(Date.now() / 1000),
    request_body_sha256: opts.bodyHash ?? crypto.createHash("sha256").update(body, "utf8").digest("hex"),
  };
  const headerB64  = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = crypto.sign("sha256", Buffer.from(`${headerB64}.${payloadB64}`, "ascii"), { key: privateKey, dsaEncoding: "ieee-p1363" });
  const sigB64 = opts.badSig ? b64url(Buffer.from(sig).reverse()) : b64url(sig);
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

const BODY = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "itm_123" });

async function main(): Promise<void> {
  console.log("1. Valid webhook");
  check("valid JWT + matching body → ok", (await verifyPlaidWebhook(BODY, makeJwt(BODY), { fetchKey })).ok);

  console.log("2. Rejections");
  check("missing header → reject",
    !(await verifyPlaidWebhook(BODY, null, { fetchKey })).ok);
  check("malformed JWT → reject",
    !(await verifyPlaidWebhook(BODY, "not.a.valid.jwt.x", { fetchKey })).ok);
  check("alg != ES256 → reject (alg-confusion guard)",
    !(await verifyPlaidWebhook(BODY, makeJwt(BODY, { alg: "none" }), { fetchKey })).ok);
  check("tampered signature → reject",
    !(await verifyPlaidWebhook(BODY, makeJwt(BODY, { badSig: true }), { fetchKey })).ok);
  check("body changed after signing → sha256 mismatch → reject",
    !(await verifyPlaidWebhook(BODY + " ", makeJwt(BODY), { fetchKey })).ok);
  check("wrong request_body_sha256 claim → reject",
    !(await verifyPlaidWebhook(BODY, makeJwt(BODY, { bodyHash: "deadbeef" }), { fetchKey })).ok);
  check("stale iat (10 min old) → reject (replay window)",
    !(await verifyPlaidWebhook(BODY, makeJwt(BODY, { iat: Math.floor(Date.now() / 1000) - 600 }), { fetchKey })).ok);

  console.log("3. Key mismatch (fresh kids — the module caches keys by kid)");
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const otherJwk = other.publicKey.export({ format: "jwk" }) as unknown as PlaidJwk;
  // Signed with OUR private key, but the fetched key is a different public key.
  check("signature from a different key → reject",
    !(await verifyPlaidWebhook(BODY, makeJwt(BODY, { kid: "kid-other" }), { fetchKey: async (kid) => ({ ...otherJwk, kid }) })).ok);
  check("key fetch throwing → reject (not a crash)",
    !(await verifyPlaidWebhook(BODY, makeJwt(BODY, { kid: "kid-throw" }), { fetchKey: async () => { throw new Error("boom"); } })).ok);

  console.log(failures === 0 ? "\nAll webhook-verify checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
