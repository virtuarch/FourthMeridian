/**
 * lib/security-headers.test.ts  (OPS-1 S5)
 *
 * Standalone tsx script (house pattern). Imports next.config.ts directly and
 * asserts the headers() contract — the same objects Next.js serves — without
 * needing a running build.
 *
 * Covers:
 *   1. Every S5 header is present for the catch-all source.
 *   2. CSP starts REPORT-ONLY (deliberate S5 exception) and contains the
 *      required directives incl. frame-ancestors 'none' and the documented
 *      Plaid/TradingView allowances.
 *   3. Clickjacking is ENFORCED via X-Frame-Options: DENY.
 *   4. HSTS present outside development (this process is not "development").
 */

import nextConfig from "../next.config";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const rules = await nextConfig.headers!();
  check("exactly one catch-all header rule", rules.length === 1 && rules[0].source === "/(.*)");

  const headers = new Map(rules[0].headers.map((h) => [h.key, h.value]));

  console.log("1. Required headers present");
  for (const key of [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Content-Security-Policy-Report-Only",
  ]) {
    check(key, headers.has(key));
  }

  console.log("2. Header values");
  check("nosniff", headers.get("X-Content-Type-Options") === "nosniff");
  check("X-Frame-Options DENY (enforced clickjacking guard)", headers.get("X-Frame-Options") === "DENY");
  check(
    "Referrer-Policy strict-origin-when-cross-origin",
    headers.get("Referrer-Policy") === "strict-origin-when-cross-origin",
  );
  check(
    "HSTS max-age >= 180 days with includeSubDomains",
    /max-age=(\d+)/.test(headers.get("Strict-Transport-Security") ?? "") &&
      Number(/max-age=(\d+)/.exec(headers.get("Strict-Transport-Security")!)![1]) >= 15552000 &&
      headers.get("Strict-Transport-Security")!.includes("includeSubDomains"),
    headers.get("Strict-Transport-Security"),
  );

  console.log("3. CSP (report-only start — documented S5 exception)");
  const csp = headers.get("Content-Security-Policy-Report-Only") ?? "";
  check("no enforcing CSP yet (flip is its own commit)", !headers.has("Content-Security-Policy"));
  for (const directive of [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]) {
    check(directive, csp.includes(directive));
  }
  check("Plaid Link allowed (cdn.plaid.com)", csp.includes("https://cdn.plaid.com"));
  check("Plaid API connect allowed (*.plaid.com)", csp.includes("https://*.plaid.com"));
  check("TradingView script allowed (s3.tradingview.com)", csp.includes("https://s3.tradingview.com"));

  console.log(failures === 0 ? "\nAll security-header tests passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
