# Bugfix investigation: `/api/plaid/refresh` calls Plaid for PlaidItems with no active linked account

Status: **implemented (Steps A, C, D) and confirmed not-needed (Step B), per explicit approval. No schema/migration changes. Code-level validation (`tsc`, `lint`) passed in-sandbox; live-DB validation (Steps 4-10 of the plan below) still needs to run against Preview — see "Implementation report" at the end of this document.**
Bugfix track, separate from D2 Step 2 (provider identity / WALLET dual-write). D2 Step 2 remains paused and untouched by this implementation.

This document is **separate from and does not restate** `BUGFIX_PLAID_PREVIEW_LINK_TOKEN_AND_REFRESH_FAILURES.md`. That document's `link-token` / `PLAID_REDIRECT_URI` conclusions stand unchanged. This document narrows in on one specific mechanism behind the `refresh` `/accounts/get` 400 that the architecture context (Preview now has its own Plaid credentials and its own database) ruled in: stale `PlaidItem` rows left over from before Preview had its own isolated setup, or created by an in-app data path that never closes them out.

## Architecture context supplied for this investigation

Preview uses its own Plaid credentials and its own database. Some archived `FinancialAccount` rows in the Preview DB still carry real institution/account identifiers (legacy leftovers from before Preview was isolated), but no currently-active Preview account should be using real/non-preview data. Desired refresh behavior going forward:

- PlaidItems with no active linked `FinancialAccount` — should not continue refreshing; skip or mark inactive; no user-facing warning needed.
- PlaidItems with an active linked `FinancialAccount` — should always attempt refresh; errors like `ITEM_LOGIN_REQUIRED` / `INVALID_ACCESS_TOKEN` must surface as real reconnect/attention-needed states, never silently suppressed.

## 1. Does `/api/plaid/refresh` currently include PlaidItems whose linked FinancialAccounts are archived or deleted?

**Yes, confirmed from code.**

`refreshAllActiveItemsForUser()` in `lib/plaid/refresh.ts` selects candidates with:

```ts
const items = await db.plaidItem.findMany({
  where:  { userId, status: PlaidItemStatus.ACTIVE },
  select: { id: true, institutionName: true },
});
```

This is the only filter — `status: ACTIVE` on `PlaidItem` itself. There is no join or exists-check against `AccountConnection.deletedAt` or `FinancialAccount.deletedAt`. `refreshPlaidItem()` then unconditionally decrypts the token and calls `plaidClient.accountsGet({ access_token })` before any per-account archived check runs. The existing `if (!fa || fa.deletedAt) continue;` guard later in that function only controls whether a balance/holding *write* happens — it does not prevent the Plaid call itself. So a `PlaidItem` with zero live accounts still produces a live Plaid API call on every refresh cycle, indefinitely, until something changes its `status`.

**Concrete mechanism that produces such PlaidItems**, found in `lib/accounts/reconcile.ts`. `pickCanonicalAndMerge()` handles automatic duplicate consolidation (sibling `FinancialAccount` rows matching the same fingerprint, e.g. Plaid reissuing a new `account_id` for the same real-world account across relinks):

```ts
for (const c of candidates) {
  if (c.id === canonical.id) continue;
  await mergeArchivedDuplicateIntoCanonical(c.id, canonical.id, DuplicateDetectionSource.SIBLING_CONSOLIDATION, spaceId);
  if (!c.deletedAt) {
    // Was active under a different plaidAccountId — archive it.
    await db.financialAccount.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
  }
}
```

This sets `FinancialAccount.deletedAt` directly. It does not soft-delete the loser's `AccountConnection` row(s), and it does not call `disconnectPlaidItemIfOrphaned()`. `disconnectPlaidItemIfOrphaned()` (`lib/plaid/disconnect.ts`) is the **only** code path in the repository that ever sets `PlaidItem.status = REVOKED` (it counts live `AccountConnection` rows for the item and, if zero, calls Plaid's `itemRemove` and flips status). It is called from exactly one call site: the `DELETE /api/accounts/[id]` route. Confirmed via repo-wide grep — no other call site exists, and no other code writes `PlaidItemStatus.REVOKED`.

Net effect: any `FinancialAccount` archived through `reconcile.ts`'s sibling-consolidation path keeps a live `AccountConnection` row (`deletedAt: null`) pointing at a `PlaidItem` that keeps `status: ACTIVE` forever. `refreshAllActiveItemsForUser` has no way to know the account behind it was archived, and will call `accountsGet` for it on every run. This matches the reported shape of the problem: old accounts with real institution/account identifiers, presumably archived this way before or during Preview's credential separation, still sitting in `ACTIVE` status and still being hit by refresh.

(Checked for other automated archival paths: `DuplicateAccountCandidate` is referenced only in `prisma/seed.ts` and `lib/accounts/reconcile.ts` — there is no separate admin/audit-UI route that also archives accounts outside of this one function.)

## 2. Should refresh automatically skip PlaidItems that no longer have any active linked FinancialAccount?

**Yes.** This matches the stated long-term direction directly ("archived/stale connections should quietly fall out of the refresh pipeline"). Recommended shape, not yet implemented:

