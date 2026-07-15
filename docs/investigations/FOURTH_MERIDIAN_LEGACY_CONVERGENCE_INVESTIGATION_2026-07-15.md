# Fourth Meridian — Legacy Artifact & Parallel-Authority Convergence Investigation

**Date:** 2026-07-15
**Scope:** full working tree (`feature/v2.5-spaces-completion`, HEAD `e74046e`, dirty — KD-20 filters + Investments Allocation WIP present on disk and audited as they exist)
**Mode:** read-only. No code, schema, migration, or git changes were made.
**Method:** six parallel deep-scan passes (account identity · investment spine · transaction/aggregation · visibility · route/dead-code archaeology · schema/scripts/flags), each producing file:line evidence, followed by independent spot-verification of every headline claim (A10 scope, goals route join, N3 net comment, legacy count sites, purge-script default, `BANKING_CATEGORIES` filter, share-route `accountName`, AI holdings assembler source — all re-confirmed by direct read).
**Limits:** production DB unreachable; anything requiring prod row counts is labeled NEEDS DB VERIFICATION. The staged tree has no `.git`, so committed-vs-uncommitted distinctions rely on STATUS.md.

---

## 1. Executive verdict

**The repository is dramatically more converged than the "old world / new world" framing fears — but the residue that remains is concentrated exactly where it is most dangerous: investments and privacy.**

Five headline conclusions:

1. **The legacy `Account` world is frozen, not active.** Zero runtime writers exist for the legacy `Account` model, `Transaction.accountId`, or `Holding.accountId` (VERIFIED — every create path writes `financialAccountId`). What remains is 4 direct read accessors, 6 `Space.accounts` count queries, ~11 dual-read OR arms, and ~10 in-memory coalesce shims — all instrumented by `scripts/phase0-seam-gates.ts` and all waiting on **one prod gate run that has never been executed**. This is a stalled retirement, not a live parallel system. The one live *user-facing bug* it causes is the Space-card account undercount (DIVERGENT).

2. **Investments is the one true PARALLEL AUTHORITY domain.** Three current-state position authorities coexist today: legacy `Holding` (feeds AI, exports, the legacy endpoint, and **all crypto**), the A-track (`PositionObservation`→A10, feeds the Investments Perspective UI), and `FinancialAccount.balance` (feeds live Wealth). Nine concrete divergence surfaces were mapped (§13). The AI/UI concentration split the prompt suspected is real and live: same `computeConcentration` formula, fed from different worlds (symbol-keyed native-currency Holding rows for AI vs instrument-keyed FX-converted A10 rows for UI).

3. **The transaction spine is genuinely converged — with three unnamed defects.** FlowType P5's "single semantic authority" claim holds for flow classification (VERIFIED: no unsanctioned sign/PFC/category flow decisions remain). What STATUS does *not* name: (a) the AI trend engine's net omits refunds while claiming to mirror the top-level net (`lib/ai/intelligence/annotations.ts:869` vs `:353/:863` — a live numeric self-contradiction); (b) AI merchant/income-source/drilldown rollups use raw native amounts while the totals they sit beside are FX-converted; (c) the Tab/Cash-Flow row population is category-defined (`BANKING_CATEGORIES`, `lib/data/transactions.ts:127`) while the AI population is flow-defined — a latent trap that goes live the day any MI-M2 producer writes the six new spend categories.

4. **Four privacy bypasses were found, and the worst one is in the NEW canonical path.** The A10 time machine scopes SAL on `status: ACTIVE` with **no `visibilityLevel` filter** (`lib/investments/investments-time-machine.ts:104–108`, `lib/investments/valuation.ts:103–107`) — per-position symbols/quantities/values of a BALANCE_ONLY-shared account leak to every Space member, while the legacy `getHoldings` path correctly gates FULL-only. The doctrine's newest spine is its biggest privacy hole. Also: goals route serializes real FA name+balance ungated (`app/api/spaces/[id]/goals/route.ts:34–39`), the activity feed persists+renders real account names for BALANCE_ONLY shares (`share/route.ts:77` → `activity/route.ts:210`), and banking-import authorization ignores visibility where investment import gates FULL.

5. **Dead code is nearly gone; dead *routes* and frozen schema remain.** Module-level hygiene checks out (STATUS's cleanups verified on disk). The remaining debt: ~6 superseded/caller-less API routes, `AiAdvice` reader-without-writer (KD-14 confirmed), `VisibilityLevel.SHARED`/`SUMMARY_ONLY` as phantom tiers, 6 undeclared env flags, and one genuinely dangerous script (`purge-plaid-connection.ts` defaults `--email` to the founder's real address, `scripts/purge-plaid-connection.ts:80`).

**Overall label: PARTIALLY VERIFIED convergence.** Account identity: LEGACY COMPATIBILITY, gate-blocked. Transactions/aggregation: CANONICAL with named residuals. Investments: PARALLEL AUTHORITY, needs an initiative. Visibility: CANONICAL seams with 4 DIVERGENT bypasses. The single most dangerous seam to leave in place is the A10 visibility gap — because every plan (including this one) routes MORE consumers onto A10.

---

## 2. Canonical architecture map (as it exists today)

```text
ACCOUNT IDENTITY (CANONICAL, verified)
  Provider (Plaid/wallet/manual/CSV)
    → PlaidItem (credentials) ∥ Connection (D2 spine, dual-written)
    → ProviderAccountIdentity (provider id mapping; plaidAccountId fallback behind warn)
    → FinancialAccount (the account)
    → SpaceAccountLink (participation + FULL/BALANCE_ONLY visibility; sole runtime link model)
  [frozen shadow: Account, Space.accounts, Transaction.accountId, Holding.accountId, VisibilityLevel.SHARED]

TRANSACTION SEMANTICS (CANONICAL, verified)
  Provider rows → merchant layer (category ONLY, never flow)
    → classifyFlow (lib/transactions/flow-classifier.ts — the single write-time authority)
    → FlowType + FlowDirection + reason persisted on Transaction
    → transfer evidence (plaid-transfer-evidence.ts — sole PFC-transfer-taxonomy reader)
    → TransactionFacts (TI2) · RelationshipResolver · transfer disposition
    → flow-predicates.ts (COST_FLOWS — single membership authority)
    → classifyLiquidity (single liquidity-axis classifier)
    → DayFacts (cash-flow-projection.ts — CF-3 canonical projection, parity-pinned)
    → UI widgets / Tab summary (sumByFlowType) / AI assembler (parallel envelope, same predicates)

INVESTMENT POSITIONS (PARALLEL AUTHORITY — the unconverged domain)
  path A (legacy): Plaid holdings + BTC sync → Holding → getHoldings → legacy endpoint / AI / export
  path B (canonical-in-waiting): Plaid capture + imports + assertions
      → Instrument/InstrumentAlias + PositionObservation + InvestmentEvent
      → PositionReconstruction + PriceObservation + FxRate
      → valuation.ts (A8-4) → A10 time machine (ValuedHoldingRow) → Investments Perspective
  path C: FinancialAccount.balance → live SpaceSnapshot → Wealth hero/cards
  crypto: writes path A + FinancialAccount.nativeBalance only; A9 bypasses the spine (nativeBalance × BTC price)

HISTORICAL VALUATION / WEALTH (CANONICAL)
  SpaceSnapshot (daily writer + backfill walk-back + A9 regeneration + SnapshotAmendment consent-rewrites)
  → wealth-time-machine → Wealth perspective / Space cards

VISIBILITY (CANONICAL seams + 4 bypasses)
  SAL.visibilityLevel → TRANSACTION_DETAIL_VISIBILITY / grantsAccountDetail (lib/ai/visibility.ts)
  → sanitizeForBalanceOnly / normalizeSharedAccounts (lib/account-privacy.ts)
  → transactionDetailWhere (detail-query.ts) → lib/data readers → UI/AI/export
  bypasses: A10 scope · goals contributions join · activity-feed names · banking-import authority

AI CONTEXT (CANONICAL assembly, divergent inputs)
  buildContext → assemblers (accounts/transactions/holdings/snapshot/goals)
  — transactions assembler: canonical predicates, own envelope (intentional)
  — holdings assembler: LEGACY Holding (divergent from UI)
```

---

## 3. Complete legacy inventory (Part 1)

Classification key per the brief. "Delete now?" = deletable before any DB migration.

