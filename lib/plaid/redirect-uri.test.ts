/**
 * lib/plaid/redirect-uri.test.ts  (V26-PLAID-REDIRECT-1)
 *
 * Pins the precedence and guard rules of the Plaid redirect-URI authority.
 *
 * THE REGRESSION THIS EXISTS FOR: `redirect_uri` was a hand-maintained env copy
 * of the deployment's own origin. Vercel's PLAID_REDIRECT_URI still held an old
 * Vercel deployment URL; when that URL was removed from Plaid's allowed-redirect
 * list, EVERY /link/token/create failed with 400 INVALID_FIELD in BOTH production
 * and preview — breaking new links AND the reconnect path an ITEM_LOGIN_REQUIRED
 * item needs to recover. Deriving from NEXT_PUBLIC_APP_URL removes the copy.
 *
 * Only the PURE core is exercised, so no env juggling is needed.
 */

import { buildPlaidRedirectUri, PLAID_OAUTH_RETURN_PATH } from "@/lib/plaid/redirect-uri";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const PROD    = "https://fourthmeridian.com";
const PREVIEW = "https://preview.fourthmeridian.com";
const PROD_URI    = `${PROD}${PLAID_OAUTH_RETURN_PATH}`;
const PREVIEW_URI = `${PREVIEW}${PLAID_OAUTH_RETURN_PATH}`;

console.log("1. Derives each environment's own registered return URL");
{
  const p = buildPlaidRedirectUri({ appUrl: PROD });
  check("production → the registered production URI", p.uri === PROD_URI, String(p.uri));
  check("source is derived", p.source === "derived", p.source);
  check("no drift", p.drift === undefined);

  const v = buildPlaidRedirectUri({ appUrl: PREVIEW });
  check("preview → the registered preview URI", v.uri === PREVIEW_URI, String(v.uri));
  check("preview and production differ", v.uri !== p.uri);
}

console.log("2. A trailing slash on the base URL does not double up");
{
  const r = buildPlaidRedirectUri({ appUrl: `${PROD}/` });
  check("no '//plaid-oauth-return'", r.uri === PROD_URI, String(r.uri));
}

console.log("3. Non-public origins yield undefined (caller omits the field)");
{
  for (const [label, appUrl] of [
    ["localhost",  "http://localhost:3000"],
    ["127.0.0.1",  "http://127.0.0.1:3000"],
    ["https loopback", "https://localhost:3000"],
    ["plain http", "http://fourthmeridian.com"],
  ] as const) {
    const r = buildPlaidRedirectUri({ appUrl });
    check(`${label} → undefined`, r.uri === undefined, String(r.uri));
    check(`${label} → source none`, r.source === "none", r.source);
  }
}

console.log("4. Nothing configured at all → undefined, never a fabricated URL");
{
  const r = buildPlaidRedirectUri({});
  check("undefined", r.uri === undefined, String(r.uri));
  check("source none", r.source === "none", r.source);
}

console.log("5. An explicit local tunnel override wins (the supported dev case)");
{
  const NGROK = "https://abc123.ngrok.io/plaid-oauth-return";
  const r = buildPlaidRedirectUri({ explicit: NGROK, appUrl: "http://localhost:3000" });
  check("tunnel URL used", r.uri === NGROK, String(r.uri));
  check("source explicit", r.source === "explicit", r.source);
  check("no drift (no usable origin to disagree with)", r.drift === undefined, r.drift);
}

console.log("6. Whitespace around an override is trimmed, not sent");
{
  const r = buildPlaidRedirectUri({ explicit: `  ${PROD_URI}  `, appUrl: PROD });
  check("trimmed", r.uri === PROD_URI, JSON.stringify(r.uri));
  check("agrees with derived ⇒ no drift", r.drift === undefined, r.drift);
}

console.log("7. THE INCIDENT: a stale override that disagrees is reported LOUDLY");
{
  const STALE = "https://fintracker1-abc123-virtuarchs-projects.vercel.app/plaid-oauth-return";
  const r = buildPlaidRedirectUri({ explicit: STALE, appUrl: PROD });
  check("override still wins (precedence stays predictable)", r.uri === STALE, String(r.uri));
  check("drift IS reported", typeof r.drift === "string" && r.drift.length > 0);
  check("drift names the offending value", (r.drift ?? "").includes(STALE));
  check("drift names the deployment's own URL", (r.drift ?? "").includes(PROD_URI));
  check("drift says to unset it on deployments", /unset it on deployments/i.test(r.drift ?? ""));
}

console.log("8. An unusable override is ignored and the derived value is used");
{
  // A stale localhost override on a real deployment must not silently disable
  // OAuth — the deployment's own origin is still correct and must win.
  const r = buildPlaidRedirectUri({ explicit: "http://localhost:3000/plaid-oauth-return", appUrl: PROD });
  check("falls back to derived", r.uri === PROD_URI, String(r.uri));
  check("source derived", r.source === "derived", r.source);
}

console.log("9. Empty-string override behaves as unset (Vercel-style blank)");
{
  const r = buildPlaidRedirectUri({ explicit: "   ", appUrl: PREVIEW });
  check("derived wins", r.uri === PREVIEW_URI, String(r.uri));
  check("source derived", r.source === "derived", r.source);
}

console.log(failures === 0
  ? "\n✅ redirect-uri: all checks passed"
  : `\n❌ redirect-uri: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
