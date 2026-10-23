-- RLS-C-S6 — A SINGLE-USE INVITE IS CONSUMED BY THE ROLE THAT REGISTERS, OR BY NOBODY
--
-- BetaAccessRequest is the one table in the revoked family (migration
-- …000100 §4) that a PUBLIC, UNAUTHENTICATED request has to touch. Two routes
-- do, and neither could survive the conversion that is coming:
--
--   POST /api/access-request   upsert by email        — the waitlist intake
--   POST /api/auth/register    findFirst + updateMany — validate, then CONSUME
--
-- The first migration granted fm_app INSERT and nothing else, with the comment
-- "Anonymous INSERT only; reads are operator work." That decision was right
-- about the shape and wrong about the role, and the grant it produced is
-- unreachable: fm_app is only ever entered through withTenantDb(), which
-- REFUSES an empty identity (and must — an identity-less fm_app query sees
-- nothing under RLS and everything under the fallback). The subject of a
-- waitlist request has no User row, and the subject of a registration does not
-- have one until the transaction that needs this table has already opened. So
-- the authority for both routes is fm_auth, the pre-identity role, exactly as
-- it is for the credential lookup that cannot key on an identity either.
--
-- ── 1. THE REDEMPTION, AND WHY THE CODE CHANGED IN THE SAME COMMIT ───────────
-- The register route consumes the invite with a compare-and-swap:
--
--     updateMany({ where: { id, status: APPROVED },
--                  data:  { status: REDEEMED, inviteTokenHash: null, … } })
--
-- Its count was never read, because "the status: APPROVED guard makes a
-- concurrent second redemption a no-op" — true, and the reason it was safe to
-- ignore. Grant a role UPDATE on this table behind a policy and it stops being
-- true: a row the policy hides is not a row the statement matched, so a
-- REFUSAL arrives as `{count: 0}` with no error and no log, and the account is
-- created while `inviteTokenHash` stays non-null. The invite is then reusable,
-- for ever, by anyone holding the emailed link.
--
-- That is a security regression rather than an outage, and it is created by
-- THIS migration: at the previous commit fm_app and fm_auth had no UPDATE
-- privilege at all, and a missing GRANT raises (`permission denied for table`)
-- where a policy filter is silent. So the grant below and
-- `redeemBetaInvite()` — which requires exactly one row and raises otherwise —
-- are one change. Shipping the grant without the guard would arm the defect;
-- shipping the guard without the grant would leave registration failing loudly
-- in invite_only mode.
--
-- ── 2. ANTI-ENUMERATION IS A COLUMN GRANT, NOT A POLICY ─────────────────────
-- BetaAccessRequest is PRE-TENANT by construction: no tenant predicate can
-- exist, so a policy cannot be the thing that stops a stranger learning whether
-- an address is on the waitlist. A column grant can. `email` is NOT granted to
-- fm_auth, which means `… WHERE email = $1` is refused by Postgres before any
-- policy is consulted — the same mechanism RLS-16 used to keep SyncIssue's
-- forensic columns out of the tenant role's reach. The redemption needs `id`
-- and `status` in its WHERE clause and nothing else, so that is the whole read
-- surface: two columns that carry no identity.
--
-- ── 3. THE INTAKE MAY NOT MINT A DECISION ───────────────────────────────────
-- `fm_app_insert … WITH CHECK (true)` authorised an anonymous INSERT of a row
-- with `status = 'APPROVED'` and an attacker-chosen `inviteTokenHash` — a
-- self-issued invite. The route only ever writes email and note, so no product
-- test could have reached it; the POLICY allowed it, which is the RLS-15 story
-- again. Both public roles are now bounded to an intake request: PENDING, no
-- token, no decision, no redemption. Replacing the policy is why a new
-- migration exists — an applied one is never edited.

-- ── THE INTAKE PREDICATE ─────────────────────────────────────────────────────
-- One definition, used by both public roles. A request, never a verdict.
CREATE OR REPLACE FUNCTION fm_beta_request_is_intake(
  status            "BetaAccessRequestStatus",
  invite_token_hash text,
  invite_expires_at timestamp,
  invited_at        timestamp,
  decided_at        timestamp,
  decided_by_id     text,
  redeemed_at       timestamp,
  redeemed_user_id  text
) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public
  AS $$ SELECT status = 'PENDING'
            AND invite_token_hash IS NULL
            AND invite_expires_at IS NULL
            AND invited_at        IS NULL
            AND decided_at        IS NULL
            AND decided_by_id     IS NULL
            AND redeemed_at       IS NULL
            AND redeemed_user_id  IS NULL $$;

-- ── fm_app — the grant stays INSERT-only, but stops authorising a verdict ────
-- Kept rather than revoked: it is the recorded owner decision for the anonymous
-- intake, it is harmless, and revoking it would hide the finding above instead
-- of fixing it. ⚠️ It is also UNREACHABLE — see the header. The route's
-- authority is fm_auth.
DROP POLICY IF EXISTS fm_app_insert ON public."BetaAccessRequest";
CREATE POLICY fm_app_insert ON public."BetaAccessRequest" FOR INSERT TO fm_app
  WITH CHECK (fm_beta_request_is_intake(
    status, "inviteTokenHash", "inviteExpiresAt", "invitedAt",
    "decidedAt", "decidedById", "redeemedAt", "redeemedUserId"));

