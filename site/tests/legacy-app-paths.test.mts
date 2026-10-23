/**
 * Application paths that used to be served on the public host are forwarded to
 * the application origin by the not-found page — and nothing else is. The inline
 * script is executed here against fake locations, so the test exercises the
 * exact bytes the page ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import { readFileSync } from "node:fs";
import { LEGACY_APP_PREFIXES, legacyAppForwardScript } from "../lib/legacy-app-paths.ts";
import { SITE_ROOT } from "./_source.mts";

const APP = "https://preview-app.fourthmeridian.com";

function run(script: string, href: string): string | null {
  const url = new URL(href);
  let replaced: string | null = null;
  const location = {
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    replace: (to: string) => { replaced = to; },
  };
  vm.runInNewContext(script, { window: { location } });
  return replaced;
}

const SITE = "https://preview.fourthmeridian.com";
const script = legacyAppForwardScript(APP);

test("legacy application paths forward with path, query and fragment", () => {
  const cases: [string, string][] = [
    ["/login", "/login"],
    ["/login?callbackUrl=%2Fdashboard%2Fassets", "/login?callbackUrl=%2Fdashboard%2Fassets"],
    ["/reset-password?token=abc", "/reset-password?token=abc"],
    ["/verify-email?token=t", "/verify-email?token=t"],
    ["/confirm-email-change?token=t", "/confirm-email-change?token=t"],
    ["/register?invite=i", "/register?invite=i"],
    ["/dashboard", "/dashboard"],
    ["/dashboard/assets?tab=x#h", "/dashboard/assets?tab=x#h"],
    ["/admin/security", "/admin/security"],
    ["/plaid-oauth-return?oauth_state_id=s", "/plaid-oauth-return?oauth_state_id=s"],
    ["/merchant-ops", "/merchant-ops"],
  ];
  for (const [from, to] of cases) assert.equal(run(script, SITE + from), APP + to, from);
});

test("everything else stays an ordinary 404", () => {
  for (const p of ["/", "/nope", "/loginx", "/dashboards", "/api/accounts", "/api/auth/session", "/request-access/x", "/x/login", "/LOGIN"]) {
    assert.equal(run(script, SITE + p), null, p);
  }
});

test("the destination origin can never come from the request", () => {
  for (const p of ["//evil.com/login", "/%2F%2Fevil.com", "/login//evil.com", "/login/..%2F..%2Fx", "/dashboard/@evil.com"]) {
    const to = run(script, SITE + p);
    if (to !== null) assert.equal(new URL(to).origin, APP, p);
  }
  assert.equal(run(script, `${SITE}//evil.com/login`), null);
});

test("the embedded origin is a JSON string literal that cannot break out of <script>", () => {
  const s = legacyAppForwardScript("https://a.test</script><script>alert(1)//");
  assert.ok(!s.includes("</script>"));
});

test("prefixes cover every application entry the public site's own pages link to", () => {
  // APP_LINKS paths (signIn /login, open /dashboard) must be forwardable if typed on this host.
  for (const p of ["login", "dashboard"]) assert.ok(LEGACY_APP_PREFIXES.includes(p), p);
  // request-access is a REAL page on this site and must not be forwarded.
  assert.ok(!LEGACY_APP_PREFIXES.includes("request-access"));
});

test("the not-found page ships the forwarder with the build's app origin", () => {
  const src = readFileSync(path.join(SITE_ROOT, "app", "not-found.tsx"), "utf8");
  assert.match(src, /legacyAppForwardScript\(PUBLIC_CONFIG\.appOrigin\)/);
});
