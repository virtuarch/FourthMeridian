/**
 * scripts/post-deploy-smoke.test.ts
 *
 * Pins the post-deploy smoke verdict (scripts/post-deploy-smoke.mjs). The
 * regression this exists for: on PR #1 (1e697a6) the check went GREEN after
 * three HTTP 401s from Vercel Deployment Protection — the application was
 * never reached. Fixtures below are the real response shapes captured from
 * fintracker1 preview deployments on 2026-10-22 (nonces shortened).
 *
 * Hermetic: imports a pure function, spawns nothing, no network.
 *
 * Run: npx tsx scripts/post-deploy-smoke.test.ts
 */

import { classifyProbe, isVercelProtection, mayCarryBypass, targetFor, VERDICT } from "./post-deploy-smoke.mjs";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const SHA = "1e697a6c2900ecd54c8d2800da41cb244a5c25a1";
const SSO_302 = {
  status: 302,
  headers: { location: "https://vercel.com/sso-api?url=https%3A%2F%2Ffintracker1-alrkntl0t-virtuarchs-projects.vercel.app%2Fapi%2Fhealth&nonce=fbdf", "set-cookie": "_vercel_sso_nonce=6524; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax", server: "Vercel" },
  body: "Protected by Vercel Authentication\nTo access this deployment with an authenticated Vercel CLI, run: vercel curl <deployment-url>",
};
const SSO_401 = { status: 401, headers: { "set-cookie": "_vercel_sso_nonce=d954; Path=/", server: "Vercel" }, body: "Protected by Vercel Authentication" };
const health = (o: object) => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

console.log("Vercel Deployment Protection is UNVERIFIED — never a pass (the PR #1 regression)");
{
  const r401 = classifyProbe({ kind: "app", ...SSO_401, deployedSha: SHA });
  check("401 with Vercel's SSO markers ⇒ UNVERIFIED", r401.verdict === VERDICT.UNVERIFIED, JSON.stringify(r401));
  check("…and the verdict is not HEALTHY", r401.verdict !== VERDICT.HEALTHY);
  const r302 = classifyProbe({ kind: "app", ...SSO_302, deployedSha: SHA });
  check("302 to vercel.com/sso-api ⇒ UNVERIFIED", r302.verdict === VERDICT.UNVERIFIED, JSON.stringify(r302));
  check("the reason says the application was not reached", /not reached/.test(r401.reason) && /not reached/.test(r302.reason));
  check("the site behind protection is UNVERIFIED too", classifyProbe({ kind: "site", ...SSO_401 }).verdict === VERDICT.UNVERIFIED);
}

console.log("a 401/30x WITHOUT Vercel's markers is the app (or something else) failing ⇒ UNHEALTHY");
{
  check("bare 401", classifyProbe({ kind: "app", status: 401, headers: {}, body: "" }).verdict === VERDICT.UNHEALTHY);
  check("302 to the app's own /login", classifyProbe({ kind: "app", status: 302, headers: { location: "https://preview-app.fourthmeridian.com/login" }, body: "" }).verdict === VERDICT.UNHEALTHY);
  check("302 to a look-alike host is not protection", !isVercelProtection({ status: 302, headers: { location: "https://vercel.com.evil.test/sso-api?x" } }));
  check("403 with no markers", classifyProbe({ kind: "app", status: 403, headers: {}, body: "Forbidden" }).verdict === VERDICT.UNHEALTHY);
  check("network failure (status 0)", classifyProbe({ kind: "app", status: 0, headers: {}, body: "fetch failed" }).verdict === VERDICT.UNHEALTHY);
  check("500", classifyProbe({ kind: "app", status: 500, headers: {}, body: "" }).verdict === VERDICT.UNHEALTHY);
  check("404 (the site's missing /api/health, the old probe's false alarm)", classifyProbe({ kind: "app", status: 404, headers: {}, body: "" }).verdict === VERDICT.UNHEALTHY);
}

