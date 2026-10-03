-- D1b — THE ONE TABLE D1's SWEEP COULD NOT SEE, BECAUSE THE SWEEP ENUMERATED
--       BY A COLUMN NAME
--
-- This is not a new policy model. It is the REMAINDER of 20261003000000's
-- already-landed theorem — ARCHIVAL CHANGES PRODUCT STATE, DISCOVERABILITY AND
-- USE; IT DOES NOT TRANSFER OR ERASE OWNERSHIP — applied to the one account-
-- subtree table that theorem missed.
--
-- ══ WHY IT WAS MISSED ═══════════════════════════════════════════════════════
-- D1 widened THIRTEEN tables, and it found them by looking for tables keyed on
-- a column literally named `financialAccountId`. Derived from
-- prisma/schema.prisma rather than argued: there are SEVENTEEN FK relations to
-- `FinancialAccount` across FIFTEEN models, spread over FOUR distinct column
-- names.
--
--     financialAccountId      14 models   — D1's set (12 of them FK relations,
--                                           plus TransactionObservation, whose
--                                           reference is a soft column, plus
--                                           SpaceAccountLink and
--                                           GoalContribution, see below)
--     accountAId              1  model    — DuplicateAccountCandidate  ← HERE
--     accountBId              1  model    — DuplicateAccountCandidate  ← HERE
--     counterpartyAccountId   1  model    — Transaction, named by NO predicate
--                                           at all (classified, with its whole
--                                           participant inventory, in
--                                           scripts/audit-account-reparenting.ts)
--
-- A convention is not an invariant. The same audit now derives that FK set from
-- the schema every run and REFUSES a pair that is neither named by an
-- account-subtree predicate nor explicitly classified, so a new FK under a new
-- column name fails the build instead of silently inheriting nothing.
--
-- ══ THE MEASURED FAILURE THIS CLOSES ════════════════════════════════════════
-- Replayed on a real `fm_app` role, as the OWNER, over the shape EVERY
-- production merge actually has — an archived, link-revoked loser folded into
-- an active winner, both the caller's own:
--
--     assertAccountReparentingAuthorized      passes
--     Transaction.updateMany                  2 of 2 moved
--     DebtProfile.updateMany                  1 of 1 moved
--     SpaceAccountLink repoint                1 of 1
--     DuplicateAccountCandidate.upsert        ABORTS, Postgres 42501
--
-- The policy is a CONJUNCTION — `fm_account_visible("accountAId") AND
-- fm_account_visible("accountBId")` (20261002000100 §17) — and archiving an
-- account REVOKES every one of its SpaceAccountLink rows
-- (lib/accounts/disconnect.ts → revokeAccountLinksEverywhere). Measured on the
-- role: `fm_account_visible(loser) = false`, `fm_account_visible(winner) =
-- true`. So the archived, OWNED loser alone makes the final statement
-- impossible, the whole fold rolls back, and the only durable record that the
-- merge happened cannot be written by the tenant who performed it.
--
-- And the refusal arrives as `PrismaClientUnknownRequestError` with `code`
-- UNDEFINED, so no `e.code === "P2002"` handler could ever have caught it.
--
-- ══ WHAT IS WRITTEN, AND WHAT IS NOT ════════════════════════════════════════
--     (visible(accountAId) OR owned(accountAId))
--       AND
--     (visible(accountBId) OR owned(accountBId))
--
-- The CONJUNCTION IS PRESERVED. §17 chose it deliberately — this table has two
-- independent owner paths that can disagree, and the conjunction hides a
-- straddling pair from BOTH tenants rather than telling either that a
-- cross-tenant pair exists. Nothing here relaxes that: each half gains the
-- owner arm its own account's root policy (`FinancialAccount.fm_app_sel`)
-- already had, and a row naming one of my accounts and one of somebody else's
-- stays invisible to me, exactly as before.
--
-- No new ownership concept. No `visibilityLevel` (RLS is TENANCY; the
-- redaction tier is lib/account-privacy.ts's). No privileged fallback.
--
-- ══ THE SAME SQL DISCIPLINE D1 ESTABLISHED, AND WHY ═════════════════════════
--
-- 1. THE PREDICATE IS WRITTEN OUT, NOT CALLED. `fm_account_visible()` is NOT
--    inlined by the planner and D1 proved it with two independent minimal
--    probes: a SubLink body disqualifies inlining, and so does `SET search_path`
--    as proconfig. Both apply, so no rewriting of the FUNCTION recovers it —
--    only writing the predicate into the policy body does. Written out, both
--    arms hoist to once-per-statement hashed SubPlans instead of an opaque call
--    per row.
--
--    `fm_visible_space_ids()` stays a function call and must: it is SECURITY
--    DEFINER, which is what breaks the SpaceMember self-reference, and the
--    planner hoists `IN (SELECT …)` to a hashed SubPlan regardless.
--
--    No `fm_account_owned()` is created. It would reintroduce exactly the
--    opacity D1 removed.
--
-- 2. `ALTER POLICY`, NOT DROP + CREATE. The expression is replaced in place, so
--    there is no window in which this table has no policy.
--
-- 3. ⚠️ THE QUALIFICATION TRAP, DOUBLED. Inside a policy body the subqueries
--    alias (`sal`, `fa`), so an unqualified `"accountAId"` resolves to the
--    INNER scope and the correlation silently becomes `sal.x = sal.x` — ALWAYS
--    TRUE, every row visible to everyone, and EVERY TENANT CASE WOULD STILL
--    PASS. D1 documented this for one column; here there are two, and a single
--    unqualified one would open the whole table.
--
--    So the OUTER TABLE IS SPELLED OUT, in the source, beside every one of the
--    four correlations: `"DuplicateAccountCandidate".%1$I`. Only the COLUMN
--    comes from the loop. And the proof is read off `pg_policies.qual` /
--    `with_check` on a migrated database, not off this source. A passing test
--    cannot tell a correct predicate from a tautology; the generated SQL can.
--
--    Measured on a throwaway after `migrate deploy`: every mention of
--    `accountAId` and of `accountBId` in all three policy bodies — 2/2, 2/2 and
--    4/4 — is `"DuplicateAccountCandidate"."account?Id"`, with no
--    `sal.x = sal.x` and no `fa.id = fa.…` anywhere.
--
-- 4. THE LOOP EXISTS SO THE TWO COLUMNS CANNOT DIVERGE. One arm template, two
--    columns, three policies — rather than the same expression hand-written six
--    times, which is six chances to leave one qualification off.
--    (⚠️ `BOTH` is a reserved SQL keyword and cannot be a plpgsql variable
--    name — D1 hit that; the variables here are `arms`/`pred`.)
--
-- ══ SCOPE ═══════════════════════════════════════════════════════════════════
-- THREE policies, not four: `DuplicateAccountCandidate` has no `fm_app_del` —
-- 20261002000100 grants DELETE to fm_app but writes no DELETE policy, so FORCE
-- ROW LEVEL SECURITY denies every delete. That asymmetry is pre-existing and is
-- deliberately left exactly as it is; widening a refusal is not this slice's
-- business.
--
-- `GoalContribution` — the other §17 Class-H table — is NOT touched, and that
-- is a REPORTED residue rather than an oversight: its predicate does name
-- `financialAccountId`, so D1's sweep could see it and still did not widen it,
-- and the same archived-owner asymmetry therefore survives there. Zero rows
-- exist in it (W2 retired Goals) and no code path reaches it, so there is
-- nothing to measure and no fold that depends on it. It is a separate decision
-- about a retired concept, not a remainder of this one.

DO $$
DECLARE
  cols text[] := ARRAY['accountAId', 'accountBId'];
  col  text;
  arms text[] := ARRAY[]::text[];
  pred text;
BEGIN
  FOREACH col IN ARRAY cols LOOP
    -- Arm 1, unchanged in meaning: an ACTIVE link into a Space I can see.
    -- Arm 2, new: I own the account. Mirrors FinancialAccount.fm_app_sel's
    -- first arm exactly, so this table now says what its roots already said.
    --
    -- ⚠️ `"DuplicateAccountCandidate".%1$I` — THE OUTER ROW, SPELLED OUT.
    -- See discipline note 3: only the COLUMN is interpolated, so the
    -- qualification is visible in the source at every one of the four
    -- correlations and cannot be lost by a loop variable going astray.
    arms := arms || format(
      $f$(EXISTS (SELECT 1 FROM "SpaceAccountLink" sal
                   WHERE sal."financialAccountId" = "DuplicateAccountCandidate".%1$I
                     AND sal.status = 'ACTIVE'
                     AND sal."spaceId" IN (SELECT fm_visible_space_ids()))
          OR EXISTS (SELECT 1 FROM "FinancialAccount" fa
                      WHERE fa."id" = "DuplicateAccountCandidate".%1$I
                        AND fa."ownerUserId" = current_fm_user_id()))$f$,
      col);
  END LOOP;

  -- The conjunction, preserved. Wrapped, because `ALTER POLICY … USING` takes a
  -- PARENTHESISED expression — an unparenthesised one is a syntax error, which
  -- is how D1's own mutation attempt silently failed to mutate.
  pred := '(' || array_to_string(arms, ' AND ') || ')';

  EXECUTE format('ALTER POLICY fm_app_sel ON public."DuplicateAccountCandidate" USING %s',               pred);
  EXECUTE format('ALTER POLICY fm_app_ins ON public."DuplicateAccountCandidate" WITH CHECK %s',          pred);
  EXECUTE format('ALTER POLICY fm_app_upd ON public."DuplicateAccountCandidate" USING %s WITH CHECK %s', pred, pred);
END $$;
