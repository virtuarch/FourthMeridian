/**
 * lib/plaid/webhook-verify-amplification.test.ts  (2026-10-07)
 *
 * The webhook endpoint is public and its key lookup runs on an UNAUTHENTICATED
 * `kid`. Before this slice any caller could make the server issue one Plaid
 * webhookVerificationKeyGet per arbitrary kid (seen on Preview). These checks
 * pin the bound — and that legitimate verification and key rotation survive it.
 *
 * Part 1 drives ONLY the public verifyPlaidWebhook API (so it also runs against
 * the pre-fix module as a negative control). Part 2 uses isolated state for the
 * exact bounds, rotation, time and expiry.
 *
 *   npx tsx lib/plaid/webhook-verify-amplification.test.ts
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as verify from "./webhook-verify";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
const BODY = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "itm_test" });

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, jwk: publicKey.export({ format: "jwk" }) as unknown as verify.PlaidJwk };
}
const K1 = keypair();
const K2 = keypair();   // a rotated key

function jwt(kid: string, signer = K1.privateKey, over: { iat?: number; badSig?: boolean; body?: string; sigLen?: number } = {}, nowMs = Date.now()): string {
  const h = b64url(JSON.stringify({ alg: "ES256", kid, typ: "JWT" }));
  const p = b64url(JSON.stringify({
    iat: over.iat ?? Math.floor(nowMs / 1000),
    request_body_sha256: crypto.createHash("sha256").update(over.body ?? BODY, "utf8").digest("hex"),
  }));
  let sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`, "ascii"), { key: signer, dsaEncoding: "ieee-p1363" });
  if (over.badSig) sig = Buffer.from(sig).reverse();
  if (over.sigLen !== undefined) sig = Buffer.alloc(over.sigLen, 1);
  return `${h}.${p}.${b64url(sig)}`;
}

/** Plaid as the attacker meets it: real keys answer, anything else is a 400. */
function plaid(keys: Record<string, verify.PlaidJwk>, opts: { delayMs?: number; failTransient?: Set<string> } = {}) {
  const calls: string[] = [];
  const fetchKey = async (kid: string): Promise<verify.PlaidJwk> => {
    calls.push(kid);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.failTransient?.has(kid)) throw Object.assign(new Error("ECONNRESET"), { isAxiosError: true });
    const k = keys[kid];
    if (!k) throw Object.assign(new Error("Request failed with status code 400"), { isAxiosError: true, response: { status: 400 } });
    return { ...k, kid, alg: "ES256", use: "sig" };
  };
  return { calls, fetchKey };
}
const admitAll = async () => true;

