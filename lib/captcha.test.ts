/**
 * lib/captcha.test.ts  (Wave 1 S3; R2 fail-closed 2026-10-31)
 *
 * Guards for verifyCaptchaToken's env-gating and FAIL-CLOSED contract.
 * Standalone tsx script; stubs global.fetch (no real network) and toggles the
 * secret env var. Runs in its own child process (the runner isolates
 * env-mutating tests).
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/captcha.test.ts
 *
 * Exits 0 on pass / 1 on failure.
 */

import { verifyCaptchaToken, captchaMode } from "@/lib/captcha";

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

async function main(): Promise<void> {
  const realErr = console.error, realWarn = console.warn;
  const quiet = () => { console.error = () => {}; console.warn = () => {}; };
  const loud = () => { console.error = realErr; console.warn = realWarn; };

  console.log("verifyCaptchaToken");

  // ── Not configured — skipped, always true, no fetch, logged once ───────────
  delete process.env.TURNSTILE_SECRET_KEY;
  check("no secret → captchaMode() = not_configured", captchaMode() === "not_configured");
  let fetchCalled = false;
  let warns = 0;
  console.warn = () => { warns++; };
  stubFetch(async () => { fetchCalled = true; return new Response("{}"); });
  const a = await verifyCaptchaToken("anything");
  const b = await verifyCaptchaToken(undefined);
  loud();
  check("no secret → true (skipped), even without a token", a === true && b === true);
  check("no secret → never calls Cloudflare", fetchCalled === false);
  check("no secret → the not-enforced warning is logged ONCE per process", warns === 1, `warns=${warns}`);
  restoreFetch();

  // ── Enforced ────────────────────────────────────────────────────────────────
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "test-site";
  check("secret set → captchaMode() = enforced", captchaMode() === "enforced");

  fetchCalled = false;
  stubFetch(async () => { fetchCalled = true; return new Response("{}"); });
  check("enforced + missing token → false without a network call",
    (await verifyCaptchaToken(undefined)) === false && (await verifyCaptchaToken("")) === false && fetchCalled === false);
  restoreFetch();

  let sentBody = "";
  stubFetch(async (_u, init) => { sentBody = String(init?.body ?? ""); return new Response(JSON.stringify({ success: true }), { status: 200 }); });
  check("enforced + Cloudflare success:true → true", (await verifyCaptchaToken("tok", "203.0.113.9")) === true);
  check("…posts secret, token and remoteip", sentBody.includes("secret=test-secret") && sentBody.includes("response=tok") && sentBody.includes("remoteip=203.0.113.9"), sentBody);
  restoreFetch();

  stubFetch(async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 }));
  check("enforced + Cloudflare success:false → false", (await verifyCaptchaToken("tok")) === false);
  restoreFetch();

  stubFetch(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
  check("enforced + 200 without success:true → false", (await verifyCaptchaToken("tok")) === false);
  restoreFetch();

  // ── Fail CLOSED on outage ───────────────────────────────────────────────────
  quiet();
  stubFetch(async () => new Response("upstream error", { status: 500 }));
  const r500 = await verifyCaptchaToken("tok");
  restoreFetch();

  stubFetch(async () => new Response(JSON.stringify({ success: true }), { status: 503 }));
  const r503 = await verifyCaptchaToken("tok");
  restoreFetch();

  stubFetch(async () => { throw new Error("network down"); });
  const rThrow = await verifyCaptchaToken("tok");
  restoreFetch();

  stubFetch(async () => new Response("<html>not json", { status: 200 }));
  const rJson = await verifyCaptchaToken("tok");
  restoreFetch();

  // Timeout: a fetch that never settles until aborted.
  stubFetch((_u, init) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  const t0 = Date.now();
  const rTimeout = await verifyCaptchaToken("tok", undefined, { timeoutMs: 50 });
  const elapsed = Date.now() - t0;
  restoreFetch();
  loud();

  check("enforced + Cloudflare HTTP 500 → false (fail-CLOSED)", r500 === false);
  check("enforced + non-2xx even with a success body → false", r503 === false);
  check("enforced + fetch throws → false (fail-CLOSED)", rThrow === false);
  check("enforced + malformed JSON → false (fail-CLOSED)", rJson === false);
  check("enforced + timeout → false (fail-CLOSED), promptly", rTimeout === false && elapsed < 2_000, `elapsed=${elapsed}ms`);

  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  console.log(failures === 0 ? "\nAll verifyCaptchaToken checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
