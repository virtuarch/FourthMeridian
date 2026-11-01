/**
 * app/api/access-request/route.test.ts  (R2 — beta intake hardening)
 *
 * POST /api/access-request — the REAL exported handler against the in-memory
 * Prisma fake, the in-memory rate limiter and the capture e-mail transport.
 * Covers the R2 controls: per-IP limit, fail-closed CAPTCHA, per-address silent
 * drop (no existence oracle), operator-notification throttle, global ceiling.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/access-request/route.test.ts
 *
 * The limiter's memory store is process-global, so sections use distinct
 * addresses/IPs and the GLOBAL ceiling (60/h) is exercised last.
 */

import "@/lib/test-support/route-env";

// lib/env snapshots process.env at load — set BEFORE any dynamic import below.
process.env.BETA_REQUESTS_EMAIL = "ops@fm.test.invalid";
process.env.RATE_LIMIT_ENABLED = "true";

// Pin the limiter clock (lib/rate-limit reads Date.now()) to the middle of an
// hour and of a UTC day, so the fixed 1 h / 24 h windows can never roll over
// mid-run and flake the ceiling assertions.
const FIXED_NOW = Date.parse("2026-10-31T12:30:00.000Z");
const HOUR_START = "2026-10-31T12:00:00.000Z";
let now = FIXED_NOW;
Date.now = () => now;

/** A complete Turnstile siteverify success reply (strict checks: hostname, action, fresh challenge_ts). */
function siteverifyOk(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: true, hostname: "fourthmeridian.com", action: "access_request", challenge_ts: new Date().toISOString(), ...over });
}

