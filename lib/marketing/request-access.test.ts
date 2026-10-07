/**
 * lib/marketing/request-access.test.ts  (domain split, Preview rehearsal)
 *
 * The request-access form's outcome must be TRUTHFUL: only a 2xx from
 * /api/access-request is success. A 404 used to be reported as "queued" — under
 * a split origin that turns a misrouted post into silent lead loss.
 *
 * fetch is stubbed; no network, no DB.
 */
import { ACCESS_REQUEST_ENDPOINT, submitAccessRequest } from "./request-access";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const realFetch = globalThis.fetch;
const calls: { url: string; body: string }[] = [];
function stub(respond: () => Response | Promise<Response>) {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return respond();
  }) as typeof fetch;
}

async function main() {
  console.log("submitAccessRequest outcome mapping");
  const cases: [string, () => Response | Promise<Response>, string][] = [
    ["200 ⇒ queued", () => new Response("{}", { status: 200 }), "queued"],
    ["404 ⇒ error (never success)", () => new Response("", { status: 404 }), "error"],
    ["429 ⇒ rate_limited", () => new Response("", { status: 429 }), "rate_limited"],
    ["400 ⇒ error", () => new Response("", { status: 400 }), "error"],
    ["403 (cross-origin refused) ⇒ error", () => new Response("", { status: 403 }), "error"],
    ["500 ⇒ error", () => new Response("", { status: 500 }), "error"],
    ["network failure ⇒ error", () => Promise.reject(new TypeError("fetch failed")), "error"],
  ];
  for (const [name, respond, want] of cases) {
    stub(respond);
    const r = await submitAccessRequest({ email: "Person@Example.com " });
    check(name, r.status === want, JSON.stringify(r));
  }

  calls.length = 0;
  stub(() => new Response("{}", { status: 200 }));
  await submitAccessRequest({ email: "Person@Example.com ", note: " hi ", captchaToken: "tok" });
  check("posts to the relative same-origin endpoint", calls[0]?.url === ACCESS_REQUEST_ENDPOINT && ACCESS_REQUEST_ENDPOINT === "/api/access-request");
  check("normalised email, trimmed note, captcha token", calls[0]?.body === JSON.stringify({ email: "person@example.com", note: "hi", captchaToken: "tok" }));

  calls.length = 0;
  stub(() => new Response("{}", { status: 200 }));
  await submitAccessRequest({ email: "p@example.com", source: { utmSource: "nl", landingPath: "/about" } });
  check("acquisition source rides in the body when present",
    calls[0]?.body === JSON.stringify({ email: "p@example.com", source: { utmSource: "nl", landingPath: "/about" } }), calls[0]?.body);
  calls.length = 0;
  await submitAccessRequest({ email: "p@example.com", source: {} });
  check("an empty source is omitted, not sent", calls[0]?.body === JSON.stringify({ email: "p@example.com" }), calls[0]?.body);

  calls.length = 0;
  const bad = await submitAccessRequest({ email: "nope" });
  check("invalid email ⇒ error without a request", bad.status === "error" && calls.length === 0);
}

main()
  .catch((e) => { failures++; console.error("  ✗ threw —", e); })
  .finally(() => {
    globalThis.fetch = realFetch;
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll request-access checks passed.");
  });