| Artifact | Domain | Type | Current writers | Current readers | Canonical replacement | Unique data? | Runtime risk | Migration risk | Delete now? | Retirement gate |
|---|---|---|---|---|---|---|---|---|---|---|
| `Account` model | Identity | LEGACY COMPATIBILITY (frozen) | none (seed wipe only, `prisma/seed.ts:274`) | 4 accessors: `app/admin/page.tsx:56`, `app/api/admin/overview/route.ts:73`, `app/api/accounts/[id]/transactions/route.ts:38`, `lib/imports/authorize.ts:74` | FinancialAccount | possibly (prod rows unknown) | admin undercount; latent auth hole (§4) | Cascade FKs on drop | No | Gates B/C=0 → M3/M4 |
| `Space.accounts` relation | Identity | LEGACY ACTIVE / DIVERGENT | none | 6 count queries / 7 usages in 5 files (§4) | SAL ACTIVE count | no | **live Space-card undercount** | none (count swap) | **Swap now (A1-S1)** | none |
| `Transaction.accountId` | Identity | LEGACY COMPATIBILITY | **none** | 8 OR arms + selects (§4) | `financialAccountId` | possibly (never backfilled) | legacy arm skips KD-15 tier gate | column drop cascades | No | Gate B=0 |
| `Holding.accountId` | Identity/Invest | LEGACY COMPATIBILITY | **none** | 1 arm (`lib/data/accounts.ts:250–252`) + coalesce | `financialAccountId` | possibly | legacy branch has no FULL gate | column drop cascades | No | Gate A=0 |
| `accountId ?? financialAccountId` shims | Identity | LEGACY COMPATIBILITY (pure) | — | ~10 sites (serialize ×2, accounts, RelationshipResolver, liquidity, cash-flow-context, cash-flow-projection ×2, liquidity-breakdown, CashFlowSummaryWidget) | single field | no | none while arms exist | must go with M3 | No | with M3 |
| `legacy: boolean` DTO flag | Identity | LEGACY COMPATIBILITY | — | `types/index.ts:231`, `lib/data/transactions.ts:346,355` | drop | no | none | none | No | with A1-S4 |
| `VisibilityLevel.SHARED` | Visibility | DEAD CODE at runtime / NEEDS DB VERIFICATION | none | zero positive; fail-closed exclusions only | `FULL` | n/a | none (fails closed) | Postgres enum recreation | No | Gate E=0 → M4 |
| `VisibilityLevel.SUMMARY_ONLY` | Visibility | FROZEN / PHANTOM TIER | **no write path** | seams lump with BALANCE_ONLY (numeric balance exposed) | implement or delete | n/a | contract-vs-behavior mismatch if ever written | enum recreation | No | NEEDS FOUNDER DECISION |
| `Holding` model | Investments | LEGACY ACTIVE (writer-fed projection) | Plaid holdings sync (`sync-current-holdings.ts:147–190`), BTC sync (`btc-sync.ts:149`) | getHoldings → legacy endpoint, AI assembler, export (§5) | A-track + CurrentPosition projection (§16) | `change24h` only (reproducible); crypto quantity **currently unique in practice** | AI/UI divergence | dual-anchor rows unknown | No | consumer cutovers + crypto on spine + Gate A |
| `lib/investments/current-holdings.ts` | Investments | LEGACY ACTIVE | — | legacy endpoint view builder | A10 / CurrentPosition | no | totals diverge from A10 | — | No | after endpoint cutover |
| `/api/spaces/[id]/investments` | Investments | LEGACY ACTIVE | — | `InvestmentConnectionsCard.tsx:97`, `InvestmentAccountsWidget.tsx:258` | time-machine route + a health-only read | no | ships full positions for a health chip | — | No | after ConnectionsCard slimmed |
| `InvestmentAccountsWidget` | Investments | LIKELY DEAD UI PATH | — | renderer registered; no template materializes `investment_accounts` | InvestmentsPerspective | no | none if no DB section rows | — | NEEDS DB VERIFICATION | section-row check |
| AI holdings assembler source | AI/Invest | LEGACY ACTIVE / DIVERGENT | — | `lib/ai/assemblers/holdings.ts:120–136,225` | A10/CurrentPosition read | no | AI vs UI concentration disagree | — | No | after A10 visibility fix |
| `aggregateCashFlow`/`deriveCashFlowAxes` fold family | Aggregation | LEGACY ACTIVE (parity-pinned) | — | adapters, SliceDrawer, SummaryWidget, compare | DayFacts (shim onto it) | no | none today (test-pinned parity) | none | Shim then delete | B-S1 |
| `bucketLiquidity`, `dailyLiquidity`, `bucketCashFlow`/`dailyCashFlow` | Aggregation | DEAD CODE | — | zero non-test consumers (one stale comment `CashFlowHistoryWidget.tsx:14`) | DayFacts | no | none | none | **Yes** | none |
| `BANKING_CATEGORIES` population filter | Transactions | LEGACY ACTIVE / latent DIVERGENT | — | `lib/data/transactions.ts:127,208` | FlowType-based population | no | goes live with MI M2 | none | No (convergence slice) | before MI M2 |
| N3 trend net | AI | DIVERGENT (defect) | — | `lib/ai/intelligence/annotations.ts:869` (comment `:353,:863` false) | named net measures | n/a | AI self-contradiction in refund months | none | Fix now | none |
| `/api/admin/overview` | Routes | DEAD CODE (superseded) | — | zero callers | RSC direct read | no | none | none | **Yes** (update `lib/security-surface.test.ts:165`) | none |
| `/api/accounts/manual/archived` | Routes | DEAD CODE (superseded) | — | zero callers | RSC archived-assets page | no | none | none | **Yes** | none |
| `/api/accounts/[id]/transactions` | Routes | SUPERSEDED (orphaned by banking deletion) | — | zero repo callers | `/api/spaces/[id]/transactions` + `/api/transactions/[id]` | no | contains the legacy-Account fallback | none | After log check | NEEDS RUNTIME VERIFICATION |
| `/api/accounts/manual/[id]` | Routes | SUPERSEDED | — | zero callers | `/api/accounts/[id]` | no | none | none | After log check | NEEDS RUNTIME VERIFICATION |
| `/api/admin/plaid/retire-superseded-item` | Routes | SUPERSEDED (inlined) | — | zero callers | exchange-expanded-history-token inline | no | none | none | NEEDS FOUNDER DECISION (recovery hatch) | — |
| `/api/merchant-ops/candidates` | Routes | DEAD CODE (superseded at birth) | — | zero callers | RSC page read | no | none | none | **Yes** | none |
| `/api/plaid/sync`, `/api/accounts/[id]/import`(+preview), `/api/transactions/[id]/correct`, `/api/investments/opening-position` | Routes | DORMANT BY DESIGN (API-first, UI unshipped) | — | zero callers, self-documented | n/a | n/a | authenticated deployed surface | none | No — keep or ship UI | NEEDS FOUNDER DECISION |
| `/dashboard/workspaces`, `/admin/workspaces` | Routes | LEGACY COMPATIBILITY (redirect stubs) | — | old bookmarks | spaces routes | no | none | none | Keep (cheap) | — |
| `AiAdvice` | AI | FROZEN SCHEMA (reader-without-writer, KD-14) | seed only | `app/api/brief/route.ts:601`, `lib/export/assemble.ts:222`, `lib/data/advice.ts:16` | v2.6b writer | n/a | can only surface seed data | none | No — INTENTIONALLY RETAINED | v2.6b |
| `DuplicateAccountCandidate` | Identity | APPEND-ONLY HISTORY / INTENTIONALLY RETAINED | reconcile merge path | none (no review UI) | — | yes (merge ledger) | none | none | No | — |
| `AccountConnection.syncStatus/lastSyncedAt` | Provider | LEGACY COMPATIBILITY (declared mirrors) | dual-written | mixed | Connection truth | no | drift risk documented | column drop later | No | D2 completion |
| `FinancialAccount.walletAddress/walletChain/nativeBalance` | Provider | LEGACY ACTIVE (transitional, self-labeled) | btc-sync, wallet route | crypto paths, A9 | PAI(WALLET)+Connection + PositionObservation | **yes today** (crypto quantity) | crypto bypasses spine | later | No | crypto-on-spine |
| `plaidAccountId` fallback reads | Provider | LEGACY COMPATIBILITY | — | `lib/plaid/refresh.ts:173–193` (warn-and-fallback ×2) | ProviderAccountIdentity | no | none (warned) | none | No | prod observation window |
| `ensureHomeLink()` | Identity | DEAD CODE (documented rollback keeper) | — | zero call sites | — | no | would write FULL links if reconnected | none | NEEDS FOUNDER DECISION | — |
| `lib/email/index.ts` barrel | Infra | DEAD CODE | — | zero importers | direct `send` imports | no | none | none | **Yes** | none |
| `lib/providers/catalog.ts` | Provider | DEAD CODE / aspirational | — | zero importers | D6 future | no | none | none | **Yes** unless D6 imminent | — |
| `lib/providers/plaid/adapter.ts` | Provider | DORMANT SEAM (by decision record) | — | zero importers | — | no | none | none | NEEDS FOUNDER DECISION | — |
| `lib/widget-registry.ts:64–67,772` `/api/spaces/[id]/holdings` dataTier | UI | PHANTOM ENDPOINT REFERENCE | — | registry metadata | real route or removal | no | future 404 | none | **Fix now** (doc-only) | none |
| `FLOWTYPE_SHADOW` flag | Config | OBSOLETE-ish (log-only residue of shadow phase) | — | `lib/plaid/syncTransactions.ts:159` | remove/rename | no | none | none | **Yes** (after P3 closure ruling) | NEEDS FOUNDER DECISION |
| 6 undeclared env flags (`AI_OUTPUT_VALIDATION_MODE`, `FLOWTYPE_SHADOW`, `INVESTMENT_IMPORTS_ENABLED`, `SECURITY_PRICES_ENABLED`, `TIINGO_API_KEY`, `OXR_APP_ID`) | Config | CONFIG DRIFT | — | live readers, absent from `.env.example`/env-status | declare | n/a | invisible to ops surface | none | **Declare now** | none |
| `scripts/dedupe-home-links.ts` | Scripts | OBSOLETE (KD-5 index now enforces) | — | — | partial unique index | no | none | none | **Yes** | none |
| `scripts/merge-wgu-merchants.ts` | Scripts | OBSOLETE (superseded by merge-merchants.ts) | — | — | merge-merchants.ts | no | none | none | **Yes** | none |
| `scripts/kd17-audit-jan-other.ts` | Scripts | TEST/DIAGNOSTIC ONLY (self-declared deletable) | — | — | — | no | none | none | **Yes** | none |
| `scripts/purge-plaid-connection.ts` | Scripts | **DANGEROUS IF RUN TODAY** | — | — | — | no | `--apply` defaults to founder's real email (`:80`) | none | **Yes (or force `--email`)** | none |
| `scripts/phase0-seam-gates.ts` | Scripts | RETIREMENT GATE — keep | — | — | — | — | — | — | No — the instrument | until M4 |
| Legacy backfill scripts (flowtype, transfer-evidence, currency, PAI, wallet-connections, tx-facts, position-observations, cc-payment, merchant-categories, reclassify-subscriptions) | Scripts | MIGRATION/BACKFILL ONLY (complete, idempotent) | — | — | — | — | provenance caveat: category writers don't stamp `categorySource` | — | Archive after retirement | M4+ |
| `types/index.ts` duplicate vocab unions (`PaymentChannel`, `CounterpartyType`, `FlowClassificationReason`) | Types | DUPLICATE CONSTANTS (DTO twin of Prisma enums) | — | structural consumers | derive from Prisma types | no | drift risk | none | Converge opportunistically | — |
| `TransactionCategory.Transport/.PersonalCare` | Schema | FROZEN SCHEMA (admitted, producer never landed) | none | none | MI M2 | n/a | none | enum values irreversible-cheap | No | MI M2 or accept |
| Reserved enum values (SyncIssueKind.REPLAY_*, ProviderType.CSV/EXCHANGE/BROKERAGE, MerchantEnrichmentSource futures, PriceBasis.INTRADAY, MerchantRuleScope.SPACE, DuplicateStatus.*) | Schema | INTENTIONALLY RETAINED (documented seams) | — | — | — | — | none | — | No | — |
| `SpaceCategory.GOAL` | Schema | LEGACY COMPATIBILITY | none | none | — | possible rows | none | enum recreation | No | NEEDS DB VERIFICATION |
| `ImportMappingProfile` | Imports | CANONICAL (partial — no CRUD route; DB-client-seeded) | auto-use path | auto-use path | CRUD slice | yes | — | — | No | NEEDS FOUNDER DECISION |

