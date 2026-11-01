/**
 * lib/captcha.test.ts  (Wave 1 S3; R2 fail-closed 2026-10-31; R2 follow-up
 * 2026-11-01 — Production fail-closed on missing config + strict siteverify)
 *
 * Guards for verifyCaptchaToken's env-gating and FAIL-CLOSED contract.
 * Standalone tsx script; stubs global.fetch (no real network) and passes env
 * OBJECTS (resolveCaptchaConfig is pure). One block toggles process.env to
 * prove the default reads env per call. Runs in its own child process.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/captcha.test.ts
 *
 * Exits 0 on pass / 1 on failure.
 */

import {
  verifyCaptchaToken, captchaMode, resolveCaptchaConfig, captchaAllowedHostnames,
  judgeSiteverifyReply, CAPTCHA_ACTIONS, CHALLENGE_MAX_AGE_SEC, type CaptchaEnv,
} from "@/lib/captcha";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const realFetch = globalThis.fetch;
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  (globalThis as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
}
function restoreFetch(): void {
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
}

const NOW = new Date("2026-11-01T12:00:00.000Z");
const FRESH_TS = new Date(NOW.getTime() - 10_000).toISOString();
const APP = "https://app.fourthmeridian.com";
const SITE = "https://fourthmeridian.com";

/** A complete, valid success reply for the given action/hostname. */
function okReply(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { success: true, hostname: "app.fourthmeridian.com", action: "register", challenge_ts: FRESH_TS, ...over };
}
function replyWith(body: unknown, status = 200): () => Promise<Response> {
  return async () => new Response(JSON.stringify(body), { status });
}

const PROD_FULL: CaptchaEnv = {
  VERCEL_ENV: "production", TURNSTILE_SECRET_KEY: "test-secret", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "test-site",
  NEXT_PUBLIC_APP_URL: APP, NEXT_PUBLIC_SITE_URL: SITE,
};