async function main(): Promise<void> {
  // ════════════════════ PART 1 — public API (negative-controllable) ═══════════
  console.log("A. A known key verifies without repeated provider calls");
  {
    const p = plaid({ "kid-good-a": K1.jwk });
    const o = { fetchKey: p.fetchKey, admitKeyFetch: admitAll };
    const r1 = await verify.verifyPlaidWebhook(BODY, jwt("kid-good-a"), o);
    const r2 = await verify.verifyPlaidWebhook(BODY, jwt("kid-good-a"), o);
    const r3 = await verify.verifyPlaidWebhook(BODY, jwt("kid-good-a"), o);
    check("valid webhooks verify", r1.ok && r2.ok && r3.ok, JSON.stringify([r1, r2, r3]));
    check("three verifications, ONE provider call", p.calls.length === 1, `${p.calls.length}`);
  }

  console.log("C. The same bogus kid, 50 times");
  {
    const p = plaid({});
    for (let i = 0; i < 50; i++) await verify.verifyPlaidWebhook(BODY, jwt("kid-bogus-repeat"), { fetchKey: p.fetchKey, admitKeyFetch: admitAll });
    check("REGRESSION: at most ONE provider call for a repeated bogus kid", p.calls.length <= 1, `${p.calls.length} calls`);
  }

  console.log("E. 20 concurrent requests for one unknown kid");
  {
    const p = plaid({ "kid-good-concurrent": K1.jwk }, { delayMs: 30 });
    const rs = await Promise.all(Array.from({ length: 20 }, () =>
      verify.verifyPlaidWebhook(BODY, jwt("kid-good-concurrent"), { fetchKey: p.fetchKey, admitKeyFetch: admitAll })));
    check("REGRESSION: concurrent misses coalesce into ONE provider call", p.calls.length === 1, `${p.calls.length} calls`);
    check("…and every one of them verifies", rs.every((r) => r.ok), JSON.stringify(rs.find((r) => !r.ok)));
  }

  console.log("D. 1,000 unique bogus kids");
  {
    const p = plaid({});
    for (let i = 0; i < 1000; i++) await verify.verifyPlaidWebhook(BODY, jwt(`kid-flood-${i}`), { fetchKey: p.fetchKey, admitKeyFetch: admitAll });
    check(`REGRESSION: provider calls bounded by the miss budget (≤ ${verify.MISS_BUDGET ?? 6})`, p.calls.length <= (verify.MISS_BUDGET ?? 6), `${p.calls.length} calls`);
  }

  console.log("G. Malformed tokens never reach the provider");
  {
    const p = plaid({ "kid-good-g": K1.jwk });
    const o = { fetchKey: p.fetchKey, admitKeyFetch: admitAll };
    const h = (o2: object) => b64url(JSON.stringify(o2));
    const cases: [string, string, string][] = [
      ["two segments", "abc.def", BODY],
      ["unparseable header", "%%%.e30.c2ln", BODY],
      ["alg none", `${h({ alg: "none", kid: "kid-good-g" })}.e30.`, BODY],
      ["kid with illegal characters", jwt("kid/../../etc"), BODY],
      ["oversized kid (500 chars)", jwt("k".repeat(500)), BODY],
      ["signature of the wrong length", jwt("kid-good-g", K1.privateKey, { sigLen: 10 }), BODY],
      ["stale iat", jwt("kid-good-g", K1.privateKey, { iat: Math.floor(Date.now() / 1000) - 3600 }), BODY],
      ["body does not match the signed hash", jwt("kid-good-g"), BODY + " "],
    ];
    for (const [label, token, body] of cases) {
      const r = await verify.verifyPlaidWebhook(body, token, o);
      check(`${label} → rejected`, !r.ok);
    }
    check("REGRESSION: none of them caused a provider call", p.calls.length === 0, `${p.calls.length} calls: ${p.calls.map((k) => k.slice(0, 12)).join(",")}`);
  }

  console.log("F. A bad signature on a KNOWN kid is rejected locally");
  {
    const p = plaid({ "kid-good-a": K1.jwk });
    const r = await verify.verifyPlaidWebhook(BODY, jwt("kid-good-a", K1.privateKey, { badSig: true }), { fetchKey: p.fetchKey, admitKeyFetch: admitAll });
    const forged = await verify.verifyPlaidWebhook(BODY, jwt("kid-good-a", K2.privateKey), { fetchKey: p.fetchKey, admitKeyFetch: admitAll });
    check("tampered signature → rejected", !r.ok && /signature/.test(r.reason ?? ""), r.reason);
    check("signed by another key under a cached kid → rejected", !forged.ok, forged.reason);
    check("no provider call (the key was cached by A)", p.calls.length === 0, `${p.calls.length}`);
    // OPERATIONALIZATION P0 — the receiver's decision logic moved into
    // lib/plaid/webhook-receiver.ts (handlePlaidWebhook) so it can be tested with
    // injected deps; the route is a thin adapter that hands it the REAL verifier.
    // The ordering claim is therefore pinned on the receiver, and the route is
    // pinned to delegate with verifyPlaidWebhook and nothing else in front of it.
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const route = strip(readFileSync(join(process.cwd(), "app/api/plaid/webhook/route.ts"), "utf8"));
    const receiver = strip(readFileSync(join(process.cwd(), "lib/plaid/webhook-receiver.ts"), "utf8"));
    const handler = receiver.slice(receiver.indexOf("export async function handlePlaidWebhook"));
    const at = (s: string) => handler.indexOf(s);
    check("the receiver verifies BEFORE parsing the body or reaching any Item / sync / database work",
      at("deps.verify(") > -1 && at("deps.verify(") < at("JSON.parse(")
      && at("deps.verify(") < at("deps.lookupItem(") && at("deps.verify(") < at("deps.scheduleSync(")
      && at("deps.verify(") < at("deps.recordEvent(")
      && /if \(!verified\.ok\)[\s\S]{0,200}status: 401/.test(handler));
    check("the route delegates to the receiver with the real verifier, reading nothing but the raw body first",
      /verify:\s*verifyPlaidWebhook/.test(route) && route.indexOf("req.text()") < route.indexOf("handlePlaidWebhook(")
      && !/JSON\.parse\(/.test(route));
  }

  // ════════════════════ PART 2 — isolated state: bounds, rotation, time ═══════
  if (typeof verify.verifyWithState !== "function" || typeof verify.newWebhookKeyState !== "function") {
    failures++; console.error("  ✗ isolated-state API missing (pre-fix module) — Part 2 cannot run");
  } else {
    let clock = Date.now();
    const now = () => clock;
    const run = (s: verify.WebhookKeyState, p: ReturnType<typeof plaid>, token: string, admit = admitAll, body = BODY) =>
      verify.verifyWithState(s, body, token, { fetchKey: p.fetchKey, admitKeyFetch: admit, now });

    console.log("B. Legitimate key rotation");
    {
      const s = verify.newWebhookKeyState();
      const p = plaid({ "kid-v1": K1.jwk, "kid-v2": K2.jwk });
      const old = await run(s, p, jwt("kid-v1", K1.privateKey, {}, clock));
      const rotated = await run(s, p, jwt("kid-v2", K2.privateKey, {}, clock));
      const again = await run(s, p, jwt("kid-v2", K2.privateKey, {}, clock));
      check("the old key verifies", old.ok);
      check("a NEW Plaid kid is fetched once and verifies", rotated.ok && p.calls.filter((k) => k === "kid-v2").length === 1);
      check("…and is then reused without another provider call", again.ok && p.calls.length === 2, `${p.calls.length}`);
    }

    console.log("D′. Memory is bounded whatever the attacker sends");
    {
      const s = verify.newWebhookKeyState();
      const p = plaid({});
      for (let w = 0; w < 60; w++) {          // 60 windows ≈ 10 h of flood
        for (let i = 0; i < 50; i++) await run(s, p, jwt(`kid-w${w}-${i}`, K1.privateKey, {}, clock));
        clock += verify.MISS_WINDOW_MS;
      }
      check(`provider calls ≤ budget × windows (${verify.MISS_BUDGET} × 60)`, p.calls.length <= verify.MISS_BUDGET * 60, `${p.calls.length}`);
      check(`negative cache never exceeds ${verify.NEG_CACHE_MAX}`, s.negative.size <= verify.NEG_CACHE_MAX, `${s.negative.size}`);
      check(`positive cache never exceeds ${verify.KEY_CACHE_MAX}`, s.keys.size <= verify.KEY_CACHE_MAX);
      check("no in-flight lookups left behind", s.inflight.size === 0);
      check("the miss window holds at most one window of timestamps", s.misses.length <= verify.MISS_BUDGET);
      const pk = plaid(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`kid-real-${i}`, K1.jwk])));
      for (let i = 0; i < 40; i++) { await run(s, pk, jwt(`kid-real-${i}`, K1.privateKey, {}, clock)); clock += verify.MISS_WINDOW_MS; }
      check(`even 40 genuine keys keep the positive cache ≤ ${verify.KEY_CACHE_MAX}`, s.keys.size <= verify.KEY_CACHE_MAX, `${s.keys.size}`);
    }

    console.log("H. Failures and budget exhaustion are never permanent");
    {
      const s = verify.newWebhookKeyState();
      const transient = new Set(["kid-new"]);
      const p = plaid({ "kid-new": K2.jwk }, { failTransient: transient });
      const down = await run(s, p, jwt("kid-new", K2.privateKey, {}, clock));
      check("Plaid unreachable → rejected", !down.ok);
      clock += 5_000;
      await run(s, p, jwt("kid-new", K2.privateKey, {}, clock));
      check("…and not re-asked within the transient window", p.calls.length === 1, `${p.calls.length}`);
      transient.clear();
      clock += verify.NEG_TRANSIENT_MS;
      const back = await run(s, p, jwt("kid-new", K2.privateKey, {}, clock));
      check("after the transient window the rotated key is fetched and verifies", back.ok && p.calls.length === 2, back.reason);

      const s2 = verify.newWebhookKeyState();
      const p2 = plaid({ "kid-rot": K2.jwk });
      for (let i = 0; i < 20; i++) await run(s2, p2, jwt(`kid-junk-${i}`, K1.privateKey, {}, clock));
      const starved = await run(s2, p2, jwt("kid-rot", K2.privateKey, {}, clock));
      check("during a flood the budget can refuse a genuine new kid (bounded, not permanent)", !starved.ok, starved.reason);
      clock += verify.MISS_WINDOW_MS;
      const recovered = await run(s2, p2, jwt("kid-rot", K2.privateKey, {}, clock));
      check("…and the next window admits it", recovered.ok, recovered.reason);

      const s3 = verify.newWebhookKeyState();
      const p3 = plaid({ "kid-shared": K1.jwk });
      const refused = await run(s3, p3, jwt("kid-shared", K1.privateKey, {}, clock), async () => false);
      check("the shared limiter can refuse a lookup", !refused.ok && p3.calls.length === 0);
      const later = await run(s3, p3, jwt("kid-shared", K1.privateKey, {}, clock));
      check("…without blacklisting the kid", later.ok && p3.calls.length === 1, later.reason);
    }

    console.log("H′. Plaid's own key expiry is honoured");
    {
      const s = verify.newWebhookKeyState();
      const p = plaid({ "kid-exp": { ...K1.jwk, expired_at: Math.floor(clock / 1000) - 60 } });
      const r = await run(s, p, jwt("kid-exp", K1.privateKey, {}, clock));
      check("a key Plaid has expired does not verify", !r.ok && /expired/.test(r.reason ?? ""), r.reason);
      const s2 = verify.newWebhookKeyState();
      const p2 = plaid({ "kid-soon": { ...K1.jwk, expired_at: Math.floor(clock / 1000) + 60 } });
      check("a key expiring later verifies now", (await run(s2, p2, jwt("kid-soon", K1.privateKey, {}, clock))).ok);
      clock += 120_000;
      const after = await run(s2, p2, jwt("kid-soon", K1.privateKey, {}, clock));
      check("…and the cached key stops verifying once it has expired", !after.ok, after.reason);
    }

    console.log("Logs carry no attacker input or key material");
    {
      const s = verify.newWebhookKeyState();
      const evil = "kid-EVIL-MARKER";
      const p = plaid({});
      const r = await run(s, p, jwt(evil, K1.privateKey, {}, clock));
      check("the rejection reason does not echo the kid", !(r.reason ?? "").includes("EVIL"), r.reason);
    }
  }

  if (failures > 0) { console.error(`\nwebhook-verify-amplification.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nwebhook-verify-amplification.test: all passed.");
}

void main();