---

## 4. Account identity analysis (Part 2)

**Verdict: LEGACY COMPATIBILITY throughout — zero runtime writers anywhere (VERIFIED). The retirement is fully instrumented and stalled on a single un-run prod gate.**

### Writers — clean across the board
Plaid sync (`lib/plaid/syncTransactions.ts:61` — "Writes financialAccountId, never legacy accountId"), webhook, CSV import (`ImportBatch.financialAccountId` is a required FK — legacy accounts structurally cannot import), BTC sync, purge, and seed all write canonical identity only. `WorkspaceAccountShare` retirement (migration `20260703120000`) is the proven template.

### Read residue (exact census)
- **4 direct legacy-`Account` accessors** — two admin counts (`app/admin/page.tsx:56`, `app/api/admin/overview/route.ts:73`), two `findFirst` fallbacks (`app/api/accounts/[id]/transactions/route.ts:38–45`, `lib/imports/authorize.ts:74–84`). Matches STATUS's "4 accessors" exactly.
- **`Space.accounts`: 6 query sites across 5 files — STATUS says 5.** The missed site: `app/api/admin/spaces/route.ts:52–54` does a full `accounts: { select: { type } }` relation *read* (admin type-distribution bar), not just a `_count`. An A1-S1 executor working from STATUS's list would miss it. (DIVERGENT, user-facing at `app/(shell)/dashboard/spaces/page.tsx:154,174`: cards can show real net worth — snapshots are canonical — with a legacy-relation account count of 0.)
- **`Transaction.accountId`: 8 dual-read OR arms** (`lib/data/transactions.ts:116,202,237,424–428`; `lib/transactions/detail-query.ts:44`; `lib/ai/assemblers/transactions.ts:358,1216`; `app/api/accounts/[id]/transactions/route.ts:62`) — zero writers.
- **`Holding.accountId`: 1 arm** (`lib/data/accounts.ts:250–252`).
- **~10 in-memory coalesce shims** — the closure doc says "4 normalization shims"; the true count is ~10 (`serialize.ts:84,119`, `accounts.ts:282`, `RelationshipResolver.ts:154`, `liquidity.ts:119`, `cash-flow-context.ts:119`, `cash-flow-projection.ts:104,223`, `liquidity-breakdown.ts:117`, `CashFlowSummaryWidget.tsx:211`). All must move at M3.
- **`VisibilityLevel.SHARED`: zero positive readers/writers.** Fail-closed exclusions only. The 2026-07-02 zero-rows audit is not committed anywhere — Gate E remains NEEDS DB VERIFICATION.

### Why the legacy paths still exist
They protect *possibly-existing* prod rows: **no migration ever backfilled `Transaction.financialAccountId` or `Holding.financialAccountId` from `accountId`** (verified across all 74 migration dirs — the parallel columns were added in `20260616000000` and `20260622150000` with no later drop). Removing the arms before Gates A/B read 0 would make real user rows silently disappear; dropping the model with rows present cascade-deletes them (both legacy FKs are `onDelete: Cascade`).

### The latent authorization hole (elevates the gate run from hygiene to security)
The transactions-route legacy fallback treats any legacy-Account match as "the Space's own — FULL by definition" with **no SAL tier check**, and the legacy OR arms ignore `Account.visibilityLevel` entirely (a legacy `PRIVATE` row would leak full rows to all members of its Space). If Gate C = 0 this is DEAD CODE; if Gate C ≠ 0 it is a live tier bypass. **NEEDS DB VERIFICATION — this is the strongest argument for running the gates first.**

### M1–M4 verdict
The framing (M1 zero runtime reads → M2 re-anchor if needed → M3 FK/column drop → M4 model+`SHARED` enum delete) is **sound**; the WAS retirement proves the pattern. Two challenges:
1. **Run the prod gate first, not third.** `scripts/phase0-seam-gates.ts` is read-only and takes minutes; its result decides whether A1-S4 is a trivial deletion (gates 0) or requires an M2 data migration. The recommended sequence in STATUS defers information that is free to obtain.
2. **Bundle `SHARED` (and `SpaceCategory.GOAL`) enum removal into the same M4 migration** as the `Account` drop — Postgres enum recreation is a locking rewrite; pay it once.

### Safe before any DB migration
Count swaps at all 6 `Space.accounts` sites + 2 admin `db.account.count` sites (fixes the live undercount); the A1-S2 `legacy-account-invariants` source-scan test (**does not exist yet** — verified); trim `scripts/diagnose-invalid-plaid-tokens.ts:143`. Everything else is gate-blocked.

---

## 5. Investment truth-spine analysis (Part 3)

**Verdict: PARALLEL AUTHORITY — the one domain where two (really three) truth systems are simultaneously live, with a tracked-nowhere cutover.**

### The two architectures
- **Legacy:** `Holding` (day-one model, `20260609234422_init`): symbol-keyed, mutable, no instrument FK, no provenance, no history, no cost basis. Writers: Plaid holdings diff-sync (`lib/investments/sync-current-holdings.ts:147–190` — deliberately modernized as "the current-state projection", skips cash & no-ticker securities) and BTC wallet sync (`lib/crypto/btc-sync.ts:149`). Readers: `getHoldings` (`lib/data/accounts.ts:246–275`) → legacy endpoint `/api/spaces/[id]/investments` → `InvestmentConnectionsCard` + (dormant) `InvestmentAccountsWidget`; **AI holdings assembler** (`lib/ai/assemblers/holdings.ts:120–136`); **data export** (`lib/export/assemble.ts:119`).
- **Evidence-grade (A-track, landed 2026-07-11→14):** `Instrument`/`InstrumentAlias`/`PositionObservation`/`InvestmentEvent`/`PositionReconstruction`/`PriceObservation`/`FxRate`, all writers env-flag-gated dark writes (`INVESTMENT_OBSERVATIONS_ENABLED` etc. — prod values NEEDS RUNTIME VERIFICATION); read side: `valuation.ts` (A8-4) → A10 time machine (`investments-time-machine.ts`) → Investments Perspective + WIP Allocation panel; A9 historical wealth regeneration.
- **Third authority in practice:** live Wealth values investment accounts from `FinancialAccount.balance` (`lib/snapshots/regenerate.ts:53–58`) — acknowledged in-repo as "not guaranteed to agree" (`scripts/diagnose-wealth-chart-gap.ts:19–20`).

