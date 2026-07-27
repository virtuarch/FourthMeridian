/**
 * lib/plaid/redirect-uri.ts  (V26-PLAID-REDIRECT-1)
 *
 * THE single authority for the `redirect_uri` sent to Plaid's /link/token/create.
 *
 * WHY THIS EXISTS
 * ---------------
 * `redirect_uri` used to be read straight from `process.env.PLAID_REDIRECT_URI`
 * at two independent call sites. That variable is a hand-maintained copy of a
 * value the deployment already knows — its own public origin — and the two
 * drifted:
 *
 *   - Vercel's PLAID_REDIRECT_URI still held an OLD Vercel deployment URL
 *     (last updated Jun 22, predating the fourthmeridian.com custom domains).
 *   - When that stale URL was removed from Plaid Dashboard → Team → API →
 *     Allowed redirect URIs, EVERY link-token creation started failing with
 *     `400 INVALID_FIELD — "OAuth redirect URI must be configured in the
 *     developer dashboard"`, in BOTH production and preview.
 *   - That broke new connections AND reconnects. An item in
 *     ITEM_LOGIN_REQUIRED could not be repaired, because update mode also
 *     needs a link token.
 *
 * The failure was invisible from both ends: Plaid's error names no value, Plaid's
 * request log stores no request body, and every Vercel var on this project is
 * marked Sensitive — so the sent value could not be read by the CLI, the Vercel
 * dashboard, or the operator. Deriving it removes the copy that could drift.
 *
 * DERIVED FROM THE APP'S OWN ORIGIN, mirroring `resolvePlaidWebhookUrl()` in
 * app/api/plaid/link-token/route.ts, which already derives the webhook from
 * NEXT_PUBLIC_APP_URL and guards non-HTTPS/localhost. NEXT_PUBLIC_APP_URL is
 * per-environment, so production yields the production return URL and preview
 * yields the preview one — both of which are the registered dashboard entries.
 *
 * PLAID_REDIRECT_URI SURVIVES AS A LOCAL-DEV OVERRIDE ONLY (an ngrok/tunnel
 * HTTPS URL, where the app has no public origin of its own). It must NOT be set
 * in Vercel. If it is set on a deployment AND disagrees with that deployment's
 * own origin, the override still wins — precedence stays predictable, matching
 * the webhook resolver — but the disagreement is reported LOUDLY rather than
 * silently reintroducing the exact drift this module exists to end.
 *
 * A non-public origin (http, localhost, 127.0.0.1) yields `undefined`, and the
 * caller omits `redirect_uri` entirely. Plaid REQUIRES it for OAuth institutions
 * (Chase, BoA, Wells Fargo, Capital One…), so omitting it is only ever correct
 * where OAuth cannot complete anyway — i.e. local development.
 */

import { env } from "@/lib/env";

/** The OAuth return page (app/plaid-oauth-return/page.tsx). */
export const PLAID_OAUTH_RETURN_PATH = "/plaid-oauth-return";

/** Where the resolved value came from — reported in the route's config log. */
export type PlaidRedirectUriSource = "explicit" | "derived" | "none";

export interface PlaidRedirectUriResolution {
  /** Value to send, or undefined ⇒ the caller omits `redirect_uri` entirely. */
  uri:    string | undefined;
  source: PlaidRedirectUriSource;
  /** Set only when an explicit override disagrees with the deployment's origin. */
  drift?: string;
}

/**
 * A URL Plaid could actually redirect a browser back to: absolute HTTPS, and not
 * a loopback host. Anything else is unusable and becomes `undefined` rather than
 * being sent and rejected.
 */
function publicHttpsUrl(raw: string | undefined): string | undefined {
  const url = raw?.trim();
  if (!url) return undefined;
  if (!/^https:\/\//i.test(url)) return undefined;
  if (/localhost|127\.0\.0\.1/i.test(url)) return undefined;
  return url;
}

/**
 * Pure core — no env access, so the precedence rules are testable directly.
 *
 * @param explicit raw PLAID_REDIRECT_URI (local-dev tunnel override), if any
 * @param appUrl   the deployment's own public base URL (NEXT_PUBLIC_APP_URL)
 */
export function buildPlaidRedirectUri(args: {
  explicit?: string;
  appUrl?:   string;
}): PlaidRedirectUriResolution {
  const base    = args.appUrl?.trim().replace(/\/$/, "");
  const derived = publicHttpsUrl(base ? `${base}${PLAID_OAUTH_RETURN_PATH}` : undefined);
  const explicit = publicHttpsUrl(args.explicit);

  if (explicit) {
    return {
      uri:    explicit,
      source: "explicit",
      drift:  derived && derived !== explicit
        ? `PLAID_REDIRECT_URI is set to ${JSON.stringify(explicit)}, which does not match ` +
          `this deployment's own OAuth return URL ${JSON.stringify(derived)}. Plaid will ` +
          `reject the link token unless the override is registered in the Plaid Dashboard. ` +
          `PLAID_REDIRECT_URI is intended for local tunnels only — unset it on deployments.`
        : undefined,
    };
  }

  return derived
    ? { uri: derived,    source: "derived" }
    : { uri: undefined,  source: "none" };
}

/** Env-reading wrapper over the pure core. */
export function resolvePlaidRedirectUri(): PlaidRedirectUriResolution {
  return buildPlaidRedirectUri({
    explicit: process.env.PLAID_REDIRECT_URI,
    appUrl:   env.NEXT_PUBLIC_APP_URL,
  });
}
