# PROV-1 — Provider Orchestration Duplication Investigation

**Date:** 2026-07-17
**Type:** Read-only investigation + planning. No code changed, no commit, no push.
**Scope trigger:** COMPLEX-0 complexity audit flagged `lib/plaid/exchangeToken.ts` (645 LOC) and
`lib/plaid/refresh.ts` (738 LOC) as near-duplicate Plaid orchestration paths (~400–500 LOC of claimed
overlap, "little/no real provider polymorphism").

## TL;DR — what the evidence actually shows

The complexity audit's headline is **directionally right but quantitatively wrong**, and it points at
the wrong axis.

- The two files are **not** ~450 LOC of copy-paste. The heavy semantic work — transaction
  classification, investment holdings/observation/event ingestion, snapshot regeneration — is **already
  shared** through single-owner primitives that both files import. Both entrypoints are *thin* over
  those primitives for those stages.
- The **genuine** hand-duplication is ~**100–150 LOC**: `mapAccountType` (verbatim), the
  identity→legacy account-lookup block (**4 inline copies**), and the **~80-line investments
  orchestration wrapper** that is copy-pasted into both files and has already **silently drifted in
  four places**.
- The two files are **legitimately different operations** — *create/reconcile* vs *update-only* — with
  deliberately different atomicity, locking, retry, health, and failure models. Merging them into one
  monolithic pipeline would **erase meaningful failure semantics**, which the mission itself warns
  against.
- The **provider adapter seam is decorative** — `plaidAdapter` and `providers/catalog.ts` have **zero
  importers**; routes call the concrete functions directly.
- The **real architectural gap** is not exchange↔refresh. It is that **there is no provider-neutral
  account-persistence spine**: the WALLET provider (`app/api/accounts/wallet/route.ts`) already
  re-implements the same account-spine orchestration by hand, sharing only leaf primitives. A second
  major provider would do the same.

Verdicts are at the end.

---

## PART 1 — Full lifecycle map

### Initial connection (`performPlaidTokenExchange`, `lib/plaid/exchangeToken.ts`)

| # | Stage | Owner |
|---|---|---|
| 1 | `public_token` → `access_token` + `item_id` | `plaidClient.itemPublicTokenExchange` (bare) `exchangeToken.ts:144` |
| 2 | Duplicate-institution gate (new item_id for already-ACTIVE institution → `DuplicateInstitutionError` + best-effort `itemRemove`) | `exchangeToken.ts:155-169` **INITIAL_ONLY** |
| 3 | Encrypt token | `encryptWithPurpose` `:172` |
| 4 | `PlaidItem` upsert (+ `syncIncompleteAt` when deferring) | `db.plaidItem.upsert` `:181-198` **INITIAL_ONLY** |
| 4b | Health heal-on-relink + retire open sync-failure | `setPlaidItemHealth` `:203`, `retireItemSyncFailure` `:209` |
| 5 | `Connection` dual-write (provider spine, best-effort) | `db.connection` find/update/create `:217-248` **INITIAL_ONLY** |
| 6 | `accountsGet` (bare) | `plaidClient.accountsGet` `:251` |
| 7 | Per-account: resolve `FinancialAccount` (identity→legacy→fingerprint→create) → `ProviderAccountIdentity` dual-write → `$transaction`(AccountConnection upsert + SpaceAccountLink) | `:259-427`; `resolveAccountByFingerprint` `lib/accounts/reconcile.ts:342`; `dualWriteProviderAccountIdentity`; `dualWriteSpaceAccountLink` |
| 8 | Investments: consent derive/seed → `investmentsHoldingsGet` (bare) → per-account observation capture → `syncCurrentHoldings` → `ingestInvestmentEvents` | `:436-566` (shared primitives, inline orchestration) |
| 9 | Transactions: inline `syncTransactionsForItem` **unless** `deferHistorySync` | `:584-600` |
| 9b | Snapshot regeneration (best-effort) | `regenerateSnapshotsForAccounts` `:604-608` |
| 10 | Audit log (best-effort) | `db.auditLog.create` `:611-628` |