### Answers to the twelve questions
1. **Authoritative today:** operationally `Holding` (AI, export, legacy endpoint, all crypto); A10 for the Investments UI and history; `FinancialAccount.balance` for live Wealth. Three authorities. PARALLEL AUTHORITY, VERIFIED.
2. **Should be:** the A-track, via a lightweight current-position projection (§16). NEEDS FOUNDER DECISION on timing only.
3. **Unique data in Holding:** effectively none. `PositionObservation` carries quantity/currency/isCash/costBasis/vested/institution price+value+as-of. The only deltas: `change24h` (reproducible from two `PriceObservation` rows) and the synthetic brokerage-cash row (superseded by DERIVED observations). **In practice crypto quantity is unique to Holding today** — because nothing writes crypto to the spine, not because the spine can't represent it.
4. **Writers of Holding:** Plaid sync ×2 entry points, BTC sync, one-time currency backfill, seed/tests. **No manual/CSV writers — imports and assertions live only on the A-track**, so imported positions are invisible to every Holding reader. Structural split, VERIFIED.
5. **Readers:** getHoldings → legacy endpoint → two components; AI assembler; export; ops scripts.
6. **Already on A10:** Investments Perspective family (holdings grid, activity, bridge, WIP allocation), time-machine route, A9→SpaceSnapshot→Wealth history.
7. **Can every consumer move?** Yes, with three deltas: AI assembler → A10-at-today; ConnectionsCard → positions-free health read (it uses only connection `state`); export → serialize `ValuedHoldingRow[]`. **Blockers first: the A10 visibility gap (§8) and crypto (Q8).** Moving AI/export onto A10 as-is would *widen* a KD-19-class leak.
8. **Crypto onto the spine:** (i) a `writeBtcHolding` sibling upserting OBSERVED `PositionObservation(source:"wallet")` against the global CRYPTO BTC `Instrument` via a `("wallet", asset)` alias; (ii) on-chain tx → `InvestmentEvent(TRANSFER_IN/OUT)`; (iii) **dedupe the bootstrap-BTC instrument risk**: `scripts/backfill-position-observations.ts:66–77` would have minted a "BTC" Instrument with `assetClass UNKNOWN` distinct from btc-price's CRYPTO instrument — if it ran, A10 shows a stale/unvalued BTC row on the wrong instrument. NEEDS DB VERIFICATION.
9. **Current-state-only support:** yes — `compareTo` optional, `asOf=today` resolves latest observation. Freshness depends on the capture flag actually running in prod. VERIFIED (code) / NEEDS RUNTIME VERIFICATION (freshness).
10. **Too expensive as the everything-path?** As implemented, yes eventually: per call it reads the **entire PositionObservation history ≤ asOf for all scope accounts** (`valuation.ts:119–134`, unbounded, grows with every daily capture), plus reconstruction/instrument/price-window/FX reads, ×2 with compareTo — with **zero caching** (route `force-dynamic`, client `no-store`). Fine for one perspective; wrong substrate for AI turns, Brief, exports, dashboards. PARTIALLY VERIFIED (no prod row counts).
11. **Lightweight canonical current-position projection: yes** — the repo's own A2 doctrine ("Holding = the current-state projection") survives; the implementation should be re-founded on the spine (§16).
12. **Can Holding be deleted?** Eventually SAFE TO DELETE — after AI/export/endpoint cutovers, crypto-on-spine, the A10 visibility fix, a current-position projection (or accepted A10 cost), and Gate A=0. Until then LEGACY ACTIVE.

### The AI/UI split (confirmed live)
UI: `InvestmentAllocationPanel.tsx:87–89` computes allocation/concentration from A10 `ValuedHoldingRow` (instrument-keyed, FX-converted, as-of-dated, **no visibility filter**). AI: `lib/ai/assemblers/holdings.ts:225` computes from legacy Holding (symbol-keyed, **native un-FX-converted weights**, FULL-only, current-only) and still emits a now-false dataLimit ("asset-class breakdown unavailable" — the A-track has it). Same shared `computeConcentration` (`lib/investments/concentration.ts`) — one formula, two worlds. Additional WIP-internal mismatch: allocation `isCash` = `Instrument.isCashEquivalent` while valuation classifies per-row (`valuation.ts:205`).

---

## 6. Transaction truth-spine analysis (Part 4)

**Verdict: CANONICAL — the FlowType convergence is real. Credit is due; do not rebuild. Three unnamed defects and one latent trap remain.**

### Verified converged (do not touch)
Single write-time classifier (`flow-classifier.ts:209` — the sanctioned home of sign/PFC/category logic); single membership authority (`flow-predicates.ts:48` `COST_FLOWS`; `BankingClient` confirmed deleted; `SERIALIZED_SPENDING_FLOWS` is a documented deliberate sibling, not a duplicate); single PFC-transfer-taxonomy reader (`plaid-transfer-evidence.ts:6`) with the only payment-app allowlist (`:64`); `RelationshipResolver` with `transfer-resolution.ts` as a thin wrapper (not a second matcher); single liquidity classifier; DayFacts with test-enforced parity (`cash-flow-projection.test.ts:50–92`); Tab summary + Group By share one `sumByFlowType` fold; the chat serializer derives its non-spending list *from the classifier*; merchant layer contract-bound to categories only (`merchant-rules.ts:41–44`); investment-flow classification is a separate domain (InvestmentEvents) with anti-double-count doctrine, not a duplicate.

### Residual semantic paths
| # | Path | Canonical alternative | Divergence | Label |
|---|---|---|---|---|
| T1 | **`BANKING_CATEGORIES` population filter** (`lib/data/transactions.ts:83–86,127,208`) — Tab/CashFlow/export population is category-defined; AI population is flow-defined (`BANKING_FLOWS`, assembler `:377`) | flow-based population | **latent**: the 6 MI1 enum categories (Medical/Entertainment/Transport/PersonalCare/Services/Education) are excluded; nothing writes them *yet* — when MI M2 ships, those rows vanish from the Tab and every CashFlow widget but stay in AI totals | LEGACY ACTIVE → DIVERGENT-when-M2 · NEEDS DB VERIFICATION (zero rows today) |
| T2 | **N3 trend net** (`annotations.ts:869`): `income − expense − debtPayments`, comment at `:353/:863` claims it "mirrors the top-level netCashFlow convention" — but N2 (`assemblers/transactions.ts:546`) is `income + refunds − expense − debtPayments` | named net measures | **live defect**: in a refund-heavy month the AI's stated net and its own trend engine disagree silently | DIVERGENT (fix formula or comment — NEEDS FOUNDER DECISION which) |
| T3 | AI drilldown Prisma `amount: { lt: 0 }` (`assemblers/transactions.ts:1211`) | predicate-expressed cost-flow filter | doctrine-consistent (KD-17 debit-only) but sign-as-semantics in a query; drops credit rows of a drilled category | LEGACY COMPATIBILITY |
| T4 | Three debt-payment definitions: D1 `lib/debt.ts:76–121` (received-by-liability), D2 assembler `:507–513` (sent-from-accounts, `amt<0`), D3 liquidity `liquidity.ts:148–152` (cash-leg incl. liability-destination transfers) | one named-measures module, D1/D2 delegating | yes — three populations, all surfaced as "debt payments" | PARALLEL AUTHORITY (intentional projections, unnamed) |
| T5 | Four/five "net" definitions (N1 economic clamped; N2 AI window; N3 trend; N4 liquidity; N5 brief savings-rate `brief/route.ts:409–411`) | `net-measures.ts` with doctrine names | N3 vs N2 diverges (above); others are honest but unlabeled | PARALLEL AUTHORITY |
| T6 | Economic-spend clamp implemented twice+ (`cash-flow.ts:267`, `cash-flow-projection.ts:171–172`, per-bucket `:343,392`) | single-site clamp (STATUS names it) | none in value | LEGACY COMPATIBILITY (code dup) |
| T7 | `plaid-flow-input.ts:161–186` legacy shadow-comparison buckets | delete after P3 closure ruling | none (diagnostics) | LEGACY COMPATIBILITY / SAFE TO DELETE pending ruling |
| T8 | Classifier v3 gap: liability-account payment-app outflow (liquidity side pinned at `liquidity.ts:194–196`; classifier lacks the rule) | classifier v3 (STATUS B-S3) | known, named | LEGACY ACTIVE (tracked) |

Payment-app handling, refund handling (two documented treatments, no local arrays), PFC usage, and category heuristics are otherwise VERIFIED converged.

---

## 7. Aggregation authority analysis (Part 5)

Chains mapped raw→semantic→projection→aggregation→consumers for all 13 metrics. Findings by class:

**Intentional projection / cache (correct — leave):**
- `SpaceSnapshot` vs live aggregates: snapshots own any date < today; live classification owns today; `SnapshotAmendment` is the sole sanctioned historical rewrite (consent-gated). CANONICAL.
- AI assembler window fold vs DayFacts: same predicates, different envelope (settled-only, pending split, KD-17 debit-only, truncation flags). Keep — but pin an assembler↔DayFacts reconciliation oracle on a shared fixture (STATUS B-S2).
- Transactions-Tab calendar heat-map (raw signed net) vs CashFlow calendar (DayFacts): deliberate different metric; **unlabeled** — label the basis or converge. NEEDS FOUNDER DECISION.

**Accidental duplicate authority (converge):**
- `aggregateCashFlow`/`deriveCashFlowAxes` fold family still live at 5 sites while DayFacts exists; parity is test-pinned so outputs cannot diverge today — shim onto DayFacts, then delete (`bucketLiquidity`/`dailyLiquidity`/`bucketCashFlow`/`dailyCashFlow` are already DEAD CODE, zero non-test consumers). = STATUS B-S1.
- `SpaceDashboard.tsx:1218–1222` inline net-worth fold treats *unknown* account types as assets; `classifyAccounts` excludes them. Fold into `classifyAccounts` during A2 host decomposition.
- Liquidity lens local type sets (`lenses/liquidity.core.ts:107–109`) duplicate `account-classifier` tiers — derive one from the other.
- `CashFlowSummaryWidget.tsx:172–178` runs three classifier passes over the same rows per render — collapse to one `aggregateDayFacts` pass.

**Currency threading gap (DIVERGENT, multi-currency Spaces):** AI merchants (`assemblers/transactions.ts:707`), incomeSources (`:797`), drilldown matched/shown totals (`:1263,1288`), largest income/expense (`:868,876`) use raw native amounts beside FX-converted totals. Thread `moneyCtx`. NEEDS DB VERIFICATION whether any live Space is multi-currency.

