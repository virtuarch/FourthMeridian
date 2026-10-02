/**
 * lib/auth/session-cookie.ts — the ONE definition of the authenticated session
 * cookie, shared by NextAuth (lib/auth.ts) and the page proxy (proxy.ts).
 *
 * WHY __Host-. NextAuth's default name is `__Secure-next-auth.session-token`.
 * `__Secure-` only demands the Secure flag; it still allows a `Domain`
 * attribute. Any sibling host under the same registrable domain — today
 * `preview.fourthmeridian.com` beside Production on `fourthmeridian.com`,
 * tomorrow a public site beside `app.fourthmeridian.com` — can therefore SET
 * `__Secure-next-auth.session-token; Domain=fourthmeridian.com` and the browser
 * will send it to the app. That is login CSRF: a victim silently signed into
 * an attacker's account, where they may then connect a real bank.
 *
 * `__Host-` forbids exactly that. A browser accepts a `__Host-` cookie only if
 * it is Secure, has Path=/ and has NO Domain attribute — so it is host-only by
 * construction and no other host can plant or receive it.
 *
 * Over plain http (local dev) neither prefix is permitted; the cookie is the
 * unprefixed `next-auth.session-token`, exactly as NextAuth would name it.
 *
 * ONE DECISION, TWO READERS. NextAuth core picks Secure from the request
 * origin; `getToken` picks it from NEXTAUTH_URL / VERCEL. If those ever
 * disagreed, the proxy would look for a cookie NextAuth never wrote and every
 * page would bounce to /login. So lib/auth.ts pins `useSecureCookies` to
 * `authCookiesSecure()` and proxy.ts passes the same `cookieName`.
 *
 * TRANSITION. Renaming the cookie signs every existing session out once: the
 * old `__Secure-` cookie is simply no longer read. It is still a signed,
 * unrevoked JWT sitting in the browser, so proxy.ts expires it on sight
 * (LEGACY_AUTH_COOKIE_NAMES) rather than leaving a live credential nobody
 * reads — and that a rollback would silently revive.
 *
 * Pure: no imports. proxy.ts keeps a zero-dependency graph.
 */

const SESSION_BASENAME  = "next-auth.session-token";
const CALLBACK_BASENAME = "next-auth.callback-url";

/**
 * Whether auth cookies carry the Secure flag. Mirrors next-auth/jwt getToken's
 * own default (`NEXTAUTH_URL` scheme, else `VERCEL`), so both readers agree.
 */
export function authCookiesSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = env.NEXTAUTH_URL;
  if (url) return url.startsWith("https://");
  return Boolean(env.VERCEL);
}

export function sessionCookieName(secure: boolean): string {
  return secure ? `__Host-${SESSION_BASENAME}` : SESSION_BASENAME;
}

export function callbackUrlCookieName(secure: boolean): string {
  return secure ? `__Host-${CALLBACK_BASENAME}` : CALLBACK_BASENAME;
}

export interface AuthCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  // Deliberately no `domain`: host-only. A `__Host-` cookie with a Domain
  // attribute is rejected by the browser outright.
}

function options(secure: boolean): AuthCookieOptions {
  return { httpOnly: true, sameSite: "lax", path: "/", secure };
}

/**
 * The `cookies` override for NextAuthOptions. Only the two cookies NextAuth
 * names `__Secure-` by default are overridden; the CSRF cookie is already
 * `__Host-next-auth.csrf-token` and the PKCE/state/nonce cookies are unused
 * (credentials provider only).
 */
export function authCookieOverrides(secure: boolean) {
  return {
    sessionToken: { name: sessionCookieName(secure),     options: options(secure) },
    callbackUrl:  { name: callbackUrlCookieName(secure), options: options(secure) },
  };
}

/**
 * Cookie names NextAuth wrote before the `__Host-` rename. Matched as a PREFIX
 * so the chunked forms (`….session-token.0`, `.1`, …) NextAuth uses for an
 * oversized JWT are expired too.
 */
export const LEGACY_AUTH_COOKIE_NAMES: readonly string[] = [
  `__Secure-${SESSION_BASENAME}`,
  `__Secure-${CALLBACK_BASENAME}`,
];

export function isLegacyAuthCookie(name: string): boolean {
  return LEGACY_AUTH_COOKIE_NAMES.some((n) => name === n || name.startsWith(`${n}.`));
}