- Add an exists-check — at least one `AccountConnection` with `deletedAt: null` whose linked `FinancialAccount.deletedAt` is also `null` — either as a filter in `refreshAllActiveItemsForUser`'s query, or as an early return at the top of `refreshPlaidItem()` before decrypt/`accountsGet` is reached. No user-facing warning, consistent with the stated spec.
- Self-heal the status while there: once an item is confirmed to have no live accounts, this is the natural point to call the existing `disconnectPlaidItemIfOrphaned()` (or an equivalent lighter-weight "mark inactive" path) so the item drops out of the cheap `status: ACTIVE` query on every subsequent refresh, rather than re-running the exists-check every single cycle.
- This guard must not touch the second case from the architecture context — PlaidItems with at least one live account must always attempt refresh, and any `ITEM_LOGIN_REQUIRED` / `INVALID_ACCESS_TOKEN` / permission error from Plaid for those must continue to propagate as a real, surfaced failure (already partially handled — `lib/plaid/errors.ts` maps `ITEM_LOGIN_REQUIRED` to a user-facing message). Building this guard is a precondition for the separately-stated "health state" direction (healthy / needs-reconnect / sync-failed), not a replacement for it — this fix only stops calling Plaid for items nobody should be checking, it doesn't yet add the health-state surface itself.

## 3. Is the correct fix data cleanup, a code guard, or both?

**Both — neither alone resolves this.**

- **Code guard (prevents recurrence).** `lib/accounts/reconcile.ts`'s sibling-consolidation branch needs to soft-delete the loser's `AccountConnection` row(s) and call `disconnectPlaidItemIfOrphaned()` for any Plaid-backed loser, mirroring what `DELETE /api/accounts/[id]` already does correctly. Defense-in-depth: `refreshAllActiveItemsForUser`/`refreshPlaidItem` should independently verify at least one live linked account exists before calling Plaid, regardless of `PlaidItem.status` — this protects against any other archival path (D1 duplicate-audit work, ad-hoc scripts, manual DB edits) making the same mistake in the future.
- **Data cleanup (fixes what already exists).** The code guard only stops new occurrences. Existing `PlaidItem` rows already sitting at `status: ACTIVE` with zero live accounts — the ones surfacing the reported real institution/account identifiers in Preview — need a one-time pass: find every `PlaidItem` with `status: ACTIVE` and zero non-deleted `AccountConnection` rows joined to a non-deleted `FinancialAccount`, and run the same disconnect logic (`itemRemove` + `status: REVOKED`) against each, exactly as if a user had just archived their last account through the normal route. This is the same shape as the existing `scripts/backfill-provider-account-identity.ts` + `scripts/verify-provider-account-identity-backfill.ts` pair — a small one-off script plus a verify script, matching established project convention.
- Code guard without cleanup leaves today's bad `PlaidItem.status` values lying about reality indefinitely. Cleanup without the code guard fixes today's data but the next sibling-consolidation merge recreates the same hole.

## 4. Relationship to the link-token investigation

Kept fully separate, per instruction. `BUGFIX_PLAID_PREVIEW_LINK_TOKEN_AND_REFRESH_FAILURES.md`'s `link-token` / `PLAID_REDIRECT_URI` conclusions are untouched by this document. That document's section 3 also raised an `INVALID_ACCESS_TOKEN` (cross-environment token) hypothesis for the `refresh` 400 — this document does not replace that hypothesis, it adds a second, code-confirmed mechanism that can independently produce 400s on `accountsGet` (orphaned-but-`ACTIVE` PlaidItems) regardless of which Plaid environment Preview's credentials point at. Both can be true at once; the original raw `error_code` in the Vercel logs (`ITEM_LOGIN_REQUIRED` / `INVALID_ACCESS_TOKEN` vs. something else) is still the fastest way to tell which one(s) are firing in the current Preview logs.

## Recommendation: standalone bugfix slice before resuming D2

**Yes — recommend treating this as its own small, standalone bugfix slice before D2 Step 2 resumes.**

- It is a concrete, code-confirmed correctness gap, not speculation — `pickCanonicalAndMerge()` demonstrably archives `FinancialAccount` rows without closing out the corresponding `AccountConnection`/`PlaidItem`.
- It is small and additive: one disconnect call added to `reconcile.ts`'s merge path, one exists-guard added to `refresh.ts`, one cleanup script + verify script — consistent with "do not implement all decisions in one branch or commit" and "keep changes additive before subtractive."
- It sits squarely inside the spirit of D8 (lifecycle consistency) — `PlaidItem.status` not reflecting whether the item has any live account is exactly a lifecycle-consistency defect — and is a concrete blocker discovered during D2 work, which the project's own rules carve out as a legitimate reason to address something outside strict decision order ("do not re-litigate approved decisions unless implementation reveals a concrete blocker").
- It directly affects the ability to cleanly validate D2 Step 2 in Preview: noisy `accountsGet` 400s from stale items make it harder to tell D2-caused refresh failures apart from this pre-existing gap.

Proposed slice scope, for a future implementation checklist (not started — investigation only):
1. Code guard in `lib/accounts/reconcile.ts` (close out `AccountConnection`/`PlaidItem` on sibling-consolidation archive).
2. Code guard in `lib/plaid/refresh.ts` (skip/self-heal PlaidItems with no live account).
3. One-off cleanup script + verify script for existing orphaned-but-`ACTIVE` PlaidItem rows in Preview's DB.

No code, schema, or migration changes have been made. This stays a recommendation pending explicit approval, per the working style already established for this project (checklist first, wait for approval, then implement one decision/slice at a time).

## Affected files (read-only, for reference — none modified)

`lib/plaid/refresh.ts`, `lib/plaid/disconnect.ts`, `lib/accounts/reconcile.ts`, `app/api/accounts/[id]/route.ts`, `app/api/plaid/refresh/route.ts`, `prisma/schema.prisma` (`PlaidItemStatus`, `AccountConnection`, `FinancialAccount` models — read only, not edited), `scripts/` (listed only, for convention reference). D2 Step 2 / WALLET dual-write code was not touched.

## Note: `[plaid][D2-3E] ProviderAccountIdentity miss, legacy plaidAccountId hit` is a separate, expected signal — not part of this bug

