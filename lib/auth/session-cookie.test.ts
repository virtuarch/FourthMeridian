/**
 * lib/auth/session-cookie.test.ts — mechanical pins for the host-only
 * `__Host-` session cookie (lib/auth/session-cookie.ts).
 *
 * Standalone tsx script (house pattern). No DB, no network.
 *
 * What is mechanical here, and what is a model:
 *   §2 drives NextAuth's OWN cookie path — its defaultCookies merged with our
 *      overrides exactly as next-auth/core/init.js merges them, chunked by its
 *      own SessionStore, serialised by the `cookie` module NextAuth uses — and
 *      parses the resulting Set-Cookie header. That is the header the browser
 *      receives.
 *   §3 is a MODEL of the browser's acceptance and sending rules (RFC 6265bis
 *      §4.1.3 cookie prefixes + §5.1.3 domain matching). It is not a browser;
 *      it states the rules the design relies on and applies them to the real
 *      headers from §2 across the four stable hosts.
 *   §4 runs the real proxy.ts against NextRequests carrying real JWTs encoded
 *      by next-auth/jwt, proving the reader and the writer agree on the name
 *      and that the legacy cookie is expired on sight.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

// Environment must be set before proxy.ts / session-cookie decide anything.
process.env.NEXTAUTH_SECRET = "session-cookie-test-secret-not-a-real-secret";
process.env.NEXTAUTH_URL = "https://app.fourthmeridian.com";

import {
  authCookiesSecure,
  sessionCookieName,
  callbackUrlCookieName,
  authCookieOverrides,
  isLegacyAuthCookie,
} from "./session-cookie";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const nextAuthRequire = createRequire(require.resolve("next-auth"));
const { defaultCookies, SessionStore } = nextAuthRequire("./core/lib/cookie.js");
const { serialize } = nextAuthRequire("cookie") as { serialize: (n: string, v: string, o: object) => string };

interface ParsedSetCookie {
  name: string;
  attrs: Map<string, string | true>;
}
function parseSetCookie(header: string): ParsedSetCookie {
  const [pair, ...rest] = header.split(";").map((s) => s.trim());
  const name = pair.slice(0, pair.indexOf("="));
  const attrs = new Map<string, string | true>();
  for (const a of rest) {
    const i = a.indexOf("=");
    if (i === -1) attrs.set(a.toLowerCase(), true);
    else attrs.set(a.slice(0, i).toLowerCase(), a.slice(i + 1));
  }
  return { name, attrs };
}

/** Headers NextAuth would emit for a session token, for a given Secure decision. */
function nextAuthSessionHeaders(secure: boolean, value: string): string[] {
  // next-auth/core/init.js: cookies = { ...defaultCookies(useSecure), ...authOptions.cookies }
  const merged = { ...defaultCookies(secure), ...authCookieOverrides(secure) };
  const store = new SessionStore(merged.sessionToken, { cookies: {} }, { debug() {} });
  const chunks: Array<{ name: string; value: string; options: object }> =
    store.chunk(value, { expires: new Date(Date.now() + 86_400_000) });
  return chunks.map((c) => serialize(c.name, c.value, c.options));
}

// ── 1. The decision and the names ─────────────────────────────────────────────
console.log("\n1. Secure decision and cookie names");
check("https NEXTAUTH_URL ⇒ secure", authCookiesSecure({ NEXTAUTH_URL: "https://app.fourthmeridian.com" } as NodeJS.ProcessEnv));
check("http NEXTAUTH_URL ⇒ not secure (local dev)", !authCookiesSecure({ NEXTAUTH_URL: "http://localhost:3000" } as NodeJS.ProcessEnv));
check("no NEXTAUTH_URL on Vercel ⇒ secure", authCookiesSecure({ VERCEL: "1" } as NodeJS.ProcessEnv));
check("no NEXTAUTH_URL off Vercel ⇒ not secure", !authCookiesSecure({} as NodeJS.ProcessEnv));
check("secure session cookie is __Host-next-auth.session-token", sessionCookieName(true) === "__Host-next-auth.session-token");
check("secure callback cookie is __Host-next-auth.callback-url", callbackUrlCookieName(true) === "__Host-next-auth.callback-url");
check("insecure (http dev) names are unprefixed, as NextAuth's own",
  sessionCookieName(false) === defaultCookies(false).sessionToken.name &&
  callbackUrlCookieName(false) === defaultCookies(false).callbackUrl.name);
