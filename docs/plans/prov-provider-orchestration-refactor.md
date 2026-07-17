# PROV — Provider Orchestration Consolidation (Implementation Plan)

**Status:** **PROV-2/3/4/5A LANDED** (see git history). PROV-5B (typed `ProviderAdapter`) and PROV-6 (`ProviderIngestionPayload` universal ingestion contract) remain **DEFERRED** by design — Plaid + Wallet prove only the account-spine writer, not a universal ingestion contract (CCPAY-2G doctrine: abstract from the second proven implementation, not the first). Durable outcome doctrine now lives in [`docs/systems/connections.md`](../systems/connections.md) (Canonical contracts + Extension points). Original design record below, derived from the PROV-1 audit.
**Date:** 2026-07-17
**Source of truth:** `docs/audits/PROV1_PROVIDER_ORCHESTRATION_DUPLICATION_AUDIT_2026-07-17.md` (read-only investigation).
**Flagged by:** COMPLEX-0 complexity audit (exchangeToken + refresh spine, A-class).
**Scope:** `lib/plaid/exchangeToken.ts`, `lib/plaid/refresh.ts`, the account-spine primitives, the (dead) `lib/providers` adapter seam, and the WALLET provider that already copies the spine.

---

## 1. Thesis

The complexity audit read `exchangeToken.ts` (645 LOC) and `refresh.ts` (738 LOC) as ~400–500 LOC of
near-duplicate orchestration. The PROV-1 audit disproved the magnitude and re-pointed the problem:

- The heavy semantic work — transaction classification, investment holdings/observation/event
  ingestion, snapshot regeneration — is **already shared** through single-owner primitives. Both
  entrypoints are thin over those stages.
- Genuine hand-duplication is **~100–150 LOC**: `mapAccountType` (verbatim), the identity→legacy
  account lookup (**4 inline copies**, while a shared helper already exists and is bypassed), and the
  **~80-line investments orchestration wrapper** (copied into both files, drifted in 4 places).
- Exchange and refresh are **legitimately different operations** — create/reconcile vs update-only —
  with intentional, correct asymmetries in retry, locking, health, tx-sync fatality, and atomicity.
  **They must not merge into one pipeline.**
- The **real gap** is orthogonal to exchange↔refresh: there is **no provider-neutral account-spine
  writer**, so the WALLET provider (`app/api/accounts/wallet/route.ts`) already re-implements the same
  FinancialAccount → ProviderAccountIdentity → AccountConnection → SpaceAccountLink → snapshot → audit
  spine by hand. A second major provider (Coinbase/Gemini) would copy it a third time.

**Doctrine (non-negotiable for this initiative):**
1. **Dedupe stages, not entrypoints.** Share collection + persistence *primitives*; each entrypoint
   keeps its own failure envelope (retry / lock / health / fatality / atomicity / cooldown).
2. **Parity before landing.** Every write-touching slice ships behind a proven equivalence gate
   (fixture diff / golden output / idempotency) — the PROV-1 Part 9 failure-semantics table is the
   invariant set no slice may perturb.
3. **Behavior decisions are explicit.** Where the two files have *drifted* (consent persistence, retry
   coverage, warn-gating), the shared version forces one canonical choice — call it out, don't
   silently pick.

---

## 2. Architecture target

```
 provider-SPECIFIC collection      Plaid: accountsGet / holdingsGet / transactionsSync (+ retry, consent)
 (per provider, owns API + auth)   Wallet: btc-explorer / xpub discovery
            │
            ▼
 NORMALIZED CONTRACT  ────────────  ProviderIngestionPayload { accounts[], holdings[], transactions[] }
 (MISSING today — PROV-6)                                     ← the contract WALLET's copy proves absent
            │
            ▼
 provider-NEUTRAL persistence       persistAccountSpine(payload, { mode: "create" | "update-only" })
 (mostly shared already)            syncCurrentHoldings · capturePositionObservations
                                    ingestInvestmentEvents · syncTransactionsForItem
            │
            ▼
 POST-WRITE consequences            regenerateSnapshots · audit · health · notify
 (shared primitives, per-entrypoint orchestration — NOT merged)
```

