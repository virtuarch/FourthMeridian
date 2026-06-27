**Status: SUPERSEDED.** The cross-owner re-share/reactivate behavior in §2/§3/§4 below was
rejected after this checklist was written — it would have let knowledge of a public wallet
address grant access to another user's private `FinancialAccount` data (transactions,
categories, notes, AI insights, goals). See
`D2_STEP1D_PROVIDER_ACCOUNT_IDENTITY_MULTI_ACCOUNT_CORRECTION.md` for the corrected model and
revised checklist. Kept here for historical record only — do not implement anything from this
document.

---

# D2 Step 2 — WALLET Dual-write Identities: Implementation Checklist

Checklist only. No code, schema, or migration changes in this document. Implements the
approved decisions from `D2_STEP2_WALLET_DUAL_WRITE_INVESTIGATION.md`: WALLET identity is
global (Decision 1), no signed-message ownership verification in this slice (Decision 2),
collision handling added at the wallet creation path (Decision 3), WALLET dual-write mirrors
PLAID where applicable (Decision 4). PLAID is not re-investigated or re-touched — it is
already shipped and validated (2A).

---

## 1. Pre-check: existing cross-owner wallet collisions

No code. Read-only SQL, run directly against the dev/staging database (this sandbox has no
live DB access, same limitation noted in every prior D2 step). This is the query
`D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` §B specified and flagged as never
having been run.

```sql
-- Active cross-owner collisions
SELECT "walletAddress",
       COUNT(*)                       AS account_count,
       COUNT(DISTINCT "ownerUserId")   AS distinct_owners,
       ARRAY_AGG(id)                   AS account_ids
FROM "FinancialAccount"
WHERE "walletAddress" IS NOT NULL AND "deletedAt" IS NULL
GROUP BY "walletAddress"
HAVING COUNT(*) > 1;

-- Cross-state collision: same address active for one row, archived for another
SELECT a."walletAddress", a.id AS active_id, b.id AS archived_id
FROM "FinancialAccount" a
JOIN "FinancialAccount" b
  ON a."walletAddress" = b."walletAddress" AND a.id <> b.id
WHERE a."deletedAt" IS NULL AND b."deletedAt" IS NOT NULL;
```

- [ ] Run both queries locally before touching any code below.
- [ ] Record the result (even "zero rows") — this is information the investigation explicitly
      said shouldn't be discovered mid-implementation.
- [ ] If collisions exist, list the affected `account_ids`. These rows are not bugs introduced
      by this slice — they're pre-existing data that Decision 1/3 means will start
      resolving (re-sharing) the next time either account is touched, once §2 ships.
- [ ] This pre-check does not gate §2/§3 (the route fix is correct regardless of today's
      collision count — it prevents new collisions and resolves existing ones on next touch
      either way). It does gate §5 (backfill needs the real exclusion set, not a guess).

## 2. Wallet route behavior on a cross-owner match

**File:** `app/api/accounts/wallet/route.ts`

**Decision: re-share / reactivate-and-share. Not reject. Not archive/repoint.**

