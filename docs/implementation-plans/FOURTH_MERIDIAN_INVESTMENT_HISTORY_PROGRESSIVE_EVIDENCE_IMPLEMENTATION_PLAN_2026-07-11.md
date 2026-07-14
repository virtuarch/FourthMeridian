# Fourth Meridian — Investment History Reconstruction & Progressive Evidence Implementation Plan

**Date:** 2026-07-11
**Branch:** `feature/v2.5-spaces-completion`
**Type:** Architecture & implementation-planning investigation. No code written, no files modified, no migrations created, no provider calls implemented.
**Established input:** the Investment Time Machine audit (16 current positions; 1 persisted investment event; positions visible via Plaid holdings; cost basis returned for some holdings but discarded; no historical positions, prices, or investment transactions persisted), plus the cross-perspective Time Machine investigation, the Time Machine/Timeline/Simulation implementation plan, and the historical-backfill/Plaid-coverage investigation (all 2026-07-11).
**Governing principle:** *"Did the data earn this?"*

---

## 1. Executive conclusion

Deep investment history cannot be reconstructed from the currently persisted dataset — that is settled evidence, not a design failure. The correct response is a **progressive-evidence architecture**: persist every investment fact with its **origin** (observed / imported / derived / user-asserted) and its **completeness tier**, let better evidence *supersede* weaker evidence without erasing it, and let historical accuracy improve monotonically as new evidence arrives (Plaid investment transactions, brokerage CSVs, user assertions, a future price provider).

The repository is unusually well prepared for this. Nearly every pattern the design needs already exists and is ratified doctrine:

- **Append-only observation series with walk-back:** `FxRate` (`prisma/schema.prisma:2003`) — the structural template for `PriceObservation`.
- **Additive, stamped, never-overwritten snapshots:** `SpaceSnapshot` with `isEstimated` + `[spaceId,date]` idempotency — the honesty-valve template for position history.
- **Provider-neutral canonical identity with alias mapping:** `Merchant`/`MerchantAlias` and `ProviderAccountIdentity` — the template for `Instrument`/`InstrumentAlias`.
- **Stage-1 provider adapters that never leak provider strings:** TE-1 (`lib/transactions/plaid-transfer-evidence.ts` → `transfer-evidence.ts`) — the template for the Plaid investments adapter.
- **Provider dedupe keys:** `Transaction.plaidTransactionId @unique` / `externalTransactionId` — the template for `InvestmentEvent.externalEventId`.
- **"Null = never a manufactured claim":** the MC1 Phase 0 doctrine — the template for every nullable provenance field below.
- **Import with rollback:** `ImportBatch` + soft-delete + `ROLLED_BACK` — the template for brokerage-history imports.
- **Deterministic read-time relationship resolution that refuses ambiguity:** `RelationshipResolver.matchTransferCandidate` — the template for Chase→Schwab funding links.
- **Trust tiers and worst-tier propagation:** the ratified Time Machine completeness model (observed/derived/estimated/user-asserted/incomplete).

What does **not** exist: any `Security`/`Instrument` model, any position history, any investment-event ingestion (`investmentsTransactionsGet` is never called), any security price series, and any preservation of the identifiers and cost-basis fields Plaid already returns. Every holdings refresh runs `deleteMany`+`create` (`lib/plaid/refresh.ts:317`, `lib/plaid/exchangeToken.ts:442`), **skips cash and no-ticker securities entirely**, and discards `security_id`, `cost_basis`, CUSIP/ISIN/SEDOL, close prices, and asset-class metadata. Every day this continues is a day of position history permanently lost — the "observation gap" the backfill investigation identified as the single urgent case for acting early.

**The recommended first slice is confirmed (with two evidence-driven amendments): the Investment Observation Foundation** — canonical `Instrument` identity, append-only `PositionObservation`, preservation of the discarded Plaid security/holding fields, written on initial enable and every refresh, with `Holding` untouched as the current-state read model. Amendments: (1) the raw-payload capture must include **cash and no-ticker securities** that the `Holding` writer skips, because brokerage cash is a position the reconstruction contract requires; (2) capture must be wired into **both** writers (`refresh.ts` *and* `exchangeToken.ts`) in the same slice, or initial-connection observations are lost.

---

## 2. Current repository / data findings

### 2.1 Code owners by concern

