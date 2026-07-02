> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 1C — ProviderAccountIdentity Backfill & Verification Investigation

Status: **read-only investigation. No code, schema, or migration changes made.**

Context confirmed before writing this report:
- `prisma/migrations/20260623215751_d2_connection_foundation` and `prisma/migrations/20260623221124_d2_provider_account_identity` both exist on disk — Step 1A and 1B migrations have been applied locally. Schema state (`Connection`, `ConnectionStatus`, `ProviderType`, `ProviderAccountIdentity`) matches the Step 1A/1B reports.
- `grep -r ProviderAccountIdentity` across `app/`, `lib/`, `components/`, `scripts/` returns zero matches outside `prisma/schema.prisma`. No route, job, or script reads or writes the table. No backfill has run.
- `scripts/backfill-space-account-link.ts` / `scripts/verify-space-account-link-backfill.ts` (D3 Step 2) exist and are the direct structural precedent referenced in the brief — both read in full and used as the template below.

---

## A. Current identity inventory

Every field on `FinancialAccount` (schema.prisma:619–703) that can uniquely identify an account today, by provider category:

| Category | Identifying field(s) | DB-level uniqueness | Set by |
|---|---|---|---|
| **PLAID** | `plaidAccountId` | `@unique` (global, DB-enforced) | `app/api/plaid/exchange-token/route.ts` at create/relink; updated only via fingerprint-reconciliation (`lib/accounts/reconcile.ts`), never by `lib/plaid/refresh.ts` |
| **WALLET** | `walletAddress` (+ `walletChain`) | **None.** No `@unique`, no composite constraint. | `app/api/accounts/wallet/route.ts`, scoped to `{ ownerUserId, walletAddress }` at the *application* level only |
| **MANUAL** | None | N/A | `app/api/accounts/manual/route.ts` — `institution: "Manual Entry"`, no `plaidAccountId`, no `walletAddress` |
| **EXCHANGE / BROKERAGE / CSV** | None exist | N/A | No implementation. Repo-wide grep for `brokerage\|exchange\|coinbase\|kraken\|schwab\|robinhood\|csv` matched only docs, the D2 architecture doc, `lib/exchangeSymbol.ts` (ticker-symbol formatting, unrelated), and UI copy. `jobs/sync-crypto.ts` / `lib/crypto-apis.ts` are confirmed-empty stubs (carried over from the prior D2 report). |

`lib/account-classifier.ts` and `lib/exchangeSymbol.ts` were checked directly — neither references `plaidAccountId`, `walletAddress`, or any provider/external-id concept. Not relevant to identity.

**Conclusion:** only two real external identifiers exist anywhere in this codebase today — `plaidAccountId` and `walletAddress`. Everything else (manual assets, exchange/brokerage/CSV) has no identifier to backfill from, because no provider integration exists yet.

---

## B. Backfill eligibility matrix

| Category | Eligible for auto-backfill? | Source field → `externalAccountId` | Blocking condition |
|---|---|---|---|
| PLAID, active (`deletedAt IS NULL`) | **Yes** | `plaidAccountId` | None — DB-unique already, one row per account |
| PLAID, archived (`deletedAt IS NOT NULL`) | **No (deferred)** | — | Stale `plaidAccountId` values from pre-reissue history (see C). Backfilling these risks writing identities for rows already merged away by `reconcile.ts`. |
| WALLET, active | **Conditional** | `walletAddress` | Only if it passes the collision pre-check in C — `walletAddress` has no DB uniqueness, so two different active accounts (even different owners) could legitimately share one |
| WALLET, archived | **No (deferred)** | — | Same reasoning as archived PLAID |
| MANUAL | **No** | — | No external identifier exists. See D. |
| EXCHANGE / BROKERAGE / CSV | **No — zero rows today** | — | No implementation; nothing to backfill |

No live DB access from this sandbox (same limitation documented in the Step 1A/1B reports — `binaries.prisma.sh` 403s, `DATABASE_URL` points at unreachable `localhost:5432`). Real population counts and the wallet-collision check below must be run locally. Exact queries:

```sql
-- Population by category (run locally)
SELECT
  CASE
    WHEN "plaidAccountId" IS NOT NULL THEN 'PLAID'
    WHEN "walletAddress"  IS NOT NULL THEN 'WALLET'
    WHEN institution = 'Manual Entry'  THEN 'MANUAL'
    ELSE 'OTHER'
  END AS category,
  ("deletedAt" IS NULL) AS active,
  COUNT(*)
FROM "FinancialAccount"
GROUP BY 1, 2
ORDER BY 1, 2;

-- Wallet-address collision pre-check (run locally, must be empty before backfilling WALLET)
SELECT "walletAddress", COUNT(*) AS account_count, COUNT(DISTINCT "ownerUserId") AS distinct_owners
FROM "FinancialAccount"
WHERE "walletAddress" IS NOT NULL AND "deletedAt" IS NULL
GROUP BY "walletAddress"
HAVING COUNT(*) > 1;
```