check("NextAuth's DEFAULT secure name was __Secure- (the thing being replaced)",
  defaultCookies(true).sessionToken.name === "__Secure-next-auth.session-token");
for (const secure of [true, false]) {
  for (const [k, c] of Object.entries(authCookieOverrides(secure))) {
    const o = c.options as unknown as Record<string, unknown>;
    check(`${k} (secure=${secure}): httpOnly, SameSite=Lax, Path=/, Secure=${secure}, NO domain key`,
      o.httpOnly === true && o.sameSite === "lax" && o.path === "/" && o.secure === secure && !("domain" in o));
  }
}

// ── 2. The real Set-Cookie header NextAuth emits ──────────────────────────────
console.log("\n2. NextAuth's own write path emits a valid __Host- cookie");
const small = nextAuthSessionHeaders(true, "x".repeat(800));
const large = nextAuthSessionHeaders(true, "y".repeat(9000)); // forces chunking
check("small JWT ⇒ one cookie", small.length === 1);
check("oversized JWT ⇒ chunked (>1 cookie)", large.length > 1, `${large.length}`);
for (const h of [...small, ...large]) {
  const p = parseSetCookie(h);
  check(`${p.name}: __Host- prefix`, p.name.startsWith("__Host-next-auth.session-token"));
  check(`${p.name}: Secure`, p.attrs.get("secure") === true);
  check(`${p.name}: HttpOnly`, p.attrs.get("httponly") === true);
  check(`${p.name}: Path=/`, p.attrs.get("path") === "/");
  check(`${p.name}: SameSite=Lax`, String(p.attrs.get("samesite")).toLowerCase() === "lax");
  check(`${p.name}: NO Domain attribute`, !p.attrs.has("domain"));
}

// ── 3. Browser model across the four stable hosts ─────────────────────────────
console.log("\n3. RFC 6265bis model: who can plant it, who receives it");
interface StoredCookie { name: string; hostOnly: boolean; domain: string }
/** RFC 6265bis §5.6 storage, reduced to what matters: prefix rules + Domain. */
function browserStore(setCookie: string, fromHost: string): StoredCookie | null {
  const p = parseSetCookie(setCookie);
  const domainAttr = p.attrs.get("domain");
  const secure = p.attrs.get("secure") === true;
  if (p.name.startsWith("__Secure-") && !secure) return null;
  if (p.name.startsWith("__Host-") && (!secure || p.attrs.get("path") !== "/" || domainAttr !== undefined)) return null;
  if (typeof domainAttr === "string") {
    const d = domainAttr.replace(/^\./, "").toLowerCase();
    // A host may only set Domain to itself or a parent (never a public suffix).
    if (!(fromHost === d || fromHost.endsWith(`.${d}`))) return null;
    return { name: p.name, hostOnly: false, domain: d };
  }
  return { name: p.name, hostOnly: true, domain: fromHost };
}
function browserSends(c: StoredCookie, toHost: string): boolean {
  return c.hostOnly ? toHost === c.domain : toHost === c.domain || toHost.endsWith(`.${c.domain}`);
}

const HOSTS = ["fourthmeridian.com", "app.fourthmeridian.com", "preview.fourthmeridian.com", "preview-app.fourthmeridian.com"];
const prodSession = browserStore(small[0], "app.fourthmeridian.com");
check("Production app's real header is ACCEPTED by the browser model", prodSession !== null);
for (const h of HOSTS) {
  const expected = h === "app.fourthmeridian.com";
  check(`Production session ${expected ? "IS" : "is NOT"} sent to ${h}`, !!prodSession && browserSends(prodSession, h) === expected);
}
const previewSession = browserStore(small[0], "preview-app.fourthmeridian.com");
for (const h of HOSTS) {
  const expected = h === "preview-app.fourthmeridian.com";
  check(`Preview-app session ${expected ? "IS" : "is NOT"} sent to ${h}`, !!previewSession && browserSends(previewSession, h) === expected);
}

