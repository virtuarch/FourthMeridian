# Preview Plaid Sandbox lane — 2026-10-06

**Scope:** exercise v2.6's Plaid implementation against fresh Plaid **Sandbox** Items on Preview before any Production cutover.

**Not touched:** Production, the 10 legacy Preview Plaid Items, `ENCRYPTION_KEY`, Vercel protection, and `PLAID_WEBHOOK_URL`.

## Setup

- **Preview env:** generic Preview `PLAID_ENV=sandbox` and `PLAID_SECRET`, set by the owner. Production's records are unchanged (last updated 2026-06-22).
- **Runtime proof:** the link-token config log shows `env: 'sandbox'`, and tokens are `link-sandbox-…`.
- **Dedicated test user:** `cmux07wop0005yospp73v9nwg` (owner-controlled address). Its two Items:
  - **U.S. Bank** `cmux0efg8000326rd1l9b7xz8`, `ins_127990`, non-OAuth.
  - **First Platypus Bank – OAuth** `cmux0j0uq02e726rd4eisbyyn`, `ins_129644`, OAuth (returned through `/plaid-oauth-return`).
- **Why a separate user:** the owner's own account holds legacy ACTIVE Item `…dkklx3`, and any "refresh all" there would call Plaid with it.

## Defects found and fixed (all gated: clean-copy CI → exact-SHA GitHub CI → Preview)

| Commit | Defect | Fix |
|---|---|---|
| `1988067` (+ migration `20261006020000`) | **Pagination-mutation strand.**<br>• Page 1 committed 100 rows; page 2 got `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`.<br>• The per-page cursor (a mid-loop value) was retried in place and by every resume, failing identically forever.<br>• The Item sat at "100 imported".<br>• Also on `main`/Production. | `PlaidItem.syncOriginCursor`: the loop restarts from where the last **completed** loop ended (from scratch for a never-completed import), at most 3 times. Re-delivered rows dedupe on the unique `plaidTransactionId`. |
| `fc86771` | **The card claimed work that was not happening.**<br>• "Importing… 100 imported" with nothing running.<br>• "Building your timeline — finishes in the background" with nothing building it. The browser resume ran a private partial pipeline that never wrote the reconstruction anchor. | **Activity rule:** `deriveIngestionActivity` (RUNNING only on a fresh lock or a fresh RUNNING execution), read from the same single ledger read as deferrals.<br>**New states:** `import_paused` and `INTELLIGENCE_NOT_BUILT`.<br>**Resume:** `resume-sync` now delegates to the shared full pipeline, `syncPlaidItemFromWebhook`.<br>**Anchor:** written once per connection. |
| `7e91477` | **"Investments synced" for an institution with no Investments product.** Consent metadata was read as support, and the endpoint's `PRODUCTS_NOT_SUPPORTED` was logged and forgotten. | `PRODUCTS_NOT_SUPPORTED` is persisted as `UNSUPPORTED`. `reconcileInvestmentsConsent` never re-promotes it from consent alone. |

**Negative controls:**
- `cursor-safety` §8: 9 checks fail on the parent; the field trace was `[null, C_p1, C_p1, C_p1]`.
- `ingestion-truth`: 19 fail on the parent, both REGRESSION cases included.
- `investments-consent-truth`: 2 fail with `sync-investments.ts` at its parent.

## Recovery proof (the same stranded Item, never replaced)

**First Platypus stranded:**
- 18:29Z — RECONNECT `FAILED` at TRANSACTIONS.
- 18:35Z — RESUME `FAILED`, still at page 1's cursor.
- 100 rows imported.

**Recovered on `1988067`:**
- 19:14:56Z — RESUME. The dead cursor got `MUTATION` once, the loop restarted from the beginning, and 4 pages succeeded. `SUCCEEDED`.
- 386 rows, 386 distinct.

**On `fc86771`:**
- The card truthfully read "Timeline not built — nothing is building it right now".
- "Build timeline" wrote `CONNECTION_INTELLIGENCE_REBUILT` at 20:09:01Z, after which the card read "Financial profile ready".
- A reload rendered the same state.

