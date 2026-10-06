/**
 * lib/auth/login-redirect.test.ts — deep links survive authentication.
 *
 * Standalone tsx script (house pattern). No DB, no network.
 *
 *   §1 the REAL proxy.ts: a signed-out page request is sent to
 *      /login?callbackUrl=<path+query>; a signed-in one is passed through with
 *      RETURN_TO_HEADER stamped to the page's own path + query, overwriting any
 *      value the client sent.
 *   §2 what a page does with it: loginUrlFor (the reader's only decision).
 *   §3 the census of bare `redirect("/login")` call sites. Each remaining one
 *      is in a file the RLS tenant-authority workstream owns
 *      (scripts/lib/db-authority-baseline.json, or pinned by
 *      lib/rls-server-component-authority.test.ts) and is DEFERRED, by name,
 *      until that work closes. The set may only shrink: a new bare call site
 *      fails this test.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

process.env.NEXTAUTH_SECRET = "login-redirect-test-secret-not-a-real-secret";
process.env.NEXTAUTH_URL = "https://app.fourthmeridian.com";

import { loginUrlFor, RETURN_TO_HEADER } from "./return-to";
import { sessionCookieName } from "./session-cookie";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();

async function proxyChecks() {
  console.log("\n1. proxy.ts keeps the deep link in both signed-out cases");
  const { encode } = await import("next-auth/jwt");
  const { NextRequest } = await import("next/server");
  const { default: proxy } = await import("../../proxy");
  const jwt = await encode({ token: { id: "u1", role: "USER" }, secret: process.env.NEXTAUTH_SECRET! });
  const url = "https://app.fourthmeridian.com/dashboard/spaces?tab=members&space=s1";

  const out = await proxy(new NextRequest(url));
  const loc = out.headers.get("location");
  check("no JWT ⇒ redirect to /login with the full path + query as callbackUrl",
    !!loc && new URL(loc).pathname === "/login" &&
    new URL(loc).searchParams.get("callbackUrl") === "/dashboard/spaces?tab=members&space=s1", String(loc));

  const inn = await proxy(new NextRequest(url, { headers: { cookie: `${sessionCookieName(true)}=${jwt}` } }));
  const forwarded = inn.headers.get(`x-middleware-request-${RETURN_TO_HEADER}`);
  check("valid JWT ⇒ passed through", inn.headers.get("x-middleware-next") === "1");
  check(`…with ${RETURN_TO_HEADER} = the page's own path + query`,
    forwarded === "/dashboard/spaces?tab=members&space=s1", String(forwarded));
  check("…declared as an overridden request header",
    (inn.headers.get("x-middleware-override-headers") ?? "").split(",").includes(RETURN_TO_HEADER));

  const spoof = await proxy(new NextRequest(url, {
    headers: { cookie: `${sessionCookieName(true)}=${jwt}`, [RETURN_TO_HEADER]: "//evil.com" },
  }));
  check("a client-sent header is OVERWRITTEN, never forwarded",
    spoof.headers.get(`x-middleware-request-${RETURN_TO_HEADER}`) === "/dashboard/spaces?tab=members&space=s1");
}

function readerChecks() {
  console.log("\n2. the page-side reader validates again");
  check("carried path ⇒ /login?callbackUrl=<encoded>",
    loginUrlFor("/dashboard/spaces?tab=members") === "/login?callbackUrl=%2Fdashboard%2Fspaces%3Ftab%3Dmembers");
  check("absent header ⇒ bare /login", loginUrlFor(null) === "/login");
  check("unsafe header ⇒ bare /login (never forwarded)", loginUrlFor("//evil.com") === "/login");
  const src = readFileSync(path.join(ROOT, "lib/auth/login-redirect.ts"), "utf8");
  check("redirectToLogin reads RETURN_TO_HEADER and routes it through loginUrlFor",
    src.includes("get(RETURN_TO_HEADER)") && src.includes("redirect(loginUrlFor("));
}

function census() {
  console.log("\n3. bare redirect(\"/login\") call sites — none may exist");
  // The seven STAGE-A5 deferrals (RLS-owned files at the time) were converted
  // to `return redirectToLogin()` in the domain-split Preview lane. A revoked
  // session on any page now returns to that page after signing in again.
  const DEFERRED: Record<string, number> = {};
  const found: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) {
        const n = (readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1").match(/redirect\(\s*["'`]\/login["'`]\s*\)/g) ?? []).length;
        if (n > 0) found[path.relative(ROOT, p)] = n;
      }
    }
  };
  for (const d of ["app", "lib", "components"]) walk(path.join(ROOT, d));
  for (const [f, n] of Object.entries(found)) {
    check(`${f}: ${n} bare site(s) is within its deferred allowance`, (DEFERRED[f] ?? 0) >= n,
      `allowance ${DEFERRED[f] ?? 0} — use \`return redirectToLogin()\` (lib/auth/login-redirect.ts)`);
  }
  const total = Object.values(found).reduce((a, b) => a + b, 0);
  check(`bare sites: ${total} (7 at STAGE-A5, 0 since the domain-split Preview lane)`, total === 0);
  for (const f of [
    "app/(shell)/dashboard/settings/page.tsx",
    "app/admin/security/page.tsx",
    "app/(shell)/dashboard/spaces/page.tsx",
    "app/(shell)/dashboard/platform/[area]/page.tsx",
    "app/(shell)/dashboard/settings/archived-assets/page.tsx",
    "lib/settings/loaders.ts",
  ]) {
    const s = readFileSync(path.join(ROOT, f), "utf8");
    check(`${f} uses redirectToLogin`, /return redirectToLogin\(\)/.test(s) && !found[f]);
  }

}

proxyChecks()
  .then(readerChecks)
  .then(census)
  .catch((e) => { failures++; console.error("  ✗ threw —", e); })
  .finally(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll login-redirect checks passed.");
  });
