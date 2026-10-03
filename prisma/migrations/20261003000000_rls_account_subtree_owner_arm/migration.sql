-- D1 — THE SUBTREE AGREES WITH ITS OWN ROOT, AND THE PREDICATE STOPS BEING A
--      PER-ROW FUNCTION CALL
--
-- Two changes to the same thirteen policies, landed together because measuring
-- them apart is what produced the wrong answer for seven weeks.
--
-- ══ 1. THE ASYMMETRY ════════════════════════════════════════════════════════
--
-- `FinancialAccount.fm_app_sel` already says:
--
--     "ownerUserId" = current_fm_user_id() OR fm_account_visible("id")
--
-- Its subtree says only the second half. So archiving an account — which
-- REVOKES every one of its SpaceAccountLink rows (lib/accounts/disconnect.ts →
-- revokeAccountLinksEverywhere) — leaves the owner able to see the account and
-- NONE of its contents. Measured, replaying the merge statement for statement
-- as the owner on a real fm_app role:
--
--     transaction.updateMany{loser}         {count: 0}  silent   (truth: 5)
--     debtProfile.updateMany{loser→winner}  {count: 0}  silent   (truth: 1)
--     accountConnection.findMany{loser}     0 rows, early-return (truth: 1)
--     duplicateAccountCandidate.upsert      ABORTS, Postgres 42501
--
-- The merge operates exclusively on archived losers, so that is every case, not
-- an edge case. And the 42501 arrives as PrismaClientUnknownRequestError with
-- `code` UNDEFINED, so no `e.code === "P2002"` handler catches it.
--
-- The theorem this encodes: ARCHIVAL CHANGES PRODUCT STATE, DISCOVERABILITY AND
-- USE. IT DOES NOT TRANSFER OR ERASE OWNERSHIP. Space membership remains
-- independently required for tenant isolation — the first arm is untouched.
--
-- ⚠️ WHAT THIS DOES NOT WIDEN. The owner arm matches only rows whose container
-- the caller OWNS. It cannot reach an account the caller does not own, in any
-- Space, ever. Proven rather than argued: against a non-owned account in a
-- Space the actor is not a member of, SELECT and UPDATE both returned 0 before
-- and after, over a real denominator of 4 rows. And counted across 4 users ×
-- 13 subtree tables on the live corpus, `added_by_owner_arm = 0` in EVERY cell
-- — all 66 links are ACTIVE, so this is a literal no-op on today's data. After
-- archiving one account the delta became exactly that account's 1,900 rows and
-- nothing else. Pure widening, confirmed by counting, not by reasoning.
--
-- ⚠️ AND WHAT IT COSTS, WHICH IS WHY IT COULD NOT LAND ALONE. The owner arm
-- removes an ACCIDENTAL backstop: today a cross-owner re-parent INTO an
-- archived, link-revoked account is refused by WITH CHECK — not because the
-- policy has an opinion about ownership, but because the destination predicate
-- is visibility-only. With the arm, that move succeeds and the victim's own
-- access drops to zero. The application-tier invariant that replaces it
-- (lib/accounts/account-reparenting.ts, acceptance cases 73-80, and the REQUIRED
-- audit over all 24 FK-capable sites) landed FIRST, deliberately. Case 76 — the
-- destination direction — was green before this file was written.
--
-- ══ 2. THE FUNCTION WAS NEVER INLINED ═══════════════════════════════════════
--
-- 20261002000100 states: "Plain SQL, not plpgsql, so the planner INLINES it and
-- the measured plan shapes are preserved." It does not. Every plan shows
-- `Filter: fm_account_visible("financialAccountId")` — an opaque call, ONCE PER
-- ROW. Two independent disqualifiers, each pinned with a minimal probe:
--
--     body            SET search_path   inlined?
--     acct > ''       no                YES
--     acct > ''       YES               no  — proconfig disqualifies
--     EXISTS (...)    no                no  — SubLink disqualifies
--
-- Both apply here, so NO rewriting of the function recovers inlining; only
-- writing the predicate into the policy body does. Measured on the real corpus
-- (Transaction 4,933 · PositionObservation 6,676), 5 runs each:
--
--     PositionObservation GROUP BY   1,755 ms / 27,451 buffers  →  97 ms / 382
--     realistic keyset page          1,161 ms / 18,396 buffers  →  12 ms / 736
--
-- 72× and 25×. §28.3 recorded 0.785 ms / 22 buffers — those are written-out
-- numbers for a predicate that shipped as a function call, and §28.4(1)'s
-- "3-12 shared buffers, independent of result-set size" was already false as
-- committed: 4.1 buffers PER ROW.
--
-- Written out, BOTH arms hoist to once-per-statement hashed SubPlans with the
-- owner arm `never executed` when the first suffices — O(visible accounts +
-- owned accounts), not O(rows). That is why the arm is free here (0.64-1.14×,
-- −15 buffers) and would have cost up to 2.42× time / 2.13× buffers as a second
-- per-row function call. No index scan becomes anything else in any cell.
--
-- And on the one shape where the arm actually fires it is FASTER: the archived
-- account's keyset page went 41.0 ms / 1,290 buffers → 17.9 ms / 1,037, with
-- rows-removed-by-filter 97 → 0. Admitting the rows lets LIMIT short-circuit
-- instead of filter-rejecting them.
--
-- ══ WHY THE PREDICATE MUST NAME THE TABLE ═══════════════════════════════════
-- The subquery aliases `sal`, so an unqualified "financialAccountId" inside it
-- resolves to the INNER scope and the correlation silently becomes `sal.x =
-- sal.x` — always true, every row visible to everyone. The row must be named
-- explicitly: `%1$I."financialAccountId"`. Avoiding that trap is precisely what
-- the function form bought, and it is the one real cost of writing it out.
-- scripts/rls-acceptance.ts and rls-app-acceptance.ts are what prove it did not
-- happen; a self-join bug here would make every tenant case pass.
--
-- ══ SCOPE ═══════════════════════════════════════════════════════════════════
-- Thirteen tables, four policies each. `fm_account_visible()` is NOT dropped —
-- 20261002000500's SyncIssue read policy still calls it, deliberately
-- unchanged. No new function is created: an `fm_account_owned()` would simply
-- reintroduce the opacity this migration exists to remove.
--
-- ALTER POLICY, not DROP + CREATE: it replaces the expression in place, so
-- there is no window in which a table has no policy.