Deferred history tail (normal Link): route fires `after(() => syncPlaidItemFromWebhook(itemId))`
(`exchange-token/route.ts:109`) → `runDeferredHistorySync` (`backgroundHistorySync.ts:275`) →
`syncTransactionsForItem` (full ~730-day null-cursor pull) → `backfillHistoryForItem` →
`recordSyncComplete`. Backstopped by the daily `sync-banks` cron (resumes from persisted cursor if the
60s `after()` budget is exceeded).

### Refresh (`refreshPlaidItem` / `refreshAllActiveItemsForUser`, `lib/plaid/refresh.ts`)

| # | Stage | Owner |
|---|---|---|
| 0 | Orphan guard (skip + self-heal items with zero live linked accounts) | `hasActiveLinkedAccount`/`selfHealOrphanedPlaidItem` `:577-605` **REFRESH_ONLY** |
| 1 | `accountsGet` (**retry-wrapped**) → per-account **update-only** balance write (identity→legacy lookup; never create/restore; skips soft-deleted) + M2 reconcile-target capture | `:164-241` |
| 2 | Investments: consent derive (change-detect persist) → `investmentsHoldingsGet` (**retry-wrapped**) → observation capture → `syncCurrentHoldings` → `ingestInvestmentEvents` | `:247-409` |
| 3 | Transactions: `syncTransactionsForItem` (**fatal**) | `:418` |
| 3b | M2 balance↔transaction reconciliation → `recordSyncIssue` (best-effort) | `:420-450` **REFRESH_ONLY** |
| 4 | Snapshot regeneration — inline for single-item, **deferred** for all-items path | `:465-467` |
| 4b | `ConnectionSynced` audit event (best-effort) | `emitDomainEvent` `:476-489` |
| — | All-items: per-item lock + defer, health-on-failure + notify, then `regenerateCompletedSpaces` once (excludes "tarnished" spaces of failed items) | `refreshAllActiveItemsForUser` `:625-738` **REFRESH_ONLY** |

### There are actually THREE Plaid ingestion orchestrations (+ a deferred tail)

1. **exchangeToken** — accounts + identities + holdings + txns + snapshot + audit (create/reconcile).
2. **refreshPlaidItem / refreshAllActiveItemsForUser** — balances + holdings + txns + reconcile + snapshot (update-only).
3. **`sync-banks` cron** (`jobs/sync-banks.ts:84`) — **transactions only**, via `syncTransactionsForItem` directly; **no** balance/holdings refresh. Plus per-account wealth-history + event ingest.
4. **webhook → `runDeferredHistorySync`** — deferred initial-history completion.

The mission framed this as "exchange vs refresh." The real orchestration surface is **four call
shapes** over one shared transaction engine.

---

## PART 2 — Field-by-field diff (stage classification)

