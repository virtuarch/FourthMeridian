/**
 * lib/marketing/public-site.test.ts  (domain split, Preview rehearsal)
 *
 * The application's half of "/" no longer meaning two things:
 *   §1 parsePublicSiteOrigin accepts only a bare http(s) origin.
 *   §2 routePublicSiteRequest: unset ⇒ inert; "/" ⇒ /dashboard; marketing and
 *      legal pages ⇒ the SAME path + query on the configured site; nothing else
 *      leaves; the destination host never comes from the request; self ⇒ inert.
 *   §3 the REAL proxy.ts with NEXT_PUBLIC_SITE_URL set (Preview topology) and
 *      the matcher lists exactly PUBLIC_SITE_PATHS.
 *
 * Deterministic, no runtime, no DB.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const PREVIEW_SITE = "https://preview.fourthmeridian.com";
const PREVIEW_APP = "https://preview-app.fourthmeridian.com";

// The module reads NEXT_PUBLIC_SITE_URL at import; set it BEFORE any import.
process.env.NEXT_PUBLIC_SITE_URL = PREVIEW_SITE;

async function main() {
  const ps = await import("./public-site");

  console.log("1. parsePublicSiteOrigin");
  check("bare https origin", ps.parsePublicSiteOrigin(PREVIEW_SITE) === PREVIEW_SITE);
  check("trailing slash normalised", ps.parsePublicSiteOrigin(`${PREVIEW_SITE}/`) === PREVIEW_SITE);
  check("unset ⇒ null", ps.parsePublicSiteOrigin(undefined) === null && ps.parsePublicSiteOrigin("  ") === null);
  for (const bad of [`${PREVIEW_SITE}/x`, `${PREVIEW_SITE}?a=1`, `${PREVIEW_SITE}#f`, "https://u:p@site.test", "javascript:alert(1)", "//evil.com", "not a url", "ftp://site.test"]) {
    check(`refused: ${bad}`, ps.parsePublicSiteOrigin(bad) === null);
  }
  check("module constant reads NEXT_PUBLIC_SITE_URL", ps.PUBLIC_SITE_ORIGIN === PREVIEW_SITE);

  console.log("\n2. routePublicSiteRequest");
  const r = (pathname: string, search = "", siteOrigin: string | null = PREVIEW_SITE, selfOrigin: string | null = PREVIEW_APP) =>
    ps.routePublicSiteRequest({ pathname, search, siteOrigin, selfOrigin });
  check("unset ⇒ inert for /", r("/", "", null).kind === "none");
  check("unset ⇒ inert for /terms", r("/terms", "", null).kind === "none");
  check("site origin == self ⇒ inert (no loop)", r("/terms", "", PREVIEW_SITE, PREVIEW_SITE).kind === "none");
  const root = r("/");
  check("/ ⇒ app-root /dashboard", root.kind === "app-root" && root.location === "/dashboard");
  for (const p of ["/about", "/legal", "/legal/ai", "/privacy", "/security", "/terms"]) {
    const v = r(p, "?ref=x");
    check(`${p} ⇒ same path + query on the site`, v.kind === "public-site" && v.location === `${PREVIEW_SITE}${p}?ref=x`);
  }
  for (const p of ["/request-access", "/login", "/register", "/dashboard", "/dashboard/brief", "/admin", "/plaid-oauth-return", "/termsx", "/aboutus", "/api/access-request"]) {
    check(`${p} stays in the application`, r(p).kind === "none");
  }
  // The destination host is fixed: path tricks can only change the PATH.
  const tricky = r("/legal//evil.com", "?x=//evil.com");
  check("path tricks never change the destination host",
    tricky.kind === "public-site" && new URL(tricky.location).origin === PREVIEW_SITE);
  check("publicSiteHref absolute when configured", ps.publicSiteHref("/terms", PREVIEW_SITE) === `${PREVIEW_SITE}/terms`);
  check("publicSiteHref relative when unset", ps.publicSiteHref("/terms", null) === "/terms");
  let threw = false;
  try { ps.publicSiteHref("//evil.com" as `/${string}`, PREVIEW_SITE); } catch { threw = true; }
  check("publicSiteHref refuses protocol-relative", threw);

  console.log("\n3. the real proxy.ts on the Preview topology");
  const { NextRequest } = await import("next/server");
  const { default: proxy } = await import("../../proxy");
  const get = (url: string, host: string) =>
    proxy(new NextRequest(url, { method: "GET", headers: { "x-forwarded-host": host, "x-forwarded-proto": "https" } }));
  const appHost = new URL(PREVIEW_APP).host;

  const home = await get(`${PREVIEW_APP}/`, appHost);
  check("app / ⇒ 307 /dashboard on the APP origin",
    home.status === 307 && new URL(home.headers.get("location") ?? "", PREVIEW_APP).href === `${PREVIEW_APP}/dashboard`,
    `${home.status} ${home.headers.get("location")}`);
  const terms = await get(`${PREVIEW_APP}/terms?v=2`, appHost);
  check("app /terms ⇒ 308 to the public site, query kept",
    terms.status === 308 && terms.headers.get("location") === `${PREVIEW_SITE}/terms?v=2`, `${terms.status} ${terms.headers.get("location")}`);
  const legal = await get(`${PREVIEW_APP}/legal/ai`, appHost);
  check("app /legal/ai ⇒ 308 to the public site", legal.status === 308 && legal.headers.get("location") === `${PREVIEW_SITE}/legal/ai`);
  const hostile = await get(`${PREVIEW_APP}/privacy`, "evil.com");
  check("a forged Host never becomes the destination",
    hostile.status === 308 && hostile.headers.get("location") === `${PREVIEW_SITE}/privacy`);
  const dash = await get(`${PREVIEW_APP}/dashboard/assets?tab=x`, appHost);
  const loc = new URL(dash.headers.get("location") ?? "", PREVIEW_APP);
  check("logged-out deep link still ⇒ /login with callbackUrl on the app origin",
    dash.status === 307 && loc.origin === PREVIEW_APP && loc.pathname === "/login" && loc.searchParams.get("callbackUrl") === "/dashboard/assets?tab=x",
    `${dash.status} ${dash.headers.get("location")}`);

  const src = readFileSync(path.join(ROOT, "proxy.ts"), "utf8");
  const matcher = src.slice(src.indexOf("matcher: ["), src.indexOf("],", src.indexOf("matcher: [")));
  check("matcher includes \"/\"", /["']\/["']/.test(matcher));
  for (const p of ps.PUBLIC_SITE_PATHS) {
    check(`matcher covers ${p}`, matcher.includes(`"${p}"`) || matcher.includes(`"${p}/:path*"`));
  }
  check("public-site routing runs before getToken",
    src.indexOf("routePublicSiteRequest(") > -1 && src.indexOf("routePublicSiteRequest(") < src.indexOf("await getToken("));
}

main()
  .catch((e) => { failures++; console.error("  ✗ threw —", e); })
  .finally(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll public-site checks passed.");
  });