| Concern | Owner (exact files / models) |
|---|---|
| Current Holding model | `prisma/schema.prisma:1188` `Holding` — `symbol, name, quantity, price, value, change24h, isCash, currency`; `@@unique([financialAccountId, symbol])` (+ legacy `accountId` twin). No security identifiers, no cost basis, no dates, no source. |
| Security model | **Does not exist.** Plaid `Security` objects are consumed in-memory (`secById`) and discarded. |
| Plaid holdings fetch | `lib/plaid/refresh.ts:269–375` (refresh path) and `lib/plaid/exchangeToken.ts:411–498` (initial-link path). Both: `investmentsHoldingsGet` → filter investment-type accounts → resolve `FinancialAccount` via `ProviderAccountIdentity` (fallback `plaidAccountId`) → **`deleteMany` + per-row `create`**. |
| deleteMany/create behavior | `refresh.ts:317`, `exchangeToken.ts:442`. Both skip `sec.type === "cash" \|\| !sec.ticker_symbol`. A third Holding writer, `lib/crypto/btc-sync.ts:149`, **upserts** (the gentler precedent already in-repo). |
| Investments perspective data path | `lib/data/investment-accounts.ts` (`getInvestmentAccountsView`) → `lib/data/accounts.ts` (`getAccounts`/`getHoldings`, FULL-visibility-gated) → `lib/investments/current-holdings.ts` (`buildInvestmentAccountsView`, per-account consent/sync states) → Investments workspace widgets. Explicitly documented "current-state only." |
| Cost basis returned vs persisted | Plaid `Holding.cost_basis` is returned (nullable) — **never read, never persisted**. Audit evidence: present for at least some of the 16 positions. |
| Security identifiers returned vs persisted | Plaid `Security` returns `security_id, isin, cusip, sedol, institution_security_id, institution_id, proxy_security_id, market_identifier_code, cfi_code` — **all discarded**. Only `ticker_symbol` and `name` survive, as strings on `Holding`. **Plaid does not return FIGI** (confirmed against the installed SDK; the prompt's FIGI mention cannot be sourced from Plaid). |
| Account/provider identity | `ProviderAccountIdentity` (`provider, externalAccountId, financialAccountId`, unique on the triple) with legacy fallback `FinancialAccount.plaidAccountId @unique`; `Connection` (provider-neutral) + legacy `PlaidItem`. `ProviderType` already includes `PLAID \| MANUAL \| WALLET \| CSV \| EXCHANGE \| BROKERAGE`. |
| Plaid Item consent state | `PlaidItem.investmentsConsent` (`PlaidInvestmentsConsent`: `ENABLED \| CONSENT_REQUIRED \| null=unknown`), derived by `lib/plaid/investmentsConsent.ts`, self-healing on refresh, `ADDITIONAL_CONSENT_REQUIRED` handled in both writers. Investments *transactions* ride the same Investments product consent — no new consent state needed. |
| Investment DTOs | `HoldingView` / `InvestmentAccountView` / `InvestmentAccountInput` in `lib/investments/current-holdings.ts` (re-exported by `lib/data/investment-accounts.ts`). |
| Refresh behavior | `refreshPlaidItem` / `refreshAllActiveItemsForUser` (`lib/plaid/refresh.ts`); manual route `app/api/plaid/refresh/route.ts` with cooldown; **no webhook endpoint, no active scheduler** (`jobs/take-snapshot.ts` is a stub). |
| Audit/event infrastructure | `AuditLog` (append-only, SetNull on delete), `emitDomainEvent` (`lib/events/emit.ts`, ephemeral dispatch — e.g. `ConnectionSynced` at `refresh.ts:443`), `recordSyncIssue` (`lib/plaid/syncIssues.ts`). |
| Import architecture | `ImportBatch` (+ counters, `resolvedColumnMapping` snapshot, `ROLLED_BACK` soft-delete rollback), `ImportMappingProfile` (space-scoped saved column maps), `Transaction.importBatchId`/`externalTransactionId`, pipeline at `app/api/accounts/[id]/import`. Currently **banking-transaction-shaped only** (`CsvColumnMap` has 8 banking keys). |
| Transaction canonicalization | `Transaction` with `plaidTransactionId @unique` dedupe, `FlowType`/`FlowDirection` (nullable, additive), `pfcPrimary/pfcDetailed` raw provider hints kept on-row, `TransactionCategory` already containing `Buy, Sell, Dividend, Split, Fee`. |
| Provider-neutral adapter patterns | TE-1 stage-1 adapter (`plaid-transfer-evidence.ts` → canonical `transfer-evidence.ts`, with `transferEvidenceSource/Version/Confidence/Reason` persisted); `plaid-flow-input.ts`/`flow-classifier.ts`; `MerchantEnrichmentSource`. |
| Completeness/trust types | `LensResult.estimated`, `assumptions[].source: "default"\|"user"\|"provider"\|"estimate"` (`lib/perspective-engine/types.ts`); `SpaceSnapshot.isEstimated`; ratified tier ladder observed/derived/estimated/user-asserted/incomplete (TM investigation §9). No `completeness` envelope on `LensResult` yet (that is TM Phase 0, a parallel workstream). |
| Space visibility/privacy | Holdings require a FULL `SpaceAccountLink` (enforced in `lib/data/accounts.ts:getHoldings`); owner-only affordances keyed on `PlaidItem.userId` (`investment-accounts.ts`). All new investment tables inherit visibility **via `financialAccountId`** — no new visibility surface. |

### 2.2 Every Plaid field currently discarded that must be preserved

From the installed SDK (`plaid@42.2.0`), fields returned today by `investmentsHoldingsGet` and dropped on the floor:

Per **Holding**: `security_id`, `cost_basis`, `institution_price_as_of`, `institution_price_datetime`, `vested_quantity`, `vested_value`, `unofficial_currency_code`.
Per **Security**: `security_id`, `isin`, `cusip`, `sedol`, `institution_security_id`, `institution_id`, `proxy_security_id`, `name`, `ticker_symbol` (kept only as a display string), `is_cash_equivalent`, `type`, `subtype`, `close_price`, `close_price_as_of`, `update_datetime`, `iso_currency_code`, `unofficial_currency_code`, `market_identifier_code`, `sector`, `industry`, `cfi_code`, `option_contract` (strike/expiry/type/underlying), `fixed_income` (yield/maturity/face value).
Entire **rows**: any holding whose security is `type === "cash"` or lacks a ticker (brokerage sweep cash, some funds/bonds) is skipped by both writers — the audit's "brokerage cash invisible as a position" finding.

### 2.3 The one persisted investment event

The audit found exactly 1 available investment event in the persisted dataset (an investment-account transaction that reached the banking `Transaction` log). This confirms: `investmentsTransactionsGet` is not part of the canonical history, and the banking sync does not meaningfully cover brokerage activity.

---

## 3. Progressive-evidence doctrine

### 3.1 Evidence classes

Every persisted investment fact carries an **origin** and every derived result carries a **completeness tier**. The classes, with their exact meaning:

| Class | Meaning | Example |
|---|---|---|
| **Observed provider holding** | A provider stated the account held this quantity on this date. A fact about *that date only*. | Plaid: 42.5 TQQQ in account X, observed 2026-07-11. |
| **Observed provider investment event** | A provider stated this activity occurred (trade date, quantity, cash legs). | Plaid `investment_transaction_id=…`, `buy`, 7.5 TQQQ, 2026-06-03. |
| **Imported brokerage event** | An event asserted by a brokerage export/statement the user supplied. Observed by the *institution*, imported by the user. | Schwab CSV row: bought 100 VTI on 2021-03-15. |
| **User-asserted opening position** | The user states an opening quantity and/or acquisition date/cost with no document. | "I held 20 AAPL before I connected." |
| **Reconstructed (derived) position** | Fourth Meridian computed a historical quantity deterministically from anchors + events. Never an observation. | 35 TQQQ on 2026-04-01, walked back from today's 42.5 through later buys. |
| **Historically priced valuation** | quantity × `PriceObservation` × FX — a *valuation* layered on a position, each factor with its own tier. | Deferred until a price provider exists. |
| **Incomplete position** | Current quantity exceeds what available events explain; the gap is explicit. | 42.5 held, events explain 22.5 → 20 unexplained. |
| **Unexplained opening quantity** | The residual itself, persisted as a first-class number, never forced to zero. | `unexplainedOpeningQuantity = 20`. |
| **Corrected / superseded evidence** | Evidence replaced by stronger or corrected evidence. Marked, never deleted. | A user assertion of 20 superseded by an imported 2021 buy of 20. |

### 3.2 Representation

- **Observed** → a `PositionObservation` row, `origin: OBSERVED`, `source: "plaid"`, dated the refresh date.
- **Derived** → rows/intervals written by the reconstruction job, `origin: DERIVED`, carrying `reconstructionVersion` and evidence refs. Regenerable; never mixed into observed rows.
- **Imported** → `InvestmentEvent` rows with `source: "csv:schwab"` (etc.), `importBatchId` set, rollback-able; opening-position imports also write `PositionObservation(origin: IMPORTED)`.
- **User-asserted** → `PositionObservation(origin: USER_ASSERTED)` and/or `InvestmentEvent(type: OPENING_BALANCE, source: "user")`, `createdByUserId` set.
- **Incomplete** → not a row class but a **reconciliation output**: per (account, instrument), `unexplainedOpeningQuantity` + `completeness: INCOMPLETE` on the reconstruction summary.

### 3.3 Precedence rules (grounded, not assumed)

The prompt's candidate ordering (observed > imported > reconstruction > user assertion > estimate > unknown) is **approximately right but wrong in one place**, and the repository's own conventions show why: in Merchant Intelligence, `USER_OVERRIDE` *dominates all detectors* — the ratified "human correction dominates" ratchet. The resolution is that precedence is **per-claim-type, not global**:

1. **For "what did the account hold on date D" (a fact about an account the provider can see):** `OBSERVED (provider, on D)` > `IMPORTED (statement/CSV covering D)` > `DERIVED (reconstruction)` > `USER_ASSERTED` > estimate > unknown. A provider observation of its own account on that date is the strongest possible evidence; user memory is weaker than a brokerage statement.
2. **For "what happened before any provider could see" (pre-connection history):** `IMPORTED` > `USER_ASSERTED` > unknown. There is no observed tier here by definition, and reconstruction *consumes* these — it does not compete with them.
3. **For corrections of Fourth Meridian's own interpretation** (instrument identity mapping, event classification): the user correction dominates (the MI `USER_OVERRIDE` precedent), because the claim is about FM's mapping, not about the account.
4. **Estimates never override anything**; unknown is honest absence (MC1: null is never a manufactured claim).

### 3.4 How new evidence improves results without erasing provenance

Three mechanisms, all pre-existing patterns:

- **Append + supersede, never update-in-place:** a stronger row is appended; the weaker row gets `supersededById` (SetNull-style pointer) — mirroring `AuditLog`'s never-delete posture. Queries read "latest non-superseded per (account, instrument, date, claim)".
- **Derived output is versioned and regenerable:** reconstruction rows carry `reconstructionVersion` (the `classifierVersion`/`tiFactsVersion` pattern). New evidence triggers a **bounded rerun** that rewrites only DERIVED rows in the affected window — observed/imported/user-asserted rows are never touched by reconstruction.
- **Import rollback restores the prior state:** imported events soft-delete on rollback (`ImportBatch.ROLLED_BACK` precedent), and the bounded reconstruction reruns, automatically re-widening `unexplainedOpeningQuantity`.

---

## 4. Canonical Instrument design

### 4.1 Identity policy

- **Canonical identity is the `Instrument.id` cuid** — never a ticker, never a provider id. Everything else is a *resolution path* to it (the `Merchant.canonicalKey` + `MerchantAlias` precedent).
- **Resolution order** (deterministic, refuse-on-ambiguity like `MerchantAlias`): (1) exact provider-scoped alias (`plaid:security_id=…`) — the fast path after first sight; (2) strong identifier match: CUSIP, then ISIN, then SEDOL; (3) composite weak key: `(tickerSymbol, marketIdentifierCode ?? "US", currency)` for equities/ETFs, `(symbol, "CRYPTO")` for crypto; (4) no match → create a new Instrument and alias. Two instruments matching different strong identifiers are **never** merged automatically; a conflict writes a sync issue (`recordSyncIssue` precedent) for review.
- **Ticker-only identity is avoided** because tickers are reused and change; the weak composite key is a *creation* key only — once an alias exists, resolution never re-derives from ticker.
- **Symbol changes:** the provider keeps its `security_id` stable across a rename → the alias still resolves; FM updates the display `tickerSymbol` and appends the old one to the alias set. A `SYMBOL_CHANGE` InvestmentEvent (from imports/corporate-action data, not Plaid) links old→new when instruments must merge; merge = alias repointing + `supersededById` on the losing Instrument, never row deletion.
- **Delisted instruments:** never deleted; `status: DELISTED` (informational), historical positions/events keep resolving.
- **Missing identifiers:** the Instrument exists with nulls; MC1 doctrine — never manufacture a CUSIP.

### 4.2 Type coverage

| Kind | Identity handling |
|---|---|
| Equities / ETFs | CUSIP/ISIN when present; weak key `(ticker, MIC, currency)`. `assetClass: EQUITY \| ETF`. |
| Mutual funds | CUSIP is usually present; ticker often 5-char. `assetClass: MUTUAL_FUND`; NAV pricing semantics live in the price contract, not identity. |
| Fixed income | CUSIP; Plaid `fixed_income` blob preserved raw on the Instrument (`fixedIncomeMeta Json?`). |
| Options | Plaid `option_contract` (underlying, strike, expiry, type) → deterministic OCC-style composite key; `underlyingInstrumentId` FK. `assetClass: OPTION`. |
| Crypto | Symbol + `assetClass: CRYPTO`; provider aliases (`plaid:…`, `wallet:BTC`, future `coinbase:…`). The BTC wallet path (`btc-sync.ts`) later resolves to the same Instrument. |
| Brokerage cash | One Instrument per currency: `assetClass: CASH`, `symbol: "USD"` etc. — what makes cash a *position* instead of a skipped row. |
| Referenced-not-held (indexes, proxy securities) | Plaid `proxy_security_id` stored as an alias relation; Instrument may exist with `isHoldable: false`. |

### 4.3 Field-level schema

```prisma
enum AssetClass { EQUITY ETF MUTUAL_FUND FIXED_INCOME OPTION CRYPTO CASH OTHER UNKNOWN }

model Instrument {
  id            String   @id @default(cuid())
  // Strong identifiers — nullable; null = never provided (MC1 doctrine).
  cusip         String?  @unique
  isin          String?  @unique
  sedol         String?
  // Display / weak identity
  tickerSymbol  String?
  name          String?
  assetClass    AssetClass @default(UNKNOWN)
  // Provider-reported metadata, preserved not interpreted
  securityType     String?   // raw Plaid type
  securitySubtype  String?   // raw Plaid subtype
  marketIdentifierCode String?
  currency      String?     // primary quote/trading currency
  sector        String?
  industry      String?
  cfiCode       String?
  isCashEquivalent Boolean?
  isHoldable    Boolean  @default(true)
  status        String   @default("ACTIVE")   // ACTIVE | DELISTED
  optionMeta      Json?   // raw Plaid option_contract
  fixedIncomeMeta Json?   // raw Plaid fixed_income
  underlyingInstrumentId String?
  supersededById  String?   // symbol-change / merge pointer — never delete
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  aliases   InstrumentAlias[]
  @@index([tickerSymbol])
  @@index([assetClass])
}

// Provider identity mapping — the ProviderAccountIdentity/MerchantAlias twin.
model InstrumentAlias {
  id           String   @id @default(cuid())
  instrumentId String
  instrument   Instrument @relation(fields: [instrumentId], references: [id], onDelete: Cascade)
  provider     String    // "plaid" | "coinbase" | "schwab" | "csv" | "wallet" | "manual"
  externalId   String    // e.g. Plaid security_id; CSV symbol key; wallet asset id
  metadata     Json?     // e.g. institution_security_id, proxy_security_id, source sample
  createdAt    DateTime @default(now())
  @@unique([provider, externalId])   // refuse the second mapping (MerchantAlias doctrine)
  @@index([instrumentId])
}
```

Instruments are **deployment-global** (like `Merchant` and `FxRate`), not tenant data — a security's identity is a public fact; visibility gating stays on positions/events via `financialAccountId`.

---

## 5. InvestmentEvent design

### 5.1 Plaid `investmentsTransactionsGet` — SDK-verified facts (plaid@42.2.0)

- **Signature:** `investmentsTransactionsGet({ access_token, start_date, end_date, options? })`; `options: { account_ids?, count? (≤500, default 100), offset?, async_update? }`.
- **Date-range rules:** `start_date`/`end_date` are `YYYY-MM-DD`, required. Historical depth up to ~24 months (per Plaid product docs and the prior coverage investigation — do not promise more).
- **Pagination:** offset-based — loop while `investment_transactions.length < total_investment_transactions`, advancing `offset`.
- **Response:** `item`, `accounts`, `securities` (full `Security` objects for every referenced security — a second instrument-capture surface), `investment_transactions`, `total_investment_transactions`, `is_investments_fallback_item`.
- **Transaction fields:** `investment_transaction_id` (unique, case-sensitive — **the dedupe key**, mirroring `plaidTransactionId`), `account_id`, `security_id` (nullable — cash-only movements have none), `date` (posting/settlement), `transaction_datetime` (nullable, select institutions), `name` (institution's description), `quantity` (+buy/−sell), `amount` (+cash debited / −cash credited), `price`, `fees` (nullable), `type`, `subtype`, `iso_currency_code`/`unofficial_currency_code`, `cancel_transaction_id` (deprecated legacy).
- **Types (6):** `buy | sell | cancel | cash | fee | transfer`. **Subtypes (~45):** incl. `buy, sell, buy to cover, sell short, contribution, deposit, withdrawal, distribution, dividend, dividend reinvestment, qualified/non-qualified dividend, interest, interest reinvestment, long/short-term capital gain (+reinvestment), account/management/fund/legal/transfer/trust/miscellaneous fee, margin expense, tax, tax withheld, non-resident tax, merger, spin off, split, stock distribution, transfer, send, request, rebalance, adjustment, assignment, exercise, expire, loan payment, pending credit, pending debit, return of principal`.
- **Cancellation/correction:** `type: "cancel"` rows negate a prior transaction; the deprecated `cancel_transaction_id` may point at it but must not be relied on. There is **no pending flag** — `pending credit`/`pending debit` subtypes are the only pending-ish signal. Plaid may restate rows on later fetches; dedupe on `investment_transaction_id` and treat re-fetched differing rows as corrections (append + supersede).
- **Update/backfill:** webhooks `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE` (new transactions) and `HISTORICAL_UPDATE` (async initial extraction complete, relevant with `async_update: true`); `PRODUCT_NOT_READY` while extraction is running — retry later. **No webhook endpoint exists in the repo**; until one does, ingestion runs on the existing refresh path + a one-time backfill pull.
- **Consent:** same Investments product consent as holdings — `PlaidItem.investmentsConsent` and the `ADDITIONAL_CONSENT_REQUIRED` handling extend as-is.
- **What Plaid does NOT provide:** position-as-of history, reliable cost basis per lot, corporate-action detail beyond the subtype label, staking rewards (no such subtype), FIGI.

### 5.2 Table decision: dedicated `InvestmentEvent` (option B, with raw-preservation making it C-lite)

**Rejected — A (extend `Transaction`):** corporate actions (split/merger/spin-off) have no cash leg, no merchant, and a *ratio* + second instrument; forcing them into `Transaction` violates its shape (`merchant String` required, `category` required, sign semantics FM-defined). The prior implementation plan already leaned this way ("corporate actions do not fit Transaction").
**Rejected — C as two tables (raw observation table + projection table):** the repository's ratified pattern is *one canonical row that preserves raw provider hints on-row* (`Transaction.pfcPrimary/pfcDetailed`, `merchantEntityId`), not a separate raw store. Two tables double the write paths for no query benefit at current volumes.
**Chosen — B: one `InvestmentEvent` table** that is simultaneously the provenance record (raw `providerType`/`providerSubtype`/`name`/`externalEventId` preserved verbatim) and the canonical projection (normalized `type`, FM sign conventions). This is exactly how `Transaction` treats Plaid PFC.

### 5.3 Canonical event vocabulary and mapping

```prisma
enum InvestmentEventType {
  BUY SELL CONTRIBUTION WITHDRAWAL TRANSFER_IN TRANSFER_OUT
  DIVIDEND INTEREST CAPITAL_GAIN FEE TAX REINVESTMENT
  SPLIT MERGER SPIN_OFF SYMBOL_CHANGE
  OPENING_BALANCE        // user-asserted / imported opening position anchor
  CANCEL ADJUSTMENT OTHER UNKNOWN
}
```

Deterministic Plaid mapping (adapter `lib/investments/plaid-investment-events.ts`, TE-1 pattern — provider strings preserved raw, never leaked into semantics):

| Plaid type/subtype | Canonical |
|---|---|
| buy/buy, buy to cover, contribution→(with security) | BUY |
| sell/sell, sell short | SELL |
| cash/contribution, deposit | CONTRIBUTION |
| cash/withdrawal, distribution (cash), request | WITHDRAWAL |
| transfer/transfer, send, stock distribution — signed by quantity | TRANSFER_IN / TRANSFER_OUT |
| cash or buy /dividend, qualified/non-qualified dividend | DIVIDEND (REINVESTMENT if `dividend reinvestment`/`interest reinvestment`/`*gain reinvestment` — carries both cash and quantity legs) |
| cash/interest, interest receivable | INTEREST |
| cash/long-term capital gain, short-term capital gain | CAPITAL_GAIN |
| fee/* (account fee, management fee, …), margin expense | FEE |
| cash/tax, tax withheld, non-resident tax | TAX |
| transfer/split | SPLIT |
| transfer/merger | MERGER |
| transfer/spin off | SPIN_OFF |
| cancel/* | CANCEL |
| adjustment, rebalance, assignment, exercise, expire, loan payment, return of principal, pending credit/debit | ADJUSTMENT or OTHER (raw subtype preserved; **never invent** semantics Plaid didn't state) |

`STAKING_REWARD` and `CASH_SWEEP` are **not in the Plaid mapping** (Plaid provides no such subtypes) — they enter the enum only when a provider that actually reports them (Coinbase/wallet adapters) is wired; until then they would be manufactured claims. `SYMBOL_CHANGE` likewise arrives only via imports/corporate-action data.

### 5.4 Field-level schema

```prisma
model InvestmentEvent {
  id                 String   @id @default(cuid())
  financialAccountId String
  financialAccount   FinancialAccount @relation(fields: [financialAccountId], references: [id], onDelete: Cascade)
  instrumentId       String?          // null = cash-only movement
  instrument         Instrument? @relation(fields: [instrumentId], references: [id], onDelete: Restrict)

  type        InvestmentEventType
  date        DateTime @db.Date      // trade/posting date (Plaid `date`)
  datetime    DateTime?              // Plaid transaction_datetime when present
  quantity    Float?                 // security units, signed (+in/−out)
  price       Float?
  amount      Float?                 // cash leg, PROVIDER sign preserved (+debit) — FM-signing happens in read adapters
  fees        Float?
  currency    String?

  // Provenance — raw provider facts preserved on-row (Transaction.pfc* pattern)
  source           String            // "plaid" | "csv:schwab" | "user" | …
  externalEventId  String?           // Plaid investment_transaction_id / file row id
  providerType     String?           // raw Plaid type
  providerSubtype  String?           // raw Plaid subtype
  description      String?           // raw institution `name`

  // Corporate-action shape
  relatedInstrumentId String?
  ratio               Float?

  // Import / assertion provenance
  importBatchId    String?
  importBatch      ImportBatch? @relation(fields: [importBatchId], references: [id], onDelete: SetNull)
  createdByUserId  String?

  // Correction / supersession — append-only doctrine
  supersededById   String?
  deletedAt        DateTime?          // import rollback soft-delete (Transaction.deletedAt pattern)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([source, externalEventId])          // provider dedupe (plaidTransactionId pattern; nulls exempt)
  @@index([financialAccountId, date])
  @@index([instrumentId, date])
  @@index([importBatchId])
}
```

Raw persistence rule: the adapter writes the canonical row **and** the raw fields in one insert; there is no stage where the raw payload exists only in memory. For rows the mapper cannot classify, `type: UNKNOWN` with raw fields intact is the honest write.

---

## 6. PositionObservation design

### 6.1 Model comparison

| Option | Verdict |
|---|---|
| A. One daily row per instrument/account | Rejected — fabricates observations on days nothing was observed; redundant storage with no query benefit (the FxRate walk-back solves reads). |
| B. One observed row per refresh date | **Core of the answer** — append exactly what was observed, when observed. |
| C. Observed rows + derived event-date rows | **Adopted for reconstruction output** — derived rows only at event dates (quantity changes), clearly stamped DERIVED. |
| D. Quantity intervals | Attractive but premature — interval maintenance under late-arriving events is the hardest write path; equivalent read semantics come free from "latest row ≤ date" walk-back. |
| E. Event log only, compute on read | Rejected alone — the audit proved events are incomplete; positions would be unanswerable wherever events are missing. Observations are the anchors that make partial event logs usable. |
| F. Hybrid B+C | **Chosen.** Observed rows per refresh (B) + derived event-date rows from reconstruction (C). Position-as-of = latest non-superseded row ≤ date per (account, instrument), worst-tier stamped. |

### 6.2 Schema

```prisma
enum PositionOrigin { OBSERVED IMPORTED DERIVED USER_ASSERTED }

model PositionObservation {
  id                 String   @id @default(cuid())
  financialAccountId String
  financialAccount   FinancialAccount @relation(fields: [financialAccountId], references: [id], onDelete: Cascade)
  instrumentId       String
  instrument         Instrument @relation(fields: [instrumentId], references: [id], onDelete: Restrict)

  date       DateTime @db.Date
  quantity   Float
  origin     PositionOrigin
  source     String              // "plaid" | "csv:schwab" | "user" | "reconstruction"

  // Observed-only valuation facts (never on DERIVED rows)
  institutionPrice       Float?
  institutionValue       Float?
  institutionPriceAsOf   DateTime? @db.Date
  costBasis              Float?    // Plaid holding-level aggregate cost basis
  vestedQuantity         Float?
  currency               String?
  isCash                 Boolean  @default(false)

  // Derived-only reconstruction provenance (null on observed rows — MC1 doctrine)
  reconstructionVersion  Int?
  completeness           String?   // COMPLETE | PARTIAL | INCOMPLETE (per §12 tiers)
  unexplainedQuantity    Float?    // residual attributable at this point
  evidenceRefs           Json?     // InvestmentEvent ids / observation ids supporting this row

  supersededById String?
  createdAt      DateTime @default(now())

  @@unique([financialAccountId, instrumentId, date, origin, source])
  @@index([financialAccountId, instrumentId, date])
  @@index([financialAccountId, date])
}
```

### 6.3 Operational behavior

**Initial enable / initial import:** capture observed rows for every holding Plaid returns — **including cash and no-ticker securities** the `Holding` writer skips; ingest events (when slice 5+ exists); run reconstruction; persist derived rows + per-position reconciliation summary with unexplained residual.
**Every future refresh:** append one OBSERVED row per (account, instrument) for today (idempotent via the unique key — same-day re-refresh updates the same row's quantity via upsert, which is honest: it is the same observation date). **Never** delete prior observation rows. **Never** rerun full history — a refresh triggers bounded repair only if new events arrived with dates inside an already-reconstructed window.
**`Holding` remains the latest-state read model** — a compatibility projection. The Investments UI keeps reading it unchanged. Replacement is not earned until the observation store has proven itself in production; even then `Holding` can survive indefinitely as a cheap projection (the `btc-sync` upsert already treats it that way).

Zero-quantity rule: when a previously observed instrument disappears from the provider payload, append an explicit `quantity: 0` OBSERVED row — a disappearance is an observation, and without it "latest row ≤ date" would hold the position open forever.

---

## 7. One-time reconstruction algorithm

### 7.1 Contract

Per (financialAccountId, instrumentId), with event window `[E_start, today]`:

```
openingQuantity + Σ signedEventQuantity = closingObservedQuantity + unexplainedResidual… rearranged and computed BACKWARD:

walkQty(today)   = observed current quantity                (anchor, OBSERVED)
walkQty(d⁻)      = walkQty(d) − Σ signedQuantity(events on d)
openingQuantity  = walkQty(E_start⁻)
unexplainedOpeningQuantity = openingQuantity   // if > 0 (or < 0), it is persisted, NEVER forced to 0
```

Determinism rules: events sorted by (date, externalEventId); CANCEL rows negate their target (matched by equal-and-opposite quantity/amount on same instrument, else both retained and flagged CONFLICTED); fractional shares are floats compared under a monetary-precision epsilon (the RelationshipResolver precedent); dividend REINVESTMENT contributes its quantity leg; cash-only events (CONTRIBUTION/WITHDRAWAL/DIVIDEND/INTEREST/FEE) contribute to the **cash instrument's** walk, not the security's; SPLIT applies ratio multiplication at its date when ratio is known, else reconstruction **stops at that date** with failure reason `UNSUPPORTED_CORPORATE_ACTION` (never guess through a split); MERGER/SPIN_OFF likewise stop the affected instruments' walks at the action date.

### 7.2 Discovering closed positions

Instruments that appear in events but not in current holdings get a backward walk anchored at `quantity: 0` today (they were fully disposed). This is how historical positions no longer held are recovered — the audit's "cannot see what I used to own" gap.

### 7.3 Output per (account, instrument)

Persisted as DERIVED `PositionObservation` rows at each event date, plus one summary row (small table `PositionReconstruction`): `earliestDefensibleDate`, `observedCurrentQuantity`, `openingQuantity`, `unexplainedOpeningQuantity`, `completeness` (COMPLETE if residual ≈ 0 and no stops; PARTIAL if residual ≠ 0; INCOMPLETE/FAILED with `failureReason` on unsupported actions or missing anchors), `reconstructionVersion`, `eventCount`, `evidenceRefs`, `runAt`.

### 7.4 Persistence & idempotency

Persist **event-date derived rows + the summary** (option C+summary; not intervals, not a cache-only result — the Timeline and Wealth regeneration need queryable rows). Idempotency: a rerun at version N deletes only rows with `origin: DERIVED AND reconstructionVersion < N` for the affected (account, instrument, window) and rewrites — observed/imported/user-asserted rows are structurally untouchable. Bounded repair: late/corrected events rerun only from `min(affected event dates)` forward to the next OBSERVED anchor.

---

## 8. Historical import strategy

### 8.1 Sources, in priority order

1. **Schwab / Fidelity / Robinhood transaction-history CSV** — highest value (real dated events, often fees/amounts), moderate parsing effort; each becomes a named `ImportMappingProfile`-style mapping (new `InvestmentCsvColumnMap` alongside the existing 8-key banking `CsvColumnMap`).
2. **Generic brokerage CSV** — the canonical column contract below + the existing mapping-profile UX.
3. **Manual opening-position assertion** — cheapest path to closing the unexplained residual: instrument, quantity, as-of date, optional cost basis → `InvestmentEvent(OPENING_BALANCE, source:"user")` + `PositionObservation(USER_ASSERTED)`.
4. **OFX/QFX** — structured, includes `<INVTRAN>`; second wave.
5. **PDF statements** — only if necessary; defer (OCR reliability vs. provenance standards).

### 8.2 Canonical import columns

`account (pre-selected, ImportBatch.financialAccountId precedent — no auto-account-creation)`, `instrument identity (symbol required; CUSIP optional → alias resolution)`, `eventType (mapped per profile)`, `tradeDate (required)`, `settlementDate?`, `quantity`, `price?`, `grossAmount?`, `fees?`, `currency (default account currency)`, `externalRowId?`, `lot/acquisition data? (preserved in metadata Json, not interpreted — tax lots are out of scope)`.

### 8.3 Behavior

- **Dedupe vs Plaid:** exact-key first (`externalEventId` within source never collides across sources), then a deterministic fingerprint — (account, instrument, date, type, quantity≈, |amount|≈) — matching Plaid-window rows are *matched, not re-inserted* (`matchedCount` counter precedent). Ambiguous fingerprints are skipped, not guessed (`fingerprint.ts` doctrine).
- **Fill missing events:** imported rows before the Plaid window simply extend the event log.
- **Supersede lower-trust evidence:** after commit, bounded reconstruction reruns; DERIVED rows regenerate; a user-asserted opening position that the import now explains gets `supersededById` → the residual shrinks. Provenance survives (§3.4).
- **Rollback:** `ImportBatch.ROLLED_BACK` soft-deletes the batch's `InvestmentEvent` rows (`deletedAt`), bounded reconstruction reruns, residuals re-widen. Identical to the banking rollback contract.

---

## 9. Historical price contract

No vendor is selected — repository evidence points to none (only `FxRate` exists, with `source` as free provenance). The contract is provider-neutral and matches the prior plan's ratified shape, extended with the basis distinction:

```prisma
enum PriceBasis { RAW_CLOSE ADJUSTED_CLOSE NAV INTRADAY CRYPTO_DAILY }

model PriceObservation {
  id           String   @id @default(cuid())
  instrumentId String
  date         DateTime @db.Date
  price        Float
  currency     String
  basis        PriceBasis
  source       String       // vendor/adapter id — provenance, not identity (FxRate doctrine)
  fetchedAt    DateTime @default(now())
  @@unique([instrumentId, date, basis])
  @@index([instrumentId, date])
}
```

Contract rulings: store **RAW_CLOSE** as the canonical valuation series (valuing a known historical quantity needs the price *as it was*); ADJUSTED_CLOSE is a separate basis for return analysis, never mixed; mutual funds use NAV; crypto uses a stated daily-close convention (`CRYPTO_DAILY`, UTC close); weekends/holidays are **absent rows** — reads walk back to latest ≤ asked and stamp the result stale-by-N-days (FX walk-back semantics exactly); missing price ⇒ valuation degrades to `estimated`/`incomplete`, never a fabricated number; currency is the quote currency, FX conversion happens downstream via `ConversionContext`; delisted symbols keep their historical rows; symbol changes are an Instrument concern (aliases), not a price concern; corporate actions do not retro-edit RAW_CLOSE rows; licensing/storage restrictions are a vendor-selection gate (redistribution/derived-data terms must permit persistent storage — a hard requirement to check before signing).

Explicit separation (each a distinct capability with distinct requirements):
1. **Position reconstruction** — events + observations only, **no prices needed**;
2. **Historical valuation** — (1) + `PriceObservation` + FX, **no tax lots needed**;
3. **Return decomposition** — (2) + complete external-flow events;
4. **Tax/cost-basis reporting** — (3) + lot policy + jurisdiction rules — **out of scope**.

---

## 10. Wealth and net-worth regeneration

Equation, per day D and Space: `Σ_positions(qty@D × price@D × fx@D) + cash + otherAssets − debt = netWorth@D`.

Rulings (extending the ratified regenerate-not-version decision):

- **`SpaceSnapshot` rows become explicitly what they already implicitly are: cached projections.** `isEstimated: true` rows are **regenerable** — a regeneration pass replaces estimated stocks/crypto components with position-priced values and can flip the flag off when every component reaches observed/derived. `isEstimated: false` rows (live-written same-day observations) are **frozen** — they are observations of what balances said that day; corrections that would move an observed row are the ratified bitemporal trigger and remain deferred.
- **Completeness degrades component-wise:** a day with priced positions but flat-held manual assets is stamped at the worst contributing tier (§12); the snapshot keeps one flag today — the per-component tier detail lives in the as-of read path, not new snapshot columns (no schema growth until a consumer needs it).
- **Brokerage cash double-counting:** the rule is **account value = Σ position values including the CASH-instrument position**; never `FinancialAccount.balance + positions`. Brokerage cash belongs to **investments** for Wealth composition and to **marketable-but-not-spendable** for Liquidity semantics — same fact, two lens interpretations, which is exactly why it must exist as a position (today it is skipped, making the sum unreconcilable against account balance).
- **Owned transfers** (Chase→Schwab) change composition (cash→investment funding), never net worth — guaranteed by both legs being INTERNAL/TRANSFER-typed, never Spending/Income.
- **Contribution ≠ market appreciation:** `Δvalue = external flows (CONTRIBUTION/WITHDRAWAL/TRANSFER) + market move (residual)`; dividends received as cash are investment *income within the account*, not market appreciation and not Space-level Income unless withdrawn. This decomposition ships in the Timeline phase, not before prices exist.
- **No bitemporal history** — the corrections-only `KnowledgeVersion` trigger conditions (backfills routinely rewriting shown history AND users anchoring decisions to it) remain unmet.

---

## 11. Chase → Schwab transfer linking

Semantics required (all already expressible in existing vocabulary):

| Leg | Record | Semantics |
|---|---|---|
| Chase checking outflow | `Transaction` (flowType TRANSFER, direction INTERNAL once populated; TE-1 may stamp `transferVenueClass: BROKERAGE`) | Liquidity ↓; never Spending, never Income |
| Schwab contribution | `InvestmentEvent(CONTRIBUTION)` (+ cash-instrument position effect) | Investment funding ↑; never Income, never market return |
| Later buy | `InvestmentEvent(BUY)` | Cash position ↓, security position ↑; net-worth-neutral except fees/slippage |

**Design: extend the existing read-time `RelationshipResolver` with an investment-funding matcher — not a new persisted relationship store.** TI4's ratified decision (relationships are recomputed explanation context, not rows) applies unchanged; the new matcher `matchInvestmentFundingCandidate(bankTxn, investmentEventCandidates)` mirrors `matchTransferCandidate` exactly: different owned accounts, same currency, equal |amount| to monetary precision, opposite direction, transfer-like on the bank side (TE-1 `transferVenueClass: BROKERAGE` evidence strengthens but is not required), a slightly wider date window than intra-bank transfers (ACH-to-brokerage settlement lag: ±5 business days), **exactly one** candidate or the match is REFUSED with `AMBIGUOUS`/`NONE` reasons. No merchant-name heuristics. Where only one leg exists (brokerage not connected, or vice versa), the leg stays unresolved and honestly labeled — the resolver's existing posture. The buy is **not** linked to the funding pair (cash is fungible; claiming "this transfer funded this buy" is a manufactured claim); the account-level cash walk already connects them arithmetically.

---

## 12. Completeness / trust model

| Tier | Applies when | Aggregable? | Renders as | Simulation input? | LLM may state as fact? | Supersedable? |
|---|---|---|---|---|---|---|
| **observed** | Provider stated it for its own account/date | Yes | Plain fact | Yes | Yes | Only by a newer observation of the same date (correction) |
| **imported-observed** | Statement/CSV the user supplied | Yes | Fact + "from your Schwab import" | Yes | Yes, with source attribution | By provider observation |
| **provider-derived** | Provider computed it (e.g. Plaid cost_basis aggregate) | Yes, labeled | Fact + provider caveat | Yes | Yes, attributed ("Schwab reports…") | By imported lot detail |
| **reconstructed (derived)** | FM computed it deterministically from anchors + events | Yes, labeled | "Reconstructed" badge | Yes, flagged | Only as "based on your transaction history, you held…" | By any evidence above |
| **user-asserted** | User stated it | Yes, labeled | "You told us" | Yes | Yes, attributed to the user | By imported/observed |
| **estimated** | Heuristic/carry-forward/stale price | Only into estimated aggregates | "Estimated" | Flagged, drives ranges not points | **No** — must hedge | By everything above |
| **incomplete** | Residual ≠ 0, missing anchor, pre-history date | Blocks claiming the total is complete | "Partial — N shares unexplained" | Excluded or flagged | **No** — must state the gap | N/A (a state, not evidence) |
| **conflicted** | Two same-tier sources disagree | **No** | "Sources disagree" + drill-down | No | No — must surface the conflict | By resolution/correction |

**Worst-tier propagation** (the ratified TM §9 rule, applied down the chain): holding quantity → min(position rows in scope); historical holding value → min(quantity tier, price tier, FX tier); account value → min over holdings incl. cash position; total investment value → min over accounts; Wealth as-of / net worth → min over components; Timeline events inherit their evidence tier; simulation baselines carry the tier of their weakest input and must surface it in forecast transparency; the LLM tool responses include the tier machine-readably and the system prompt contract forbids stating estimated/incomplete values as fact. The UI never renders derived/incomplete history in observed-fact styling — the pixel-level enforcement rule from the TM investigation, unchanged.

---

## 13. Full implementation roadmap for Claude Code

Reordered from the prompt's 17-item list where evidence demands. Notation: each slice ends with a commit; every schema slice is additive; kill switch = "absent flag/option ⇒ byte-identical behavior" (the repo's established convention — no formal flag system exists).

**Track A — stop the loss (immediate, no external dependencies)**

| # | Slice | Content | Stop condition |
|---|---|---|---|
| A1 | **Investment Observation Foundation** (§15 — the first slice) | `Instrument` + `InstrumentAlias` + `PositionObservation` (+enums); resolver `lib/investments/instrument-resolver.ts`; capture writer `lib/investments/position-capture.ts` wired into **both** holdings writers behind `INVESTMENT_OBSERVATIONS_ENABLED`; backfill current `Holding` rows into day-one observations; `Holding` untouched | Refresh appends observations (incl. cash rows); Holding/UI byte-identical; rollback loses nothing current |
| A2 | Holding compatibility hardening | Switch `deleteMany`+`create` → per-symbol upsert + delete-of-absent (the `btc-sync` pattern); purely behavioral, no schema | Same visible holdings; row ids stable across refresh |
| A3 | Crypto/wallet observation parity | `btc-sync.ts` writes `PositionObservation` via the same capture module; BTC alias → Instrument | Wallet positions observed daily |

**Track B — events and reconstruction (needs Plaid investments consent only — already modeled)**

| # | Slice | Content | Stop condition |
|---|---|---|---|
| B1 | `InvestmentEvent` schema + Plaid adapter (pure) | Table + enum + `plaid-investment-events.ts` mapper with unit tests over SDK fixtures; no fetch yet | Mapper is total (every type/subtype → canonical or UNKNOWN), deterministic, raw-preserving |
| B2 | `investmentsTransactionsGet` ingestion | Paginated fetch (24-mo window) on enable + refresh; dedupe on `[source, externalEventId]`; consent/`PRODUCT_NOT_READY` handling; securities payload feeds the Instrument resolver | Re-runs add zero duplicates; events visible in DB for real accounts |
| B3 | One-time reconstruction + reconciliation summary | §7 algorithm as a pure core (`reconstruction-core.ts`, fixture-tested) + a persistence runner; DERIVED rows + `PositionReconstruction` summaries; bounded-repair entry point | Contract holds on real data: opening + events = current + residual, residual persisted not zeroed; 16 real positions each get a summary |
| B4 | Investments perspective honesty upgrade | Surface per-position completeness + "history since"/unexplained badges from summaries; read path only | Derived never styled as observed |

**Track C — imports (needs CSV history from the user; parallel to B after B1)**

| # | Slice | Content | Stop condition |
|---|---|---|---|
| C1 | Opening-position assertion | Minimal UI + API: OPENING_BALANCE event + USER_ASSERTED observation; triggers bounded reconstruction | Residual shrinks; assertion supersedable |
| C2 | Brokerage CSV import | `InvestmentCsvColumnMap`, Schwab profile first, `ImportBatch` reuse, dedupe/rollback per §8 | Import → dedupe vs Plaid → reconstruction rerun → rollback restores prior state |

**Track D — prices and valuation (blocked on price-provider selection)**

| # | Slice | Content | Stop condition |
|---|---|---|---|
| D1 | `PriceObservation` schema + adapter contract | Table + provider-neutral fetch interface (`lib/prices/`), `fetch-fx-rates.ts` as the job template; no vendor call yet | Contract testable with fixture vendor |
| D2 | Backfill + daily price capture | Vendor adapter; backfill for held instruments' active windows; daily close job | Walk-back reads work; misses degrade tier |
| D3 | Historical investment valuation | `value@D = qty@D × price@D × fx@D` read path, worst-tier stamped | Valuation refuses (incomplete) where price/position missing |
| D4 | Wealth snapshot regeneration | Regenerate `isEstimated` SpaceSnapshot rows with priced investment components (§10); observed rows frozen | Estimated rows improve; observed rows byte-identical |

**Track E — consumers (each gated on D3/D4)**

E1 Investment Time Machine adapter (as-of positions/valuation into the perspective-engine seam from the parallel TM workstream) → E2 Timeline contribution-vs-growth decomposition (§10 equation) → E3 Simulation integration (baseline contributions/returns, tier-flagged) → E4 LLM investment tools (tier-aware, §12 contract). Chase→Schwab funding matcher (§11) is independent after B2 and can run in parallel.

**Dependency summary:** start now: A1→A2→A3, B1. Needs nothing external: B2–B4, C1. Needs user CSVs: C2. Needs price provider: D1 contract now, D2–D4 after selection. Deferred: bitemporal `KnowledgeVersion`, tax lots, corporate-action dataset, webhooks (separate provider-plumbing workstream already recommended by the backfill investigation).

---

## 14. Schema / migration strategy

1. **Migration 1 (A1):** create `Instrument`, `InstrumentAlias`, `PositionObservation`, enums. Purely additive; no existing table touched. Backfill in the same slice's code (not the migration): current `Holding` rows → OBSERVED observations dated today, aliased via ticker (weak key — flagged in alias metadata as `bootstrap: true` for later upgrade when Plaid's `security_id` is seen).
2. **Migration 2 (B1):** create `InvestmentEvent` + enum + `ImportBatch` relation. Additive.
3. **Migration 3 (B3):** create `PositionReconstruction` summary table. Additive.
4. **Migration 4 (D1):** create `PriceObservation` + `PriceBasis`. Additive.
5. **No destructive `Holding` migration ever scheduled in this program.** The `deleteMany`+`create` change (A2) is **code-only** — it should land after A1 has run in production for at least one full refresh cycle, so observation capture is proven before the writer is touched. `Holding` remains the Investments read model indefinitely; any future retirement is its own investigation.
6. **Rollback posture:** every migration is reversible by dropping the new tables; because `Holding` and its writers are untouched in schema slices, rollback never loses current holdings. Historical features (reconstruction display, valuation, TM adapter) stay kill-switched until their completeness tests pass against real data.
7. **Ordering rule:** additive migration → dark writes behind switch → real-data validation → read-path consumption → (much later) writer behavior changes. This is the D2/MI/TI2 sequence, reused.

---

## 15. Smallest next implementation slice — confirmed with amendments

**"Investment Observation Foundation" (A1) is confirmed as the correct first slice**, for the reasons the backfill investigation already established: investments are the one domain with an *observation gap* — history not captured now is permanently lost, and capture requires no new provider product, no consent change, no price vendor, and no UI. Repository evidence adds two amendments to the proposed scope and one exclusion:

- **Amendment 1 — capture cash and no-ticker securities.** The proposed scope said "preserve identifiers and cost basis"; the code shows both writers *skip entire rows* (`sec.type === "cash" || !sec.ticker_symbol`). The observation writer must iterate the raw payload, not the filtered one, or brokerage cash never becomes a position and §7's contract can never reconcile.
- **Amendment 2 — wire both writers.** `exchangeToken.ts` (initial link) and `refresh.ts` duplicate the holdings logic; capturing only in refresh loses the first observation of every new connection. Extract one shared capture module and call it from both.
- **Exclusion — do not change `deleteMany`+`create` in this slice.** That is A2, after capture is proven. First slice = pure addition.

Everything else in the candidate scope is confirmed: canonical Instrument identity, append-only PositionObservation, observed rows on enable + refresh, `Holding` untouched as UI read model, no prices, no reconstruction, no Time Machine UI.

---

## 16. Exact Claude Code prompt for the approved first slice

> **Task: Implement the Investment Observation Foundation — canonical Instrument identity + append-only PositionObservation capture. Branch `feature/v2.5-spaces-completion`.**
>
> **Context:** Holdings are currently overwritten on every refresh (`lib/plaid/refresh.ts:317`, `lib/plaid/exchangeToken.ts:442` — `deleteMany`+`create`), cash/no-ticker securities are skipped entirely, and Plaid's security identifiers (`security_id`, `cusip`, `isin`, `sedol`), cost basis, and price-as-of fields are discarded. This slice starts capturing append-only position observations and canonical instrument identity WITHOUT changing any existing behavior. Design source: `FOURTH_MERIDIAN_INVESTMENT_HISTORY_PROGRESSIVE_EVIDENCE_IMPLEMENTATION_PLAN_2026-07-11.md` §4, §6, §15.
>
> **Hard constraints:**
> - The `Holding` table, both `deleteMany`+`create` writers' existing writes, the Investments perspective read path (`lib/data/investment-accounts.ts`), and all UI remain **byte-identical** in behavior. This slice only ADDS.
> - Additive migration only. No column changes to existing tables (except new relation back-references Prisma requires).
> - All new capture code runs behind an env kill switch `INVESTMENT_OBSERVATIONS_ENABLED` (absent/false ⇒ no new writes, existing behavior untouched) and is best-effort/non-fatal (a capture failure must never fail a refresh — follow the `writeBtcHolding` try/catch precedent in `lib/crypto/btc-sync.ts`).
> - MC1 doctrine: nullable provenance fields with no defaults — null means "not provided", never a manufactured claim.
>
> **1. Investigate first (report inline before coding):** confirm the holdings write sites in `lib/plaid/refresh.ts` and `lib/plaid/exchangeToken.ts` and the exact Plaid payload fields available on `holdings[]` and `securities[]` in `plaid@42.2.0`; confirm `ProviderAccountIdentity`/`MerchantAlias` unique-key conventions; confirm how `btc-sync.ts` upserts Holdings (the non-fatal precedent).
>
> **2. Schema (one additive migration):** add `Instrument`, `InstrumentAlias`, `PositionObservation`, and enums `AssetClass`, `PositionOrigin`, exactly per plan §4.3 and §6.2 (Instrument: strong ids `cusip @unique`/`isin @unique`/`sedol`, `tickerSymbol`, `name`, `assetClass`, raw `securityType`/`securitySubtype`, `marketIdentifierCode`, `currency`, `sector`, `industry`, `cfiCode`, `isCashEquivalent`, `optionMeta Json?`, `fixedIncomeMeta Json?`, `supersededById`; InstrumentAlias: `@@unique([provider, externalId])`; PositionObservation: `@@unique([financialAccountId, instrumentId, date, origin, source])`, observed-fact fields `institutionPrice/institutionValue/institutionPriceAsOf/costBasis/vestedQuantity/currency/isCash`, derived-only fields left null this slice).
>
> **3. Instrument resolver (`lib/investments/instrument-resolver.ts`):** pure-core + db-binding split (the lens/core convention). Resolution order: provider alias (`plaid`, `security_id`) → CUSIP → ISIN → SEDOL → create-with-weak-key. Never merge two instruments automatically; on strong-identifier conflict, record a sync issue (`recordSyncIssue`) and keep them separate. Upsert alias on first resolution. Unit tests: alias hit, cusip hit, creation, conflict refusal, cash security (`type === "cash"` ⇒ `assetClass: CASH`, symbol = currency code).
>
> **4. Capture module (`lib/investments/position-capture.ts`):** one exported `capturePositionObservations({ financialAccountId, plaidHoldings, securitiesById, date })` that iterates the **raw, unfiltered** holdings for the account — including cash and no-ticker securities the Holding writer skips — resolves each security to an Instrument, and upserts one `PositionObservation` per (account, instrument) for the capture date with `origin: OBSERVED`, `source: "plaid"`, quantity, and every preserved field (`cost_basis` → `costBasis`, `institution_price` → `institutionPrice`, `institution_price_as_of` → `institutionPriceAsOf`, `institution_value` → `institutionValue`, `vested_quantity` → `vestedQuantity`, currency fallback chain as the Holding writer does). Same-day re-capture updates the same row (same observation date — honest). Additionally: for any instrument that has a prior observation for this account but is absent from today's payload, append an explicit `quantity: 0` observation (disappearance is an observation).
>
> **5. Wire into BOTH writers:** call the capture module from the holdings sections of `lib/plaid/refresh.ts` AND `lib/plaid/exchangeToken.ts`, before the existing `deleteMany` (so the raw payload is captured regardless of Holding filtering), gated on the kill switch, wrapped non-fatal.
>
> **6. Backfill script (`scripts/backfill-position-observations.ts`):** one-time, idempotent — current `Holding` rows → OBSERVED observations dated today via ticker-weak-key instrument creation, alias metadata `{ bootstrap: true }`. Do not fabricate historical dates.
>
> **7. Tests:** unit tests for resolver and capture core (fixtures modeled on real Plaid holdings/securities payload shapes, including a cash security and a cusip-less security); an integration test that runs capture twice and asserts append-only/idempotent behavior and the zero-quantity disappearance row; a guard test that with the kill switch off, no new tables are written.
>
> **8. Real-data validation:** with the switch on, run a refresh against the real connected brokerage (16 positions expected); verify: one observation per position **plus cash**, identifiers/cost basis persisted where Plaid returned them, `Holding` rows and the Investments UI unchanged, second refresh adds no duplicate rows.
>
> **Stop conditions:** all of §8 verified; existing test suite green; no change to any existing table's rows; commit boundary = one commit for the migration + models, one for resolver+capture+wiring+tests, one for the backfill script. **Do not** implement `investmentsTransactionsGet`, reconstruction, prices, imports, UI changes, or the `deleteMany` upsert change in this slice.
>
> **Rollback strategy:** kill switch off restores prior behavior instantly; dropping the three new tables loses only observation history, never current holdings.

---

## 17. Explicit boundaries

**Possible now (current data + this plan's Track A):** current factual holdings; append-only observation history accruing from day one; canonical instrument identity with preserved identifiers and cost-basis aggregates; brokerage cash as a position; honest per-position provenance.

**Possible after Plaid investment events (Track B):** ~24 months of buys/sells/contributions/withdrawals/dividends/fees; deterministic position reconstruction inside that window; discovery of closed positions; explicit unexplained opening quantities; contribution-vs-withdrawal flow facts; Chase→Schwab funding links (both legs).

**Requires CSV/imported history or user assertion (Track C):** anything before the ~24-month Plaid window — pre-connection buys, opening positions, acquisition dates, historical cost detail; shrinking unexplained residuals to zero for long-held positions.

**Requires a price provider (Track D):** any historical *valuation* — portfolio value over time, allocation history, Wealth snapshot upgrades, Investment Time Machine values, return decomposition. Positions and quantities do not wait for this; values do.

**Remains impossible without new evidence:** positions on dates before any observation, event, import, or assertion covers them (the residual stays, honestly); reliable per-lot cost basis without brokerage lot data; corporate-action detail (split ratios, merger terms) without a corporate-actions dataset — reconstruction stops at such events rather than guessing; historical prices for instruments no vendor covers; and anything the provider restated before Fourth Meridian ever observed it.

---

*End of plan. No code was written, no files modified, no migrations created, no provider calls implemented, nothing committed.*
