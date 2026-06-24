# D2 Step 3A — ProviderAccountIdentity Read Cutover Investigation (PLAID)

Status: **read-only investigation. No code, schema, or migration changes made.**

Context confirmed before writing this report:
- D0 docs reorg complete (this report and its cross-references use the new `docs/initiatives/d2/` paths).
- D3 complete.
- D2 1A (Connection), 1B (ProviderAccountIdentity schema), 1C (PLAID backfill + verification, WALLET deferred), 2A (PLAID dual-write helper, wired into `exchange-token/route.ts`) all complete.
- `grep -r plaidAccountId` across the whole repo (excluding `node_modules`) returns exactly 22 files. 12 are docs/schema/migrations (reference-only, not application read paths). The remaining 10 are accounted for in full below — every one was read in this investigation.

---

## A. Inventory table

| # | Location | Read operation | Classification |
|---|---|---|---|
| 1 | `lib/accounts/reconcile.ts:64` — `providerIdentityOf(fa)` | Pure function; branches on `fa.plaidAccountId` (a field on a caller-supplied object) to build a `ProviderIdentity`. Not itself a DB call — the read happens wherever the caller fetched `fa`. | **Eligible for cutover** — shared by every PLAID duplicate-prevention call site (see #2, #9). One change here propagates to all callers. |
| 2 | `lib/accounts/reconcile.ts:76-85` — `findActiveAccountByIdentity(identity)`, plaid branch | `db.financialAccount.findFirst({ where: { plaidAccountId: identity.plaidAccountId, deletedAt: null, ... } })` | **Eligible for cutover** — the actual DB lookup behind #1's plaid branch. This is the duplicate-prevention check used at restore time (see #9). |
| 3 | `lib/accounts/reconcile.ts:105,121-153` — `CANDIDATE_SELECT` / `findCandidatesByFingerprint` | Selects `plaidAccountId` into `FingerprintCandidate.plaidAccountId`, but the fingerprint match itself (institutionId/institution + mask + type + officialName/plaidName/name) never filters or branches on it — confirmed by reading `pickCanonicalAndMerge()` and `resolveAccountByFingerprint()` in full; neither references `c.plaidAccountId`. | **No-op / display-only** — selected but unused in any decision. Not a cutover candidate either way; could be dropped from the select independent of this work, but that's a separate, unrelated cleanup, not requested here. |
| 4 | `lib/plaid/refresh.ts:99` — `refreshPlaidItem()` balance lookup | `db.financialAccount.findUnique({ where: { plaidAccountId: acct.account_id } })`, skips if not found or archived. Runs once per account on every manual refresh and (once wired) the future cron/webhook. | **Eligible for cutover** — highest-frequency *recurring* read of the set. |
| 5 | `lib/plaid/refresh.ts:143-146` — holdings cross-reference | `db.financialAccount.findUnique({ where: { plaidAccountId: plaidAcct.account_id }, select: { id: true } })` | **Eligible for cutover** — same pattern as #4, same file. |
| 6 | `lib/plaid/syncTransactions.ts:205-213` — `resolveFinancialAccountId()` | `db.financialAccount.findUnique({ where: { plaidAccountId }, select: { id: true } })`, memoized per sync run via `accountIdCache`. | **Eligible for cutover** — highest *volume* read of the set (one lookup per unique account per sync batch, but batches can cover thousands of transactions). Cache amplifies whatever this returns, so get this one right before relying on it. |
| 7 | `app/api/plaid/exchange-token/route.ts:133` — exact-match resolution | `db.financialAccount.findUnique({ where: { plaidAccountId: acct.account_id } })` — first branch checked on every Link/relink. | **Eligible for cutover** — and the lowest-risk of the set: this file already dual-writes `ProviderAccountIdentity` (Step 2A) for every account it touches, so coverage here is the freshest in the codebase. A miss just falls through to the fingerprint-fallback or create branch, both of which already have duplicate-prevention safety nets — not a silent failure. |
| 8 | `app/api/plaid/exchange-token/route.ts:326-328` — holdings cross-reference | `db.financialAccount.findUnique({ where: { plaidAccountId: plaidAcct.account_id }, select: { id: true } })` | **Eligible for cutover** — same pattern as #7, same file. |
| 9 | `app/api/accounts/[id]/restore/route.ts:73-74,94-95` — `select` + call into #1/#2 | Selects `plaidAccountId`/`walletAddress` off the account being restored, passes into `providerIdentityOf()` → `findActiveAccountByIdentity()`. | **Eligible for cutover** — this is the call-site half of #1/#2; cutting over reconcile.ts's two exported functions covers this automatically, no independent change needed here. |
| 10 | `app/api/accounts/manual/[id]/restore/route.ts:63-64` — same call into #1/#2 | Same `providerIdentityOf`/`findActiveAccountByIdentity` calls, but this route is hard-guarded to `fa.type === "other"` before reaching this code (confirmed in the Step 1C-C report). For every account this route ever actually processes, `plaidAccountId` is always `null`, so `providerIdentityOf`'s plaid branch never fires here in practice. | **Not a read-cutover candidate** — technically passes through #1, but never exercises the PLAID branch for this caller's domain. No PLAID-specific behavior to change. |
| 11 | `app/api/accounts/wallet/route.ts` | Comment only ("no plaidAccountId" — documents that wallet-created accounts never set the field). No actual reference. Confirmed this route does its own owner-scoped `{ ownerUserId, walletAddress }` lookup directly, not via `findActiveAccountByIdentity`. | **Not a read-cutover candidate** — WALLET-scoped, explicitly excluded by the brief. |
| 12 | `prisma/seed.ts:152-185` | Sets `plaidAccountId` as a literal fixture value when seeding demo `FinancialAccount` rows. | **Tooling only** — local/dev fixture data, not a production read path. |
| 13 | `scripts/verify-provider-account-identity-backfill.ts` (Checks 1, 3, 6) | Reads `FinancialAccount.plaidAccountId` specifically to cross-check it against `ProviderAccountIdentity.externalAccountId` and report drift. | **Must stay legacy permanently** — this script's entire purpose is comparing the legacy field against the new table. Cutting it over would defeat it; it needs to keep reading the legacy field for as long as both exist. |
| 14 | `scripts/backfill-provider-account-identity.ts` | Reads `FinancialAccount.plaidAccountId` as the source value written into new `ProviderAccountIdentity` rows. | **Tooling only / must stay legacy** — it's the backfill's source of truth; by definition it reads the legacy field. |
| 15 | `lib/accounts/provider-identity.ts` | The Step 2A dual-write helper. Reads `ProviderAccountIdentity` (not `FinancialAccount.plaidAccountId`) to decide create-vs-repoint-vs-no-op. | **Write path / not a read-cutover candidate** — already implemented; this is the write side the rest of this report is about eventually feeding from instead of `FinancialAccount.plaidAccountId`. |

**Investigation point 7 (UI/API exposure):** zero. `app/api/accounts/route.ts`, `app/api/accounts/[id]/route.ts` (GET/PATCH/DELETE), `app/api/accounts/[id]/transactions/route.ts`, and every component under `components/` were checked — none select, return, or render `plaidAccountId`. There is nothing to cut over on the UI/API-response side because nothing is exposed there today.

---

## B. Risk assessment

**The read direction is structurally safer than the write direction.** A cutover read would look up `ProviderAccountIdentity.findUnique({ where: { provider_externalAccountId: { provider: "PLAID", externalAccountId } } })` — backed directly by the real `@@unique([provider, externalAccountId])` index (schema.prisma:557). This is race-free and indexed, unlike the dual-write helper's `findFirst({ financialAccountId, provider })` (which has no matching unique index and relies on an application-level invariant). Reads are the cheaper, safer half of this migration.

**Risk 1 — coverage gaps (the main one).** Every eligible-for-cutover site in §A currently does a single `findUnique` against `FinancialAccount.plaidAccountId` and treats "not found" as a real signal (account doesn't exist / was removed / never linked). If a read path switched outright to `ProviderAccountIdentity` with no fallback, any `FinancialAccount` row with `plaidAccountId` set but **no** corresponding identity row would silently behave as if the account doesn't exist — wrong for refresh (balance update skipped), wrong for sync (transactions dropped with a warning), wrong for exchange-token (a real duplicate could get created instead of being matched). Known sources of gaps: (a) any account created before the Step 1C-A backfill ran and never re-verified since, (b) a Step 2A dual-write call that hit its non-fatal catch block and was only logged, never retried. **Mitigation for any future cutover step: re-run `scripts/verify-provider-account-identity-backfill.ts` immediately before cutting over anything, and implement the cutover read with a fallback to the legacy field (try new table, fall back to `plaidAccountId`, log when the fallback fires) rather than a hard replacement — at least for an initial bake-in period.**

**Risk 2 — orphaned identity rows after a merge are expected, not a defect.** When `reconcile.ts`'s `pickCanonicalAndMerge()` archives a losing `FinancialAccount` row (line 199), it never touches that row's `plaidAccountId` or its `ProviderAccountIdentity` row (reconcile.ts has no dual-write calls — confirmed in the Step 2A investigation). The loser's identity row still correctly points at the loser — that's accurate history, not drift, and mirrors the same "orphaned identity on an archived account is informational, not a failure" precedent already established by the verify script's Check 5. A cutover read would resolve identically to today's legacy-field lookup in this case. Low risk, noted for completeness.

**Risk 3 — partial cutover within a single feature creates inconsistent behavior.** `refresh.ts` and `syncTransactions.ts` and exchange-token's holdings lookup all use the identical resolution pattern; cutting over one without the others (e.g., transactions resolve via the new table but holdings still resolve via the legacy field) would make debugging a future discrepancy harder than necessary. Recommend cutting over together per file/feature, not splitting a single read pattern across two data sources.

**Risk 4 — added latency.** Every cutover site in §A goes from one `findUnique` to (at minimum) one `findUnique` on `ProviderAccountIdentity` plus one more on `FinancialAccount` by the resolved id (or a single query with a `select`/join, an implementation detail for later). For `syncTransactions.ts`'s cached-per-run lookup this is a one-time cost per account per batch, not per transaction — minor. For `refresh.ts`/exchange-token this runs once per account per request — negligible in absolute terms.

**Risk 5 — no webhook handler exists yet.** Unchanged from the Step 2A finding: there's no Plaid webhook route today, so there's no additional surface to worry about here either.

---

## C. Recommended cutover order (proposed future steps — none implemented now)

Each step below is its own decision/branch, consistent with "do not implement all decisions in one branch":

1. **Step 3B (gate, no code):** re-run `scripts/verify-provider-account-identity-backfill.ts` against the live DB. Confirm Check 1 (missing identity) and Check 3 (mismatch) are both still PASS. If not, re-run the backfill before touching any read path.
2. **Step 3C:** cut over `app/api/plaid/exchange-token/route.ts`'s exact-match lookup (§A #7) only. Smallest blast radius — same file as the freshest dual-write, and a miss degrades gracefully into the existing fingerprint-fallback/create path rather than failing silently.
3. **Step 3D:** cut over `lib/accounts/reconcile.ts`'s `findActiveAccountByIdentity` plaid branch (§A #2, with #1 and #9 following automatically). Shared by the restore route(s); same fallback-with-logging approach.
4. **Step 3E:** cut over `lib/plaid/refresh.ts` (§A #4 and #5 together — same file, same pattern, do both in one step per Risk 3 above).
5. **Step 3F:** cut over `lib/plaid/syncTransactions.ts` (§A #6) and exchange-token's holdings lookup (§A #8) together, since both resolve the identical "Plaid account_id → FinancialAccount for holdings/transactions" question. Do this last — highest volume, so the read pattern should already be proven safe by steps 3C–3E first.
6. **Step 3G (separate, later decision):** once all of the above have run cleanly for an observation period, consider removing the legacy-field fallback from each cutover site (still not removing the `FinancialAccount.plaidAccountId` column itself — that stays per "do not remove legacy tables prematurely," and is its own future decision regardless).

WALLET read cutover is out of scope for all of the above and remains blocked on the Step 1C-C collision decision.

## D. Smallest safe implementation slice (if/when a cutover step is approved)

Step 3B (the verification gate) has zero code risk and should run regardless of what's decided next. If a code cutover is wanted next, **Step 3C is the recommended starting slice**: one file (`exchange-token/route.ts`), one read site, implemented as try-new-table-then-fall-back-to-legacy-field with a log line on fallback — not a hard replacement. This pairs naturally with the dual-write this same file already performs, so any coverage gap would show up immediately in that file's own logs during bake-in.

## E. Rollback plan

No code changes were made in this step, so there is nothing to roll back from this report itself. For any future cutover step: implementing each read as fallback-to-legacy rather than a hard replacement makes rollback a one-line code revert (remove the new-table lookup, keep the existing `plaidAccountId` lookup) — no data migration, no schema change, and no change to `ProviderAccountIdentity` or `FinancialAccount.plaidAccountId` would ever be required to undo a read-path cutover.

## F. Validation plan (for whenever a cutover step is implemented)

- `npx tsc --noEmit`, `npm run lint` — standard.
- Re-run `scripts/verify-provider-account-identity-backfill.ts` before and after.
- During bake-in, log (don't fail) any case where the new-table lookup and the legacy-field lookup would have disagreed, to surface coverage gaps before removing the fallback.
- Targeted local testing per cutover step: Step 3C → relink a Plaid sandbox institution and confirm exact-match resolution still works; Step 3D → exercise the generic restore route on an archived Plaid-linked account; Step 3E → manual "Refresh" on a linked account; Step 3F → manual "Sync Now" plus an investment-holdings account.

---

**No implementation performed. No schema, migration, route, UI, or data changes made in this step.**
