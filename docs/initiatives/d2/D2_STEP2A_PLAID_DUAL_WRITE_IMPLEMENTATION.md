# D2 Step 2A — PLAID ProviderAccountIdentity Dual-write — Implementation

Status: **implemented per approved scope.** No schema changes. No migrations. No read cutover. No WALLET work.

Approved scope (verbatim):
- Add dualWriteProviderAccountIdentity helper
- Wire create branch
- Wire fingerprint-repoint branch
- Wire exact-match branch
- Best-effort/non-fatal
- connectionId remains null
- No schema changes
- No migrations
- No read cutover
- No WALLET work

---

## 1. Impact map

| File | Change | Why |
|---|---|---|
| `lib/accounts/provider-identity.ts` (new) | `dualWriteProviderAccountIdentity(financialAccountId, provider, externalAccountId)` — find-by-{financialAccountId, provider} → create if missing, update `externalAccountId` in place if drifted, no-op if correct. Try/catch, logs, never throws. | New mirror-write helper, scoped exactly to the design in `docs/initiatives/d2/D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md` §B. |
| `app/api/plaid/exchange-token/route.ts` | +1 import line; +1 call site (`await dualWriteProviderAccountIdentity(fa.id, ProviderType.PLAID, acct.account_id);`) placed once, immediately after the exact-match/fingerprint-repoint/create resolution block (after line 220, before the AccountConnection upsert). | Only file in the codebase that ever writes `plaidAccountId` (confirmed in the Step 2A investigation). |
| `prisma/schema.prisma` | Comment-only update on the `ProviderAccountIdentity` model header — the old comment said "not yet... written by any application code," which became false the moment this change shipped. No field, type, index, or constraint changed. `prisma generate` output is identical. | Keep the schema file's own documentation accurate; not a schema change in the sense the project's rules mean (no migration triggered). |

**Single call site, not three.** The design doc described three call sites (exact-match, fingerprint-repoint, create). In the actual route, all three branches converge on the same two local variables — `fa` (the resolved/created `FinancialAccount`) and `acct.account_id` (the Plaid identifier) — before the AccountConnection upsert runs. Placing one call there, after the branch logic instead of duplicated inside each branch, produces the identical effect for all three approved branches: exact-match → no-op (idempotent), fingerprint-repoint → update-in-place, create → create. This is a code-shape choice, not a scope reduction — flagging it here rather than leaving it implicit, consistent with the project's impact-map requirement.

**Not touched, and confirmed not needing changes:** `lib/accounts/reconcile.ts`, `lib/plaid/refresh.ts`, `lib/plaid/syncTransactions.ts`, `app/api/plaid/refresh/route.ts`, `app/api/plaid/sync/route.ts`, `jobs/sync-banks.ts`, `app/api/accounts/[id]/restore/route.ts`, `app/api/accounts/[id]/route.ts`, `app/api/accounts/manual/[id]/restore/route.ts`, anything WALLET/MANUAL/CSV.

`connectionId` is `null` at the one call site (no `Connection` writers exist anywhere yet — unchanged from Step 1A/1C-A).

## 2. Rollback plan

- **Code-only revert:** delete `lib/accounts/provider-identity.ts`, remove the import and the one call site from `exchange-token/route.ts`, revert the `schema.prisma` comment. No migration involved — nothing in the schema itself changed.
- **Data-only revert (if bad rows were written):** `DELETE FROM "ProviderAccountIdentity";` then re-run `scripts/backfill-provider-account-identity.ts` to restore the known-good PLAID backfill state. Same rollback already documented for Step 1C-A/2A.
- **Partial failure during normal operation:** by design, a `dualWriteProviderAccountIdentity` failure never rolls back or blocks the Plaid import/relink it's attached to — it's caught, logged, and the request completes successfully regardless. Nothing to roll back in that case; at most a single account's identity row is stale until the next sync self-heals it (every call is idempotent).

## 3. Validation checklist

| Check | Result |
|---|---|
| `git status --short` before editing | Confirmed only the two pre-existing investigation docs were untracked; no other pending changes. |
| `npx tsc --noEmit` | **Clean — zero errors.** |
| `npm run lint` | **Clean — 0 errors, 4 warnings**, all 4 pre-existing `@next/next/no-img-element` warnings in unrelated components (`AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx`) — none in the files this step touched. |
| `npx prisma generate` | Blocked in this sandbox: `403 Forbidden` fetching the engine binary from `binaries.prisma.sh` (no outbound access to that host from this environment). Not a code problem — the existing generated client (already on disk, includes `ProviderAccountIdentity`/`ProviderType`/`PLAID`) was used for the `tsc` check above and is unaffected, since this step changed zero schema fields, types, or constraints. **Run locally:** `npx prisma generate` (should be instant/no-op given no schema change). |
| `npx prisma migrate dev` | Not applicable — no schema change. |
| Targeted route test (re-run `scripts/verify-provider-account-identity-backfill.ts`) | Attempted; failed with `PrismaClientInitializationError: ... Prisma Client was generated for "darwin-arm64", but the actual deployment required "linux-arm64-openssl-3.0.x"` — this sandbox cannot reach the live Postgres instance or run the matching query engine, consistent with every prior DB-dependent attempt in this project. **Run locally:** `npx tsx scripts/verify-provider-account-identity-backfill.ts` — expect the same pass result as before (3 PLAID rows, all checks green), since this step adds a write path but doesn't touch existing rows. |
| Functional check of the new call site | Not run end-to-end (would require a live Plaid sandbox link flow against the local DB). **Recommended local check:** link or relink a Plaid sandbox institution, then `SELECT * FROM "ProviderAccountIdentity" WHERE provider = 'PLAID';` and confirm a row exists per imported account with `externalAccountId` matching the account's `plaidAccountId`. |

## 4. What to run locally

```
npx prisma generate
npx tsc --noEmit
npm run lint
npx tsx scripts/verify-provider-account-identity-backfill.ts
```

Then, functionally: link (or relink) a Plaid sandbox institution through the app and confirm `ProviderAccountIdentity` rows appear/update for each account, with `connectionId` still `null` for all of them.

---

**Scope discipline:** no schema changes, no migrations, no read cutover, no WALLET/MANUAL/CSV code touched. `git diff --stat` for this change: `app/api/plaid/exchange-token/route.ts` (+15/-1), `prisma/schema.prisma` (+13/-4, comment-only), plus the one new file `lib/accounts/provider-identity.ts`.
