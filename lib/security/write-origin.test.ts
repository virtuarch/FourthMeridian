/**
 * lib/security/write-origin.test.ts — adversarial pins for the browser-write
 * Origin boundary (lib/security/write-origin.ts) and its wiring in proxy.ts.
 *
 * Standalone tsx script (house pattern). No DB, no network.
 *
 * §1 the verdict matrix across the four stable hosts, both environments.
 * §2 route-class behaviour: machine paths, cron, auth, public writes.
 * §3 selfOriginOf — the host the browser addressed, not the server's bind name.
 * §4 the REAL proxy.ts on NextRequests: refused writes never reach a handler
 *    (403 with the distinct error), allowed ones pass through untouched.
 * §5 route-classification census: every mutating /api handler is either
 *    browser-facing (judged) or an enumerated machine path, so a new webhook
 *    cannot be broken — or exempted — silently.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

process.env.NEXTAUTH_SECRET = "write-origin-test-secret-not-a-real-secret";
process.env.NEXTAUTH_URL = "https://app.fourthmeridian.com";

import {
  evaluateWriteOrigin,
  selfOriginOf,
  MACHINE_WRITE_PATHS,
  WRITE_ORIGIN_REFUSED_ERROR,
} from "./write-origin";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const PROD_SITE    = "https://fourthmeridian.com";
const PROD_APP     = "https://app.fourthmeridian.com";
const PREVIEW_SITE = "https://preview.fourthmeridian.com";
const PREVIEW_APP  = "https://preview-app.fourthmeridian.com";
const EPHEMERAL    = "https://fourth-meridian-git-feature-x.vercel.app";

const write = (selfOrigin: string | null, origin: string | null, extra: Partial<{ method: string; pathname: string; secFetchSite: string | null }> = {}) =>
  evaluateWriteOrigin({
    method: extra.method ?? "POST",
    pathname: extra.pathname ?? "/api/accounts/acc_1",
    selfOrigin,
    origin,
    secFetchSite: extra.secFetchSite ?? null,
  });

// ── 1. The matrix ──────────────────────────────────────────────────────────────
console.log("\n1. a write is accepted ONLY from the deployment's own origin");
const ALL = [PROD_SITE, PROD_APP, PREVIEW_SITE, PREVIEW_APP, EPHEMERAL, "https://evil.com", "http://app.fourthmeridian.com"];
for (const self of [PROD_APP, PREVIEW_APP, EPHEMERAL, PROD_SITE /* today's Production app host */]) {
  for (const from of ALL) {
    const v = write(self, from);
    const expected = from === self;
    check(`app on ${self} ${expected ? "ACCEPTS" : "refuses"} a write from ${from}`, v.allowed === expected, JSON.stringify(v));
  }
}
check("Origin: null is refused", !write(PROD_APP, "null").allowed);
check("Origin: NULL (case) is refused", !write(PROD_APP, "NULL").allowed);
check("malformed Origin is refused", !write(PROD_APP, "not a url").allowed);
check("javascript: Origin is refused", !write(PROD_APP, "javascript:alert(1)").allowed);
check("Origin with a different port is refused", !write("https://app.fourthmeridian.com", "https://app.fourthmeridian.com:8443").allowed);
check("Origin matching case-insensitively is accepted", write(PROD_APP, "https://APP.fourthmeridian.com").allowed);
check("lookalike suffix host is refused", !write(PROD_APP, "https://app.fourthmeridian.com.evil.com").allowed);
check("unknown self origin + any Origin ⇒ refused (fail closed)", !write(null, PROD_APP).allowed);
check("refusal reason is origin-mismatch for a sibling", (() => { const v = write(PROD_APP, PROD_SITE); return !v.allowed && v.reason === "origin-mismatch"; })());

console.log("\n1b. Origin absent: Sec-Fetch-Site decides; neither ⇒ not a browser");
check("Sec-Fetch-Site: same-origin ⇒ accepted", write(PROD_APP, null, { secFetchSite: "same-origin" }).allowed);
check("Sec-Fetch-Site: same-site (a sibling host) ⇒ refused", !write(PROD_APP, null, { secFetchSite: "same-site" }).allowed);
check("Sec-Fetch-Site: cross-site ⇒ refused", !write(PROD_APP, null, { secFetchSite: "cross-site" }).allowed);
check("Sec-Fetch-Site: none ⇒ refused (no browser writes from the address bar)", !write(PROD_APP, null, { secFetchSite: "none" }).allowed);
check("no Origin, no Sec-Fetch-Site ⇒ allowed as non-browser", (() => { const v = write(PROD_APP, null); return v.allowed && v.basis === "non-browser"; })());
check("Origin present wins over a lying Sec-Fetch-Site", !write(PROD_APP, PROD_SITE, { secFetchSite: "same-origin" }).allowed);