A retest of `/api/plaid/refresh` on another Preview sandbox account returned `200` and synced successfully; the remaining log noise was this warning, emitted from `lib/plaid/refresh.ts:117` and `:183`. This is **not** part of the orphaned-`PlaidItem` defect described above, and is **not a refresh bug** — it is intentional, documented D2 Step 3E behavior: every D2 read-cutover site (`exchange-token` D2-3C/3F, `reconcile.ts` D2-3D, `refresh.ts` D2-3E, `syncTransactions.ts` D2-3F) tries `ProviderAccountIdentity` first and falls back to the legacy `FinancialAccount.plaidAccountId` lookup, logging a warning whenever the fallback fires, precisely so coverage gaps stay visible instead of silently passing — see `docs/initiatives/d2/D2_STEP3A_PROVIDER_ACCOUNT_IDENTITY_READ_CUTOVER_INVESTIGATION.md` ("Risk 1 — coverage gaps") and `D2_STEP3E_REFRESH_READ_CUTOVER_IMPLEMENTATION.md`.

## Follow-up: explaining the verify-PASS vs. refresh-warning contradiction for two specific accounts

A run of `scripts/verify-provider-account-identity-backfill.ts --verbose` against Preview returned PASS (20 eligible PLAID accounts, 0 missing, 0 mismatches, 0 duplicates). A refresh immediately afterwards still logged the D2-3E fallback warning for two specific accounts: `financialAccountId=cmqqllcj6002inlk20bmuvval` and `financialAccountId=cmqqllcmk002qnlk237wc3nce`. This is not actually a contradiction once the two checks' scopes are compared — they are answering different questions over different sets of rows.

**1. Active or archived?** Cannot be queried directly from this sandbox (no live DB credentials here — same constraint noted in `D2_STEP3E_REFRESH_READ_CUTOVER_IMPLEMENTATION.md`), but it can be derived logically from the evidence already given, with no gap: **both must be archived (`deletedAt IS NOT NULL`).** Proof: the warning only fires from the `if (!fa)` branch in `lib/plaid/refresh.ts:113-119` (and `:175-186`), reached only after `db.financialAccount.findUnique({ where: { plaidAccountId: acct.account_id } })` succeeded — `findUnique` on a unique column means each account's current `plaidAccountId` is non-null and equals the live `account_id` Plaid just returned. So both accounts satisfy `plaidAccountId IS NOT NULL`. The verify script's eligible-PLAID set (`scripts/verify-provider-account-identity-backfill.ts:148`) is `deletedAt IS NULL AND plaidAccountId IS NOT NULL`, and it reported exactly 20 eligible accounts with 0 missing. If either of these two accounts were active, it would necessarily have been counted in that 20 and flagged as missing (see point 2) — contradicting the reported PASS. The only way to satisfy both facts at once is `deletedAt IS NOT NULL` for both. Empirical confirmation, if wanted: `select id, "deletedAt", "plaidAccountId" from "FinancialAccount" where id in ('cmqqllcj6002inlk20bmuvval','cmqqllcmk002qnlk237wc3nce');`

**2. Do they have ProviderAccountIdentity rows?** No — proven directly by the warning itself, not inferred. The warning is only reachable when `db.providerAccountIdentity.findFirst({ where: { provider: PLAID, externalAccountId: acct.account_id } })` (`refresh.ts:107-110` / `:170-173`) returned no row at all for that exact `externalAccountId`. So no `ProviderAccountIdentity` row exists anywhere pointing at the current `plaidAccountId` value for either account — not a stale/mismatched row, an absent one.

**3. (If they had rows) why would refresh miss them?** Doesn't apply here — point 2 establishes the rows don't exist, so there's no mismatch/staleness to explain on that side.

**4. Why did the verification script pass despite the missing rows?** Because the script's Check 1 (`verify-provider-account-identity-backfill.ts:146-148`) deliberately scopes "eligible" to `deletedAt IS NULL`, and archived accounts are explicitly, intentionally out of scope — not a script bug. This mirrors a documented design decision in `docs/initiatives/d2/D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md`: "PLAID, archived (`deletedAt IS NOT NULL`) → No (deferred) → Stale `plaidAccountId` values from pre-reissue history... Backfilling these risks writing identities for rows already merged away by `reconcile.ts`. Rule: scope PLAID backfill to `deletedAt IS NULL` only." The backfill script (`scripts/backfill-provider-account-identity.ts:94`) enforces the identical `deletedAt: null` filter at the write side. So these two accounts almost certainly predate that backfill's scope decision, or were archived before/without ever running through it — by design, they were never going to get a `ProviderAccountIdentity` row while archived, and the verify script — built to check the same scope the backfill targets — correctly does not flag their absence as a failure.

**5. Exact query/path divergence.** Two structurally different queries, looking at two different sets of rows, both correct for what each is designed to check:
- Verify script: starts from `FinancialAccount` rows filtered to `deletedAt IS NULL AND plaidAccountId IS NOT NULL`, then checks each has a matching `ProviderAccountIdentity` row. Archived rows are excluded from the start — by design (per D2 Step 1C-A above).
- `refresh.ts`: starts from whatever Plaid's live `accountsGet`/`investmentsHoldingsGet` response returns for a given `PlaidItem` (no awareness of our `deletedAt` flag at all at the point of lookup), tries `ProviderAccountIdentity` by `externalAccountId`, and falls back to `financialAccount.findUnique({ where: { plaidAccountId } })` — which also carries **no `deletedAt` filter** — before finally checking `fa.deletedAt` only to decide whether to *write* an update (`refresh.ts:124`), by which point the warning has already been logged.

