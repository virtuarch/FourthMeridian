/**
 * lib/onboarding/first-run.core.ts  (Connections pass PR 2 — first-time onboarding)
 *
 * PURE. Two decisions from five facts, so the rule is testable without a DB:
 *
 *   redirect — send this user, ONCE, from the post-login landing (the Brief) to
 *              the welcome view on Connections. Only a user who has never had a
 *              source of any kind, who is not a member of someone else's Space,
 *              and who has neither seen nor dismissed the welcome.
 *   invite   — show the dismissible "connect your first account" notice: a user
 *              with no LIVE source who has not dismissed it, and who is not
 *              being redirected right now.
 *
 * ⚠️ ESTABLISHED USERS ARE NEVER REDIRECTED. "Ever had a source" counts revoked
 * Plaid Items, errored wallets and soft-deleted accounts, so a provider failure
 * or a disconnect can never make an established user look new. The reader also
 * fails OPEN (no redirect, no invite) — see first-run.ts.
 *
 * Connecting is never required: neither decision blocks a page; the redirect
 * fires at most once and every destination stays reachable.
 */

export interface FirstRunFacts {
  /** Plaid Items + wallet Connections + owned accounts, in ANY state, ever. */
  sourcesEver: number;
  /** The same, live only (Item not revoked, account not deleted). */
  sourcesLive: number;
  /** ACTIVE membership in a Space that is not the user's personal Space. */
  sharedMemberships: number;
  presented: boolean;
  dismissed: boolean;
}

export interface FirstRunDecision {
  redirect: boolean;
  invite: boolean;
}

export const NO_ONBOARDING: FirstRunDecision = { redirect: false, invite: false };

/** Where the one-time redirect lands. `welcome=1` turns on the greeting. */
export const ONBOARDING_HREF = "/dashboard/connections?welcome=1";

export function decideFirstRun(f: FirstRunFacts): FirstRunDecision {
  const redirect = f.sourcesEver === 0 && f.sharedMemberships === 0 && !f.presented && !f.dismissed;
  const invite = !redirect && f.sourcesLive === 0 && !f.dismissed;
  return { redirect, invite };
}