**Historical paths applying current metadata (doctrinal, needs disclosure ruling):** liquidity tiers use current account types for historical rows (documented self-healing, `liquidity.ts:12–13` — but a re-typed account silently rewrites its Cash In/Out history, surfaced nowhere); merchant resolution applied historically (intentional identity); Wealth composition non-class modes carry the explicit "Current classification" label (honest). Pending/posted asymmetry in snapshot walk-back (cash includes pending, cards exclude — `backfill.ts:255`) is the known TI2-W3 finding. NEEDS FOUNDER DECISION ×2.

**Account counts:** the one metric with flatly wrong authority today (legacy relation) — §4.

---

## 8. Visibility / privacy convergence (Part 6)

Canonical seams are real and well-tested: `TRANSACTION_DETAIL_VISIBILITY`/`grantsAccountDetail` (`lib/ai/visibility.ts:44–68`), `sanitizeForBalanceOnly`/`normalizeSharedAccounts` (`lib/account-privacy.ts`), `transactionDetailWhere` (`detail-query.ts:33–52`), KD-15-pinned data-layer queries, KD-1-pinned AI assemblers, D3/D4-filtered export. KD-20 defense-in-depth filters are present at all 7 named working-tree sites (VERIFIED on disk; commit state per STATUS).

| Domain | Canonical visibility seam | Bypass sites | Risk | Required convergence |
|---|---|---|---|---|
| Dashboard accounts/holdings | `getAccountsWithVisibility`/`getHoldings` FULL gate | none | — | none (KD-19 holds) |
| Transaction lists/detail/corrections | KD-15 predicate + `transactionDetailWhere` | none | — | none |
| **Investments (A10)** | should be `TRANSACTION_DETAIL_VISIBILITY` | **`investments-time-machine.ts:104–108`, `valuation.ts:103–107`** — SAL `status: ACTIVE` only, no visibilityLevel; route comment claiming "already redaction-aware" is false | **HIGH** — BALANCE_ONLY accounts' per-position symbols/qty/values + InvestmentEvents to every ACTIVE member; contradicts `getHoldings` on the same page family | add the visibility filter to both `resolveScope`s (or aggregate non-FULL to value-only) **before any new A10 consumer** |
| **Goals (live route)** | export-side D4 exists; live route has none | `app/api/spaces/[id]/goals/route.ts:34–39` — contribution FA `{id,name,balance}` serialized ungated | **HIGH** — real name+balance of BALANCE_ONLY/revoked accounts to all members | apply D4 at the route |
| **Activity feed** | none | write `share/route.ts:77` (`accountName: fa.name`), render `activity/route.ts:210–221`; name persisted in AuditLog | **MEDIUM-HIGH, durable** — real names of BALANCE_ONLY shares; renderer fix doesn't purge history | write `genericAccountName()` for non-FULL; decide retro-scrub (NEEDS DB VERIFICATION + FOUNDER DECISION) |
| **Banking CSV import** | investment import gates FULL; banking does not | `lib/imports/authorize.ts:68–100` — any-visibility ACTIVE link + role; preview fingerprints probe existing rows; rollback likewise | **MEDIUM** — Space ADMIN can write into / probe / roll back a BALANCE_ONLY account | mirror the FULL gate or rule write-authority a separate axis (NEEDS FOUNDER DECISION) |
| Wealth/snapshot reconstruction | aggregate-only outputs | `backfill.ts:124–140`, `regenerate-history.ts:169–176` walk BALANCE_ONLY transaction deltas | LOW (aggregates only; small-Space side-channel) | document as accepted or hold non-FULL flat (FOUNDER DECISION; = the doctrine-oracle test STATUS names) |
| SUMMARY_ONLY tier | phantom — no write path; behaves as BALANCE_ONLY everywhere (numeric balance exposed) | all seams | contract mismatch if ever produced | implement the qualitative tier or delete the value (FOUNDER DECISION) |
| Merge/reconcile | `dualWriteSpaceAccountLink` | `reconcile.ts:482–503` re-activates a REVOKED link on winner-update | LOW-probability access resurrection | preserve REVOKED unless loser was ACTIVE |
| Admin | separate `requireSystemAdmin` authority | intentional | — | PARALLEL AUTHORITY (intentional) |
| AI/chat/brief/export | assembler gates + composed readers | none | — | none |

Legacy `Account` compatibility semantics ("Space's own = FULL") do not widen access *across members* but do ignore `Account.visibilityLevel` — see §4's latent hole, Gate C-dependent.

---

## 9. Route / helper archaeology (Part 7)

133 API routes enumerated; ~110 ACTIVELY CALLED with verified fetch callers; auth posture uniformly explicit (middleware deliberately excludes `/api/*`; every route self-guards — VERIFIED).

**Keep (externally reachable, caller-less by design):** `/api/health` (uptime), `/api/plaid/webhook` (signature-verified; registered via `link-token/route.ts:45–52`), `/api/jobs/*` individual bodies (documented cron fallback targets), `/api/jobs/dispatch` (the vercel.json cron).