| Logical stage | exchangeToken | refresh | Classification |
|---|---|---|---|
| `mapAccountType` | `:102` (exported) | `:59` (private copy) | **IDENTICAL** (byte-for-byte; hand-duplicated) |
| Token exchange / decrypt | `itemPublicTokenExchange` `:144` | `decryptWithPurpose` `:157` | **ENTRYPOINT_SPECIFIC** |
| Duplicate-institution gate | `:155-169` | — | **INITIAL_ONLY** |
| PlaidItem upsert | `:181-198` | (read-only + narrow consent update) | **INITIAL_ONLY** |
| Connection dual-write | `:217-248` | — | **INITIAL_ONLY** |
| `accountsGet` | bare `:251` | retry-wrapped `:164` | **NEAR_IDENTICAL** (retry asymmetry) |
| Identity→legacy account lookup | `:270-284` + `:471-487` | `:179-196` + `:301-324` | **NEAR_IDENTICAL** (4 inline copies; warn-gating/tag differ) |
| Fingerprint resolve | `resolveAccountByFingerprint` `:309` | — | **INITIAL_ONLY** |
| FinancialAccount create | `:337-356` | — (`continue` on miss `:200`) | **INITIAL_ONLY** |
| FinancialAccount balance update field-set | `:287-297` | `:214-226` | **SEMANTICALLY_DIFFERENT** (see Part 3) |
| ProviderAccountIdentity dual-write | `:362` | — | **INITIAL_ONLY** |
| AccountConnection + SpaceAccountLink `$transaction` | `:374-423` | — | **INITIAL_ONLY** |
| Consent derive/persist | `:441-455` (write-if-derivable) | `:258-273` (change-detect over stored) | **SEMANTICALLY_DIFFERENT** |
| `holdingsCallable` gate | `:456-457` | `:276-277` | **IDENTICAL** |
| `investmentsHoldingsGet` + secById + per-account filter | `:461-467` | `:281-290` | **NEAR_IDENTICAL** (retry asymmetry) |
| observation capture args | `:497-508` | `:334-345` | **IDENTICAL** |
| `syncCurrentHoldings` | `:520-527` | `:358-364` | **SHARED_PRIMITIVE_ALREADY** |
| `ingestInvestmentEvents` | `:534-542` | `:373-381` | **SHARED_PRIMITIVE_ALREADY** |
| ADDITIONAL_CONSENT_REQUIRED catch | `:551-565` | `:391-408` | **IDENTICAL** |
| Transaction sync | `syncTransactionsForItem` (swallowed / deferrable) `:584-600` | `syncTransactionsForItem` (fatal) `:418` | **SHARED_PRIMITIVE_ALREADY** (differ on fatality/timing) |
| M2 balance↔tx reconciliation | — | `:420-450` | **REFRESH_ONLY** |
| Snapshot regeneration | inline `:604-608` | inline or deferred `:465-467` | **SHARED_PRIMITIVE_ALREADY** (differ on orchestration) |
| Health on failure | — | `:695-702` | **REFRESH_ONLY** |
| Health heal on success | `:203` | — | **INITIAL_ONLY** |
| Audit | `auditLog.create` `:611` | `emitDomainEvent(ConnectionSynced)` `:476` | **SEMANTICALLY_DIFFERENT** |

**Reading:** the copy-paste rows are `mapAccountType`, the identity→legacy lookup (×4), and the
investments block scaffolding. Everything labeled SHARED_PRIMITIVE_ALREADY is a single-owner function
both files call — that is where most of the "~450 LOC overlap" impression comes from, and it is
**already deduplicated**.

---

## PART 3 — Persistence duplication

| Target | exchangeToken | refresh | Shared? |
|---|---|---|---|
| `FinancialAccount` | resolve(identity→legacy→fingerprint→create) + update; restores (`deletedAt:null`) | update-only; never create/restore; skips soft-deleted | resolution ladder **inline-duplicated at the lookup step**; fingerprint/create initial-only |
| `ProviderAccountIdentity` | `dualWriteProviderAccountIdentity` `:362` | — | INITIAL_ONLY |
| `Connection` / item state | `Connection` upsert `:217-248`; `PlaidItem` upsert `:181` | narrow `investmentsConsent` updates only | INITIAL_ONLY |
| `AccountConnection` | `$transaction` upsert `:374-404` | read-only (fan-out/self-heal) | INITIAL_ONLY |
| `SpaceAccountLink` | `dualWriteSpaceAccountLink` `:407-422` | read-only | INITIAL_ONLY |
| `Holding` | `syncCurrentHoldings` | `syncCurrentHoldings` | **SHARED** (single owner) |
| securities/instruments/prices | via `capturePositionObservations`/`ingestInvestmentEvents` | same | **SHARED** |
| `Transaction` | via `syncTransactionsForItem` | same | **SHARED** |
| `PositionObservation` | `capturePositionObservations` | same | **SHARED** (append-only, idempotent within a day) |
| `SpaceSnapshot` | `regenerateSnapshotsForAccounts` | `regenerateSnapshotsForAccounts` / `regenerateSpaceSnapshot` | **SHARED** (single owner; refresh adds dedup/exclusion orchestration) |