---

## C. Recommended backfill rules

**1. (provider, externalAccountId) global uniqueness — not safe to assume blindly.**

- For PLAID: already enforced today via `FinancialAccount.plaidAccountId @unique`, so a 1:1 copy into `ProviderAccountIdentity` cannot collide *for currently-active rows*. The real risk is historical: `reconcile.ts`'s own header comment documents three different `plaidAccountId` values having existed for the same real-world Robinhood account over time (Plaid reissues `account_id` on reconnect). If backfill includes archived rows, it would create multiple `ProviderAccountIdentity` rows for what `reconcile.ts` has already determined is one canonical account — `(provider, externalAccountId)` stays unique as a constraint, but the table would contain stale, semantically-misleading entries. **Rule: scope PLAID backfill to `deletedAt IS NULL` only.**
- For WALLET: `walletAddress` has zero DB-level uniqueness and zero proof-of-ownership check in `app/api/accounts/wallet/route.ts` (the route accepts any string as an address; nothing verifies the caller controls it). Two different users adding the same public address is a real, currently-possible state with no current safeguard. The compound unique constraint already shipped in Step 1B (`@@unique([provider, externalAccountId])`) has no `ownerUserId` in it, so a genuine collision would make the *second* row's insert fail outright (or be silently skipped if the backfill uses `skipDuplicates`). **Rule: run the collision pre-check in B before any WALLET write; exclude colliding addresses from backfill and report them as exceptions, never let them fail or silently vanish into a `skipDuplicates` no-op.**

**2. Manual assets — Option B, no `ProviderAccountIdentity` row.**

Same reasoning the architecture report already reached for `Connection` (§6): manual assets have no provider, no credential, nothing that "identifies" them externally — there is nothing for `externalAccountId` to hold that means anything. A synthetic value (e.g. the `FinancialAccount.id` itself) would be a redundant indirection, not a real identity, and would make a future "every account has a `ProviderAccountIdentity`" assumption falsely appear satisfied for accounts that have no provider relationship at all. Manual assets should remain without a row, treated as a *known, expected exception* by the verification script — never counted as a failure.