- Reject is excluded by Decision 2 ("do not reject the current wallet UX for lack of
  signature proof").
- Archive/repoint is excluded on its own merits: a collision means two independently created
  `FinancialAccount` rows, each potentially with its own transaction/share history. Silently
  archiving either one would destroy a real user's visible account without consent — a much
  larger behavior change than anything decided here.
- Re-share (active match) and reactivate-and-share (archived match) already exist in this
  route today for the *same-owner* case. The only change is removing the `ownerUserId` filter
  that artificially limits them to same-owner — making WALLET matching global, consistent
  with `ProviderAccountIdentity`'s shipped unique constraint and with how the PLAID branch in
  `reconcile.ts` already behaves (unscoped).

Concretely:

- [ ] Active-match lookup (lines 52–55): drop `ownerUserId: userId` from the `where` clause.
      Becomes `{ walletAddress: walletAddress.trim(), deletedAt: null }`.
- [ ] Archived-match lookup (lines 127–130): same change, drop `ownerUserId: userId`.
- [ ] Leave the archived-duplicate **fold** check (lines 99–102, inside the active-match
      branch) scoped to `ownerUserId: userId` — unchanged. That check is "clean up the
      requesting user's own redundant archived row," not collision resolution; sweeping in a
      third party's archived account here would be a separate, unapproved behavior change.
- [ ] Add a code comment at both changed queries citing this checklist and Decisions 1–3, so
      a future reader doesn't "fix" this back to owner-scoped as an apparent bug.
- [ ] Confirm no new 409/conflict response exists anywhere in this route after the edit — the
      whole point is that a collision now resolves silently, same UX promise the route's
      header comment already makes for the same-owner case.

**State plainly (for the PR description, not just this doc):** once this ships, a user who
types in a wallet address already tracked by someone else gains live shared visibility into
that account — view access to its balance, transactions, and history — with no proof they
actually control the address. That is the explicit, approved tradeoff of Decision 2 + Decision
3 together, not a side effect to discover later.

## 3. Dual-write call sites

**File:** `app/api/accounts/wallet/route.ts`

Three call sites, one per branch — not one consolidated site like PLAID's. This is a
deliberate shape deviation, flagged in the investigation (§B): PLAID's three branches converge
on a single `fa` before one shared call; WALLET's three branches each `return` independently,
so each needs its own call to `dualWriteProviderAccountIdentity(financialAccountId,
ProviderType.WALLET, walletAddress.trim())`.

- [ ] Add import: `ProviderType` is **not currently imported** in this file (line 22 imports
      `AccountType, AccountOwnerType, ShareStatus, VisibilityLevel, DuplicateDetectionSource`
      only) — add `ProviderType` to that import.
- [ ] Add import: `dualWriteProviderAccountIdentity` from `@/lib/accounts/provider-identity`.
- [ ] Call site 1 — active-match branch: after the `mergeArchivedDuplicateIntoCanonical` fold
      (after line 110), before snapshot regen. Argument: `activeFa.id`. Self-heals any
      pre-existing active wallet account that predates this slice.
- [ ] Call site 2 — archived-match/reactivate branch: alongside the share upsert (after the
      `accountConnection.updateMany` reactivation, ~line 140). Argument: `archivedFa.id`.
- [ ] Call site 3 — create branch: after `financialAccount.create()` resolves (~line 207),
      alongside the new `AccountConnection` create. Argument: `fa.id`.
- [ ] No changes to `lib/accounts/provider-identity.ts` — `dualWriteProviderAccountIdentity()`
      is already provider-generic (its own header comment says so explicitly) and its
      try/catch is already non-fatal regardless of provider. Confirm by reading, don't assume.
- [ ] Confirm `connectionId` stays `null` in all three calls — the helper enforces this
      internally; there is no caller-side parameter to override it.

## 4. `reconcile.ts` changes

**File:** `lib/accounts/reconcile.ts`

- [ ] `findActiveAccountByIdentity()`'s WALLET branch (lines 116–123): drop
      `ownerUserId: identity.ownerUserId` from the `where` clause, for the same reason as §2 —
      consistency with the route-level fix, and consistency with how the PLAID branch directly
      above it in this same function already behaves (global, unscoped).
- [ ] Update the doc comment above the function (lines 76–85) — line 85 currently states "The
      WALLET branch is unchanged by this step" (referring to D2 Step 3D). Replace with a note
      pointing at this checklist.
- [ ] No change to the `ProviderIdentity` type's wallet variant (line 56) or
      `providerIdentityOf()` (lines 59–69). `ownerUserId` stays part of the identity's shape —
      it's still meaningful as "who created/holds this specific row." Only the *query filter*
      inside `findActiveAccountByIdentity` is dropped, not the field itself.
- [ ] Confirm `app/api/accounts/[id]/restore/route.ts`'s existing
      `ownerUserId !== user.id → 403` guard is unaffected — that guard checks permission on
      the row *being restored*, a different row than the one this lookup searches for. It
      stays exactly as-is; this change only widens which *other* row counts as an existing
      match.

**`mergeArchivedDuplicateIntoCanonical()` (lines ~335–432): no changes needed.** Already
confirmed, by direct read, fully owner-agnostic — it operates on two `FinancialAccount` ids
passed in by the caller and never reads or writes `ownerUserId` anywhere in its body. It moves
`Transaction`/`GoalContribution`/`DebtProfile`/`WorkspaceAccountShare` rows from loser to
winner and writes one `DuplicateAccountCandidate` audit row, regardless of who owns either
side. Nothing about making the lookups in §2/§4 global changes what this function itself does
— it only changes which rows get handed to it as loser/winner.

## 5. Backfill script — WALLET branch (Option B)

**File:** `scripts/backfill-provider-account-identity.ts`

Per `D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` §D: **Option B** — exclude
colliding addresses, backfill the rest. (Option C, "wait for dual-write," was correct *until*
this slice; this slice *is* that wait ending.)

- [ ] Add a pre-pass that computes the exclusion set directly: active `FinancialAccount` rows
      grouped by `walletAddress` where `COUNT(DISTINCT ownerUserId) > 1`. Compute this from
      the database on every run, rather than hand-copying §1's one-time result, so the script
      stays correct as new collisions are resolved by §2 or new ones appear before backfill
      runs again.
- [ ] For each active `FinancialAccount` with `walletAddress IS NOT NULL` and not in the
      exclusion set: candidate `{ financialAccountId, connectionId: null,
      provider: ProviderType.WALLET, externalAccountId: walletAddress }`.
- [ ] Reuse the existing `createMany({ skipDuplicates: true })` write path — no new write
      pattern, mirrors the PLAID branch already in this file.
- [ ] Update the module header comment (lines 8–12): remove "WALLET is explicitly deferred,"
      replace with the Option B exclusion rule and a pointer to this checklist.
- [ ] Report excluded addresses + distinct-owner counts in the run summary (both `--dry-run`
      and live), so an operator sees exactly what was skipped and why.
- [ ] Run this script *after* §2/§3 ship, not before — sequencing matters here: backfilling
      against the old owner-scoped behavior would capture a stale collision count.

Why a backfill is still needed even after §3's dual-write call sites ship: those call sites
only fire when an account is *touched again* (created, re-shared, reactivated). A wallet
account that sits untouched after this slice ships would never get a
`ProviderAccountIdentity` row without an explicit backfill — the dual-write and the backfill
cover different accounts, not the same ones twice.

## 6. Verify script — WALLET extension

**File:** `scripts/verify-provider-account-identity-backfill.ts`

Extends the 7-check design from `D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` §E.

- [ ] Extend the source-data load (currently lines 80–83, PLAID-only) to also load WALLET
      identities.
- [ ] **Check 1 (missing, real failure):** extend eligibility to active accounts with
      `walletAddress IS NOT NULL` and not in the collision-exclusion set (same set §5 computes
      — factor into one shared helper if practical, not mandatory for this slice). Missing
      `ProviderAccountIdentity` row on an eligible WALLET account is a real failure, same
      treatment as PLAID.
- [ ] **Check 2 (duplicate per account, real failure):** extend the existing per-account
      duplicate check to WALLET identities.
- [ ] **Check 3 (mismatch, real failure):** compare `identity.externalAccountId` against
      `account.walletAddress` for WALLET rows. Per 1C-C §A, `walletAddress` is immutable
      post-create, so this should never drift — checked directly rather than assumed, same
      stated philosophy as the existing PLAID check 3 comment (lines 21–27).
- [ ] **Check 4 (global uniqueness):** no code change — already provider-generic (operates on
      `allIdentities` across all providers, lines 135–153). Confirm by re-running once WALLET
      rows exist.
- [ ] **Check 5 (orphaned, informational):** currently filters `plaidIdentities` only (line
      156) — this is itself a latent PLAID-only gap, not just a WALLET-readiness gap.
      Generalize to all identities, any provider.
- [ ] **Check 6 (known exceptions, informational):** update the WALLET sub-bucket (currently
      lines 169, 174 — `walletForNow`) to distinguish backfilled vs. collision-excluded,
      rather than reporting all WALLET accounts as one undifferentiated "for now" bucket.
- [ ] **Check 7 (new, informational/monitoring):** standing cross-owner collision monitor,
      independent of backfill state — active `FinancialAccount` rows grouped by
      `walletAddress` where `COUNT(DISTINCT ownerUserId) > 1`. Always printed, never sets
      `failed = true`. This is the structural risk named in 1C-C §B/E; surfacing it on every
      run means it's never silently forgotten even as §2's route fix resolves individual cases
      over time.
- [ ] Update the module header comment (lines 9–12): remove "WALLET accounts are reported as a
      known exception... WALLET backfill hasn't happened yet," replace with the actual new
      scope.

---

## Schema / migration required?

**No.**

- `ProviderAccountIdentity.@@unique([provider, externalAccountId])` (schema.prisma:557) is
  already global — this already matches Decision 1 exactly, shipped in Step 1B. Nothing to
  add.
- `FinancialAccount.walletAddress` (schema.prisma:662) should **not** get a new `@unique` or
  composite-unique constraint, and this is worth pushing back on explicitly because it's the
  obvious-looking "fix": a DB-level unique constraint would make the *first* `create()` win
  and the *second* throw at the database layer — turning every cross-owner collision into a
  hard error, which directly contradicts Decision 2/3 (re-share, not reject). The whole point
  of §2's application-layer lookup-before-create change is that, once it ships, the colliding
  `create()` is never attempted in the first place — the route finds the existing row first
  and branches into re-share. Enforcement belongs at the app layer here, not the DB layer,
  because the desired outcome on collision is "find and share," not "reject."
- No new columns: `connectionId` stays `null` (Decision 4), `createdByUserId` already exists
  (D11), nothing else is referenced by this slice.

`npx prisma generate` and `npx prisma migrate dev` are still run per the standing validation
list below — a clean run with no proposed diff is the actual confirmation that this claim
holds, not an assumption to skip.

## Files expected to change

| File | Change |
|---|---|
| `app/api/accounts/wallet/route.ts` | Active/archived-match lookups go global (drop `ownerUserId`); add `ProviderType` import; 3 new `dualWriteProviderAccountIdentity` call sites |
| `lib/accounts/reconcile.ts` | `findActiveAccountByIdentity`'s WALLET branch (lines 116–123) drops the `ownerUserId` filter; doc-comment update |
| `scripts/backfill-provider-account-identity.ts` | New WALLET branch, Option B collision exclusion; header-comment update |
| `scripts/verify-provider-account-identity-backfill.ts` | New WALLET coverage in checks 1–3 and 6; check 5 generalized beyond PLAID-only; new check 7; header-comment update |

**Not expected to change:** `lib/accounts/provider-identity.ts` (already provider-generic, no
signature change needed — confirmed by direct read of its header and body);
`prisma/schema.prisma` (no schema change, see above); `app/api/plaid/exchange-token/route.ts`
(PLAID-only, already shipped and validated — out of scope per "do not re-investigate PLAID");
`app/api/accounts/[id]/restore/route.ts` and `app/api/accounts/manual/[id]/restore/route.ts`
(consume `findActiveAccountByIdentity`/`providerIdentityOf` but need no edits themselves — the
restore route's own permission guard on the row being restored is on a different row than the
one §4's lookup change affects; the manual restore route is already ruled out as inapplicable
to wallets per 1C-C §C).

## Validation strategy

Standing validation, run in order:
- [ ] `npx prisma generate`
- [ ] `npx prisma migrate dev` — expect no proposed migration; a non-empty diff here is a stop
      signal, not something to accept and continue past.
- [ ] `npx tsc --noEmit`
- [ ] `npm run lint`

Targeted manual/fixture validation (no automated test framework exists for this pipeline
today — consistent with how every prior D2 step has been validated):
- [ ] §1's pre-check queries, run before any code change, result recorded.
- [ ] Two-user functional test: User A creates a wallet account with address X. User B (a
      different account) submits the same address X via `POST /api/accounts/wallet`. Expect:
      `200`, not `409`; User B's space gains a `WorkspaceAccountShare` + `SpaceAccountLink`
      pointing at the **same** `FinancialAccount.id` User A has; no second `FinancialAccount`
      row created; `SpaceSnapshot` regenerates for both users' spaces without error.
- [ ] Same scenario with User A's account archived first — confirm User B's submission
      reactivates User A's existing row (not a new create) and shares it into User B's space.
- [ ] Confirm User A's own data (transactions, goal contributions, debt profile) remains
      visible to User A after User B's reshare — re-share must not change ownership or strip
      User A's access.
- [ ] Idempotency: same user submits the same address twice in a row (active-match branch
      hit twice) — confirm the second call doesn't create a second
      `ProviderAccountIdentity` row, for WALLET specifically (the helper's idempotency was
      previously validated for PLAID only).
- [ ] `scripts/backfill-provider-account-identity.ts --dry-run` first; confirm reported
      "would insert" / excluded counts line up with §1's findings before running it live.
- [ ] `scripts/verify-provider-account-identity-backfill.ts`, before and after the backfill
      runs; confirm check 7's collision monitor reports the same accounts §1's manual query
      found — cross-checking the two independent code paths agree.

## Rollback plan

**Not symmetric with PLAID's (2A) rollback** — flagged explicitly in the investigation (§E)
and still true. Two separately revertible pieces:

1. **The identity-table write** (§3 call sites, §5/§6 script changes): pure code/script
   revert. `DELETE FROM "ProviderAccountIdentity" WHERE provider = 'WALLET';` stays safe and
   reversible — nothing reads the table for WALLET yet (Step 3 WALLET read cutover hasn't
   started and is blocked on this same work).
2. **The collision-handling behavior change** (§2/§4's global lookups): reverting this
   restores owner-scoped matching, but does **not** undo any re-share/reactivation that
   already happened for real users while the global behavior was live. If User B already
   gained shared visibility into User A's account before a revert lands, that
   `WorkspaceAccountShare`/`SpaceAccountLink` row still exists afterward — a code revert stops
   *future* cross-owner shares, it does not retroactively revoke ones already granted.

- [ ] Keep §2/§4 (collision handling) and §3 (dual-write call sites) as separately revertible
      commits, so either can come back out without the other if a problem is isolated to just
      one half.
- [ ] If a live problem is found and a full revert is overkill: re-adding the `ownerUserId`
      filter to the two lookups (§2, §4) is a two-line, low-risk mitigation that disables
      future cross-owner sharing while leaving the dual-write/backfill/verify work intact.
- [ ] Document in the PR/commit description that reshare grants already made before any
      rollback are not automatically revoked — undoing a specific unwanted cross-owner share
      after the fact would need a manual admin/support action, not a code revert.

---

Stopping here. No code, schema, or migration changes have been made. Awaiting approval to
implement.