**On `7e91477`:**
- 20:26:42Z — final post-cooldown MANUAL `FULL_REFRESH` `SUCCEEDED`.
- `completedSyncCount` 3; cursor equals origin; no lock, marker or history build.
- Still 386/386 rows, 14 accounts.
- Consent is now `UNSUPPORTED`, and the card no longer claims Investments.

## Lifecycle evidence

- **Idempotency:** repeated targeted refreshes added 0 transactions and 0 accounts. A concurrent pair gave one 200 and one 429 cooldown.
- **Disconnect (U.S. Bank, via the app):**
  - Item `REVOKED`; `PLAID_ITEM_REVOCATION_CONFIRMED` with `outcome: REMOVED` (`/item/remove`).
  - 14 accounts soft-deleted and their links `REVOKED`; history retained.
  - First Platypus untouched and refreshed successfully afterwards.
- **Isolation (fm_app, real roles):**
  - The owner sees 0 of the test user's Items, accounts and transactions.
  - The test user sees only its own 2 Items, 0 of the owner's data and 0 legacy data.
  - No identity sees 0. Forbidden UPDATE/DELETE affect 0 rows.
  - The test user's links are only in its own PERSONAL Space, and it has 0 platform grants.
- **Webhook:** missing, forged and garbage signatures all get the app's `401 invalid webhook signature` from the signed-in browser.
- **Legacy Preview Items:** explicit columns including `updatedAt` are identical to the 17:5xZ snapshot. 0 updated, 0 provider calls. (A whole-row JSON hash differs only because of the additive `syncOriginCursor` key.)
- **Health:** 0 unfinished executions, 0 held locks, 0 `fm_*` idle-in-transaction, 0 lock waits, 0 duplicate `plaidTransactionId`, 0 Preview 5xx in the lane window.

## Production (read-only)

**Changes in the lane window (17:54Z → 20:28Z):** 2 refresh executions, 2 provider calls, and 1 Item update. All of it is one **inbound Plaid Production webhook**: `POST /api/plaid/webhook` ×3 at 19:25:08Z, `TRANSACTIONS_REMOVED`, Production Item `…6yndn9`, handled by the existing deployment `87e4df7` (one `SUCCEEDED`, the duplicate `SKIPPED` by lock).

**Scheduled jobs in the window:**
- `resume-stale-imports` ×31;
- `sync-crypto` ×1.

**Why none of it can come from this lane:**
- it holds only Sandbox credentials;
- Preview's database is separate;
- the webhook preceded the Sandbox disconnect by about 45 s;
- no Production deployment, migration (still 88), env record or Item creation occurred.

## Not end-to-end tested (and why)

- **Real Plaid webhook delivery.** Vercel Authentication answers Plaid with 401. Not weakened.
- **The outer `sync-banks` all-ACTIVE-Items loop.** It would call the legacy Items. Its per-Item body (`runFullRefresh` → `syncTransactionsForItem` + balances) ran live via MANUAL/RESUME. The loop itself — Item selection, admission, health/notify, post-loop regeneration, and `runCronItemRefresh` — is covered by automated tests only.
- **The sync lock under live contention.** Cooldown and the resume age gate sit in front of it. Acquire/release were not directly observed. Covered by `sync-lock` / `refresh-execution` tests.

## Found, not fixed (outside this lane's fix scope)

- **Webhook verification fetches Plaid's key for an unauthenticated, attacker-chosen `kid`**, with no negative cache or rate limit. A forged `kid` reached the Plaid client on Preview. The same code is on Production's public endpoint. FIX BEFORE CUTOVER.
- **Plaid-type `Connection.status` is not mirrored on disconnect.** It stays ACTIVE while the PlaidItem is REVOKED; it is read only for wallet timestamps. Hygiene, deferred.
- **`RefreshExecution` loses the Plaid error code** (`failureCategory UNKNOWN`) where `ProviderCall` has it. Observability, deferred.
