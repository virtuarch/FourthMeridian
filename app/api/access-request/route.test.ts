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

  t.section("3. repeats of the same canonical address — stored, but the operator is not re-mailed");
  {
    const logs: string[] = [];
    const r2 = await quietWarn(() => submit({ email: "alice@example.test" }), logs); counted.n++;
    const r3 = await quietWarn(() => submit({ email: "ALICE+again@example.test" }), logs); counted.n++;
    t.check("both 200 with the identical body", r2.status === 200 && r3.status === 200
      && JSON.stringify(r2.body) === JSON.stringify(firstBody) && JSON.stringify(r3.body) === JSON.stringify(firstBody));
    t.check("each repeat is a stored event (3 events, 1 waitlist row per stored spelling)",
      fake.rows("BetaAccessRequestEvent").length === 3, fake.rows("BetaAccessRequestEvent").length);
    t.check("operator e-mail throttled per address (still 1)", operatorEmails() === 1);
    t.check("throttle logged with reason=email", logs.some((l) => l.includes("throttled reason=email")), logs);
  }

  t.section("4. per-address ceiling (3/24h) — the 4th is DROPPED with the identical 200");
  {
    const logs: string[] = [];
    const before = { ev: fake.rows("BetaAccessRequestEvent").length, au: fake.rows("AuditLog").length };
    const r4 = await quietWarn(() => submit({ email: "Alice+third@Example.test" }), logs); counted.n++;
    t.check("200, byte-identical to a first submission (no existence oracle)", r4.status === 200 && JSON.stringify(r4.body) === JSON.stringify(firstBody), r4);
    t.check("nothing stored, audited or e-mailed for the dropped submission",
      fake.rows("BetaAccessRequestEvent").length === before.ev && fake.rows("AuditLog").length === before.au && operatorEmails() === 1);
    t.check("no log line carries the raw address", logs.length > 0 && logs.every((l) => !l.toLowerCase().includes("alice")), logs);
  }

  t.section("5. CAPTCHA enforced + Cloudflare 500 → refused (fail-closed), nothing stored");
  {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "test-site";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;
    const before = fake.rows("BetaAccessRequestEvent").length;
    try {
      const r = await quietWarn(() => submit({ email: "bob@example.test", captchaToken: "tok" }));
      t.check("400 CAPTCHA failure", r.status === 400 && String(r.body.error).includes("CAPTCHA"), r);
      t.check("nothing stored", fake.rows("BetaAccessRequestEvent").length === before);
      globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch;
      const ok = await quietWarn(() => submit({ email: "bob@example.test", captchaToken: "tok" })); counted.n++;
      t.check("…and a confirmed token is admitted", ok.status === 200 && fake.rows("BetaAccessRequestEvent").length === before + 1);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.TURNSTILE_SECRET_KEY;
      delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    }
  }

  t.section("6. operator global throttle — at most 20 e-mails per hour, requests still stored");
  {
    const logs: string[] = [];
    const sentBefore = operatorEmails(); // alice + bob = 2
    for (let i = 0; i < 20; i++) { await quietWarn(() => submit({ email: `user${i}@example.test` }), logs); counted.n++; }
    t.check("e-mails capped at 20 in the hour", operatorEmails() === 20, { sentBefore, now: operatorEmails() });
    t.check("every submission was still stored", fake.rows("BetaAccessRequestEvent").length === 4 + 20, fake.rows("BetaAccessRequestEvent").length);
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
  }

  t.done();
}

main().catch((err) => { console.error(err); process.exit(1); });