// ── 2. Route classes ──────────────────────────────────────────────────────────
console.log("\n2. route classes");
for (const m of ["GET", "HEAD", "OPTIONS", "get"]) {
  check(`${m} is not judged (safe method)`, write(PROD_APP, "https://evil.com", { method: m }).allowed);
}
for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
  check(`${m} from a sibling is refused`, !write(PROD_APP, PROD_SITE, { method: m }).allowed);
}
check("Plaid webhook POST with no Origin passes (signature-authenticated)", write(PROD_APP, null, { pathname: "/api/plaid/webhook" }).allowed);
check("Plaid webhook POST with a foreign Origin still passes (not a browser authority)",
  write(PROD_APP, "https://evil.com", { pathname: "/api/plaid/webhook" }).allowed);
check("the machine exemption is EXACT — a sibling path is judged",
  !write(PROD_APP, PROD_SITE, { pathname: "/api/plaid/webhook-x" }).allowed &&
  !write(PROD_APP, PROD_SITE, { pathname: "/api/plaid/webhook/x" }).allowed &&
  !write(PROD_APP, PROD_SITE, { pathname: "/api/plaid/link-token" }).allowed);
check("MACHINE_WRITE_PATHS is exactly the Plaid webhook", MACHINE_WRITE_PATHS.length === 1 && MACHINE_WRITE_PATHS[0] === "/api/plaid/webhook");
check("cron (GET + Bearer) is outside the check", write(PROD_APP, null, { method: "GET", pathname: "/api/jobs/dispatch" }).allowed);
check("NextAuth credential POST from a sibling is refused (login CSRF)", !write(PROD_APP, PREVIEW_SITE, { pathname: "/api/auth/callback/credentials" }).allowed);
check("NextAuth credential POST from itself is accepted", write(PROD_APP, PROD_APP, { pathname: "/api/auth/callback/credentials" }).allowed);
check("public write (access-request) from the same origin is accepted", write(PROD_SITE, PROD_SITE, { pathname: "/api/access-request" }).allowed);
check("public write (access-request) cross-origin is refused until cutover adds an explicit CORS rule",
  !write(PROD_APP, PROD_SITE, { pathname: "/api/access-request" }).allowed);

// ── 3. selfOriginOf ───────────────────────────────────────────────────────────
console.log("\n3. the self origin is the host the browser addressed");
const H = (o: Record<string, string>) => new Headers(o);
check("x-forwarded-host + proto (Vercel)", selfOriginOf(H({ "x-forwarded-host": "app.fourthmeridian.com", "x-forwarded-proto": "https", host: "internal.vercel" }), "http:") === PROD_APP);
check("host header + fallback protocol (next dev)", selfOriginOf(H({ host: "localhost:3000" }), "http:") === "http://localhost:3000");
check("127.0.0.1 is its own origin (not the bind hostname)", selfOriginOf(H({ host: "127.0.0.1:3000" }), "http:") === "http://127.0.0.1:3000");
check("first entry of a comma-joined forwarded header wins", selfOriginOf(H({ "x-forwarded-host": "app.fourthmeridian.com, evil.com", "x-forwarded-proto": "https,http" }), "http:") === PROD_APP);
check("no host ⇒ null", selfOriginOf(H({}), "https:") === null);
check("non-http(s) proto ⇒ null", selfOriginOf(H({ host: "a", "x-forwarded-proto": "ftp" }), "https:") === null);