**3. EXCHANGE / BROKERAGE / CSV — nothing to do.** Zero implementation, zero rows. Backfill should not reference these provider types at all in v1; they get populated only once a real Phase 3 adapter exists and writes them going forward (this is governed by the architecture doc's five-phase plan — Step 1C does not pull that work forward).

**4. Backfill script design** — `scripts/backfill-provider-account-identity.ts`, structurally identical to `backfill-space-account-link.ts`:

- `--dry-run` — computes and prints everything that would be written; zero DB writes.
- `--verbose` — logs every account processed, not just the summary.
- Snapshot existing `ProviderAccountIdentity` rows up front (idempotency + accurate dry-run counts on re-run).
- Query eligible accounts: `deletedAt IS NULL AND (plaidAccountId IS NOT NULL OR walletAddress IS NOT NULL)`.
- Run the wallet-collision pre-check; build the exclusion set first.
- Build candidates: PLAID rows → `{financialAccountId, connectionId: null, provider: PLAID, externalAccountId: plaidAccountId}`; WALLET rows not in the exclusion set → same shape with `provider: WALLET, externalAccountId: walletAddress`. `connectionId` stays `null` for all backfilled rows — backfilling `PlaidItem → Connection` is explicitly out of scope (carried over from the architecture doc's Phase 2 description) and is its own future decision, not bundled here.
- Write via `createMany({ data: candidates, skipDuplicates: true })`, gated on `!DRY_RUN` — same idempotency mechanism D3 Step 2 used, here backed by the `(provider, externalAccountId)` unique constraint already shipped in Step 1B.
- Never updates or deletes any other table. Never touches `FinancialAccount`, `Connection`, `AccountConnection`.
- Summary output: accounts scanned, PLAID candidates, WALLET candidates, WALLET collisions excluded (with the colliding addresses listed), MANUAL/no-identifier skipped (informational), already-present (re-run), inserted count.

---

## D. Verification design

`scripts/verify-provider-account-identity-backfill.ts`, structurally identical to `verify-space-account-link-backfill.ts` (read-only, zero writes, exit code 1 on real failure):

| # | Check | Treatment |
|---|---|---|
| 1 | Every eligible active account (PLAID with `plaidAccountId`, or WALLET with `walletAddress` not in the collision set) has exactly one `ProviderAccountIdentity` row | Real failure if missing |
| 1b | Accounts with no identifier (MANUAL, or any account with neither field) | Reported separately as a known exception — same pattern as D3 Check 1's `knownExceptions` bucket. Never a failure. |
| 1c | WALLET accounts excluded by the collision pre-check | Reported separately as a known exception, same treatment |
| 2 | Uniqueness — group `ProviderAccountIdentity` by `(provider, externalAccountId)`, flag any count `> 1` | Defensive only; the DB constraint should make this impossible, but cheap to check directly rather than trust blindly |
| 3 | Orphaned identities — `ProviderAccountIdentity` rows whose `financialAccountId` points at a since-soft-deleted (`deletedAt IS NOT NULL`) account | Informational only, never fails — identical treatment to D3 Check 4. (A hard-delete can't produce this case at all: `onDelete: Cascade` removes the identity row automatically.) |
| 4 | Provider mismatch — for `provider=PLAID` rows, `externalAccountId` must equal the linked account's current `plaidAccountId`; for `provider=WALLET`, must equal current `walletAddress` | Real failure if mismatched |
| 5 | Duplicate identities per account — group by `(financialAccountId, provider)`, flag count `> 1` | Real failure if found (nothing in the schema prevents two different `externalAccountId` values from both pointing at one account under the same provider; shouldn't happen from a clean single backfill run, but worth checking) |

**Important caveat for Check 4, stated explicitly in the script's header comment:** because nothing dual-writes `ProviderAccountIdentity` yet, this verification is a **snapshot at backfill time, not a live mirror**. Any reconnect or fingerprint-merge that runs *after* backfill (both update `plaidAccountId` directly, per `app/api/plaid/exchange-token/route.ts` and `reconcile.ts`) will silently make `ProviderAccountIdentity` stale until a future dual-write step (architecture doc Phase 3/4) exists. Check 4 will correctly catch this drift if verification is re-run later, but nothing alerts proactively today. This is expected, not a defect in the verification design — flagging it here so it isn't mistaken for a bug when first observed.

---

## E. Rollback plan

`ProviderAccountIdentity` is read by nothing (confirmed: zero references outside `schema.prisma`). Rollback is a full data wipe, identical in shape to D3 Step 2's rollback:

```sql
DELETE FROM "ProviderAccountIdentity";
```

followed by a clean re-run of the backfill script. No migration reversion needed — the table itself stays (it was already shipped additively in Step 1B); only its *rows* are reversible. Re-running after a rollback is safe and idempotent for the same reason the backfill script itself is idempotent (`skipDuplicates` against the existing unique constraint).

**Migration safety (investigation point 8), confirmed:**
- No route has been changed. No UI has been changed.
- No read path has been cut over — nothing queries `ProviderAccountIdentity`.
- No write path has been dual-written — nothing creates rows in it. A future backfill script would be the *first* writer, and only via additive `INSERT`/`createMany` statements; it never touches `FinancialAccount`, `Connection`, or `AccountConnection`.

---

## F. Recommended smallest safe implementation slice

Split the eventual implementation (not requested yet — this report stops at design) into two narrower steps rather than one combined "backfill + verify" change:

1. **Dry-run only, PLAID first.** Ship `scripts/backfill-provider-account-identity.ts` with `--dry-run`, scoped to PLAID accounts only (`deletedAt IS NULL AND plaidAccountId IS NOT NULL`) — the one category with an existing DB-level unique constraint and zero collision ambiguity. Run it locally to get real counts before writing a single row. This validates the script logic against real data with zero risk.
2. **WALLET added second, gated on the collision pre-check coming back clean.** Only after the dry-run's wallet-collision report (B) is reviewed and any colliding addresses are resolved or explicitly accepted as exclusions, extend the same script to WALLET and proceed to a live run + `scripts/verify-provider-account-identity-backfill.ts`.

This mirrors the same "shrink to the smallest defensible unit" pattern already used for Step 1A (Connection-only) and Step 1B (ProviderAccountIdentity-only, no backfill). MANUAL and EXCHANGE/BROKERAGE/CSV are not part of any slice — there is nothing to backfill for them (C).

---

## Open decisions carried forward (not resolved by this report)

1. Whether archived/historical `plaidAccountId`/`walletAddress` values ever get their own `ProviderAccountIdentity` rows (e.g. for audit/history purposes), or remain permanently excluded. Recommend: leave excluded indefinitely unless a concrete need surfaces — nothing reads the table yet.
2. How to resolve real wallet-address collisions if the local pre-check finds any (split by `ownerUserId`-scoped identity? add `ownerUserId` to the unique constraint? require ownership proof at write time?). Cannot be answered without first running the pre-check against real data.
3. When Phase 3 (first real provider adapter) lands and which provider it targets — unchanged from the architecture doc's still-open §11 item 2; not this step's job to resolve.

**No implementation performed. No schema, migration, route, or UI changes made in this step.**