console.log("the app is HEALTHY only when /api/health says so and the commit matches");
{
  const ok = classifyProbe({ kind: "app", ...health({ status: "ok", db: "ok", commit: "1e697a6" }), deployedSha: SHA });
  check("status ok + commit prefix ⇒ HEALTHY", ok.verdict === VERDICT.HEALTHY, JSON.stringify(ok));
  check("degraded db ⇒ UNHEALTHY", classifyProbe({ kind: "app", ...health({ status: "degraded", db: "error", commit: "1e697a6" }), deployedSha: SHA }).verdict === VERDICT.UNHEALTHY);
  check("commit mismatch ⇒ UNHEALTHY (alias serving another build)", classifyProbe({ kind: "app", ...health({ status: "ok", db: "ok", commit: "cde8fa0" }), deployedSha: SHA }).verdict === VERDICT.UNHEALTHY);
  // The current route (OPS-014) publishes no commit at all.
  const current = { status: "ok", db: "ok", scheduler: { overdueJobs: 0 }, time: "2026-10-22T13:40:00.000Z" };
  const onDeployment = classifyProbe({ kind: "app", ...health(current), deployedSha: SHA, url: "https://fintracker1-alrkntl0t-virtuarchs-projects.vercel.app/api/health" });
  check("no commit on the per-deployment URL ⇒ HEALTHY, identity by immutable URL",
    onDeployment.verdict === VERDICT.HEALTHY && /immutable per-deployment URL/.test(onDeployment.reason), onDeployment.reason);
  const onAlias = classifyProbe({ kind: "app", ...health(current), deployedSha: SHA, url: "https://preview-app.fourthmeridian.com/api/health" });
  check("no commit on an alias host ⇒ HEALTHY but says identity NOT verified",
    onAlias.verdict === VERDICT.HEALTHY && /NOT verified/.test(onAlias.reason), onAlias.reason);
  check("200 HTML (an SSO page served 200, or a wrong route) ⇒ UNHEALTHY",
    classifyProbe({ kind: "app", status: 200, headers: { "content-type": "text/html" }, body: "<html>login</html>", deployedSha: SHA }).verdict === VERDICT.UNHEALTHY);
  check("200 JSON non-object ⇒ UNHEALTHY", classifyProbe({ kind: "app", status: 200, headers: {}, body: "null", deployedSha: SHA }).verdict === VERDICT.UNHEALTHY);
}

console.log("the public site is probed at / (it has no API by design)");
{
  check("fourth-meridian-site ⇒ site target at /", targetFor("Preview – fourth-meridian-site").kind === "site" && targetFor("Production – fourth-meridian-site").path === "/");
  check("fintracker1 ⇒ app target at /api/health", targetFor("Preview – fintracker1").path === "/api/health" && targetFor("Production").kind === "app");
  check("site 200 text/html ⇒ HEALTHY", classifyProbe({ kind: "site", status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: "<html/>" }).verdict === VERDICT.HEALTHY);
  check("site 200 non-HTML ⇒ UNHEALTHY", classifyProbe({ kind: "site", status: 200, headers: { "content-type": "application/json" }, body: "{}" }).verdict === VERDICT.UNHEALTHY);
}

console.log("the bypass secret is only ever sent to our own hosts over https");
{
  check("*.vercel.app", mayCarryBypass("https://fintracker1-alrkntl0t-virtuarchs-projects.vercel.app/api/health"));
  check("preview-app.fourthmeridian.com", mayCarryBypass("https://preview-app.fourthmeridian.com/api/health"));
  check("not http", !mayCarryBypass("http://x.vercel.app/"));
  check("not a look-alike", !mayCarryBypass("https://fourthmeridian.com.evil.test/") && !mayCarryBypass("https://evilvercel.app/"));
  check("not garbage", !mayCarryBypass("not a url"));
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