// ── 4. The real proxy ─────────────────────────────────────────────────────────
async function proxyChecks() {
  console.log("\n4. proxy.ts enforces it before any handler runs");
  const { NextRequest } = await import("next/server");
  const { default: proxy } = await import("../../proxy");
  const req = (url: string, method: string, headers: Record<string, string>) =>
    new NextRequest(url, { method, headers, body: method === "GET" ? undefined : "{}" });
  const vercel = (host: string) => ({ "x-forwarded-host": host, "x-forwarded-proto": "https" });

  const refused = await proxy(req(`${PROD_APP}/api/accounts/acc_1`, "PATCH", { ...vercel("app.fourthmeridian.com"), origin: PROD_SITE }));
  check("apex/public origin → Production app write: 403", refused.status === 403, `status ${refused.status}`);
  const body = await refused.json();
  check("…with the distinct cross_origin_write_refused error", body.error === WRITE_ORIGIN_REFUSED_ERROR);
  check("…and no redirect", refused.headers.get("location") === null);

  const prevToProd = await proxy(req(`${PROD_APP}/api/spaces/s1/members/u1`, "DELETE", { ...vercel("app.fourthmeridian.com"), origin: PREVIEW_APP }));
  check("Preview app origin → Production write: 403", prevToProd.status === 403);
  const prodToPrev = await proxy(req(`${PREVIEW_APP}/api/spaces/s1/members/u1`, "DELETE", { ...vercel("preview-app.fourthmeridian.com"), origin: PROD_APP }));
  check("Production app origin → Preview write: 403", prodToPrev.status === 403);
  const evil = await proxy(req(`${PROD_APP}/api/user/profile`, "POST", { ...vercel("app.fourthmeridian.com"), origin: "https://evil.com" }));
  check("unrelated external origin → 403", evil.status === 403);

  const own = await proxy(req(`${PROD_APP}/api/accounts/acc_1`, "PATCH", { ...vercel("app.fourthmeridian.com"), origin: PROD_APP }));
  check("own origin → passes through (no status override, no redirect)", own.status === 200 && own.headers.get("location") === null && own.headers.get("x-middleware-next") === "1",
    `status ${own.status} next=${own.headers.get("x-middleware-next")}`);
  const ownPrev = await proxy(req(`${PREVIEW_APP}/api/accounts/acc_1`, "PATCH", { ...vercel("preview-app.fourthmeridian.com"), origin: PREVIEW_APP }));
  check("Preview's own origin → passes through on Preview", ownPrev.headers.get("x-middleware-next") === "1");

  const plaid = await proxy(req(`${PROD_APP}/api/plaid/webhook`, "POST", { ...vercel("app.fourthmeridian.com"), "plaid-verification": "jwt" }));
  check("Plaid webhook (no Origin) passes through", plaid.headers.get("x-middleware-next") === "1");
  const cron = await proxy(req(`${PROD_APP}/api/jobs/dispatch`, "GET", { ...vercel("app.fourthmeridian.com"), authorization: "Bearer x" }));
  check("cron GET passes through", cron.headers.get("x-middleware-next") === "1");
  const script = await proxy(req("http://localhost:3000/api/brief/generate", "POST", { host: "localhost:3000" }));
  check("server-side script POST (no Origin, no Sec-Fetch-*) passes through", script.headers.get("x-middleware-next") === "1");
  const crossGet = await proxy(req(`${PROD_APP}/api/accounts`, "GET", { ...vercel("app.fourthmeridian.com"), origin: PROD_SITE }));
  check("cross-origin GET is not judged here (no token read, no redirect)", crossGet.headers.get("x-middleware-next") === "1");
}

// ── 5. Census ─────────────────────────────────────────────────────────────────
function census() {
  console.log("\n5. every mutating /api handler is classified");
  const ROOT = process.cwd();
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === "route.ts") routes.push(p);
    }
  };
  walk(path.join(ROOT, "app/api"));
  const mutating = routes.filter((p) => /export\s+(async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b/.test(readFileSync(p, "utf8")));
  const toPath = (p: string) => "/" + path.relative(path.join(ROOT, "app"), path.dirname(p)).split(path.sep).join("/");
  const mutatingPaths = mutating.map(toPath);
  check(`census found the mutating handlers (${mutatingPaths.length})`, mutatingPaths.length >= 50, String(mutatingPaths.length));
  // A machine route is one that authenticates by a provider signature rather
  // than the browser session. If a new one appears it MUST be enumerated.
  const machineLike = mutating.filter((p) => /plaid-verification|svix-signature|stripe-signature|x-hub-signature|x-signature|verifyWebhook/i.test(readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  const machinePaths = machineLike.map(toPath).sort();
  check("the only signature-authenticated mutating route is the Plaid webhook",
    JSON.stringify(machinePaths) === JSON.stringify(["/api/plaid/webhook"]), JSON.stringify(machinePaths));
  for (const m of MACHINE_WRITE_PATHS) {
    check(`exempt path ${m} exists as a mutating route`, mutatingPaths.includes(m));
  }
  const cronDirs = routes.filter((p) => toPath(p).startsWith("/api/jobs/"));
  check("every /api/jobs/* cron route is GET-only (outside the check)",
    cronDirs.length > 0 && cronDirs.every((p) => !/export\s+(async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b/.test(readFileSync(p, "utf8"))));
  const proxySrc = readFileSync(path.join(ROOT, "proxy.ts"), "utf8");
  check("proxy matcher includes /api/:path*", /["']\/api\/:path\*["']/.test(proxySrc));
  check("proxy's /api branch returns before getToken is called",
    proxySrc.indexOf('startsWith("/api/")') > -1 && proxySrc.indexOf('startsWith("/api/")') < proxySrc.indexOf("await getToken("));
}

proxyChecks()
  .then(census)
  .catch((e) => { failures++; console.error("  ✗ threw —", e); })
  .finally(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll write-origin checks passed.");
  });