// The attack the rename closes: a sibling planting a parent-domain session cookie.
const plantNew = `${sessionCookieName(true)}=attacker; Domain=fourthmeridian.com; Path=/; Secure; HttpOnly; SameSite=Lax`;
const plantOld = `__Secure-next-auth.session-token=attacker; Domain=fourthmeridian.com; Path=/; Secure; HttpOnly; SameSite=Lax`;
for (const from of ["fourthmeridian.com", "preview.fourthmeridian.com", "preview-app.fourthmeridian.com"]) {
  check(`${from} CANNOT plant a Domain-scoped __Host- session cookie`, browserStore(plantNew, from) === null);
  const old = browserStore(plantOld, from);
  check(`(non-vacuity) ${from} COULD plant the old __Secure- name and the app would receive it`,
    !!old && browserSends(old, "app.fourthmeridian.com"));
}
check("a __Host- cookie without Secure is refused (model sanity)",
  browserStore(`${sessionCookieName(true)}=v; Path=/; HttpOnly`, "app.fourthmeridian.com") === null);

// ── 4. The real proxy agrees with the writer, and expires the legacy cookie ───
console.log("\n4. proxy.ts reads the __Host- cookie and expires the legacy one");
async function proxyChecks() {
  const { encode } = await import("next-auth/jwt");
  const { NextRequest } = await import("next/server");
  const { default: proxy } = await import("../../proxy");
  const jwt = await encode({ token: { id: "u1", role: "USER" }, secret: process.env.NEXTAUTH_SECRET! });

  const req = (cookie: string) =>
    new NextRequest("https://app.fourthmeridian.com/dashboard/spaces?tab=x", { headers: { cookie } });

  const withNew = await proxy(req(`${sessionCookieName(true)}=${jwt}`));
  check("__Host- session ⇒ proxy lets the page through (no redirect)", withNew.headers.get("location") === null,
    `location=${withNew.headers.get("location")}`);

  const withOld = await proxy(req(`__Secure-next-auth.session-token=${jwt}`));
  const loc = withOld.headers.get("location") ?? "";
  check("legacy __Secure- session alone ⇒ treated as signed out (redirect to /login)", loc.includes("/login"));
  check("…keeping the deep link as callbackUrl",
    new URL(loc).searchParams.get("callbackUrl") === "/dashboard/spaces?tab=x");
  const setCookies = withOld.headers.getSetCookie();
  const expired = setCookies.map(parseSetCookie).find((c) => c.name === "__Secure-next-auth.session-token");
  check("…and the legacy cookie is EXPIRED on the response", !!expired &&
    (expired.attrs.get("max-age") === "0" || String(expired.attrs.get("expires") ?? "").includes("1970")),
    setCookies.join(" | "));
  check("…with Secure (required to delete a __Secure- cookie) and no Domain",
    !!expired && expired.attrs.get("secure") === true && !expired.attrs.has("domain"));

  const both = await proxy(req(`${sessionCookieName(true)}=${jwt}; __Secure-next-auth.session-token.0=a; __Secure-next-auth.session-token.1=b`));
  const names = both.headers.getSetCookie().map((h) => parseSetCookie(h).name);
  check("chunked legacy cookies are expired too, while the new session passes",
    both.headers.get("location") === null &&
    names.includes("__Secure-next-auth.session-token.0") && names.includes("__Secure-next-auth.session-token.1"));
  check("the CURRENT session cookie is never expired by the cleanup",
    !names.includes(sessionCookieName(true)));
  check("isLegacyAuthCookie does not match the new name", !isLegacyAuthCookie(sessionCookieName(true)));
}

// ── 5. Source pins — one decision, both readers ───────────────────────────────
function sourcePins() {
  console.log("\n5. lib/auth.ts and proxy.ts use the shared decision");
  const ROOT = process.cwd();
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
  const auth = strip(readFileSync(path.join(ROOT, "lib/auth.ts"), "utf8"));
  const proxySrc = strip(readFileSync(path.join(ROOT, "proxy.ts"), "utf8"));
  check("authOptions pins useSecureCookies to authCookiesSecure()", /useSecureCookies:\s*authCookiesSecure\(\)/.test(auth));
  check("authOptions.cookies = authCookieOverrides(authCookiesSecure())", /cookies:\s*authCookieOverrides\(\s*authCookiesSecure\(\)\s*\)/.test(auth));
  check("proxy getToken passes cookieName: sessionCookieName(…)", /cookieName:\s*sessionCookieName\(/.test(proxySrc));
  check("proxy getToken passes the same secureCookie decision", /secureCookie\s*=\s*authCookiesSecure\(\)/.test(proxySrc));
  check("no other getToken caller exists outside proxy.ts (else it would read the old default name)",
    !/getToken\(/.test(auth));
}

proxyChecks()
  .then(sourcePins)
  .catch((e) => { failures++; console.error("  ✗ proxy checks threw —", e); })
  .finally(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll session-cookie checks passed.");
  });
