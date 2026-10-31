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
  check("no secret → passed (skipped), even without a token", a === "passed" && b === "passed");
  check("no secret → never calls Cloudflare", fetchCalled === false);
  check("no secret → the not-enforced warning is logged ONCE per process", warns === 1, `warns=${warns}`);
  restoreFetch();

  // ── Enforced ────────────────────────────────────────────────────────────────
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "test-site";
  check("secret set → captchaMode() = enforced", captchaMode() === "enforced");

  fetchCalled = false;
  stubFetch(async () => { fetchCalled = true; return new Response("{}"); });
  check("enforced + missing token → rejected without a network call",
    (await verifyCaptchaToken(undefined)) === "rejected" && (await verifyCaptchaToken("")) === "rejected" && fetchCalled === false);
  restoreFetch();

  let sentBody = "";
  stubFetch(async (_u, init) => { sentBody = String(init?.body ?? ""); return new Response(JSON.stringify({ success: true }), { status: 200 }); });
  check("enforced + Cloudflare success:true → passed", (await verifyCaptchaToken("tok", "203.0.113.9")) === "passed");
  check("…posts secret, token and remoteip", sentBody.includes("secret=test-secret") && sentBody.includes("response=tok") && sentBody.includes("remoteip=203.0.113.9"), sentBody);
  restoreFetch();

  stubFetch(async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 }));
  check("enforced + Cloudflare success:false → rejected (the challenge failed)", (await verifyCaptchaToken("tok")) === "rejected");
  restoreFetch();

  quiet();
  stubFetch(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
  const noSuccess = await verifyCaptchaToken("tok");
  loud();
  check("enforced + 200 without a boolean success → unavailable (malformed reply, still denied)", noSuccess === "unavailable");
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

  check("enforced + Cloudflare HTTP 500 → unavailable (fail-CLOSED)", r500 === "unavailable");
  check("enforced + non-2xx even with a success body → unavailable", r503 === "unavailable");
  check("enforced + fetch throws → unavailable (fail-CLOSED)", rThrow === "unavailable");
  check("enforced + malformed JSON → unavailable (fail-CLOSED)", rJson === "unavailable");
  check("enforced + timeout → unavailable (fail-CLOSED), promptly", rTimeout === "unavailable" && elapsed < 2_000, `elapsed=${elapsed}ms`);
  check("no outage verdict is ever passed", [r500, r503, rThrow, rJson, rTimeout, noSuccess].every((v) => v !== "passed"));

  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  console.log(failures === 0 ? "\nAll verifyCaptchaToken checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