**Same normalization/persistence logic existing twice?** Only three places:

1. **`mapAccountType`** — verbatim copy (`exchangeToken.ts:102` exported vs `refresh.ts:59` private).
2. **Identity→legacy account lookup** — **4 inline copies** (`exchangeToken.ts:270-284` + `:471-487`;
   `refresh.ts:179-196` + `:301-324`). A shared helper for exactly this —
   `findActiveAccountByIdentity` (`lib/accounts/reconcile.ts:139`) — **already exists** and is used by
   the restore routes, but **both hot paths bypass it** with inline copies.
3. **FinancialAccount balance-update field-set drift** (not a straight copy — a *divergence*):
   - refresh-only: `balanceLastUpdatedAt`; `balance ?? fa.balance` (coalesce to existing).
   - exchange-only: `deletedAt:null` (restore); `plaidAccountId` (fingerprint branch); `balance ?? 0`.
   - common: `availableBalance`, conditional `creditLimit`, `lastUpdated`, `syncStatus:"synced"`.

Everything else is genuinely single-owner.

---

## PART 4 — Transaction path

Plaid raw → adapter/mapping → normalized → FlowType/TI → persistence **all live inside
`syncTransactionsForItem` (`lib/plaid/syncTransactions.ts`)**. Neither entrypoint imports or calls
`classifyFlow`, `buildTransactionFacts`, `mapPlaidCategory`, etc.

Pipeline (per page, cursor-driven `:219-499`): `transactionsSync` (retry) → `resolveFinancialAccountId`
(identity→legacy) → sign-flip/normalize → `mapPlaidCategory` (+ CC-1 card-payment rescue) →
`buildPlaidFlowInput` → **`classifyFlow` → `buildFlowWriteFields`** → `buildTransactionFacts` →
TE1 transfer evidence (TRANSFER only) → merchant enrichment/write → **persist** (3-tier upsert:
plaidId → fingerprint → create) → soft-delete removed → per-page cursor persist. The whole classify
block is try/caught and degrades to null columns; never blocks a write.

**Verdict:** initial-link and refresh use the **same semantic transaction pipeline, byte-identical
classification.** The only divergence is *when/under what guard* the engine runs and *whether its
failure is fatal* — not what it does to a row. **No divergence to document beyond fatality/timing.**

---

## PART 5 — Investments path

Shared primitives (single owner, both files import the same module):
`deriveInvestmentsConsent`, `capturePositionObservations`/`investmentObservationsEnabled`,
`syncCurrentHoldings`, `ingestInvestmentEvents`/`investmentEventsEnabled`. Primitive **call sequence is
identical** in both: observations → `syncCurrentHoldings` → `ingestInvestmentEvents`.

- `syncCurrentHoldings` writes `Holding` via **insert / update-in-place / remove-stale** (not
  delete+recreate); idempotent; removal gated on `payloadComplete`.
- `capturePositionObservations` writes `PositionObservation` **append-only across days**, idempotent
  within a day; identical args from both callers.

But the **~80-line orchestration wrapper around those primitives is hand-duplicated** in both files
(consent seed, holdings fetch, per-account filter, secById build, identity lookup + legacy fallback,
primitive sequence, ADDITIONAL_CONSENT_REQUIRED catch), and has **drifted**:

- **DRIFT-1 (consent persistence).** exchange persists the derived value whenever derivable (no prior
  state); refresh change-detects against the stored `item.investmentsConsent` and logs transitions.
  Different persistence conditions, same eventual gate.
- **DRIFT-2 (retry).** refresh wraps `investmentsHoldingsGet`/`accountsGet` in `withPlaidRetry`;
  exchange calls them bare.