-- ── fm_auth — the pre-identity role the two public routes actually run as ────

-- The waitlist intake. INSERT only, bounded to a request.
GRANT INSERT ON TABLE public."BetaAccessRequest" TO fm_auth;
CREATE POLICY fm_auth_ins ON public."BetaAccessRequest" FOR INSERT TO fm_auth
  WITH CHECK (fm_beta_request_is_intake(
    status, "inviteTokenHash", "inviteExpiresAt", "invitedAt",
    "decidedAt", "decidedById", "redeemedAt", "redeemedUserId"));

-- The redemption. TWO columns readable, FOUR writable, and nothing else.
--
-- ⚠️ THE SELECT GRANT AND POLICY ARE NOT OPTIONAL, AND NOT A WIDENING. An
-- UPDATE whose WHERE clause reads columns needs SELECT privilege on them AND
-- must reach the row through a SELECT (or ALL) policy as well as the UPDATE
-- one. Omitting either turns the redemption into `permission denied` and takes
-- invite_only registration down. `email` and `note` are deliberately absent, so
-- the role that can consume an invite still cannot read, filter on, or count by
-- the address it was issued to.
GRANT SELECT ("id", "status") ON TABLE public."BetaAccessRequest" TO fm_auth;
GRANT UPDATE ("status", "redeemedAt", "redeemedUserId", "inviteTokenHash")
  ON TABLE public."BetaAccessRequest" TO fm_auth;

-- The invite LIFECYCLE is addressable; the WAITLIST is not. A PENDING request
-- and a DENIED one are invisible to this role even by id, so the public surface
-- cannot see who is queued or who was turned down — and what it can see is two
-- columns that carry no identity at all.
--
-- ⚠️ IT COVERS 'REDEEMED' BECAUSE THE SELECT POLICY IS ALSO APPLIED TO THE NEW
-- ROW. This was measured, not assumed, and it is worth stating because the
-- failure is badly misleading. With this policy written as the obvious
-- `status = 'APPROVED' AND "inviteTokenHash" IS NOT NULL` — the live invite, the
-- only row a redemption may touch — the redemption fails with:
--
--     ERROR: new row violates row-level security policy for table "BetaAccessRequest"
--
-- which names the UPDATE policy's WITH CHECK and is nothing to do with it: the
-- UPDATE policy admits the transition exactly as written. It is the SELECT
-- policy refusing the POST-UPDATE row, because the destination of the only
-- transition the role is allowed to make was outside the set of rows it is
-- allowed to see. A SELECT policy narrower than its own write policy's
-- destination makes that write impossible, and says so in the wrong voice.
-- Narrowing this back to the live invite would take invite_only registration
-- down with an error that looks like a bug in the clause above it.
CREATE POLICY fm_auth_sel ON public."BetaAccessRequest" FOR SELECT TO fm_auth
  USING (status = 'APPROVED' OR status = 'REDEEMED');

-- Redemption is ONE-WAY at the database. The only transition fm_auth can make
-- is an outstanding invite to a consumed one with its token destroyed. It cannot
-- un-redeem, re-approve, deny, or restore a token — including its own, a moment
-- later. That is a bound on what the role may REACH, not a re-statement of the
-- product rule: expiry stays in validateInvite(), which is the single stated
-- invite-validation authority and the only one holding a clock.
CREATE POLICY fm_auth_redeem ON public."BetaAccessRequest" FOR UPDATE TO fm_auth
  USING      (status = 'APPROVED' AND "inviteTokenHash" IS NOT NULL)
  WITH CHECK (status = 'REDEEMED' AND "inviteTokenHash" IS NULL);

-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
-- No SELECT for fm_app: the tenant role has no business reading a waitlist, and
-- there is no identity in this table to bind one to.
--
-- No grant for `validateInvite`, which looks a live invite up by token hash and
-- returns the bound email. Granting that read to a public role would hand it
-- `email` and `inviteTokenHash` — the enumeration surface and the secret — so it
-- is a CAPABILITY instead (lib/registration-policy.ts, reached through
-- systemDb, the lib/users/availability.ts idiom): a raw token in, a closed
-- `{valid, email, requestId}` out. The invite token IS the authorisation, and it
-- is a 32-byte secret that only the addressee was emailed, so possession proves
-- the right to learn that one address and no other.
--
-- No change to SyncIssue. The wallet sweep's `groupBy` on `lastOccurredAt` is
-- reached only from jobs/sync-crypto.ts and enumerates every wallet in the
-- deployment, so it moved to fm_system; RLS-16's column grant is unchanged and
-- `lastOccurredAt` stays out of the tenant role's reach.