**Superseded/dead (see §14 for disposition):** `/api/admin/overview`, `/api/accounts/manual/archived`, `/api/merchant-ops/candidates` (all superseded by RSC direct reads — the repo's recurring supersession pattern: page goes RSC, JSON twin lingers), `/api/accounts/[id]/transactions` (orphaned by the 2026-07-13 banking deletion; contains a legacy-Account fallback), `/api/accounts/manual/[id]` (generic `/api/accounts/[id]` handles it), `/api/admin/plaid/retire-superseded-item` (inlined into exchange-expanded-history-token).

**Dormant by design (keep or ship UI — FOUNDER DECISION):** `/api/plaid/sync`, `/api/accounts/[id]/import` + `/preview` (CSV UI never shipped), `/api/transactions/[id]/correct` (MI M5 correction API, no UI), `/api/investments/opening-position` (flag-gated A7-2).

**Notable corrections to STATUS:** `/dashboard/credit` is **live** (linked from `FicoCard.tsx:43,67`) despite the SC-6 note listing it among deleted pages. `lib/widget-registry.ts:64–67,772` documents a phantom `GET /api/spaces/[id]/holdings` endpoint that does not exist.

**Dead modules (only 3 in the whole tree — hygiene is excellent):** `lib/email/index.ts` (never-adopted barrel, 0 importers), `lib/providers/catalog.ts` (aspirational D6 substrate, 0 importers), `lib/providers/plaid/adapter.ts` (dormant seam by decision record). `ensureHomeLink()` (documented rollback keeper, 0 callers). No tombstones, no orphaned v1-dashboard remnants, no dead context shapes — STATUS's cleanup claims all verified on disk.

---

## 10. Schema archaeology (Part 8)

51 models, 56 enums, full accessor census. Highlights (full census in the investigation record):

- **Every model is live, documented-reserved, or gate-blocked — none is deletable today at the schema level.**
- `Account` — 0 writers / 4 readers → §4. `Transaction.accountId` / `Holding.accountId` — 0 writers, arms only, never backfilled → gates.
- `AiAdvice` — **FROZEN SCHEMA, reader-without-writer (KD-14 CONFIRMED)**: three live read paths (`brief/route.ts:601`, `export/assemble.ts:222`, `data/advice.ts:16`) can only ever surface seed data. INTENTIONALLY RETAINED for v2.6b; consider dark-launching the readers off (FOUNDER DECISION).
- `DuplicateAccountCandidate` — append-only merge ledger, no reader by design. RETAIN.
- `Holding` vs A-track, `PlaidItem` vs `Connection`, `SpaceSnapshot` vs `SnapshotAmendment` — all deliberate pairs today; only Holding is targeted for eventual retirement (§5).
- Field-level residue: `AccountConnection.syncStatus/lastSyncedAt` (declared mirrors), `FinancialAccount.walletAddress/walletChain/nativeBalance` (self-labeled transitional — crypto's de-facto truth), flat debt columns (documented fallback), `plaidAccountId` warn-and-fallback reads (`lib/plaid/refresh.ts:173–193`, removal gated on a prod observation window), reserved no-writer fields (`Instrument.underlyingInstrumentId`, `sedol`, `Transaction.pendingTransactionRef` — TI4 reconciler absent by design).
- Enums: `VisibilityLevel.SHARED` (0 uses, Gate E), `SUMMARY_ONLY` (phantom tier, §8), `SpaceCategory.GOAL` (legacy, rows unknown), `TransactionCategory.Transport/.PersonalCare` (admitted with producers that never landed — MI backlog), plus ~10 documented-reserved values (fine). **Removal of any Postgres enum value is a locking type-recreation — bundle all removals into the single M4 migration.**
- Migration history: exactly **one** DROP ever (`20260703120000` WAS retirement — gate-verified, with the definitive comment that `Account`/`accountId`s/`SHARED` were *deliberately left*). Embedded SQL backfills all accounted for. One same-day FK reversal (`20260714130000`→`140000` SnapshotAmendment CASCADE→soft-ref) — consistent now, but an environment that stopped between them would cascade-delete amendments.

Ranked disposition: **§14 (safe now) / §15 (DB-gated) / retain-intentionally** as labeled in §3.

---

## 11. Scripts / migrations residue (Part 9)

48 scripts classified. Operational & wired: `run-tests` (CI), 4 backfill commands, 2 audit commands, `check-job-health`, `seed-platform-spaces` (idempotent), `merge-merchants`, `copy-fx-rates`. One-time-complete (idempotent, house dry-run-default pattern): 12 backfills — with one caveat: the category-writing trio (`backfill-cc-payment-categories`, `backfill-merchant-categories`, `reclassify-subscriptions`) predates MI and doesn't stamp `categorySource`; prefer the MI backfill for any re-run. Reusable diagnostics: `diagnose-*`, `audit-visibility-levels` (the Gate E instrument), `audit-ciphertext-versions`, verifiers. Retirement gate: `phase0-seam-gates.ts` — **keep until M4 executes**.

**Dangerous:**
- `purge-plaid-connection.ts` — irreversible hard deletes + Plaid `itemRemove()`; **defaults `--email` to `chr.hogan1997@gmail.com`** (`:80`). Delete it or make `--email` required. SAFE TO DELETE.
- `reset-chase-history-test.ts` / `dev-reset-test-state.ts` — destructive dev harnesses (confirm-token-guarded, but will run against prod if pointed there).
- `prisma/seed.ts` — `deleteMany()` across ~26 tables with no NODE_ENV guard (standard dev seed; worth a guard).

Obsolete: `dedupe-home-links.ts` (KD-5 index enforces the invariant now), `merge-wgu-merchants.ts` (superseded), `kd17-audit-jan-other.ts` (self-declared deletable, KD-17 closed).

**Backfills that never completed runtime cutover:** the two dual-FK column additions (`20260616000000`, `20260622150000`) — the exact M1–M4 gap; and TI3 apply-state remains UNVERIFIED (STATUS's own marker) — NEEDS DB VERIFICATION.

---

## 12. Feature-flag / config residue (Part 10)

- **Undeclared-but-read (6):** `AI_OUTPUT_VALIDATION_MODE` (the KD-2 kill switch!), `FLOWTYPE_SHADOW`, `INVESTMENT_IMPORTS_ENABLED`, `SECURITY_PRICES_ENABLED`, `TIINGO_API_KEY`, `OXR_APP_ID` — absent from `.env.example` and invisible to the platform env-status ops widget. Declare all six.
- **Obsolete:** `FLOWTYPE_SHADOW` (`syncTransactions.ts:159`) — classification is unconditional now; the flag only gates an aggregate log. Remove or rename after a P3-closure ruling. `SPACE_ID`/`MONTH` die with kd17 script.
- **Operational kill switches (keep, documented):** `RATE_LIMIT_ENABLED` (prod default-on, warned opt-out), `DISABLE_SYSTEM_ADMIN`, `AI_OUTPUT_VALIDATION_MODE=shadow`, `WEALTH_REGENERATION_ENABLED` interlock, structural as-of kill switch in `lenses/liquidity.ts` (source-scan-locked).
- **A-track dark-write gates** (`INVESTMENT_{OBSERVATIONS,EVENTS,RECONSTRUCTION,IMPORTS}_ENABLED`, `SECURITY_PRICES_ENABLED`): permanently-on-in-dev; **prod values are unverifiable from the repo — NEEDS RUNTIME VERIFICATION** and they gate the entire §5 plan.
- **DB-based config:** `PlatformSetting` incl. `registration_mode` (default `open` — the beta-gate flip is config, not code).
- **Source-scan guard tests:** ~15 load-bearing negative guards (platform-surface, security-surface, deletion-safety, shell seams, liquidity asOf ban, flow-desync invariant, palette ratchet, single-writer greps for JobRun/Notification, privacy trio). INTENTIONALLY RETAINED — a Phase 7 pattern to extend (§17).

---

## 13. Divergence matrix (all confirmed sites where two surfaces can answer differently)

| # | Question | Surface A | Surface B | Mechanism | Label |
|---|---|---|---|---|---|
| 1 | Space account count | Space cards / admin (legacy `Space.accounts`) | SAL ACTIVE count (snapshots, assembler) | frozen legacy rows vs canonical links | DIVERGENT — live bug |
| 2 | Portfolio concentration | UI Allocation (A10, instrument-keyed, FX) | AI assembler (Holding, symbol-keyed, native) | different source/keying/currency/visibility/time | DIVERGENT — live |
| 3 | Portfolio value today | Investments header (A8 valuation) | legacy endpoint totalValue (`FinancialAccount.balance`) & `Holding.value` | three fact sources; cash handling differs | DIVERGENT |
| 4 | Wealth "today" vs Investments "today" | SpaceSnapshot from balances | A8 valuation | acknowledged in-repo (`diagnose-wealth-chart-gap.ts:19`) | DIVERGENT — known |
| 5 | Historical stocks value | Wealth chart (A9, holdConstantBeforeEarliest) | Investments at same asOf (strict) | pre-earliest dates: estimate vs nothing | DIVERGENT — deliberate, unlabeled |
| 6 | Visibility of positions | getHoldings/AI (FULL-only) | A10 (no filter) / AI totals (incl. BALANCE_ONLY values) | three postures over one Space | DIVERGENT + leak |
| 7 | Exported positions | export (Holding) | Investments UI (A10) | imports/assertions/derived-cash invisible to export | DIVERGENT |
| 8 | BTC quantity/value | Wealth crypto (nativeBalance×price) | Holding BTC row | A10 (absent or stale bootstrap row) | DIVERGENT — NEEDS DB VERIFICATION |
| 9 | Net cash flow | N1 economic (clamped, no debt) | N2 AI (`+refunds −debt`) | N3 trend (no refunds — defect) / N4 liquidity / N5 brief | DIVERGENT (N3) + unnamed measures |
| 10 | Debt payments | D1 received-by-liability | D2 sent-from-accounts | D3 liquid-cash-leg | PARALLEL AUTHORITY — intentional, unnamed |
| 11 | "A banking transaction" | Tab/CashFlow (`BANKING_CATEGORIES`) | AI (`BANKING_FLOWS`) | latent until MI M2 writes new categories | DIVERGENT-when-M2 |
| 12 | Top merchants / income sources (multi-ccy) | AI rollups (native amounts) | AI totals (converted) | currency threading gap | DIVERGENT (multi-ccy only) |
| 13 | Daily calendar color | Tab heat-map (raw signed net) | CashFlow calendar (DayFacts) | deliberate different metric, unlabeled | PARALLEL — intentional, needs label |
| 14 | Net worth fold | `SpaceDashboard` inline (`type !== "debt"`) | `classifyAccounts` | unknown types counted vs excluded | DIVERGENT (edge) |
| 15 | Account name shown to members | activity feed (real name persisted) | everywhere else (generic label) | share-event payload | DIVERGENT — privacy |

---

## 14. Safe-delete list (no DB gate, no behavior risk — can land as one or two hygiene PRs)

1. `/api/admin/overview` route (+ update `lib/security-surface.test.ts:165` pin) — DEAD.
2. `/api/accounts/manual/archived` route — DEAD.
3. `/api/merchant-ops/candidates` route — DEAD.
4. `lib/email/index.ts` — dead barrel.
5. `lib/providers/catalog.ts` — unless D6 is imminent.
6. Dead folds: `bucketLiquidity`, `dailyLiquidity` (now); `bucketCashFlow`/`dailyCashFlow` + stale `CashFlowHistoryWidget.tsx:14` comment (with the B-S1 shim).
7. `scripts/dedupe-home-links.ts`, `scripts/merge-wgu-merchants.ts`, `scripts/kd17-audit-jan-other.ts`.
8. `scripts/purge-plaid-connection.ts` — or make `--email` required (it defaults to the founder's live account).
9. `FLOWTYPE_SHADOW` flag + its log branch (after a one-line P3-closure ruling).
10. Fix-not-delete: declare the 6 undeclared env flags; remove the phantom `/api/spaces/[id]/holdings` reference in `lib/widget-registry.ts`; fix N3's comment-or-formula; trim `diagnose-invalid-plaid-tokens.ts:143`.

**Safe SWAPS now (behavior-changing but bug-fixing, no DB gate):** the 6 `Space.accounts` + 2 `db.account.count` count sites → SAL/FA counts; add the missing `legacy-account-invariants` source-scan test.

## 15. DB-gated retirement list (order matters)

| Gate (run against prod) | Instrument | Unblocks |
|---|---|---|
| Gate A: `Holding.accountId` rows = 0 | `phase0-seam-gates.ts` | `getHoldings` legacy branch removal |
| Gate B: `Transaction.accountId`-only rows = 0 | same | 8 OR arms + shims + `legacy` DTO flag (A1-S4); else M2 re-anchor migration first |
| Gate C: legacy `Account` rows = 0 | same | 2 findFirst fallbacks; the transactions-route auth hole dies with them |
| Gate E: `SHARED` rows = 0 (SAL + Account) | `audit-visibility-levels.ts` | enum value removal (bundle into M4) |
| Section rows for `investment_accounts` = 0 | ad-hoc query | delete `InvestmentAccountsWidget` + registry entry |
| Bootstrap "BTC" Instrument duplicate check | ad-hoc query | crypto-on-spine slice design |
| MI1 category rows = 0 | ad-hoc query | confirms T1 is latent, not live |
| A-track flags on in prod + observation freshness | Vercel env + row timestamps | entire §5 cutover plan |
| TI3 apply-state | recorded dry-run | STATUS marker |
| Then: M3 (drop `Transaction.accountId`, `Holding.accountId` + indexes) → M4 (drop `Account`, `Space.accounts`, `VisibilityLevel.SHARED` + `SpaceCategory.GOAL` in one enum-recreation migration; remove seed wipe + trim gate script) | hand-written migration per the WAS template (pg_dump artifact first) | done |

---

## 16. Canonical truth-spine target architecture (PROPOSAL)

```text
ACCOUNT IDENTITY
  Provider → Connection/PlaidItem → ProviderAccountIdentity → FinancialAccount → SpaceAccountLink
  (Account, Space.accounts, dual FKs, SHARED: deleted at M4)

TRANSACTION TRUTH
  provider rows → merchant layer (category only)
  → classifyFlow v3 → FlowType (+facts, transfer evidence, disposition)
  → flow-predicates → { DayFacts } ← sole fold family (aggregateCashFlow = shim)
  → net-measures.ts (economicNet · aiWindowNet · liquidityNet · 3 named debt measures)
  → UI · AI assembler (own envelope, oracle-reconciled) · export · Brief
  population contract: flow-based everywhere (BANKING_CATEGORIES filter retired)

INVESTMENT TRUTH
  Plaid capture ∥ wallet sync ∥ CSV import ∥ user assertion     ← crypto joins here
  → Instrument/Alias + PositionObservation + InvestmentEvent
  → Reconstruction + PriceObservation + FxRate
  → valuation (A8-4)
  → **getCurrentPositions(scope)** — the ONE new artifact this report proposes:
      A10-at-today behind a latest-observation-per-(account,instrument) read
      (Prisma distinct/max-date now; materialized CurrentPositionProjection later if needed),
      visibility (TRANSACTION_DETAIL_VISIBILITY) applied INSIDE it,
      returning ValuedHoldingRow + costBasis + provenance
  → Investments UI (full time machine) · AI holdings · export · ConnectionsCard (health-only read, no positions)
  → Holding deleted; current-holdings.ts shrinks to connection-state derivation

WEALTH / HISTORY
  live: FinancialAccount.balance → SpaceSnapshot (daily) [optionally upgraded to getCurrentPositions later]
  history: A9 regeneration + SnapshotAmendment (sole rewrite) → wealth-time-machine → cards/hero/chart

VISIBILITY
  one predicate module (lib/ai/visibility.ts) enforced inside every read seam:
  data layer · AI · export · A10/getCurrentPositions · goals serialization · activity normalization
  SUMMARY_ONLY: implemented or deleted (no phantom tiers)

AI CONTEXT (AI-5-ready)
  buildContext → assemblers, all reading the same seams as UI:
  holdings ← getCurrentPositions · nets ← net-measures · population ← flow contract
```

The key opinionated call: **do not make every consumer call the full Time Machine.** A10 stays the historical/comparison engine; `getCurrentPositions` is the cheap canonical projection derived from the same evidence — the legitimate heir to A2's "Holding = current-state projection" doctrine.

---

## 17. Phased retirement plan (Part 12)

Slices sized ≤ ~1 day each; every slice lands with suite green.

### Phase 0 — Inventory & invariants (now; parallel with anything)
| Slice | Domain | Goal | Files | Schema | DB gate | Risk | Tests | Exit |
|---|---|---|---|---|---|---|---|---|
| P0-1 | Identity | **Run prod gates A/B/C/E**, record counts in-repo | `scripts/phase0-seam-gates.ts`, `audit-visibility-levels.ts` | none | is the gate | none (read-only) | — | counts committed to a doc |
| P0-2 | Investments | Prod verification bundle: A-track flags, observation freshness, bootstrap-BTC dupe, `investment_accounts` section rows, MI1 category rows | — | none | yes | none | — | answers recorded |
| P0-3 | Config | Declare 6 env flags; kill phantom holdings endpoint ref; guard seed.ts; fix/require purge-script email | `.env.example`, `lib/env.ts`, `widget-registry.ts`, scripts | none | no | none | env.validate | drift zero |

### Phase 1 — Safe runtime cutovers (no DB gate)
| Slice | Goal | Risk | Exit |
|---|---|---|---|
| P1-1 (=A1-S1/S2) | 6+2 count-site swaps to SAL/FA + new `legacy-account-invariants` source-scan test | numbers change (correctly) | Space cards show true counts; scan test green |
| P1-2 | **A10 visibility fix**: `TRANSACTION_DETAIL_VISIBILITY` into both `resolveScope`s + privacy test | UI hides BALANCE_ONLY positions (correct) | privacy pin green |
| P1-3 | Goals-route D4 filter + activity-feed generic names (write+render) | copy changes | privacy pins green |
| P1-4 | Fix N3 (formula or comment) + `net-measures.ts` naming module | trend numbers may shift | doctrine test |
| P1-5 | Dead-route/module/script deletions (§14) | none | suite green |

### Phase 2 — Canonical consumer convergence
| Slice | Goal | Exit |
|---|---|---|
| P2-1 (=B-S1) | `aggregateCashFlow` → DayFacts shim; delete dead folds; single-site clamp; collapse SummaryWidget triple pass | parity tests still green |
| P2-2 | Population convergence: `getTransactions` flow-based filter + Tab↔assembler population invariant test (**gates MI M2**) | invariant green |
| P2-3 | `getCurrentPositions()` (A10-at-today, latest-per-pair, visibility inside) + `ValuedHoldingRow`+provenance contract | new module + tests |
| P2-4 | AI holdings assembler → getCurrentPositions (kills divergence #2; drops the false dataLimit) | AI/UI concentration byte-identical on fixture |
| P2-5 | Export holdings → getCurrentPositions; ConnectionsCard → health-only read | export includes imported/asserted positions |
| P2-6 | Crypto on the spine: wallet PositionObservation writer + `("wallet",asset)` alias + TRANSFER events; dedupe bootstrap instrument | BTC visible in A10; divergence #8 dead |
| P2-7 (=B-S3/B-S2) | classifier v3 (liability payment-app) + evidence-stamp decoupling + doctrine oracle + 4 gap tests; thread `moneyCtx` through AI rollups | oracle green |
| P2-8 | Banking-import FULL-gate ruling implemented; reconcile REVOKED preservation | privacy pins |

### Phase 3 — Production DB verification (formal)
Re-run gates post-cutover; record TI3/backfill markers; confirm zero legacy reads via a week of `plaidAccountId`-fallback/warn observation.

### Phase 4 — Data re-anchor (only if Gates A/B/C ≠ 0)
Hand-written UPDATE migration re-anchoring legacy-anchored rows to FinancialAccounts (+ SAL creation for orphaned Spaces), then re-run gates.

### Phase 5 — Schema/FK deletion (maintenance window)
M3 (drop dual columns/indexes; delete arms+shims+DTO flag in the same PR) → M4 (drop `Account`, `Space.accounts` back-relations, `SHARED`+`GOAL` enum recreation; pg_dump artifact first, per WAS template) → Holding drop as its own later migration once Phase 2.3–2.6 have soaked.

### Phase 6 — Dead code/scripts removal
Archive one-time backfills; delete `phase0-seam-gates.ts` legacy gates (or reduce to tombstone asserting zero); retire `current-holdings.ts` remnant; drop legacy endpoint after ConnectionsCard cutover soak.

### Phase 7 — Source-scan guards
Extend the house pattern: no `db.account.` / no `accountId` outside migrations; no `spaceAccountLink.findMany` without `visibilityLevel` in investment/goal read paths; no new fold over Transaction rows outside DayFacts/predicates; no `db.holding.` (post-retirement).

**Timing vs Investments hardening:** P0, P1, P2-3/2-4 **before or during** (they change what Investments hardening builds on); P2-1/2-2/2-7 during (parallel lane); Phases 3–5 **after beta gate decisions, with maintenance window for Phase 5**; Holding drop only after beta soak.

---

## 18. Pre-Investments-hardening checklist (Part 13)

Direct answers:

1. **Must resolve before continuing Investments work:** (a) **A10 visibility gap** — every hardening step routes more consumers onto A10; harden a leaking spine and you scale the leak; (b) **prod verification bundle P0-2** — you cannot harden what may not be running (flags) or may be double-mintign instruments (bootstrap BTC); (c) **the `getCurrentPositions` contract decision** — otherwise hardening bakes in per-consumer Time Machine calls; (d) commit or explicitly file the Allocation WIP (STATUS has no ledger row for it).
2. **Investigate now, delete later:** everything in §15 (gates), Holding itself, legacy endpoint, `current-holdings.ts`, dormant routes.
3. **Consumers to move to the canonical position spine first:** AI holdings assembler (highest leverage — kills the flagship divergence), then export, then ConnectionsCard (health-only). Wealth live writer stays on balances for now (intentional).
4. **AI holdings: move BEFORE UI hardening completes** — but strictly AFTER the A10 visibility fix (P1-2 → P2-3 → P2-4). Moving it first without the fix widens the leak to AI surfaces.
5. **Should `Holding` retirement join the `Account` initiative? No — separate initiatives, one shared gate run.** `Account` retirement is a self-contained gate-and-drop with zero writers (mechanical). `Holding` retirement requires new construction (crypto writer, projection, three consumer cutovers). Coupling them holds the easy one hostage to the hard one. They share P0-1/P0-2 verification and can share the eventual M-series migration window.
6. **DB deletions that must wait:** all of Phase 5; `Holding` drop last (after crypto + consumers soak in beta); `SHARED`/`GOAL` enum removal only inside M4; `SnapshotAmendment` untouched (brand-new).

**Strict pre-Investments checklist:**
- [ ] P0-1 prod gate run recorded (A/B/C/E counts in-repo)
- [ ] P0-2 investment verification recorded (flags on? capture fresh? BTC instrument single? section rows? MI1 rows?)
- [ ] P1-2 A10 visibility filter + privacy pin merged
- [ ] P1-1 count swaps + invariant test merged (kills the user-visible undercount)
- [ ] P1-3 goals + activity-feed privacy fixes merged
- [ ] `getCurrentPositions` contract ratified (founder sign-off on §16)
- [ ] Allocation WIP committed with a STATUS ledger row
- [ ] Founder decisions §20 items 1–4 ruled
- [ ] N3 fixed (any AI-adjacent hardening inherits it otherwise)

---

## 19. STATUS.md changes required

1. §3/D3 row: correct "5 `Space.accounts` sites" → 6 query sites / 7 usages incl. the `admin/spaces` full relation read; correct "4 normalization shims" → ~10 coalesce sites; "~11 arms across 7 files" → 6 files.
2. SC-6 note: `/dashboard/credit` was **not** deleted — it is live and linked from FicoCard.
3. Add an **Investments cutover ledger row** (AI/export/ConnectionsCard → canonical positions; crypto-on-spine; Holding retirement gates) — the A-track rows record construction, not cutover, and the WIP has no row.
4. Add a **KD entry for the A10 visibility gap** (KD-19-class), the goals-route join, the activity-feed name persistence, and the banking-import authority asymmetry.
5. Record KD-14 reader-behavior decision (Brief/export read AiAdvice with no writer).
6. Note the six undeclared env flags and their remediation; note `FLOWTYPE_SHADOW` disposition.
7. Record the P0-1 gate-run results when executed (the M1 exit criterion is currently unmeasurable and unlabeled as such).
8. Fix the closure doc's M3 shim count (or reference this investigation).
9. Add N3, currency-threading site list, and the `BANKING_CATEGORIES` latent trap to the v2.5.5 residual list (STATUS names the genus; the species are now identified).

## 20. Founder decisions required

1. **`getCurrentPositions` contract** — ratify the §16 shape (A10-at-today + visibility inside + provenance) as the single position contract. PROPOSAL.
2. **SUMMARY_ONLY** — implement the qualitative tier or delete the enum value (phantom today; behaves as BALANCE_ONLY if ever written).
3. **Activity-feed retro-scrub** — real account names already persisted in AuditLog metadata for BALANCE_ONLY shares: scrub, or accept-and-document.
4. **Banking-import authority** — mirror the investment-import FULL gate, or ratify "write authority is a separate axis from read visibility."
5. **N3** — is the trend net *supposed* to include refunds (fix formula) or not (fix comment + name the measure)?
6. **Tab calendar metric** — label "gross ledger net" or converge on DayFacts.
7. **Wealth reconstruction over BALANCE_ONLY transaction deltas** — accept (balance-history is granted) or hold-flat; same ruling covers the small-Space side-channel.
8. **Historical liquidity under current account types** — accept silently-self-healing history or surface a disclosure.
9. **Account vs Holding initiative structure** — ratify "separate initiatives, shared gates" (§18.5).
10. **Dormant API-first routes** (`/api/plaid/sync`, CSV import pair, correct, opening-position) — ship UI, keep dormant, or prune.
11. **Prod DB access for P0-1** — who runs the gates and where the counts are recorded.
12. **KD-14 readers** — dark-launch off until the v2.6b writer exists, or accept seed-data exposure.
13. **`retire-superseded-item` route** — keep as documented admin recovery hatch or delete.
14. **A6/A8 ledger renumbering** (already deferred once) — bundle with the new Investments cutover row.

---

## Summary table

| Domain | Legacy authority | Canonical authority | Divergence today | Migration needed | Delete candidate | Timing |
|---|---|---|---|---|---|---|
| Account identity | `Account`, `Space.accounts`, dual FKs, `SHARED` | FinancialAccount + SAL (+PAI/Connection) | Space-card/admin counts (live) | M3/M4 drops after gates; M2 only if gates ≠ 0 | yes — all of it | gates now; drops post-beta window |
| Space participation/visibility | (WAS retired) `SHARED`, phantom SUMMARY_ONLY | SAL FULL/BALANCE_ONLY + visibility.ts | 4 bypass sites (A10, goals, activity, import-auth) | none (code fixes) | SHARED + maybe SUMMARY_ONLY | bypass fixes NOW |
| Transaction semantics | `BANKING_CATEGORIES` population; shadow diag; classifier-v3 gap | classifyFlow + predicates + evidence + facts | latent (MI M2) + N3 defect | none | shadow diag, dead folds | before MI M2 |
| Cash-flow projection | `aggregateCashFlow` family (parity-pinned) | DayFacts | none (test-pinned) | none | dead bucketers now, family post-shim | B-S1 during hardening |
| Net/debt measures | 4–5 informal nets, 3 debt folds | net-measures.ts (to build) | N3 live; rest unlabeled | none | — | P1 |
| Investment positions | `Holding` + current-holdings + legacy endpoint | A-track → getCurrentPositions (to build) | 9 mapped surfaces (§13) | Holding drop after cutovers + Gate A | yes — Holding, endpoint, helper | the initiative; before AI-5 |
| Crypto positions | Holding + FA.nativeBalance | (absent — needs wallet→spine writer) | 3-way BTC answers | new writer, no schema | wallet fields later | P2-6 |
| Historical valuation | — | SpaceSnapshot + A9 + SnapshotAmendment | hold-constant vs strict (label only) | none | no | — |
| Wealth | inline host fold | classifyAccounts + snapshots | unknown-type edge | none | inline fold | A2 decomposition |
| Visibility | legacy "Space's own = FULL" arm | TRANSACTION_DETAIL_VISIBILITY seams | A10/goals/activity/import | none (code) | with Gate C | NOW |
| AI context | legacy Holding input; native-ccy rollups | canonical assemblers | concentration + currency + N3 | none | — | before AI-5 persistent state |
| Routes/config | 6 dead/superseded routes; 6 undeclared flags | RSC reads; declared env | none | none | yes | P1 hygiene |

---

## Report back to ChatGPT

**Five biggest legacy artifacts**
1. Legacy `Account` + `Space.accounts` + `Transaction.accountId`/`Holding.accountId` + `VisibilityLevel.SHARED` — frozen, zero writers, fully instrumented, blocked only on a never-run prod gate (`scripts/phase0-seam-gates.ts`).
2. `Holding` + `current-holdings.ts` + `/api/spaces/[id]/investments` — the legacy investment current-state world, still authoritative for AI, export, connections UI, and **all crypto**.
3. The `aggregateCashFlow`/`deriveCashFlowAxes` pre-CF-3 fold family (parity-pinned; plus 4 genuinely dead fold functions).
4. `BANKING_CATEGORIES` as the Tab/CashFlow row-population filter (`lib/data/transactions.ts:127`) — a category-based population in a flow-based world.
5. `AiAdvice` (reader-without-writer), the 6 superseded/dormant routes, and the 6 undeclared env flags — the long tail.

**Five biggest parallel-authority risks**
1. **A10's missing visibility filter** (`investments-time-machine.ts:104` / `valuation.ts:103`) — BALANCE_ONLY positions leak to all Space members through the *canonical* path.
2. **AI vs UI concentration** — same formula, different position sources, keying, and currency handling.
3. **Three-way current-position authority** (Holding vs A-track vs FinancialAccount.balance) — Wealth, Investments, AI, and export can all state different portfolio values today.
4. **N3 trend net omits refunds** while claiming to mirror the AI's headline net — a silent numeric self-contradiction inside one AI response.
5. **The goals-route + activity-feed real-name/balance leaks** — small code, durable (AuditLog-persisted) privacy divergence.

**Deletable immediately:** 3 superseded routes, 2 dead lib modules, 4 dead fold functions, 3 obsolete scripts, the founder-email purge script (or force `--email`), `FLOWTYPE_SHADOW`, phantom widget-registry endpoint ref — plus the 8 count-site *swaps* which are safe now and fix a live bug.

**Requires DB proof first:** every dual-FK arm/shim/fallback removal (Gates A/B/C), `SHARED` + `SpaceCategory.GOAL` enum removal (Gate E), `InvestmentAccountsWidget` deletion (section rows), crypto-slice design (bootstrap-BTC dupe), MI1-category latency confirmation, A-track prod flags/freshness, TI3 apply-state.

**Must move onto a canonical spine before Investments hardening:** the AI holdings assembler (after the A10 visibility fix), export holdings, and ConnectionsCard (to a positions-free health read) — all via a new `getCurrentPositions()` projection; crypto must gain a spine writer.

**Should `Holding` survive?** Short-term yes (it is the only crypto position record and the only visibility-correct read today); long-term no — replace with `getCurrentPositions` over `PositionObservation` and delete. It holds no irreplaceable data (`change24h` is reproducible; costBasis already lives on the spine unread).

**`Account` + `Holding` retirement: one initiative or two?** Two, sharing one gate run. Account is mechanical gate-and-drop; Holding needs construction (crypto writer, projection, three consumer cutovers). Don't hold the easy one hostage.

**Recommended next 5–10 slices (in order):**
1. P0-1: run prod seam gates + visibility audit, commit counts.
2. P0-2: investment prod-verification bundle (flags, freshness, BTC instrument dupe, section rows, MI1 rows).
3. P1-2: A10 visibility filter + privacy pin.
4. P1-1: legacy count swaps (8 sites) + `legacy-account-invariants` scan test.
5. P1-3: goals-route D4 filter + activity-feed generic names.
6. P1-4: N3 fix + `net-measures.ts`.
7. P2-3: `getCurrentPositions()` projection + contract.
8. P2-4: AI holdings assembler cutover.
9. P2-2: flow-based population convergence + Tab↔AI invariant (gates MI M2).
10. P2-1: DayFacts sole-fold shim + dead-fold deletion (=B-S1).

**The one most dangerous legacy seam to leave in place:** the **A10 visibility gap**. Everything this report recommends — and everything the Investments hardening and AI-5 roadmap implies — routes more consumers onto A10. It is the only defect that gets *worse* with every step of the convergence plan, and it inverts the usual assumption that the new spine is the safe one. Fix it before anything else touches investments.