async function main() {
  const { FakePrisma, installFakePrisma } = await import("@/lib/test-support/fake-prisma");
  const { invoke, request, makeChecker } = await import("@/lib/test-support/route-harness");
  const { capturedEmails, clearCapturedEmails } = await import("@/lib/email/providers/capture");

  const t = makeChecker("POST /api/access-request (R2)");
  const fake = new FakePrisma();
  await installFakePrisma(fake);
  const { POST } = await import("./route");

  let ipSeq = 0;
  const nextIp = () => `198.51.100.${++ipSeq}`;
  const submit = (body: Record<string, unknown>, ip = nextIp()) =>
    invoke(POST, request("/api/access-request", { body: { consent: true, ...body }, ip }));
  const operatorEmails = () => capturedEmails().filter((m) => String((m as { to?: unknown }).to).includes("ops@fm.test.invalid")).length;
  const counted = { n: 0 }; // submissions that reached the global limiter

  const quietWarn = async <T,>(fn: () => Promise<T>, sink: string[] = []) => {
    const w = console.warn, e = console.error;
    console.warn = (...a: unknown[]) => { sink.push(a.map(String).join(" ")); };
    console.error = () => {};
    try { return await fn(); } finally { console.warn = w; console.error = e; }
  };

  fake.reset();
  clearCapturedEmails();

  t.section("1. per-IP limit unchanged — 5 per 15 min");
  {
    const ip = "203.0.113.77";
    const rs = [];
    for (let i = 0; i < 6; i++) rs.push(await quietWarn(() => submit({ email: "not-an-email" }, ip)));
    t.check("first five reach validation (400), the sixth is 429", rs.slice(0, 5).every((r) => r.status === 400) && rs[5].status === 429, rs.map((r) => r.status));
  }

  t.section("2. happy path — stored, audited, operator notified once");
  let firstBody: unknown;
  {
    const r = await submit({ email: "Alice+beta@Example.test" });
    counted.n++;
    firstBody = r.body;
    t.check("200 with the identical body", r.status === 200 && r.body.success === true, r);
    t.check("request + event + audit rows written",
      fake.rows("BetaAccessRequest").length === 1 && fake.rows("BetaAccessRequestEvent").length === 1
      && fake.rows("AuditLog", { action: "BETA_ACCESS_REQUESTED" }).length === 1);
    t.check("one operator e-mail", operatorEmails() === 1, capturedEmails());
  }

  t.section("3. repeats — stored; the operator is not re-mailed for a variant of the same canonical address");
  {
    const logs: string[] = [];
    const r2 = await quietWarn(() => submit({ email: "alice+beta@example.test" }), logs); counted.n++;
    const r3 = await quietWarn(() => submit({ email: "ALICE@example.test" }), logs); counted.n++;
    t.check("both 200 with the identical body", r2.status === 200 && r3.status === 200
      && JSON.stringify(r2.body) === JSON.stringify(firstBody) && JSON.stringify(r3.body) === JSON.stringify(firstBody));
    t.check("each repeat is a stored event (3 events)", fake.rows("BetaAccessRequestEvent").length === 3, fake.rows("BetaAccessRequestEvent").length);
    t.check("operator e-mail throttled per CANONICAL address (still 1)", operatorEmails() === 1);
    t.check("throttle logged with reason=email", logs.some((l) => l.includes("throttled reason=email")), logs);
  }

  t.section("4. per-address ceiling (3/24h, keyed on the address AS STORED) — the 4th is DROPPED with the identical 200");
  {
    const logs: string[] = [];
    const third = await quietWarn(() => submit({ email: "Alice+Beta@Example.TEST" }), logs); counted.n++;
    t.check("control: the 3rd submission of the same stored address is admitted", third.status === 200 && fake.rows("BetaAccessRequestEvent").length === 4);
    const before = { req: fake.rows("BetaAccessRequest").length, ev: fake.rows("BetaAccessRequestEvent").length, au: fake.rows("AuditLog", { action: "BETA_ACCESS_REQUESTED" }).length };
    const r4 = await quietWarn(() => submit({ email: "alice+beta@EXAMPLE.test" }), logs); counted.n++;
    t.check("4th → 200, byte-identical to a first submission (no existence oracle)", r4.status === 200 && JSON.stringify(r4.body) === JSON.stringify(firstBody), r4);
    t.check("nothing stored for the dropped submission: no waitlist row, no event row, no audit row, no e-mail",
      fake.rows("BetaAccessRequest").length === before.req && fake.rows("BetaAccessRequestEvent").length === before.ev
      && fake.rows("AuditLog", { action: "BETA_ACCESS_REQUESTED" }).length === before.au && operatorEmails() === 1);
    const drops = fake.rows("AuditLog", { action: "BETA_INTAKE_DUPLICATE_DROPPED" });
    t.check("the drop is recorded as ONE hourly BETA_INTAKE_DUPLICATE_DROPPED row — counts only (no address, no hash)",
      drops.length === 1 && (drops[0].metadata as { hourWindow?: string }).hourWindow === HOUR_START
      && (drops[0].metadata as { limit?: number }).limit === 3 && !JSON.stringify(drops[0]).toLowerCase().includes("alice")
      && Object.keys(drops[0].metadata as object).sort().join(",") === "hourWindow,limit", drops);
    t.check("no log line carries the raw address", logs.length > 0 && logs.every((l) => !l.toLowerCase().includes("alice")), logs);
  }
  {
    // Review fix: +tag variants must not be able to fill the real address's bucket.
    for (let i = 0; i < 4; i++) { await quietWarn(() => submit({ email: "victim+x@example.test" })); counted.n++; }
    const evBefore = fake.rows("BetaAccessRequestEvent").length;
    const real = await quietWarn(() => submit({ email: "victim@example.test" })); counted.n++;
    t.check("after victim+x@ hits its ceiling, the real victim@ is still STORED (variants cannot silently block it)",
      real.status === 200 && fake.rows("BetaAccessRequestEvent").length === evBefore + 1
      && fake.rows("BetaAccessRequest").some((r) => r.email === "victim@example.test"));
    for (const v of ["victim+1@example.test", "victim+2@example.test", "victim+3@example.test"]) { await quietWarn(() => submit({ email: v })); counted.n++; }
    const real2 = await quietWarn(() => submit({ email: "victim@example.test" })); counted.n++;
    t.check("…nor do three distinct +1/+2/+3 variants", real2.status === 200 && fake.rows("BetaAccessRequestEvent").length === evBefore + 5);
  }

  t.section("5. CAPTCHA enforced — unavailable → 503, rejected → 400, passed → 200 (fail-closed)");
  {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "test-site";
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = "fourthmeridian.com";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;
    const before = fake.rows("BetaAccessRequestEvent").length;
    try {
      const r = await quietWarn(() => submit({ email: "bob@example.test", captchaToken: "tok" }));
      t.check("Cloudflare 500 → 503 'temporarily unavailable' with Retry-After", r.status === 503
        && String(r.body.error).includes("temporarily unavailable") && !!r.headers.get("retry-after"), r);
      globalThis.fetch = (async () => new Response(JSON.stringify({ success: false }), { status: 200 })) as typeof fetch;
      const rej = await quietWarn(() => submit({ email: "bob@example.test", captchaToken: "tok" }));
      t.check("Cloudflare success:false → 400 CAPTCHA failure", rej.status === 400 && String(rej.body.error).includes("CAPTCHA"), rej);
      // Strict siteverify: success:true is not enough.
      globalThis.fetch = (async () => new Response(siteverifyOk({ action: "register" }), { status: 200 })) as typeof fetch;
      const wrongAction = await quietWarn(() => submit({ email: "bob@example.test", captchaToken: "tok" }));
      t.check("success:true with another surface's action ('register') → 400", wrongAction.status === 400 && String(wrongAction.body.error).includes("CAPTCHA"), wrongAction);
      globalThis.fetch = (async () => new Response(siteverifyOk({ action: undefined }), { status: 200 })) as typeof fetch;
      const noAction = await quietWarn(() => submit({ email: "bob@example.test", captchaToken: "tok" }));
      t.check("success:true without an action → 400", noAction.status === 400, noAction);
      globalThis.fetch = (async () => new Response(siteverifyOk({ hostname: "evil.example" }), { status: 200 })) as typeof fetch;
      const badHost = await quietWarn(() => submit({ email: "bob@example.test", captchaToken: "tok" }));
      t.check("success:true from a hostname outside the allowlist → 400", badHost.status === 400, badHost);
      globalThis.fetch = (async () => new Response(siteverifyOk({ challenge_ts: new Date(Date.parse(new Date().toISOString()) - 301_000).toISOString() }), { status: 200 })) as typeof fetch;
      const stale = await quietWarn(() => submit({ email: "bob@example.test", captchaToken: "tok" }));
      t.check("success:true with a challenge older than 300 s → 400", stale.status === 400, stale);
      t.check("nothing stored for any strict-check failure", fake.rows("BetaAccessRequestEvent").length === before);
      globalThis.fetch = (async () => new Response(siteverifyOk(), { status: 200 })) as typeof fetch;
      const ok = await quietWarn(() => submit({ email: "bob@example.test", captchaToken: "tok" })); counted.n++;
      t.check("…and a confirmed token (allowed host, action 'access_request', fresh) is admitted", ok.status === 200 && fake.rows("BetaAccessRequestEvent").length === before + 1);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.TURNSTILE_SECRET_KEY;
      delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
      delete process.env.TURNSTILE_ALLOWED_HOSTNAMES;
    }
  }

  t.section("5b. CAPTCHA keys missing IN PRODUCTION → 503 (fail closed), never a pass");
  {
    const savedVercelEnv = process.env.VERCEL_ENV;
    const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.fourthmeridian.com";
    const realFetch = globalThis.fetch;
    let siteverify = 0;
    globalThis.fetch = (async () => { siteverify++; return new Response(siteverifyOk(), { status: 200 }); }) as typeof fetch;
    const before = fake.rows("BetaAccessRequestEvent").length;
    const origErr = console.error; console.error = () => {};
    try {
      const missing = await quietWarn(() => submit({ email: "carol@example.test", captchaToken: "tok" }));
      t.check("no keys → 503 'temporarily unavailable' with Retry-After", missing.status === 503
        && String(missing.body.error).includes("temporarily unavailable") && !!missing.headers.get("retry-after"), missing);
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "test-site";
      const siteOnly = await quietWarn(() => submit({ email: "carol@example.test", captchaToken: "tok" }));
      t.check("site key only (half-configured) → 503", siteOnly.status === 503, siteOnly);
      delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
      const secretOnly = await quietWarn(() => submit({ email: "carol@example.test", captchaToken: "tok" }));
      t.check("secret only (half-configured) → 503", secretOnly.status === 503, secretOnly);
      t.check("Cloudflare never consulted, nothing stored", siteverify === 0 && fake.rows("BetaAccessRequestEvent").length === before);
    } finally {
      console.error = origErr;
      globalThis.fetch = realFetch;
      delete process.env.TURNSTILE_SECRET_KEY;
      delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
      if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedVercelEnv;
      if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
    }
  }

  t.section("6. operator global throttle — at most 20 e-mails per hour, requests still stored");
  {
    const logs: string[] = [];
    const sentBefore = operatorEmails(); // alice + victim (canonical) + bob = 3
    const evBefore = fake.rows("BetaAccessRequestEvent").length;
    for (let i = 0; i < 20; i++) { await quietWarn(() => submit({ email: `user${i}@example.test` }), logs); counted.n++; }
    t.check("e-mails capped at 20 in the hour", sentBefore === 3 && operatorEmails() === 20, { sentBefore, now: operatorEmails() });
    t.check("every submission was still stored", fake.rows("BetaAccessRequestEvent").length === evBefore + 20, fake.rows("BetaAccessRequestEvent").length);
    t.check("throttle logged with reason=global", logs.some((l) => l.includes("throttled reason=global")));
  }

  t.section("7. GLOBAL ceiling (60/h) — 429 with a generic message");
  {
    let last: Awaited<ReturnType<typeof submit>> | null = null;
    let i = 0;
    while (counted.n < 60) { last = await quietWarn(() => submit({ email: `flood${i++}@example.test` })); counted.n++; }
    t.check("the 60th counted submission is still admitted", last?.status === 200, last);
    const before = fake.rows("BetaAccessRequestEvent").length;
    const over = await quietWarn(() => submit({ email: "one-more@example.test" }));
    t.check("the 61st → 429 with Retry-After", over.status === 429 && !!over.headers.get("retry-after"), over);
    t.check("generic message (no address-specific wording)", typeof over.body.error === "string" && !String(over.body.error).includes("one-more"));
    t.check("nothing stored for the refused submission", fake.rows("BetaAccessRequestEvent").length === before);
    const thr = fake.rows("AuditLog", { action: "BETA_INTAKE_THROTTLED" });
    t.check("the refusal is recorded as ONE BETA_INTAKE_THROTTLED row { hourWindow, limit }",
      thr.length === 1 && (thr[0].metadata as { hourWindow?: string }).hourWindow === HOUR_START && (thr[0].metadata as { limit?: number }).limit === 60, thr);
    for (let k = 0; k < 3; k++) await quietWarn(() => submit({ email: `more${k}@example.test` }));
    t.check("…and further refusals in the SAME hour add no row (still 1)", fake.rows("AuditLog", { action: "BETA_INTAKE_THROTTLED" }).length === 1);
    t.check("duplicate drops later in the same hour add no row either (victim+x was dropped too, still 1)",
      fake.rows("AuditLog", { action: "BETA_INTAKE_DUPLICATE_DROPPED" }).length === 1);
  }

  t.section("8. next UTC hour — the limit is the PlatformSetting; the first refusal of the new hour writes the next row");
  {
    now = FIXED_NOW + 60 * 60 * 1000;
    fake.seed("PlatformSetting", { key: "beta_intake_global_limit_per_hour", value: "10" });
    const rs = [];
    for (let k = 0; k < 11; k++) rs.push(await quietWarn(() => submit({ email: `h2-${k}@example.test` })));
    t.check("setting 10 → ten admitted, the 11th is 429", rs.slice(0, 10).every((r) => r.status === 200) && rs[10].status === 429, rs.map((r) => r.status));
    await quietWarn(() => submit({ email: "h2-extra@example.test" }));
    const thr = fake.rows("AuditLog", { action: "BETA_INTAKE_THROTTLED" });
    const next = thr.find((r) => (r.metadata as { hourWindow?: string }).hourWindow === "2026-10-31T13:00:00.000Z");
    t.check("exactly one new row for the new hour, carrying limit 10", thr.length === 2 && (next?.metadata as { limit?: number } | undefined)?.limit === 10, thr);
  }

  t.section("9. getBetaIntakeGlobalLimitPerHour — invalid or unreadable ⇒ the default (60)");
  {
    const { getBetaIntakeGlobalLimitPerHour } = await import("@/lib/platform-settings");
    const set = (v: string) => { fake.reset(); fake.seed("PlatformSetting", { key: "beta_intake_global_limit_per_hour", value: v }); };
    set("250"); t.check("a valid value is used", (await getBetaIntakeGlobalLimitPerHour()) === 250);
    set("5"); t.check("below the minimum (10) ⇒ default", (await getBetaIntakeGlobalLimitPerHour()) === 60);
    set("5000"); t.check("above the maximum (1000) ⇒ default", (await getBetaIntakeGlobalLimitPerHour()) === 60);
    set("lots"); t.check("non-integer ⇒ default", (await getBetaIntakeGlobalLimitPerHour()) === 60);
    fake.reset(); t.check("no row ⇒ default", (await getBetaIntakeGlobalLimitPerHour()) === 60);
    fake.on("PlatformSetting", "findUnique", () => { throw new Error("P1001"); }, { once: true });
    t.check("store error ⇒ default (never closes or unbounds the intake)", (await quietWarn(() => getBetaIntakeGlobalLimitPerHour())) === 60);
  }

  t.done();
}

main().catch((err) => { console.error(err); process.exit(1); });