Net cause: these two accounts are archived, were never in scope for the `ProviderAccountIdentity` backfill (intentionally, per the D2 Step 1C-A archived-exclusion rule), and their `PlaidItem` is still `status: ACTIVE` (the same orphaned-`PlaidItem` gap documented above in this file) — so Plaid keeps returning live data for them on every refresh, `refresh.ts`'s legacy-fallback lookup (which is unfiltered on `deletedAt`) keeps finding and matching them, and the warning keeps firing — correctly logging a real, if currently harmless (no write occurs), coverage gap that only exists because of archived rows, which is exactly the case the verify script was designed to not count as a failure. This is the same root architectural issue as the orphaned-`PlaidItem` finding above, one level deeper: fixing that gap (closing out `AccountConnection`/`PlaidItem` on archive, per Section 3 of this document) would also stop these two D2-3E warnings, since the `PlaidItem` would stop being refreshed at all once correctly disconnected. No separate identity-layer fix is implicated — `ProviderAccountIdentity`/the backfill/verify scripts are all behaving exactly as designed.

**Revised conclusion, superseding the paragraph above this section:** the follow-up analysis for the two specific accounts (`cmqqllcj6002inlk20bmuvval`, `cmqqllcmk002qnlk237wc3nce`) shows this particular pair is **not** an identity coverage/backfill defect — `ProviderAccountIdentity`, the backfill script, and the verify script are all behaving exactly per their documented design (archived rows are deliberately out of scope for all three). It is the orphaned-`PlaidItem` issue from earlier in this document, observed from a second angle: an archived `FinancialAccount` whose `PlaidItem` is still `status: ACTIVE` gets live Plaid data on every refresh, and the unfiltered legacy-fallback lookup in `refresh.ts` matches it and warns. The Section 3 fix (close out `AccountConnection`/`PlaidItem` on archive, plus the refresh-time exists-guard) resolves this pair as a side effect — no separate identity-layer fix is needed for these two specifically.

That said, the broader "D2-3E fires for archived accounts that predate or fall outside the backfill's `deletedAt IS NULL` scope" pattern described in the paragraph above can still occur independently of the orphaned-`PlaidItem` gap (e.g. for an archived account whose `PlaidItem` *was* correctly disconnected, if some other code path ever re-included it) — so re-running the verify script periodically remains good practice, but it is not the lead explanation for these two IDs:

```
npx tsx scripts/verify-provider-account-identity-backfill.ts --verbose
```

No fix is proposed here — this section is investigation only. `link-token`'s `PLAID_REDIRECT_URI`/config investigation remains entirely separate from both this note and the orphaned-`PlaidItem` finding above.

---

## Implementation checklist (pending approval — no code written yet)

Confirmed root cause: a lifecycle gap, not an identity/backfill issue, not a Plaid credential issue, not D2 Step 2/WALLET. `lib/accounts/reconcile.ts`'s sibling-consolidation path archives a `FinancialAccount` without closing out its `AccountConnection`/`PlaidItem`, so the `PlaidItem` stays `status: ACTIVE` forever and `refresh.ts` keeps calling Plaid for it. Two confirmed Preview instances: `cmqqllcj6002inlk20bmuvval`, `cmqqllcmk002qnlk237wc3nce`.

**Explicitly out of scope for this slice:** schema changes, migrations, D2 Step 2 / WALLET dual-write, `link-token` / `PLAID_REDIRECT_URI`, creating `ProviderAccountIdentity` rows for archived accounts, any UI changes, any "health state" surface (healthy/needs-reconnect/sync-failed) — this slice only stops Plaid calls for accounts nobody should be checking; it doesn't add the health-state UI layer.

### Step A — close the gap at the source: `lib/accounts/reconcile.ts`

- In `pickCanonicalAndMerge()` (currently lines 218-253), inside the loop that archives a loser (`if (!c.deletedAt) { ... }`, line 245-249), before/alongside setting `FinancialAccount.deletedAt`:
  - Fetch the loser's live `AccountConnection` rows (`where: { financialAccountId: c.id, deletedAt: null }`, selecting `id` and `plaidItemDbId`) — `CANDIDATE_SELECT` (line 150) doesn't carry this today, so this is a new query inside the loop, scoped to the one candidate being archived.
  - Soft-delete those `AccountConnection` rows (`updateMany({ where: { financialAccountId: c.id, deletedAt: null }, data: { deletedAt: new Date() } })`) — mirrors `app/api/accounts/[id]/route.ts` lines 157-160 exactly.
  - For each distinct non-null `plaidItemDbId` found, call `disconnectPlaidItemIfOrphaned(plaidItemDbId)` (import from `@/lib/plaid/disconnect`, same as `app/api/accounts/[id]/route.ts` line 25) — same call-after-soft-delete ordering as lines 203-209 of that route, so the orphan count it computes is accurate.
  - This function is also called from `resolveAccountByFingerprint`'s caller path and from the restore route's merge path (`mergeArchivedDuplicateIntoCanonical` → eventually reaches `pickCanonicalAndMerge` in some call chains) — confirm via the function's actual call graph whether the same loop is reached from `app/api/accounts/[id]/restore/route.ts`'s `mergeArchivedDuplicateIntoCanonical` call (line 131) before/separately from `pickCanonicalAndMerge`, so the fix isn't duplicated or missed on that path. (`mergeArchivedDuplicateIntoCanonical` itself only moves history — confirmed in the prior investigation it never touches `AccountConnection`/`PlaidItem` — so the restore route's direct call at line 131 needs the same treatment if it can ever leave behind a loser with live connections. Needs a quick read of `mergeArchivedDuplicateIntoCanonical`'s full body before implementation to confirm whether it ever archives a *second* row beyond the one passed in.)
  - No effect on WALLET-backed losers — `plaidItemDbId` will be null for those, loop is a no-op for them (WALLET has no `PlaidItem` concept). Confirms no D2 Step 2/WALLET touch.