- **DRIFT-3 (warning gating/tags).** refresh suppresses the legacy-fallback warning for archived
  accounts and tags `[D2-3E]`; exchange warns unconditionally and tags `[D2-3F]`.
- **STALE DOC hazard.** `refresh.ts` header + inline comments still say holdings are
  "delete-then-recreate," which `syncCurrentHoldings` no longer does. (Documentation only — flag for a
  cleanup.)

**Dangerous drift?** Only DRIFT-1/2 have behavioral weight (consent semantics; transient-error
resilience on the link path). Neither corrupts data today, but they are exactly the kind of divergence
a shared wrapper would prevent going forward.

---

## PART 6 — Provider adapter audit

**Artifacts:**

- `lib/providers/plaid/adapter.ts` (23 LOC) — `plaidAdapter = { provider, refreshItem, syncTransactions }`.
  A **pure re-export, zero logic.** Its own header: "Not yet referenced by any route."
- `lib/providers/catalog.ts` (186 LOC) — a static routing registry of "integration methods" carrying
  **routing metadata only**; its header explicitly states it "never imports or instantiates the adapter
  or pipeline."

**Importer census (grep):**
- `plaidAdapter` → **0 importers.**
- `catalog.ts` helpers (`listProviderCatalogEntries` / `getProviderCatalogEntry` /
  `listEnabledProviderCatalogEntries`) → **0 importers.**
- Every route/cron/webhook imports the **concrete** functions (`performPlaidTokenExchange`,
  `refreshPlaidItem`, `syncTransactionsForItem`) directly.

| Question | Answer |
|---|---|
| What adapters exist? | One (`plaidAdapter`), a re-export shell. |
| Who imports them? | Nobody. |
| Control execution or expose unused interface? | Neither — it is unreferenced. |
| Provider-neutral? | It is not even typed against a shared interface (header says so deliberately). |
| Could a second provider plug in? | No — there is no interface to implement and no dispatcher that reads adapters. |
| Would a 2nd provider still copy Plaid orchestration? | Yes — WALLET already does (Part 10). |

**Classification: DECORATIVE / effectively DEAD.** The catalog is a *real, used* UI/launch-routing
layer, but it is a **different thing** from an execution adapter — it intentionally never touches
adapters. The execution adapter seam (`plaidAdapter`) is decorative. The complexity audit's suspicion
is **confirmed.**

---

## PART 7 — Canonical pipeline proposal

The evidence does **not** support merging exchange + refresh into one pipeline (their failure/atomicity
models are deliberately different — Part 9). It **does** support separating *provider-specific
collection* from *provider-neutral persistence/semantics*, and finishing the primitive extraction the
codebase already started.

```
                 ┌─────────────────────────────────────────────┐
 provider-       │  Plaid collection      Wallet collection ... │  (per-provider; owns API calls,
 SPECIFIC        │  accountsGet/holdings   btc-explorer/xpub     │   retry, consent, raw payloads)
                 └───────────────────┬─────────────────────────-┘
                                     ▼
                 ┌─────────────────────────────────────────────┐
 NORMALIZED      │  ProviderIngestionPayload                    │  (MISSING today — the key gap)
 CONTRACT        │  { accounts[], holdings[], transactions[] }  │
                 └───────────────────┬─────────────────────────-┘
                                     ▼
                 ┌─────────────────────────────────────────────┐
 provider-       │  persistAccountSpine()  ← exists as scattered│
 NEUTRAL         │    leaf primitives, no single orchestrator   │
 PERSISTENCE     │  syncCurrentHoldings / capturePositionObs /  │  (mostly SHARED already)
                 │  ingestInvestmentEvents / syncTransactions   │
                 └───────────────────┬─────────────────────────-┘
                                     ▼
 POST-WRITE      │  regenerateSnapshots / audit / health / notify │  (SHARED primitives; entrypoint
 CONSEQUENCES    │  — orchestrated per-entrypoint, NOT merged     │   chooses which + fatality)
```