Ordering invariants any shared code must preserve (PROV-1 Part 8): item/credential before accounts;
identity/account resolution before AccountConnection+SpaceAccountLink (written atomically together);
secById before per-holding writes; **observation capture before `syncCurrentHoldings`**;
`syncCurrentHoldings` before `ingestInvestmentEvents`; cursor advances per-page after that page's
writes; refresh captures balances before tx-sync (M2 reconciliation); all-items refresh completes every
item before `regenerateCompletedSpaces`.

---

## 3. Slices

### PROV-2 · Dedupe the proven copies — **LOW risk**
Extract `mapAccountType` to a shared module (currently exported at `exchangeToken.ts:102`, private copy
at `refresh.ts:59`, byte-identical). Replace the **4 inline identity→legacy account lookups**
(`exchangeToken.ts:270-284` + `:471-487`; `refresh.ts:179-196` + `:301-324`) with the existing
`findActiveAccountByIdentity` (`lib/accounts/reconcile.ts:139`, already used by the restore routes).
Fix the stale "delete-then-recreate" comments in `refresh.ts` (holdings now go through
`syncCurrentHoldings`'s insert/update/remove-stale).

*Decision required:* reconcile the lookup warn-gating — refresh suppresses the coverage-gap warning for
archived accounts and tags `[D2-3E]`; exchange warns unconditionally and tags `[D2-3F]`. Pick one
behavior in the shared helper.

*Exit:* `mapAccountType` has one owner; zero inline identity→legacy copies remain; refresh comments
match actual behavior; tsc + eslint clean; unit + oracle green; no behavior change beyond the
reconciled warn-gating.

### PROV-3 · Shared investments-ingest primitive — **MEDIUM risk**
Extract the ~80-line investments orchestration wrapper (consent seed, `investmentsHoldingsGet`,
per-account filter, secById build, identity lookup + legacy fallback, observation→holdings→events
sequence, ADDITIONAL_CONSENT_REQUIRED catch) into
`syncInvestmentsForItem(accessToken, plaidItemId, { retry, consentMode })`, consumed by both files. The
leaf primitives are already shared; this deduplicates the scaffolding and freezes the four drifts.

*Decisions required:*
- **DRIFT-1 (consent persistence).** exchange writes the derived value whenever derivable (no prior
  state); refresh change-detects against stored `investmentsConsent` and logs transitions. Choose the
  canonical rule (likely: change-detect + log, with a first-link seed path).
- **DRIFT-2 (retry).** refresh wraps `investmentsHoldingsGet` in `withPlaidRetry`; exchange calls it
  bare. Decide whether the shared primitive always retries (recommended — closes the link-path
  transient-failure gap) or takes retry as a caller flag.

*Exit:* one investments-ingest function; DRIFT-1/DRIFT-2 resolved and documented; **golden-output
parity** on `Holding` + `PositionObservation` writes for both entrypoints; consent state transitions
unchanged (or intentionally changed with a note); suite + oracle green.

### PROV-4 · Provider-neutral account-spine writer — **MEDIUM → HIGH risk**
`persistAccountSpine(payload, ctx, { mode })` — one writer for the FinancialAccount →
ProviderAccountIdentity → AccountConnection → SpaceAccountLink (+ Connection) spine:
- `mode: "create"` — exchangeToken semantics: identity→legacy→fingerprint→create, per-account
  `$transaction`(AccountConnection + SpaceAccountLink), `deletedAt:null` restore, `plaidAccountId`
  stamp on the fingerprint branch.
- `mode: "update-only"` — refresh semantics: never create/restore, skip soft-deleted,
  `balance ?? fa.balance` coalesce, `balanceLastUpdatedAt` provenance.

Consumed by `exchangeToken` **and** the WALLET route (`app/api/accounts/wallet/route.ts`), retiring the
WALLET spine copy. This is the slice that actually readies a third provider.

*Exit:* `exchangeToken` + wallet route write the spine through one function; **write-path-equivalence
fixture diff** across FinancialAccount + ProviderAccountIdentity + AccountConnection + SpaceAccountLink
+ Connection for create, update-only, and wallet paths; per-account `$transaction` boundary preserved
in create mode; idempotency test (re-run yields no churn); suite + oracle green.

### PROV-6 · Second-provider readiness contract — **DESIGN** (do before any native provider)
Define `ProviderIngestionPayload` (normalized accounts/holdings/transactions) and the
`collect → normalize → persist → consequences` contract that a provider implements. Back the catalog's
disabled `EXCHANGE` / `BROKERAGE` entries (`lib/providers/catalog.ts:141-164`) with a real adapter
shape. This is the gate that must pass before Coinbase/Gemini implementation begins.

*Exit:* a written contract + a worked example (Plaid producing the payload, `persistAccountSpine`
consuming it) that demonstrates a native provider needs *only* a collection module, not a spine copy.

### PROV-5 · Adapter seam reality check — **LOW to delete / HIGH to adopt**
`lib/providers/plaid/adapter.ts` (`plaidAdapter`) has **zero importers** and is a pure re-export;
`lib/providers/catalog.ts` execution helpers have zero importers. Near-term: **delete `plaidAdapter`**
(dead). Only build a typed `ProviderAdapter` interface + route entrypoints through it **alongside
PROV-6** — never speculatively.

*Exit:* dead `plaidAdapter` removed (grep-confirmed 0 importers); OR (only with PROV-6) a typed adapter
interface with real route adoption + integration parity.

---

## 4. Sequencing & dependencies

```
PROV-2 ──▶ PROV-3 ──▶ PROV-4 ──▶ PROV-6 (design) ──▶ [native provider work]
   │                     ▲
   └── PROV-5 (delete plaidAdapter) can land any time; typed-adapter variant gated on PROV-6
```

- **PROV-2** is standalone and safe first (pure parity + one warn-gating decision).
- **PROV-3** depends on PROV-2's shared lookup helper.
- **PROV-4** is the highest-value / highest-risk slice; do after PROV-2/3 settle the primitives.
- **PROV-6** is design work that formalizes what PROV-4 makes possible; it gates any native provider.
- **PROV-5 delete** is independent and can ship immediately.

**Do NOT** attempt an exchange↔refresh pipeline merge — explicitly out of scope (PROV-1 Part 9).

---

## 5. Risk & parity gates

| Slice | Risk | Mandatory parity proof |
|---|---|---|
| PROV-2 `mapAccountType` extract | LOW | tsc; byte-identical body |
| PROV-2 adopt `findActiveAccountByIdentity` | LOW→MED | unit parity on identity/legacy/deleted branches; reconcile warn-gating + tag |
| PROV-2 comment fix | LOW | none (docs) |
| PROV-3 investments wrapper | MEDIUM | **golden output** on Holding/PositionObservation; DRIFT-1 consent decision; DRIFT-2 retry decision |
| PROV-4 `persistAccountSpine` | MED→HIGH | **write-path equivalence** (FA + PAI + AccountConnection + SAL + Connection) for create / update-only / wallet; `$transaction` boundary; idempotency test |
| PROV-5 delete `plaidAdapter` | LOW | grep (0 importers) |
| PROV-5 typed adapter | HIGH | route-level integration parity (only with PROV-6) |
| PROV-6 contract design | LOW | n/a until implemented |

**Invariant floor (all slices):** the PROV-1 Part 9 failure-semantics table must be preserved —
especially tx-sync fatality (fatal in refresh, swallowed in exchange), per-account atomicity in create
mode, refresh's never-create/idempotent update model, and the manual-only cooldown scope.

---

## 6. Out of scope

- Merging `exchangeToken` and `refresh` into a single pipeline (semantics differ by design).
- Changing the transaction pipeline (`syncTransactionsForItem`) — already single-owner and shared.
- The `sync-banks` cron's transactions-only shape and the webhook `runDeferredHistorySync` tail — left
  as-is; they consume the same shared engine.
- Any actual Coinbase/Gemini/native-exchange implementation — gated behind PROV-6.
</content>