async function main(): Promise<void> {
  const realErr = console.error, realWarn = console.warn, realLog = console.log;
  const quiet = () => { console.error = () => {}; console.warn = () => {}; };
  const loud = () => { console.error = realErr; console.warn = realWarn; console.log = realLog; };
  const reg = { action: CAPTCHA_ACTIONS.register, now: NOW } as const;

  console.log("resolveCaptchaConfig — the fail-closed matrix (pure)");
  const matrix: Array<[string, CaptchaEnv, string]> = [
    ["production, both keys",                 PROD_FULL, "enforced"],
    ["production, neither key",               { VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: APP }, "misconfigured"],
    ["production, secret only",               { VERCEL_ENV: "production", TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_APP_URL: APP }, "misconfigured"],
    ["production, site key only",             { VERCEL_ENV: "production", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k", NEXT_PUBLIC_APP_URL: APP }, "misconfigured"],
    ["production, both keys, no hostname",    { VERCEL_ENV: "production", TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" }, "misconfigured"],
    ["production, empty-string secret",       { ...PROD_FULL, TURNSTILE_SECRET_KEY: "" }, "misconfigured"],
    ["preview, neither key",                  { VERCEL_ENV: "preview" }, "not_configured"],
    ["preview, site key only",                { VERCEL_ENV: "preview", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" }, "not_configured"],
    ["preview, secret only",                  { VERCEL_ENV: "preview", TURNSTILE_SECRET_KEY: "s" }, "enforced"],
    ["preview, both keys",                    { VERCEL_ENV: "preview", TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" }, "enforced"],
    ["development, neither key",              { VERCEL_ENV: "development" }, "not_configured"],
    ["local (no VERCEL_ENV), neither key",    {}, "not_configured"],
    ["VERCEL_ENV=Production (not exact), neither", { VERCEL_ENV: "Production" }, "not_configured"],
  ];
  for (const [name, env, want] of matrix) {
    const got = resolveCaptchaConfig(env).mode;
    check(`${name} → ${want}`, got === want, `got ${got}`);
  }

  console.log("captchaAllowedHostnames");
  check("hosts of APP + SITE URLs, lowercased, plus TURNSTILE_ALLOWED_HOSTNAMES (trimmed, deduped)",
    JSON.stringify(captchaAllowedHostnames({ NEXT_PUBLIC_APP_URL: "https://App.Example.com:3000/x", NEXT_PUBLIC_SITE_URL: SITE, TURNSTILE_ALLOWED_HOSTNAMES: " www.fourthmeridian.com, ,fourthmeridian.com " }))
      === JSON.stringify(["app.example.com", "fourthmeridian.com", "www.fourthmeridian.com"]),
    JSON.stringify(captchaAllowedHostnames({ NEXT_PUBLIC_APP_URL: "https://App.Example.com:3000/x", NEXT_PUBLIC_SITE_URL: SITE, TURNSTILE_ALLOWED_HOSTNAMES: " www.fourthmeridian.com, ,fourthmeridian.com " })));
  check("unparseable / empty URLs are ignored", captchaAllowedHostnames({ NEXT_PUBLIC_APP_URL: "not a url", NEXT_PUBLIC_SITE_URL: "" }).length === 0);

  console.log("verifyCaptchaToken — not configured (outside Production)");
  {
    let fetchCalled = false; let warns = 0;
    console.warn = () => { warns++; };
    stubFetch(async () => { fetchCalled = true; return new Response("{}"); });
    const env: CaptchaEnv = { VERCEL_ENV: "preview" };
    const a = await verifyCaptchaToken("anything", { ...reg, env });
    const b = await verifyCaptchaToken(undefined, { ...reg, env });
    loud(); restoreFetch();
    check("no secret outside Production → passed (skipped), even without a token", a === "passed" && b === "passed");
    check("…never calls Cloudflare", fetchCalled === false);
    check("…the not-enforced warning is logged ONCE per process", warns === 1, `warns=${warns}`);
  }

  console.log("verifyCaptchaToken — Production fail-closed on missing / half config");
  {
    let fetchCalled = false; let errs = 0;
    console.error = () => { errs++; };
    stubFetch(async () => { fetchCalled = true; return new Response(JSON.stringify(okReply())); });
    const missing = { VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: APP };
    const m1 = await verifyCaptchaToken("tok", { ...reg, env: missing });
    const m2 = await verifyCaptchaToken(undefined, { ...reg, env: missing });
    const errsAfterMissing = errs;
    const secretOnly = await verifyCaptchaToken("tok", { ...reg, env: { VERCEL_ENV: "production", TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_APP_URL: APP } });
    const siteOnly = await verifyCaptchaToken("tok", { ...reg, env: { VERCEL_ENV: "production", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k", NEXT_PUBLIC_APP_URL: APP } });
    const noHost = await verifyCaptchaToken("tok", { ...reg, env: { VERCEL_ENV: "production", TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" } });
    loud(); restoreFetch();
    check("Production, no keys → unavailable (with or without a token)", m1 === "unavailable" && m2 === "unavailable");
    check("…a single error log per process for that condition", errsAfterMissing === 1, `errs=${errsAfterMissing}`);
    check("Production, secret only → unavailable", secretOnly === "unavailable");
    check("Production, site key only → unavailable", siteOnly === "unavailable");
    check("Production, no allowed hostname → unavailable", noHost === "unavailable");
    check("…none of them called Cloudflare", fetchCalled === false);
  }

  console.log("verifyCaptchaToken — reads env per call (a later key set takes effect)");
  {
    const saved = { ...process.env };
    quiet();
    process.env.VERCEL_ENV = "production";
    delete process.env.TURNSTILE_SECRET_KEY; delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    process.env.NEXT_PUBLIC_APP_URL = APP;
    const before = await verifyCaptchaToken("tok", reg);
    const modeBefore = captchaMode();
    process.env.TURNSTILE_SECRET_KEY = "test-secret"; process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "test-site";
    stubFetch(replyWith(okReply()));
    const after = await verifyCaptchaToken("tok", reg);
    restoreFetch(); loud();
    for (const k of ["VERCEL_ENV", "TURNSTILE_SECRET_KEY", "NEXT_PUBLIC_TURNSTILE_SITE_KEY", "NEXT_PUBLIC_APP_URL"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    check("process.env Production without keys → misconfigured / unavailable", modeBefore === "misconfigured" && before === "unavailable");
    check("…then keys set (no restart) → enforced and passed", after === "passed", after);
  }

  console.log("verifyCaptchaToken — enforced");
  {
    let fetchCalled = false;
    stubFetch(async () => { fetchCalled = true; return new Response("{}"); });
    check("enforced + missing token → rejected without a network call",
      (await verifyCaptchaToken(undefined, { ...reg, env: PROD_FULL })) === "rejected"
      && (await verifyCaptchaToken("", { ...reg, env: PROD_FULL })) === "rejected" && fetchCalled === false);
    restoreFetch();

    let sentBody = "";
    stubFetch(async (_u, init) => { sentBody = String(init?.body ?? ""); return new Response(JSON.stringify(okReply()), { status: 200 }); });
    check("enforced + valid success reply → passed", (await verifyCaptchaToken("tok", { ...reg, ip: "203.0.113.9", env: PROD_FULL })) === "passed");
    check("…posts secret, token and remoteip", sentBody.includes("secret=test-secret") && sentBody.includes("response=tok") && sentBody.includes("remoteip=203.0.113.9"), sentBody);
    restoreFetch();

    stubFetch(replyWith({ success: false, "error-codes": ["invalid-input-response"] }));
    check("enforced + Cloudflare success:false → rejected (the challenge failed)", (await verifyCaptchaToken("tok", { ...reg, env: PROD_FULL })) === "rejected");
    restoreFetch();

    quiet();
    stubFetch(replyWith({ ok: 1 }));
    const noSuccess = await verifyCaptchaToken("tok", { ...reg, env: PROD_FULL });
    loud(); restoreFetch();
    check("enforced + 200 without a boolean success → unavailable (malformed reply, still denied)", noSuccess === "unavailable");

    // ── Strict siteverify checks ──────────────────────────────────────────────
    quiet();
    const strict: Array<[string, Record<string, unknown>, CaptchaEnv, string]> = [
      ["marketing host (NEXT_PUBLIC_SITE_URL) is allowed",                okReply({ hostname: "fourthmeridian.com" }), PROD_FULL, "passed"],
      ["hostname compared case-insensitively",                           okReply({ hostname: "APP.FourthMeridian.com" }), PROD_FULL, "passed"],
      ["TURNSTILE_ALLOWED_HOSTNAMES extends the list",                   okReply({ hostname: "www.fourthmeridian.com" }), { ...PROD_FULL, TURNSTILE_ALLOWED_HOSTNAMES: "www.fourthmeridian.com" }, "passed"],
      ["foreign hostname → rejected",                                    okReply({ hostname: "evil.example" }), PROD_FULL, "rejected"],
      ["suffix look-alike hostname → rejected",                          okReply({ hostname: "app.fourthmeridian.com.evil.example" }), PROD_FULL, "rejected"],
      ["missing hostname → rejected",                                    okReply({ hostname: undefined }), PROD_FULL, "rejected"],
      ["missing action → rejected",                                      okReply({ action: undefined }), PROD_FULL, "rejected"],
      ["empty action → rejected",                                        okReply({ action: "" }), PROD_FULL, "rejected"],
      ["another surface's action (login token on register) → rejected", okReply({ action: "login" }), PROD_FULL, "rejected"],
      ["challenge_ts older than the max age → rejected",                 okReply({ challenge_ts: new Date(NOW.getTime() - (CHALLENGE_MAX_AGE_SEC + 1) * 1000).toISOString() }), PROD_FULL, "rejected"],
      ["challenge_ts exactly at the max age → passed",                   okReply({ challenge_ts: new Date(NOW.getTime() - CHALLENGE_MAX_AGE_SEC * 1000).toISOString() }), PROD_FULL, "passed"],
      ["missing challenge_ts → rejected",                                okReply({ challenge_ts: undefined }), PROD_FULL, "rejected"],
      ["unparseable challenge_ts → rejected",                            okReply({ challenge_ts: "yesterday" }), PROD_FULL, "rejected"],
      ["outside Production with an empty allowlist the hostname is not checked", okReply({ hostname: "localhost" }), { VERCEL_ENV: "preview", TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" }, "passed"],
      ["…but action is still required there",                           okReply({ hostname: "localhost", action: undefined }), { VERCEL_ENV: "preview", TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" }, "rejected"],
      ["outside Production a configured allowlist IS checked",           okReply({ hostname: "evil.example" }), { VERCEL_ENV: "preview", TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k", NEXT_PUBLIC_APP_URL: APP }, "rejected"],
    ];
    const results: string[] = [];
    for (const [, body, env] of strict) {
      stubFetch(replyWith(body));
      results.push(await verifyCaptchaToken("tok", { ...reg, env }));
      restoreFetch();
    }
    loud();
    strict.forEach(([name, , , want], i) => check(name, results[i] === want, `got ${results[i]}`));

    check("each surface accepts only its own action",
      judgeSiteverifyReply(okReply({ action: "access_request" }), { action: CAPTCHA_ACTIONS.accessRequest, allowedHostnames: [], now: NOW }).verdict === "passed"
      && judgeSiteverifyReply(okReply({ action: "login" }), { action: CAPTCHA_ACTIONS.login, allowedHostnames: [], now: NOW }).verdict === "passed"
      && judgeSiteverifyReply(okReply({ action: "register" }), { action: CAPTCHA_ACTIONS.accessRequest, allowedHostnames: [], now: NOW }).verdict === "rejected");
  }

  // ── Fail CLOSED on outage ───────────────────────────────────────────────────
  console.log("verifyCaptchaToken — outage");
  quiet();
  stubFetch(async () => new Response("upstream error", { status: 500 }));
  const r500 = await verifyCaptchaToken("tok", { ...reg, env: PROD_FULL });
  restoreFetch();

  stubFetch(replyWith(okReply(), 503));
  const r503 = await verifyCaptchaToken("tok", { ...reg, env: PROD_FULL });
  restoreFetch();

  stubFetch(async () => { throw new Error("network down"); });
  const rThrow = await verifyCaptchaToken("tok", { ...reg, env: PROD_FULL });
  restoreFetch();

  stubFetch(async () => new Response("<html>not json", { status: 200 }));
  const rJson = await verifyCaptchaToken("tok", { ...reg, env: PROD_FULL });
  restoreFetch();

  // Timeout: a fetch that never settles until aborted.
  stubFetch((_u, init) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  const t0 = Date.now();
  const rTimeout = await verifyCaptchaToken("tok", { ...reg, env: PROD_FULL, timeoutMs: 50 });
  const elapsed = Date.now() - t0;
  restoreFetch();
  loud();

  check("enforced + Cloudflare HTTP 500 → unavailable (fail-CLOSED)", r500 === "unavailable");
  check("enforced + non-2xx even with a success body → unavailable", r503 === "unavailable");
  check("enforced + fetch throws → unavailable (fail-CLOSED)", rThrow === "unavailable");
  check("enforced + malformed JSON → unavailable (fail-CLOSED)", rJson === "unavailable");
  check("enforced + timeout → unavailable (fail-CLOSED), promptly", rTimeout === "unavailable" && elapsed < 2_000, `elapsed=${elapsed}ms`);
  check("no outage verdict is ever passed", [r500, r503, rThrow, rJson, rTimeout].every((v) => v !== "passed"));

  console.log(failures === 0 ? "\nAll verifyCaptchaToken checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