### Step B — restore-flow consistency check (read-only check, not a change)

- `app/api/accounts/[id]/restore/route.ts` already restores `AccountConnection.deletedAt` (lines 152-156) but explicitly does **not** attempt to revive a `REVOKED` `PlaidItem` (by design — header comment lines 34-41: re-linking via Plaid Link is the intended path back). Once Step A makes `pickCanonicalAndMerge` correctly revoke `PlaidItem`s for sibling-consolidated losers, restoring one of those losers will behave exactly like restoring a normally-deleted Plaid account already does today — no new code needed here, just confirm during validation (see below) that restoring a Step-A-archived account doesn't error and correctly leaves the `PlaidItem` revoked/requiring relink rather than silently reactivating a dead token.

### Step C — guard in `lib/plaid/refresh.ts`

- `refreshAllActiveItemsForUser()` (currently lines ~84-95 per the query shown in the investigation): keep the `status: ACTIVE` filter, add an exists-check for at least one live linked account before including a `PlaidItem` in the refresh batch. Two implementation options to choose between at checklist-approval time (not deciding now): (1) add a `where` clause using a relation `some` filter directly in the `findMany`, if `PlaidItem`'s schema has (or can have, without a migration — confirm via existing relations) a reverse relation to `AccountConnection`/`FinancialAccount` usable in a `some: { deletedAt: null, financialAccount: { deletedAt: null } }` filter; or (2) keep the query as-is and add a cheap existence check per item before calling `refreshPlaidItem()`, skipping (no warning, per the original spec) and triggering `disconnectPlaidItemIfOrphaned()` inline if the check fails, so the item self-heals out of future `status: ACTIVE` queries instead of re-checking every cycle.
- Apply the same exists-check inside `refreshPlaidItem()` itself (top of the function, before `decrypt()`/`accountsGet()` at current lines ~84-95), since it can also be called directly for a single item (`app/api/plaid/refresh/route.ts`'s single-item path), not only via `refreshAllActiveItemsForUser`.
- Must not change behavior for any `PlaidItem` with at least one live linked account — those continue straight through to `accountsGet`/`investmentsHoldingsGet`/sync exactly as today, including full propagation of `ITEM_LOGIN_REQUIRED` / `INVALID_ACCESS_TOKEN` / permission errors (no new try/catch swallowing introduced — confirm by diffing only the lines added, not the existing error-handling block).
- This guard is what makes the D2-3E warning disappear naturally (per the explicit requirement): once a `PlaidItem` with no live account is skipped before the Plaid call, its accounts are never iterated, so the `providerAccountIdentity.findFirst` / legacy-fallback lookup at lines 107-119 and 170-186 never runs for them at all — not because the warning is suppressed, but because the code path that logs it is never reached for archived accounts.

### Step D — one-time cleanup script for existing orphaned data

- New script, modeled directly on `scripts/backfill-provider-account-identity.ts` + `scripts/verify-provider-account-identity-backfill.ts`'s pairing convention:
  - `scripts/cleanup-orphaned-plaid-items.ts` — read-write, one-time. Query: every `PlaidItem` with `status: ACTIVE` and zero `AccountConnection` rows satisfying `deletedAt: null AND financialAccount.deletedAt: null` (i.e., either no live connection at all, or its only connections point at archived accounts). For each, soft-delete any remaining non-deleted `AccountConnection` rows pointing at already-archived `FinancialAccount`s (the data-only half of Step A's gap, already-existing bad data) and call `disconnectPlaidItemIfOrphaned()`. Dry-run by default (`--apply` flag required to write, matching the project's general caution around one-off scripts); log every `PlaidItem.id` + affected `FinancialAccount.id`s either way.
  - `scripts/verify-orphaned-plaid-items.ts` (or extend the existing verify script with an additional informational check, decide at implementation time which is less invasive) — read-only, confirms zero `PlaidItem` rows remain at `status: ACTIVE` with no live linked account, post-cleanup.

### Step E — verification script / SQL checks

- Ad-hoc SQL for manual spot-checks during and after implementation (no schema change, read-only):
  ```sql
  -- PlaidItems with status ACTIVE but no live AccountConnection -> live FinancialAccount
  SELECT pi.id, pi."institutionName", pi.status
  FROM "PlaidItem" pi
  WHERE pi.status = 'ACTIVE'
    AND NOT EXISTS (
      SELECT 1 FROM "AccountConnection" ac
      JOIN "FinancialAccount" fa ON fa.id = ac."financialAccountId"
      WHERE ac."plaidItemDbId" = pi.id AND ac."deletedAt" IS NULL AND fa."deletedAt" IS NULL
    );
  ```
  Expected result: non-empty before Step D's cleanup runs, empty immediately after, and should stay empty going forward once Steps A and C are deployed (re-run periodically, e.g. alongside the existing identity-backfill verify script, as a cheap regression check).
- Confirm the two known accounts (`cmqqllcj6002inlk20bmuvval`, `cmqqllcmk002qnlk237wc3nce`) appear in this query's result set before the fix and disappear after.

### Validation plan

1. `npx prisma generate` — no schema changed, but run anyway per project convention to catch any accidental drift.
2. `npx tsc --noEmit` — confirm the new/changed functions in `reconcile.ts`, `refresh.ts`, and the two new scripts type-check cleanly.
3. `npm run lint`.
4. Run the SQL check from Step E before any code change to capture the current baseline count (expect ≥2, including the two known IDs).
5. Run `scripts/cleanup-orphaned-plaid-items.ts` in dry-run mode against Preview, confirm the two known `FinancialAccount` IDs' `PlaidItem`s are correctly identified; then run with `--apply`.
6. Re-run the Step E SQL check — expect zero rows.
7. Re-run `scripts/verify-provider-account-identity-backfill.ts --verbose` — expect unchanged PASS (this fix doesn't touch `ProviderAccountIdentity` at all).
8. Trigger `/api/plaid/refresh` for a user who has both (a) a healthy active Plaid-linked account and (b) one of the now-cleaned-up archived accounts' former item — confirm no D2-3E warning and no Plaid call logged for the archived item, and confirm the active item still refreshes normally (balance/holdings/transactions updated).
9. Negative-path check: pick (or simulate via sandbox) an active linked account whose Plaid item is in a real bad state (e.g. revoke test-bank credentials in Plaid's sandbox to force `ITEM_LOGIN_REQUIRED`), confirm refresh still calls Plaid for it, the error still surfaces (not swallowed), and `lib/plaid/errors.ts`'s existing mapping still produces the expected user-facing state.
10. Exercise Step B manually: archive a sibling-consolidated account via the normal duplicate-merge flow, confirm its `PlaidItem` is now `REVOKED` and its `AccountConnection` is soft-deleted; then hit `POST /api/accounts/[id]/restore` for it and confirm it restores the `FinancialAccount`/`AccountConnection` without error and without attempting to re-activate the revoked `PlaidItem`.
11. Targeted route testing: `DELETE /api/accounts/[id]` and `app/api/accounts/manual/[id]/route.ts`'s delete path, to confirm those existing, already-correct flows are untouched by the `reconcile.ts` change.

### Rollback plan

- Steps A and C are small, additive code changes in two existing files (`lib/accounts/reconcile.ts`, `lib/plaid/refresh.ts`) — revertable with a single `git revert` of that commit, no data implications (the revert simply stops closing out connections/skipping refresh going forward; any `PlaidItem`/`AccountConnection` rows already corrected by Step D stay corrected, since `REVOKED`/soft-deleted states are inert and harmless either way).
- Step D's cleanup script is the only step with a write side-effect on existing data. Mitigation: dry-run-by-default, explicit `--apply` flag, full before/after logging of every affected `PlaidItem.id`/`FinancialAccount.id`. If a cleanup run incorrectly revokes a `PlaidItem` that did have a live account (a bug in the script's query), the realistic recovery path mirrors today's existing restore design: `AccountConnection.deletedAt` can be cleared back to `null` (cheap, reversible), but the Plaid `itemRemove()` call (if it reached Plaid) is not reversible — the user would need to relink via Plaid Link, exactly as already happens today for any legitimately-revoked item. This is why dry-run review before `--apply` is mandatory, not optional, and why this script should run against Preview first and be spot-checked against the two known IDs before ever considering Production data.
- No schema/migration to roll back in any step.

### Exact files expected to change

- `lib/accounts/reconcile.ts` — modify `pickCanonicalAndMerge()` (Step A).
- `lib/plaid/refresh.ts` — modify `refreshAllActiveItemsForUser()` and `refreshPlaidItem()` (Step C).
- `scripts/cleanup-orphaned-plaid-items.ts` — new file (Step D).
- `scripts/verify-orphaned-plaid-items.ts` — new file, or an extension of `scripts/verify-provider-account-identity-backfill.ts` (decide at implementation time) (Step D/E).
- No changes expected to: `app/api/accounts/[id]/route.ts`, `app/api/accounts/[id]/restore/route.ts`, `app/api/accounts/manual/[id]/route.ts`, `lib/plaid/disconnect.ts`, `prisma/schema.prisma`, any D2 Step 2/WALLET file, any `link-token`/`PLAID_REDIRECT_URI` file. Confirm this list stays accurate once `mergeArchivedDuplicateIntoCanonical`'s full body is read during implementation (per the open question flagged in Step A).

**Stopping here per instruction — no code, schema, or migration changes made. Waiting for approval before implementing.**

---

## Implementation report

Approved-for-implementation directive resolved the two open questions from the checklist as follows, and implementation proceeded on that basis:

- **Step C scope** — pre-call guard added to `refreshAllActiveItemsForUser` only, not also inside `refreshPlaidItem()` itself (the checklist's Step C had floated both). See "Step C" below for what this means for the single-item refresh path.
- **Step B (restore route)** — inspected the direct call path; concluded no code change is needed, with reasoning recorded below rather than a change.

### Step A — `lib/accounts/reconcile.ts` (implemented)

Read `mergeArchivedDuplicateIntoCanonical()`'s full body (lines 341-438) to resolve the open question the checklist flagged. Confirmed it only ever re-points `Transaction`, `GoalContribution`, `DebtProfile`, `WorkspaceAccountShare`/`SpaceAccountLink`, and upserts the `DuplicateAccountCandidate` audit row — it never touches `AccountConnection`, `PlaidItem`, or `FinancialAccount.deletedAt` either way. It is a pure "move history" operation. This means every call site that archives a "loser" must independently close out that loser's connections — `mergeArchivedDuplicateIntoCanonical` itself can never be the place to do it.

That full read also surfaced a **second gap beyond what the checklist described**: `resolveAccountByFingerprint()` (lines 277-311) has its own direct loop —

```ts
if (activeCandidates.length > 0) {
  const canonical = await pickCanonicalAndMerge(activeCandidates, spaceId);
  for (const a of archivedCandidates) {
    await mergeArchivedDuplicateIntoCanonical(a.id, canonical!.id, DuplicateDetectionSource.FINGERPRINT_MATCH, spaceId);
  }
  ...
```

— that folds already-archived fingerprint-matched siblings into the newly-resolved canonical directly, without ever going through `pickCanonicalAndMerge`'s loop. The checklist's Step A only explicitly described the loop inside `pickCanonicalAndMerge`. This second loop has the identical gap for the identical reason, and is arguably the more likely source of the two known broken accounts specifically, since both are already-archived rows being folded — exactly this loop's shape, not the "was active, just archived" shape `pickCanonicalAndMerge`'s `if (!c.deletedAt)` branch covers.

Implemented as one shared private helper, `closeOutAccountConnections(financialAccountId)`, called unconditionally from both loops (not gated on whether the row was already archived coming in — an already-archived candidate can still be carrying a live connection if it was archived before this fix existed, which is exactly the bug):

- `pickCanonicalAndMerge()`'s loser loop — called for every non-canonical candidate, after `mergeArchivedDuplicateIntoCanonical` and after the conditional `deletedAt` archive.
- `resolveAccountByFingerprint()`'s `archivedCandidates` fold loop — called for every `a` after `mergeArchivedDuplicateIntoCanonical`.

`closeOutAccountConnections` mirrors `app/api/accounts/[id]/route.ts`'s existing DELETE-handler pattern exactly: find live `AccountConnection` rows for the account, soft-delete them, then call `disconnectPlaidItemIfOrphaned()` (imported from `@/lib/plaid/disconnect`, unchanged) for each distinct `plaidItemDbId`. No-op for accounts with no live connections (WALLET accounts, manual accounts, or ones already closed out).

No change to `pickCanonicalAndMerge`'s other call site (line ~301, the "no active candidates" branch) was needed — it already routes through the same loop that was just fixed.

### Step B — restore route (confirmed no change needed)

`app/api/accounts/[id]/restore/route.ts` calls `mergeArchivedDuplicateIntoCanonical(fa.id, canonical.id, mergeSource)` directly (line 131) when restoring an account that turns out to be a duplicate of an already-active one. Conclusion: **no change needed**, because:

1. That function never touches `AccountConnection`/`PlaidItem` either way (confirmed above) — it cannot itself create a new orphan on the canonical side, and it cannot independently leave `fa` in a worse connection-state than it already was in.
2. `fa` arrives at this call already archived (the route's earlier guard rejects restoring a non-deleted account), and under the **fixed** system, every path in `reconcile.ts` that archives a row as a duplicate-merge loser now closes its connections at the same time (Step A). The normal `DELETE /api/accounts/[id]` path already did this correctly before this fix.
3. The only way `fa` could reach this call still carrying a live connection is if it was archived by one of the two buggy loops Step A just fixed, before this fix shipped — i.e., pre-existing bad data, not a new defect this call path can produce going forward.
4. That pre-existing bad data is exactly what Step D's cleanup script remediates. Once it's run, and once Step A is deployed, no `fa` reaching restore should ever carry a live connection while staying archived — so there's nothing for the restore route to additionally clean up itself.

If a future change ever makes this route archive a *second* row beyond the one being restored, this conclusion would need revisiting — today it doesn't (confirmed by full read of the route).

### Step C — `lib/plaid/refresh.ts` (implemented, scoped to `refreshAllActiveItemsForUser`)

Added `hasActiveLinkedAccount(plaidItemDbId)` — counts live `AccountConnection` rows joined to a non-archived `FinancialAccount` — and `selfHealOrphanedPlaidItem(plaidItemDbId)` — soft-deletes any stray live connections then calls `disconnectPlaidItemIfOrphaned()`. Both are private to `refresh.ts`, not exported, not shared with `reconcile.ts`'s helper (different call shape: per-`FinancialAccount` vs. per-`PlaidItem`).

In `refreshAllActiveItemsForUser`'s loop, before the existing `try { refreshPlaidItem(item.id) }`:

```ts
if (!(await hasActiveLinkedAccount(item.id))) {
  await selfHealOrphanedPlaidItem(item.id);
  continue;
}
```

The existing `try`/`catch` block is otherwise completely untouched — confirmed by diff review (see below). Items with at least one active linked account go through exactly the same code path as before, so `ITEM_LOGIN_REQUIRED`/`INVALID_ACCESS_TOKEN`/permission errors are never suppressed for them.

**Documented scope decision, per explicit approval, not an oversight:** `refreshPlaidItem()` itself and the single-item manual-refresh path (`app/api/plaid/refresh/route.ts`'s `body.plaidItemId` branch, which does its own `status: ACTIVE` lookup and calls `refreshPlaidItem()` directly, bypassing `refreshAllActiveItemsForUser` entirely) are **not** guarded by this change. In practice this path is reached from a UI "refresh" affordance on a specific connected account; an archived account shouldn't surface that affordance at all, so this path shouldn't normally receive an orphaned item's id. If it ever does (e.g. a stale client-side reference), that single manual refresh would still log the D2-3E warning and skip the write, exactly as before this fix — same fallback-with-log behavior the project already treats as acceptable elsewhere. Worth knowing about, not fixed here, per the approval's explicit scoping to `refreshAllActiveItemsForUser`.

**Note on the original "D2-3E disappears entirely" expectation:** confirmed true for the diagnosed bug — a `PlaidItem` with *zero* active linked accounts (the two known cases) is now skipped before Plaid is ever called, so the warning's code path is never reached for them. Not claimed true for a different, narrower, pre-existing situation this fix doesn't touch: a multi-account `PlaidItem` where *some* linked accounts are active and *one* sibling was separately archived — that item still has an active account, so it still refreshes, and Plaid's `accountsGet` still returns data for the archived sibling's underlying `account_id` (Plaid doesn't know we've archived it locally), which still triggers the warning for that one sub-account. This is the same accepted, already-documented fallback-with-log design (D2-3C/3D/3E/3F) as before — not part of the orphaned-`PlaidItem` bug, and out of scope per the checklist's "no `refreshPlaidItem()` internals" framing of this round's approval.

### Step D — cleanup + verify scripts (implemented)

- `scripts/cleanup-orphaned-plaid-items.ts` — dry-run by default, `--apply` to write (deliberately the opposite default of `backfill-provider-account-identity.ts`, since `--apply` here calls Plaid's non-reversible `itemRemove()`). Finds every `status: ACTIVE` `PlaidItem` with zero live-connection-to-live-account links, reports every stray connection found, and in `--apply` mode closes them out via the same `closeOutAccountConnections`-style soft-delete + `disconnectPlaidItemIfOrphaned()` sequence as Step A/C.
- `scripts/verify-orphaned-plaid-items.ts` — read-only. Check 1 (real failure) mirrors the Step E SQL exactly. Checks 2-3 are informational cross-references (stale connections on non-ACTIVE items; archived-PLAID-accounts-with-no-identity-row count, for comparison against `verify-provider-account-identity-backfill.ts`).
- Both import `db` from `@/lib/db` (cleanup also imports `disconnectPlaidItemIfOrphaned` from `@/lib/plaid/disconnect`) rather than instantiating a standalone `PrismaClient`, unlike the four pre-existing scripts in this directory. Confirmed directly in-sandbox that `tsx` resolves this project's `@/*` tsconfig path alias at script-run time (tested with a throwaway file importing `@/lib/db`, got past the import to a real `PrismaClientInitializationError` — the known engine-mismatch issue, not a resolution failure). Deliberate: the alternative would be a second, hand-rolled copy of `disconnectPlaidItemIfOrphaned`'s Plaid-calling/decrypt logic inside the script, which is exactly the kind of duplication this fix is trying to avoid elsewhere.

### Validation results

In-sandbox (no live DB available here — same `linux-arm64` vs. `darwin-arm64` Prisma engine constraint documented previously in `D2_STEP3E_REFRESH_READ_CUTOVER_IMPLEMENTATION.md`; confirmed again directly — `npx prisma generate` fails fetching the `linux-arm64` engine binary, network-blocked in this sandbox, exit before even reaching the schema):

1. `npx prisma generate` — **not run successfully** (sandbox network blocks the engine-binary fetch). Not required for this change anyway — no `prisma/schema.prisma` edits were made, so the already-generated client's types are unaffected.
2. `npx tsc --noEmit` — **clean, zero errors**, across the whole project including both edited files and both new scripts.
3. `npm run lint` — **clean**: 0 errors. 4 pre-existing warnings remain, all in unrelated files (`<img>` usage in `AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx`) that this change did not touch.
4. Reviewed `git diff` for both edited files directly — confirmed the existing `try`/`catch` in `refreshAllActiveItemsForUser` is byte-for-byte unchanged, and confirmed no edit touched `refreshPlaidItem()`, `app/api/accounts/[id]/route.ts`, `app/api/accounts/[id]/restore/route.ts`, `app/api/accounts/manual/[id]/route.ts`, `lib/plaid/disconnect.ts`, or `prisma/schema.prisma` — matching the "exact files expected to change" list below.

**Still needs to run against Preview's real database (cannot be done from this sandbox)** — validation-plan steps 4 through 11 from the checklist above:

- Baseline Step E SQL check (expect the two known IDs' items to show up).
- `scripts/cleanup-orphaned-plaid-items.ts` dry-run, confirm it identifies those same two items, then `--apply`.
- Re-run the Step E SQL check (expect zero rows) and `scripts/verify-provider-account-identity-backfill.ts --verbose` (expect unchanged PASS).
- Trigger `/api/plaid/refresh` for a user with both a healthy item and a now-cleaned-up archived item; confirm no D2-3E warning/no Plaid call for the cleaned-up item, and normal refresh for the healthy one.
- Negative-path check that a real `ITEM_LOGIN_REQUIRED`/similar still surfaces for an active item.
- Exercise restore on a sibling-consolidated archived account; confirm `PlaidItem` stays `REVOKED` post-restore (relink required), no error.
- Targeted re-test of `DELETE /api/accounts/[id]` and the manual-account delete path to confirm they're unaffected.

### Rollback plan (unchanged from the approved checklist, confirmed still accurate)

- Steps A and C are additive code changes in two existing files, each independently `git revert`-able with no data implications — reverting just stops closing out connections / stops skipping orphaned items going forward; anything Step D already corrected stays corrected (a `REVOKED` status or a soft-deleted connection is inert either way).
- Step D's cleanup script is the only step with a write side-effect on existing data. `AccountConnection.deletedAt` can be cleared back to `null` cheaply if a run is found to be wrong. Plaid's `itemRemove()` call, if it reached Plaid, is not reversible — relink via Plaid Link is required regardless, same as every other legitimate revoke today. This is why the script defaults to dry-run and `--apply` is opt-in.
- No schema or migration involved in any step — nothing to roll back there.

### Exact files changed

- `lib/accounts/reconcile.ts` — added `closeOutAccountConnections()`; called from `pickCanonicalAndMerge()`'s loser loop and from `resolveAccountByFingerprint()`'s `archivedCandidates` fold loop (the second gap found during implementation).
- `lib/plaid/refresh.ts` — added `hasActiveLinkedAccount()` and `selfHealOrphanedPlaidItem()`; guard added to `refreshAllActiveItemsForUser()` only. `refreshPlaidItem()` itself is unchanged.
- `scripts/cleanup-orphaned-plaid-items.ts` — new.
- `scripts/verify-orphaned-plaid-items.ts` — new.
- Confirmed unchanged: `app/api/accounts/[id]/route.ts`, `app/api/accounts/[id]/restore/route.ts`, `app/api/accounts/manual/[id]/route.ts`, `lib/plaid/disconnect.ts`, `prisma/schema.prisma`, `app/api/plaid/refresh/route.ts`, any D2 Step 2/WALLET file, any `link-token`/`PLAID_REDIRECT_URI` file.