- **`ProviderIngestionPayload`** (normalized accounts/holdings/transactions) is the missing contract.
  Today each provider hand-assembles persistence from raw provider objects.
- **`persistAccountSpine(payload, ctx)`** — a provider-neutral writer for the
  FinancialAccount → ProviderAccountIdentity → AccountConnection → SpaceAccountLink spine, consumed by
  `exchangeToken` **and** the wallet route (which currently copies it), with a `mode: "create" |
  "update-only"` switch (create/reconcile vs refresh's never-create).
- Entrypoints stay thin and keep their **own** orchestration of consequences (fatality, locking,
  cooldown, health) — those are not merged.

---

## PART 8 — Execution ordering (must be preserved by any shared code)

1. Token exchange → PlaidItem upsert **before** any account write (item is the credential owner).
2. Duplicate gate **before** PlaidItem upsert commits accounts.
3. `ProviderAccountIdentity` / `FinancialAccount` resolution **before** AccountConnection + SpaceAccountLink.
4. AccountConnection + SpaceAccountLink written **together atomically** (per-account `$transaction`).
5. Securities/secById map built **before** per-holding writes.
6. **Observation capture BEFORE `syncCurrentHoldings`** (captures cash/no-ticker the Holding writer
   filters, and precedes the remove-stale step).
7. `syncCurrentHoldings` **before** `ingestInvestmentEvents`.
8. Transaction cursor advances **per page, after** that page's row writes (crash-safe resume).
9. **Refresh:** balances captured **before** transaction sync (M2 reconciliation diffs balance vs txn
   movement); snapshot regeneration **after** balances+holdings+txns are durable.
10. **All-items refresh:** every item completes **before** `regenerateCompletedSpaces` (avoids partial
    same-day snapshots from still-stale institutions).

Any `persistAccountSpine` extraction must honor 3–7; any consequence layer must honor 8–10.

---

## PART 9 — Failure semantics (a shared pipeline cannot erase these)

| Dimension | Initial-link (exchange) | Refresh |
|---|---|---|
| Retry | **none** on exchange body (`accountsGet`/`investmentsHoldingsGet` bare) | `withPlaidRetry` on both |
| Sync lock | exchange body **lock-free**; only deferred history tail locked | always caller-wrapped (`withPlaidItemSyncLock`) |
| Idempotency | mixed — spine upserts idempotent, but `create`/duplicate-gate are first-run semantics | fully re-run-safe (per-statement, update-only) |
| Dedupe | fingerprint reconcile + duplicate-institution gate | none needed (never creates) |
| Transaction boundary | per-account `$transaction` (AccountConnection+SAL) — **partial commits possible** | **no `$transaction`** — per-statement |
| Rollback | none across accounts | none (idempotent by design) |
| Health on failure | **none** (heal-on-success only; failure just propagates to route) | `classifyPlaidErrorForHealth` + `setPlaidItemHealth(ERROR)` + `notifyItemSyncFailed` |
| Fatal tx-sync? | **swallowed** (Link still succeeds) | **fatal** (fails the item → health fires) |
| Cooldown | none (rate-limited instead) | manual refresh/sync only |
| Audit | `auditLog(ACCOUNT_ADD)` | `emitDomainEvent(ConnectionSynced)` |

These are **intentional and correct** for the two operations: a first link must be transactional at the
account grain and must not mark an item unhealthy on a user's very first attempt; a refresh must be
idempotent, retryable, lock-guarded, and health-reporting. **This table is the reason the two
entrypoints must NOT collapse into one pipeline** — only their *stages* (collection, persistence
primitives) should be shared, with each entrypoint keeping its own failure envelope.

---

## PART 10 — New-provider simulation (Coinbase / Gemini / CSV)

**The simulation is already run in production twice — WALLET and IMPORTS.**

- **WALLET** (`app/api/accounts/wallet/route.ts`, 336 LOC) **re-implements the entire account-spine
  orchestration inline**: FinancialAccount resolve/create/reactivate → AccountConnection →
  `dualWriteSpaceAccountLink` → `alignWalletProviderSpine`/ProviderAccountIdentity →
  `regenerateSnapshotsForAccounts` → audit. It shares only the **leaf** primitives with Plaid; the
  orchestration is a hand-rolled copy of exchangeToken's spine.
- **IMPORTS** (`lib/imports/pipeline.ts`) is **DB-free / transaction-only** — parses+normalizes to
  `NormalizedTransaction[]` and never creates accounts (attaches to an existing account via the
  `[id]/import` route). It is *not* an account-provider.

**Adding Coinbase today:**

| Question | Answer |
|---|---|
| Files needing edits | New route + collection module; **copy** the account-spine block from exchangeToken/wallet; add `ProviderType.EXCHANGE` handling; flip a `catalog.ts` entry to `enabled:true`; likely a new `*-sync.ts`. Realistically **5–8 files**, most net-new, one large copy. |
| Plaid-specific logic copied | The **account-spine orchestration** (resolve → identity → AccountConnection → SpaceAccountLink → snapshot → audit), `mapAccountType`-shaped mapping, the consent/holdings scaffolding pattern. |
| Canonical stages reusable | `syncCurrentHoldings`, `capturePositionObservations`, `ingestInvestmentEvents`, `syncTransactionsForItem` (**if** raw payloads are adapted to Plaid shapes), `regenerateSnapshotsForAccounts`, `dualWriteSpaceAccountLink`, `dualWriteProviderAccountIdentity`. |
| Missing provider-neutral contract | **`ProviderIngestionPayload`** (normalized accounts/holdings/transactions) and **`persistAccountSpine()`**. Their absence is exactly why WALLET copied the spine. |

**Verdict:** a second major provider is **not** cheap today — it repeats the spine copy WALLET already
made.

---

## PART 11 — Recommended slices (derived from evidence)

- **PROV-2 — dedupe the proven copies (LOW).** Move `mapAccountType` to a shared module; replace the
  **4 inline identity→legacy lookups** with the existing `findActiveAccountByIdentity`. Pure parity;
  no behavior change. Also fix the stale "delete-then-recreate" comments in `refresh.ts`.
- **PROV-3 — shared investments-ingest primitive (MEDIUM).** Extract the ~80-line investments
  orchestration wrapper into `syncInvestmentsForItem(accessToken, plaidItemId, { retry, consentMode })`
  consumed by both files. Forces a **decision on DRIFT-1** (canonical consent-persistence semantics)
  and DRIFT-2 (retry everywhere). Golden-output/write-path parity required.
- **PROV-4 — provider-neutral account-spine writer (MEDIUM→HIGH).** `persistAccountSpine(payload,
  { mode })` consumed by `exchangeToken` + wallet route; kills the WALLET copy and readies a 3rd
  provider. Write-path-equivalence gated (fixture diff on FinancialAccount/AccountConnection/SAL/PAI).
- **PROV-5 — adapter seam reality check (LOW to delete / HIGH to adopt).** Either **delete**
  `plaidAdapter` (dead) — recommended near-term — or, only alongside PROV-6, make it real by routing
  entrypoints through a typed `ProviderAdapter` interface.
- **PROV-6 — second-provider readiness gate (design).** Define `ProviderIngestionPayload` and the
  `collect → normalize → persist → consequences` contract; make the catalog's disabled EXCHANGE/
  BROKERAGE entries backed by a real adapter. This is the gate that must pass before Coinbase/Gemini.

Sequence: PROV-2 → PROV-3 → PROV-4 → (PROV-6 design) → PROV-5. Do **not** attempt an exchange↔refresh
merge — it is explicitly *not* recommended (Part 9).

---

## PART 12 — Risk classification

| Slice | Risk | Parity proof required |
|---|---|---|
| PROV-2 `mapAccountType` extract | **LOW** | tsc; call-site identity (byte-identical body) |
| PROV-2 adopt `findActiveAccountByIdentity` | **LOW→MED** | unit parity on identity/legacy/deleted branches; the warn-gating + `[D2-3E/3F]` tag differences must be reconciled (decide one) |
| PROV-2 comment fix | **LOW** | none (docs) |
| PROV-3 investments wrapper | **MEDIUM** | **golden-output** on Holding/PositionObservation writes; **decide DRIFT-1 consent semantics** (behavior change either way) + apply retry uniformly (DRIFT-2) |
| PROV-4 `persistAccountSpine` | **MED→HIGH** | **write-path equivalence** fixture diff across FinancialAccount + ProviderAccountIdentity + AccountConnection + SpaceAccountLink + Connection; `mode:create` must preserve the per-account `$transaction` + fingerprint reconcile; `mode:update-only` must preserve refresh's never-create/skip-deleted + `balanceLastUpdatedAt` + coalesce |
| PROV-5 delete `plaidAdapter` | **LOW** | grep (already 0 importers) |
| PROV-5 adopt typed adapter | **HIGH** | full route-level integration parity |
| PROV-6 contract design | **LOW** (design) | n/a until implemented |

**Flag for mandatory parity gating:** PROV-3 (golden output) and PROV-4 (write-path equivalence +
idempotency). The failure-semantics table (Part 9) is the invariant set any refactor must not perturb —
especially **fatality of tx-sync** and **per-account atomicity**.

---

## Deliverable — verdicts

**Plaid orchestration materially duplicated?**
**YES** — but ~100–150 LOC of real copy-paste (`mapAccountType`, 4× identity lookup, the ~80-line
investments wrapper), **not** the ~400–500 LOC the complexity audit implied. Most of that apparent
overlap is already shared via single-owner primitives.

**Canonical shared ingestion pipeline justified?**
**PARTIAL** — justified as *shared normalization/persistence primitives* (extract the duplicated
wrapper + a provider-neutral `persistAccountSpine`). **NOT** justified as a single merged
exchange↔refresh pipeline — their failure semantics are deliberately different.

**Existing provider adapter seam real?**
**NO** — `plaidAdapter` and `providers/catalog.ts` execution-adapter surface have **zero importers**;
routes call concrete functions directly. Decorative/dead. (The catalog as a UI *routing* layer is real
but is a different concern.)

**Initial-link and refresh semantics compatible enough to share core?**
**PARTIAL** — the transaction, investments, and snapshot cores are **already shared**. The
account-resolution step and the failure/atomicity/lock/health/cooldown envelopes are legitimately
different and must stay separate.

**Second provider easy to add today?**
**NO** — it would copy the account-spine orchestration, exactly as the WALLET provider already did.
No provider-neutral normalized payload contract exists.

**Refactor required before next major provider?**
**YES** — but scoped: PROV-2/3/4 (dedupe + `persistAccountSpine` + `ProviderIngestionPayload`), **not**
a big-bang pipeline merge.

**Safe to begin implementation after this audit?**
**YES for PROV-2** (LOW risk, pure parity) and the `plaidAdapter` deletion. **PROV-3/PROV-4 require
parity gating** (golden output + write-path equivalence + the DRIFT-1 consent decision) before landing.

**Recommended next slices:**
- **PROV-2** — extract `mapAccountType`; adopt `findActiveAccountByIdentity` (kill 4 inline copies);
  fix stale refresh.ts comments. *(LOW)*
- **PROV-3** — shared `syncInvestmentsForItem` primitive; resolve DRIFT-1/DRIFT-2. *(MEDIUM)*
- **PROV-4** — provider-neutral `persistAccountSpine(mode)`; retire the WALLET spine copy. *(MED→HIGH)*
- **PROV-6** — design `ProviderIngestionPayload` + collect→normalize→persist→consequences contract;
  back the catalog's disabled EXCHANGE/BROKERAGE entries. *(design)*
- **PROV-5** — delete the decorative `plaidAdapter` now; only build a typed adapter interface alongside
  PROV-6. *(LOW to delete)*
</content>
