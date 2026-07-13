/**
 * lib/captcha.test.ts  (Wave 1 S3)
 *
 * Guards for verifyCaptchaToken's env-gating and fail-open contract. Standalone
 * tsx script; stubs global.fetch (no real network) and toggles the secret env
 * var. Runs in its own child process (the runner isolates env-mutating tests).
 *
 *     npx tsx lib/captcha.test.ts
 *
 * Exits 0 on pass / 1 on failure.
 */

import { verifyCaptchaToken } from "@/lib/captcha";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const realFetch = globalThis.fetch;
function stubFetch(impl: () => Promise<Response>): void {
  (globalThis as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
}
function restoreFetch(): void {
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
}

async function main(): Promise<void> {
  console.log("verifyCaptchaToken");

  // ── Disabled (no secret) — verification skipped, always true, no fetch ──────
  delete process.env.TURNSTILE_SECRET_KEY;
  let fetchCalled = false;
  stubFetch(async () => { fetchCalled = true; return new Response("{}"); });
  check("no secret configured → true (skipped)", (await verifyCaptchaToken("anything")) === true);
  check("no secret configured → never calls Cloudflare", fetchCalled === false);
  restoreFetch();

  // ── Configured secret ───────────────────────────────────────────────────────
  process.env.TURNSTILE_SECRET_KEY = "test-secret";

  check("secret set + missing token → false (failed challenge)", (await verifyCaptchaToken(undefined)) === false);

  stubFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  check("secret set + Cloudflare success:true → true", (await verifyCaptchaToken("tok")) === true);
  restoreFetch();

  stubFetch(async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 }));
  check("secret set + Cloudflare success:false → false", (await verifyCaptchaToken("tok")) === false);
  restoreFetch();

  // ── Fail-open on outage ───────────────────────────────────────────────────────
  stubFetch(async () => new Response("upstream error", { status: 500 }));
  check("secret set + Cloudflare HTTP 500 → true (fail-open)", (await verifyCaptchaToken("tok")) === true);
  restoreFetch();

  stubFetch(async () => { throw new Error("network down"); });
  check("secret set + fetch throws → true (fail-open)", (await verifyCaptchaToken("tok")) === true);
  restoreFetch();

  console.log(failures === 0 ? "\nAll verifyCaptchaToken checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