DO $$
DECLARE
  t text;
  visible_arm text;
  owned_arm   text;
  pred        text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Transaction', 'TransactionEvent', 'TransactionObservation',
    'PositionObservation', 'Holding', 'InvestmentEvent',
    'InvestmentEventCoverage', 'PositionCoverage', 'PositionReconstruction',
    'DebtProfile', 'AccountConnection', 'ProviderAccountIdentity', 'ImportBatch'
  ] LOOP
    -- Arm 1, unchanged in meaning: an ACTIVE link into a Space I can see.
    -- fm_visible_space_ids() stays a function call and must — it is SECURITY
    -- DEFINER, which is what breaks the SpaceMember self-reference, and the
    -- planner hoists `IN (SELECT …)` to a hashed SubPlan regardless.
    visible_arm := format(
      $f$EXISTS (SELECT 1 FROM "SpaceAccountLink" sal
                  WHERE sal."financialAccountId" = %1$I."financialAccountId"
                    AND sal.status = 'ACTIVE'
                    AND sal."spaceId" IN (SELECT fm_visible_space_ids()))$f$, t);

    -- Arm 2, new: I own the account. Mirrors FinancialAccount.fm_app_sel's
    -- first arm exactly, so the subtree now says what its root already said.
    owned_arm := format(
      $f$EXISTS (SELECT 1 FROM "FinancialAccount" fa
                  WHERE fa."id" = %1$I."financialAccountId"
                    AND fa."ownerUserId" = current_fm_user_id())$f$, t);

    pred := '(' || visible_arm || ' OR ' || owned_arm || ')';

    EXECUTE format('ALTER POLICY fm_app_sel ON public.%I USING %s',                 t, pred);
    EXECUTE format('ALTER POLICY fm_app_ins ON public.%I WITH CHECK %s',            t, pred);
    EXECUTE format('ALTER POLICY fm_app_upd ON public.%I USING %s WITH CHECK %s',   t, pred, pred);
    EXECUTE format('ALTER POLICY fm_app_del ON public.%I USING %s',                 t, pred);
  END LOOP;
END $$;
