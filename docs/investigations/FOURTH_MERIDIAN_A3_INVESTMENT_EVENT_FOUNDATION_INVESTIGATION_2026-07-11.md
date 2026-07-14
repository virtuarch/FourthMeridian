# Fourth Meridian — A3 Investment Event Foundation Investigation

**Date:** 2026-07-11
**Branch investigated:** `feature/v2.5-spaces-completion`
**Status:** Investigation only. No code written, no files modified, no migrations created.
**Context:** A1 (Investment Observation Foundation — `Instrument`, `InstrumentAlias`, `PositionObservation`, observation capture, brokerage-cash derivation) is complete and wired into `lib/plaid/refresh.ts` / `lib/plaid/exchangeToken.ts` behind `INVESTMENT_OBSERVATIONS_ENABLED`. A2 (Holding Writer Modernization) is in flight separately and is code-only (no schema). This document designs A3: the canonical `InvestmentEvent` layer.

**Relation to prior ratified work:** `FOURTH_MERIDIAN_INVESTMENT_HISTORY_PROGRESSIVE_EVIDENCE_IMPLEMENTATION_PLAN_2026-07-11.md` §5 already sketched `InvestmentEvent` (its slices B1/B2 ≈ this A3). This investigation re-grounds that sketch against (a) the A1 code that has since landed, (b) the installed SDK (`plaid@42.2.0`, verified directly from `node_modules`), and (c) live Plaid documentation. Where this document differs from §5, the difference is flagged with **[REVISION]** and justified. This document supersedes §5 for A3 implementation purposes.

---

## 1. Executive conclusion

**Build one additive table, `InvestmentEvent`, that is simultaneously the provenance record and the canonical projection — exactly how `Transaction` treats Plaid PFC.** Raw provider facts (`providerType`, `providerSubtype`, raw description, raw `security_id`, provider event id) live on-row next to the normalized canonical fields (`type`, signed `quantity`, FM-signed `amount`, `fees`, `price`, `currency`). Do **not** split raw and canonical into two tables: the repository's ratified pattern (`Transaction.pfcPrimary/pfcDetailed/merchantEntityId`, `PositionObservation` observed-vs-derived columns, `Instrument.optionMeta`) is one canonical row preserving raw hints, and two tables double every write path for zero query benefit at current volumes.

Provider-neutrality is achieved the same way it already is everywhere else in the repo: a **pure stage-1 adapter** (`lib/investments/plaid-investment-events.ts`, the TE-1 / `plaid-transfer-evidence.ts` pattern) maps the provider payload to the canonical row; provider strings never leak past the adapter; unmappable rows write `type: UNKNOWN` with raw fields intact rather than being dropped or guessed. Future providers (Coinbase, Schwab-native, brokerage CSV via `ImportBatch`, manual assertions) each get their own stage-1 adapter into the same table, deduped by `[source, externalEventId]` — the `plaidTransactionId` pattern generalized.

A3 is append-only and dark: gated behind a new `INVESTMENT_EVENTS_ENABLED` flag (separate from `INVESTMENT_OBSERVATIONS_ENABLED`), nothing reads it, `Holding`/Cash Flow/Liquidity/Wealth are untouched. Its sole consumers are future: A4 reconstruction, Time Machine contribution-vs-growth, and AI assemblers.

---

## 2. Repository audit — what exists, what is reused

### 2.1 Transaction ontology (`prisma/schema.prisma` `model Transaction`, ~line 1511)

The banking `Transaction` is the platform's most mature ontology and is the direct template:

- **Provider dedupe:** `plaidTransactionId String? @unique` plus generic `externalTransactionId` for imports. Reused as `@@unique([source, externalEventId])`.
- **Raw-hint preservation:** `pfcPrimary`/`pfcDetailed`/`pfcConfidenceLevel` are raw Plaid strings stored beside canonical `flowType` — "Plaid owns/versions this taxonomy; it is a provider hint, not Fourth Meridian semantics." Reused as `providerType`/`providerSubtype`.
- **Null doctrine (MC1 Phase 0):** null = "never provided / pre-slice row", never a manufactured claim. Reused for every nullable field.
- **Versioned derivation:** `classifierVersion`, `tiFactsVersion`, `transferEvidenceVersion` gate backfills/replays. Reused as `mapperVersion`.
- **Soft delete + rollback:** `deletedAt` + `ImportBatch.status = ROLLED_BACK`. Reused verbatim.
- **Sign convention:** schema comment: "Positive = money in, negative = out"; `lib/plaid/syncTransactions.ts` flips Plaid's sign **at write time**. See §4 [REVISION] — A3 adopts write-time canonical signing, not read-time.

### 2.2 FlowType (`lib/transactions/flow-classifier.ts`, schema enums ~line 1348)

`FlowType.INVESTMENT` classifies *banking* rows touching investment venues as `INTERNAL` asset conversion — it deliberately says nothing about what happened inside the brokerage. `InvestmentEventType` is the missing inside-the-brokerage vocabulary; it complements, never replaces, FlowType. `FlowClassificationReason` demonstrates the "stable, auditable machine reason" pattern; A3's mapper is total and deterministic so a per-row reason enum is unnecessary — the raw `providerType`/`providerSubtype` *is* the reason.

### 2.3 RelationshipResolver (`lib/transactions/RelationshipResolver.ts`)

Ratified TI4 doctrine: relationships are **not persisted** — resolved at read time, pure/deterministic, zero imports, refuse-ambiguity ("REFUSED, never guessed"). A3 inherits this: no persisted FK from `InvestmentEvent` to `Transaction` (the brokerage contribution and its matching bank transfer leg are matched at read time by a future resolver extension), and CANCEL↔target matching is deterministic matching inside A4, not a stored pointer (`cancel_transaction_id` is deprecated and unreliable — SDK-verified).

### 2.4 ImportBatch (`model ImportBatch`, ~line 1788)

Full rollback-capable import provenance exists: `financialAccountId` required (no auto-account-creation), `matchedCount`/`skippedCount` counters, `ROLLED_BACK` → soft-delete. `InvestmentEvent.importBatchId` (nullable, `onDelete: SetNull`) plugs in unchanged. CSV *parsing* for investment events (an `InvestmentCsvColumnMap`) is out of A3 scope — A3 only leaves the seam.

### 2.5 Provider adapter pattern

- `lib/providers/catalog.ts` — routing registry; adapters must not depend on it. A3 adds nothing here.
- `lib/providers/plaid/adapter.ts` — deliberately minimal re-export seam ("no generic adapter framework until a second sync provider exists"). A3 follows: no framework, one concrete Plaid mapper + one ingest function, re-exported later if desired.
- `lib/transactions/plaid-transfer-evidence.ts` (TE-1) — the stage-1 normalizer precedent: provider payload → canonical contract, provider strings never stored in canonical fields.
- `lib/plaid/syncTransactions.ts` — the ingestion-loop template: internal `PlaidItem.id` in, cursor/pagination loop, `account_id → FinancialAccount` via unique `plaidAccountId` with skip-and-warn for unmapped accounts, upsert-by-provider-id, retry wrapper, `SyncIssue` recording.
- `lib/plaid/investmentsConsent.ts` + `PlaidInvestmentsConsent` — consent gating for the Investments product already exists and extends as-is.

### 2.6 PositionObservation + capture (A1, landed)

`lib/investments/position-capture.ts` establishes: kill-switch env gate, pure mapping core + thin DB binding, same-day idempotent upsert, append-only prior days, disappearance→explicit zero, best-effort/non-fatal contract at call sites (`refresh.ts:324`, `exchangeToken.ts:449`). `PositionObservation` already carries the **derived-row provenance columns A4 will write** (`reconstructionVersion`, `completeness`, `unexplainedQuantity`, `evidenceRefs`) — deliberately null in A1. **Consequence for A3:** completeness is a *reconstruction* output living on observations/summaries, not an event attribute (§4).

### 2.7 Instrument / InstrumentAlias + resolver (A1, landed)

`lib/investments/instrument-resolver.ts`: alias → CUSIP → ISIN → SEDOL → weak(ticker+MIC) → create; strong-id conflicts REFUSED with `SyncIssue(INSTRUMENT_IDENTITY_CONFLICT)`. `resolveInstrumentForPlaidSecurity` is directly reusable: the `investmentsTransactionsGet` response includes a full `securities` array — **a second instrument-capture surface** that A3 feeds through the same resolver, so events and holdings converge on identical Instrument identity.

### 2.8 Downstream (relationship targets, audited)

- **Cash Flow** (`lib/transactions/cash-flow.ts:262`): INVESTMENT rows explicitly ignored — cash flow reads `Transaction` only.
- **Liquidity** (`lib/transactions/liquidity.ts`): investment venue movement resolved from *transfer evidence on banking rows*, not brokerage internals.
- **Wealth**: `SpaceSnapshot` + `Holding` aggregates.
- **Time Machine plan** (§ layering): `InvestmentEvent` is designated an **L1 canonical fact**; contribution-vs-growth decomposition is the first read use case (its table §131: "(1) + InvestmentEvent for contributions/withdrawals/dividends/fees").
- **Conversation**: `lib/ai/assemblers/holdings.ts` exists; an events assembler is a future mirror, not A3.
- **Naming note:** `lib/events/` already exists (platform notification/audit events). The investment module must live in `lib/investments/` — never `lib/events/`.

### 2.9 Verdict — reuse table

| Existing asset | A3 reuse |
|---|---|
| `Transaction` raw-hint + dedupe + soft-delete pattern | Schema template |
| `syncTransactions.ts` loop shape | Ingest function template |
| TE-1 stage-1 adapter pattern | `plaid-investment-events.ts` mapper |
| `resolveInstrumentForPlaidSecurity` | Called per securities payload |
| `parsePlaidDate`, `isCashSecurity` (position-capture) | Imported as-is |
| `investmentsConsent.ts`, `retry.ts`, `syncIssues.ts` | Called as-is |
| `ImportBatch` + rollback contract | FK seam (nullable) |
| RelationshipResolver read-time doctrine | No persisted cross-links |
| MC1 null doctrine, kill-switch gating, best-effort capture | Contracts copied |

Nothing needs modification for A3 except the two wiring sites (`refresh.ts`, `exchangeToken.ts`) that already host A1 capture — the same `if (enabled) try/catch` block pattern. **A2 coordination:** A2 edits the `Holding` writer in these same files; A3's additions are adjacent, additive blocks — sequence the merges, no structural conflict.

---

## 3. Plaid `investmentsTransactionsGet` — verified facts

Verified directly against `node_modules/plaid/dist/api.d.ts` (plaid@42.2.0) and plaid.com/docs (fetched 2026-07-11).

**Request:** `{ access_token, start_date, end_date (YYYY-MM-DD, required), options?: { account_ids?, count? (1–500, default 100), offset?, async_update? } }`.

**Response:** `{ item, accounts: InvestmentAccount[], securities: Security[], investment_transactions: InvestmentTransaction[], total_investment_transactions, request_id, is_investments_fallback_item? }`.

**`InvestmentTransaction` fields (SDK-exact):**

| Field | Type | Notes |
|---|---|---|
| `investment_transaction_id` | `string` | Unique across all Plaid transactions, case-sensitive — **the dedupe key** |
| `cancel_transaction_id` | `string \| null` | **@deprecated** — never rely on it |
| `account_id` | `string` | → `FinancialAccount.plaidAccountId @unique` |
| `security_id` | `string \| null` | null = cash-only movement |
| `date` | `string` | ISO date; "typically the settlement date" |
| `transaction_datetime` | `string \| null` | Select institutions only |
| `name` | `string` | Institution's raw description |
| `quantity` | `number` | **Positive = buy, negative = sell** (units) |
| `amount` | `number` | **Positive = cash debited, negative = cash credited** (also for cash-only rows) |
| `price` | `number` | Execution price (0 for many cash rows) |
| `fees` | `number \| null` | Combined fees |
| `type` | enum | `buy \| sell \| cancel \| cash \| fee \| transfer` (6) |
| `subtype` | enum | 48 values — full list in §5 mapping |
| `iso_currency_code` / `unofficial_currency_code` | `string \| null` | Exactly one non-null |

**Pagination:** offset-based; loop while fetched `< total_investment_transactions`, advancing `offset`. Docs: "the sequence of transaction ordering is stable and will not shift" (reverse-chronological).

**Historical depth:** "up to 24 months of user-authorized transaction data" (docs, verified). Do not promise more.

**Initial extraction / readiness:** if investments was in the Link `products` array, data is extracted at Link; a first call immediately after Link may block 1–2 minutes while Plaid waits for data. With `async_update: true` (for Items not initialized with investments), extraction is asynchronous: calls return `PRODUCT_NOT_READY` until the `HISTORICAL_UPDATE` webhook fires. `ADDITIONAL_CONSENT_REQUIRED` follows the same consent flow `investmentsConsent.ts` already handles for holdings.

**Update behavior:** webhooks `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE` (new transactions) and `HISTORICAL_UPDATE` (initial/backfill extraction complete). **No webhook endpoint exists in the repo** (confirmed; `syncTransactions.ts` header notes the same gap for banking). Until one exists, ingestion runs on the existing refresh entry points + the daily job, re-pulling a trailing window.

**Correction behavior:** no cursor, no `removed[]` (unlike `transactionsSync`). Corrections appear as (a) `type: "cancel"` rows negating a prior row, and/or (b) restated rows on later fetches. Deterministic handling: dedupe on `investment_transaction_id`; a re-fetched row whose material fields differ from the stored row is a **correction → append new row + `supersededById` on the old** (append-only doctrine), never an in-place silent overwrite of canonical fields.

**Pending behavior:** there is **no pending flag** on investment transactions. The only pending-ish signals are the `pending credit` / `pending debit` subtypes. Do not fabricate a `SettlementState` — preserve the raw subtype and map to `ADJUSTMENT` (they are provisional cash movements, not settled facts).

**Provider IDs:** transaction → `investment_transaction_id`; security → `security_id` (+ `institution_security_id`/`proxy_security_id` on the `Security` object, already handled by A1's alias metadata); account → `account_id`.

**SDK deltas vs. the prior plan doc §5.1 [REVISION]:** the installed SDK enumerates **48** subtypes, including two the plan doc's list missed — `trade` and `unqualified gain` — plus it listed "interest receivable" correctly. The mapping table in §5 covers all 48.

---

## 4. Canonical `InvestmentEvent` schema

**Answer to the split question:** raw provider fields stay **on-row**. Grounds: `Transaction.pfc*` precedent (§2.1); `Instrument.optionMeta/fixedIncomeMeta` precedent (raw preserved, not interpreted); the plan doc's ratified rejection of a two-table raw/projection split; and the operational rule that the adapter writes canonical + raw **in one insert** — there is no stage where raw exists only in memory.

**What does NOT belong on the row:**
- **Completeness** — a reconstruction (A4) output; lives on derived `PositionObservation` rows and the A4 summary table. An event is evidence; it does not know whether the ledger is complete. The per-row honesty valve is `type: UNKNOWN` + preserved raw fields.
- **Full raw JSON payload** — rejected. Every field of `InvestmentTransaction` is individually preserved by the columns below; a `rawPayload Json` would duplicate 100% of the data. (`Instrument` stores `optionMeta` Json only for *sub-objects* not worth columnizing — no such sub-objects exist here.)
- **Persisted links to `Transaction` / `PositionObservation`** — RelationshipResolver doctrine (§2.3).

```prisma
enum InvestmentEventType {
  BUY
  SELL
  CONTRIBUTION
  WITHDRAWAL
  TRANSFER_IN
  TRANSFER_OUT
  DIVIDEND
  INTEREST
  CAPITAL_GAIN
  REINVESTMENT
  FEE
  TAX
  SPLIT
  MERGER
  SPIN_OFF
  SYMBOL_CHANGE     // imports/corporate-action data only — never from Plaid
  OPENING_BALANCE   // user-asserted / imported opening anchor
  CANCEL
  ADJUSTMENT
  OTHER
  UNKNOWN
}

model InvestmentEvent {
  id                 String   @id @default(cuid())
  financialAccountId String
  financialAccount   FinancialAccount @relation(fields: [financialAccountId], references: [id], onDelete: Cascade)
  instrumentId       String?
  instrument         Instrument? @relation(fields: [instrumentId], references: [id], onDelete: Restrict)

  type     InvestmentEventType
  date     DateTime  @db.Date   // posting/settlement date (Plaid `date`)
  datetime DateTime?            // Plaid transaction_datetime when provided
  quantity Float?               // security units, signed: + units in / − units out
  price    Float?
  amount   Float?               // cash leg, FM sign: + cash into account / − cash out
  fees     Float?               // always stored ≥ 0 (a cost), or null = not provided
  currency String?              // ISO 4217 or unofficial code; null = never provided

  // Provenance — raw provider facts on-row (Transaction.pfc* pattern)
  source             String    // "plaid" | "csv:<profile>" | "user" | "coinbase" | …
  externalEventId    String?   // Plaid investment_transaction_id / file row id
  providerType       String?   // raw Plaid type — verbatim
  providerSubtype    String?   // raw Plaid subtype — verbatim
  providerSecurityId String?   // raw Plaid security_id — survives resolver failure
  description        String?   // raw institution `name` — verbatim
  mapperVersion      Int?      // stage-1 adapter version (classifierVersion pattern)

  // Corporate-action shape (nullable; Plaid supplies neither — imports/manual do)
  relatedInstrumentId String?
  ratio               Float?

  // Import / assertion provenance
  importBatchId   String?
  importBatch     ImportBatch? @relation(fields: [importBatchId], references: [id], onDelete: SetNull)
  createdByUserId String?

  // Correction / supersession — append-only doctrine
  supersededById String?
  deletedAt      DateTime?    // import rollback soft-delete (Transaction.deletedAt pattern)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([source, externalEventId])   // provider dedupe; nulls exempt (manual rows)
  @@index([financialAccountId, date])
  @@index([financialAccountId, instrumentId, date])
  @@index([instrumentId, date])
  @@index([importBatchId])
}
```

**[REVISION] vs. plan doc §5.4 — three changes, each grounded:**

1. **`amount` is FM-signed at write, not provider-signed.** The plan doc kept Plaid's sign (+debit) and deferred FM-signing to read adapters. Rejected on three repo grounds: (a) `syncTransactions.ts` flips Plaid's sign at write and the `Transaction` schema comment defines the platform convention — one convention platform-wide; (b) CSV/manual/Coinbase rows arrive in arbitrary conventions — write-time canonicalization in each stage-1 adapter is the only point where they converge, otherwise every reader needs per-source sign logic forever; (c) nothing is lost — the flip is deterministic and the raw `providerType`/`providerSubtype`/`description` identify the original convention. Mapping: FM `amount = −(plaid amount)`. `quantity` needs no flip (Plaid's +buy/−sell already matches "+units in").
2. **`providerSecurityId` added.** If `resolveInstrumentForPlaidSecurity` refuses (identity conflict) or the security record is missing from the payload, the event must still be written — dropping evidence because identity resolution failed would violate the honesty doctrine. `instrumentId` stays null, the raw id survives, and a later repair pass can re-resolve. (A1's capture skips holdings with unresolvable securities — acceptable for *repeating* daily observations, unacceptable for *unrepeatable* historical events.)
3. **`mapperVersion` added** (the `classifierVersion` / `transferEvidenceVersion` pattern): lets a corrected mapper find and re-derive `type` for rows written by older versions without a Plaid re-fetch — re-derivation of the *canonical* field from preserved raw fields is legitimate (it is a projection), unlike mutating raw fields.

Also added: `@@index([financialAccountId, instrumentId, date])` — A4's core walk query.

**Field semantics:** null = never provided (MC1). `fees` normalized non-negative. `quantity` null (not 0) on pure-cash rows. Cash-only rows (`instrumentId` null) must carry `currency` — it routes A4's cash-instrument walk.

---

## 5. Provider mapping — Plaid stage-1 adapter

Module: `lib/investments/plaid-investment-events.ts`. Pure, deterministic, total (every one of the 6×48 type/subtype combinations yields a canonical type — `UNKNOWN` is a valid output, silence is not). Provider strings are stored raw and never leak into canonical semantics. Never invent capabilities: `STAKING_REWARD`, `CASH_SWEEP`, settlement states, and split ratios are absent because Plaid does not report them.

| Plaid `type` / `subtype` | Canonical `type` | Notes |
|---|---|---|
| `buy` / `buy`, `buy to cover`, `contribution` (with `security_id`), `trade` (qty > 0) | `BUY` | |
| `buy` / `dividend reinvestment`, `interest reinvestment`, `long-term capital gain reinvestment`, `short-term capital gain reinvestment` | `REINVESTMENT` | Carries both cash and quantity legs |
| `sell` / `sell`, `sell short`, `trade` (qty < 0) | `SELL` | |
| `sell` / `exercise`, `assignment` | `SELL` | Option disposition; raw subtype preserved |
| `cash` / `contribution`, `deposit` | `CONTRIBUTION` | External funding in |
| `cash` / `withdrawal`, `request` | `WITHDRAWAL` | External funding out |
| `cash` / `distribution` | `WITHDRAWAL` | Cash out of the account; raw subtype distinguishes |
| `cash` / `dividend`, `qualified dividend`, `non-qualified dividend` | `DIVIDEND` | |
| `cash` / `interest`, `interest receivable` | `INTEREST` | |
| `cash` / `long-term capital gain`, `short-term capital gain`, `unqualified gain` | `CAPITAL_GAIN` | |
| `cash` / `tax`, `tax withheld`, `non-resident tax` | `TAX` | |
| `cash` / `pending credit`, `pending debit` | `ADJUSTMENT` | Provisional; no pending flag exists — do not fabricate one |
| `fee` / `account fee`, `management fee`, `fund fee`, `legal fee`, `transfer fee`, `trust fee`, `miscellaneous fee`, `margin expense` | `FEE` | |
| `transfer` / `transfer`, `send`, `stock distribution` | `TRANSFER_IN` if qty > 0, `TRANSFER_OUT` if qty < 0; cash-only (no security) signed by FM amount | In-kind or cash movement |
| `transfer` / `split` | `SPLIT` | `ratio` null — Plaid does not supply it |
| `transfer` / `merger` | `MERGER` | |
| `transfer` / `spin off` | `SPIN_OFF` | |
| `cancel` / * | `CANCEL` | Negates a prior row; matching is A4's job, `cancel_transaction_id` deprecated — ignore |
| `adjustment`, `rebalance`, `loan payment`, `return of principal`, `expire`, and any subtype under an unexpected type | `ADJUSTMENT` or `OTHER` | Raw preserved; `expire` → `ADJUSTMENT` (position removal without cash) |
| Anything unrecognized (future Plaid additions) | `UNKNOWN` | Raw fields intact — the honest write |

Sign normalization in the adapter: `amount_fm = −amount_plaid`; `quantity` passed through; `fees` → `Math.abs(fees)`; `currency = iso_currency_code ?? unofficial_currency_code`.

**Future providers:** brokerage CSV → per-profile stage-1 mapper into the same canonical row, `source: "csv:<profile>"`, `externalEventId` = file row id when present else null (fingerprint dedupe per plan doc §8.3), `importBatchId` set. Manual → `OPENING_BALANCE`/`ADJUSTMENT`, `source: "user"`, `createdByUserId` set. Coinbase/wallet adapters may extend the enum (e.g. `STAKING_REWARD`) **only when that provider is wired** — enum growth is provider-evidence-driven.

---

## 6. Event ontology — why this taxonomy and not the minimal one

The brief's candidate minimum (BUY, SELL, DIVIDEND, INTEREST, TRANSFER_IN/OUT, CONTRIBUTION, WITHDRAWAL, REINVESTMENT, FEE, CORPORATE_ACTION, UNKNOWN) is close but wrong in four places, each decided by what providers actually report and what A4 needs:

- **`CORPORATE_ACTION` collapsed is rejected; `SPLIT`/`MERGER`/`SPIN_OFF` are distinct.** Plaid reports them as distinct subtypes (no invention), and A4 treats them differently: `SPLIT` needs a ratio to walk through (else stop), `MERGER`/`SPIN_OFF` stop the affected instrument's walk unconditionally. A single `CORPORATE_ACTION` would force A4 to re-read raw provider strings — exactly the leak the adapter exists to prevent.
- **`CAPITAL_GAIN` and `TAX` added.** Direct Plaid subtypes (7 of the 48). Folding them into DIVIDEND/FEE would misstate income character for future tax-aware reads.
- **`CANCEL`, `ADJUSTMENT`, `OTHER` added.** `cancel` is a Plaid *type*; A4 must see it to negate. `ADJUSTMENT`/`OTHER` are the deterministic homes for real subtypes (`rebalance`, `adjustment`, `loan payment`, …) that have position/cash effects but no cleaner semantics — better than overloading `UNKNOWN`, which is reserved for "mapper did not recognize the input."
- **`OPENING_BALANCE` and `SYMBOL_CHANGE` added (non-provider).** `OPENING_BALANCE` is the manual/imported anchor that closes A4's unexplained residual. `SYMBOL_CHANGE` links instrument merges from import/corporate-action data (never Plaid).

Total: 21 values, every one traceable to a verified provider subtype, an import/manual source, or an A4 requirement. Nothing speculative.

---

## 7. Relationship design

| Related object | Relationship | Mechanism |
|---|---|---|
| **Instrument** | Persisted FK, nullable, `onDelete: Restrict` | Resolver on securities payload; `providerSecurityId` raw fallback; `relatedInstrumentId` for corporate-action counterpart |
| **PositionObservation** | **No FK either direction** | A4's derived observations cite events via `evidenceRefs Json` (already in schema, null since A1). Events explain observations; they never mutate them |
| **Holding** | **None** | `Holding` stays the current-state read model (A2's concern). Events never write it. Any future "explain this holding" UI joins at read time via instrument |
| **RelationshipResolver** | Read-time only (TI4 doctrine) | Future slices: CANCEL↔target (A4, deterministic equal-and-opposite match), brokerage CONTRIBUTION ↔ banking TRANSFER leg (future resolver extension, same refuse-ambiguity rules). Nothing persisted |
| **Cash Flow** | **None in A3; none planned as a source** | Cash flow reads `Transaction` only (`cash-flow.ts:262` ignores INVESTMENT). Brokerage-internal events are not household cash flow; the funding leg already appears as a banking Transaction. Double-count risk is structurally avoided by never feeding events into cash flow |
| **Liquidity** | **None** | Liquidity resolves investment-venue movement from transfer *evidence on banking rows* (CF-2). Unchanged |
| **Wealth** | None in A3 | Future: contribution-vs-growth decomposition (Time Machine plan §131) reads CONTRIBUTION/WITHDRAWAL/DIVIDEND/FEE to separate external flows from market movement |
| **Future Timeline** | L1 canonical fact | Consumed later through L2 lenses with the `asOf` + completeness envelope; display `TimelineEvent`s synthesized at read (widget "never cares where an event came from") |
| **Simulation** | Indirect | Simulation consumes reconstructed positions (A4 output) + price series (D-series), not raw events |
| **Conversation** | Future assembler | `lib/ai/assemblers/investment-events.ts` mirroring `transactions.ts` (visibility gating via `financialAccountId`, same KD-15 posture). Not A3 |
| **ImportBatch** | Persisted FK, nullable, SetNull | Rollback soft-deletes batch events (`deletedAt`), identical to banking |
| **FinancialAccount** | Persisted FK, required, Cascade | The visibility/tenancy anchor — same as PositionObservation |

---

## 8. Position-reconstruction (A4) prerequisites — what A3 must preserve

A4's backward walk (`walkQty(d⁻) = walkQty(d) − Σ signedQuantity(events on d)`, anchored at OBSERVED rows) is deterministic **iff** A3 guarantees:

1. **Signed `quantity` in a single convention** (+in/−out) across all sources — the adapter's job, verified by fixture tests.
2. **Stable total ordering:** sort key `(date, source, externalEventId, id)`. Plaid's `date` is date-only; `datetime` is sparse — never required for correctness.
3. **Instrument linkage or raw fallback:** `instrumentId`, else `providerSecurityId` so repair can attach later. Events with neither resolved identity nor raw id would silently corrupt walks — the adapter must always write `providerSecurityId` when Plaid supplies `security_id`.
4. **Cash routing:** cash-only events carry `currency`, so A4 walks them against the per-currency cash instrument (the `internal` provider alias A1's brokerage-cash module already mints).
5. **CANCEL preserved as its own row** with full quantity/amount — A4 matches equal-and-opposite deterministically; unmatched cancels flag CONFLICTED, never guessed.
6. **Corporate-action stops:** `SPLIT` without `ratio` / `MERGER` / `SPIN_OFF` must be visible as typed rows so A4 stops at that date with `UNSUPPORTED_CORPORATE_ACTION` rather than walking through garbage.
7. **UNKNOWN rows keep their quantity:** A4 treats an UNKNOWN row with nonzero quantity as a stop/degrade condition for that instrument — possible only because the row was written, not dropped.
8. **Append-only corrections:** `supersededById` chains + `deletedAt`, so A4's bounded repair ("rerun from min(affected dates) to next OBSERVED anchor") has a stable event log to re-read. Restated Plaid rows append + supersede — never in-place canonical mutation.
9. **`mapperVersion`** so a mapper fix can re-project `type` without re-fetch, and A4 can require a minimum mapper version.
10. **Boundary honesty:** the earliest fetched date (24-month cap) is *coverage*, not completeness. A4 computes `openingQuantity` at window start and persists any nonzero value as `unexplainedOpeningQuantity` — never forced to 0. A3 needs no extra column; the per-item fetch window is recoverable from the events themselves plus `JobRun` records.
11. **Fees/amount fidelity** for later cost-basis work: `amount` is the all-in cash effect; `fees` stored separately when Plaid itemizes.

---

## 9. Migration plan

One additive migration; nothing existing is altered.

**Migration `add_investment_event`:**
1. Create enum `InvestmentEventType` (21 values) — a **new** enum type, not `ALTER TYPE ADD VALUE`, so the slice is reversible (TI2 precedent).
2. Create table `InvestmentEvent` per §4 with the four indexes + unique.
3. Add back-relations: `FinancialAccount.investmentEvents`, `Instrument.investmentEvents`, `ImportBatch.investmentEvents` (relation lists only — no column changes on those tables).

**No backfill.** No data exists to backfill; history arrives via the first gated ingestion run (24-month pull happens naturally by requesting `start_date = today − 24 months`).

**Rollout gates:**
- New env flag `INVESTMENT_EVENTS_ENABLED` (default absent/false) — independent of `INVESTMENT_OBSERVATIONS_ENABLED` so observation capture and event ingestion can be operated separately.
- Writers are best-effort/non-fatal at call sites (the A1 `try/catch` contract) — an events failure never aborts a holdings refresh.
- Rollback = drop table + enum; nothing reads it, so rollback is consequence-free.
- **A2 coordination:** the wiring slice (A3-3) touches `refresh.ts`/`exchangeToken.ts`, which A2 is editing. Land A3-1/A3-2 (schema + pure mapper — zero file overlap) immediately; hold A3-3 until A2 merges, then rebase.

---

## 10. Claude Code implementation slices

| Slice | Content | Files | Exit criteria |
|---|---|---|---|
| **A3-1** | Schema: enum + `InvestmentEvent` + relations; migration | `prisma/schema.prisma`, one migration | `prisma migrate dev` clean; `prisma generate` clean; no existing table altered; existing tests green |
| **A3-2** | Pure Plaid mapper `lib/investments/plaid-investment-events.ts`: total type/subtype→canonical function, sign normalization, `mapPlaidInvestmentTransactionToEvent()`; fixture tests over all 48 subtypes + unknown-input case | new lib + test | Mapper total & deterministic; every fixture asserts raw preservation; `MAPPER_VERSION = 1` exported |
| **A3-3** | Ingest `lib/investments/investment-event-ingest.ts`: paginated `investmentsTransactionsGet` (count 500, offset loop, 24-month window), account mapping via `plaidAccountId` (skip-and-warn), securities → `resolveInstrumentForPlaidSecurity` (conflict ⇒ event kept with `providerSecurityId`, `instrumentId` null), upsert by `[source, externalEventId]`, restated-row supersession, consent/`PRODUCT_NOT_READY`/retry handling, `SyncIssue` on failures; wire into `refresh.ts` + `exchangeToken.ts` behind `INVESTMENT_EVENTS_ENABLED` (best-effort block, A1 pattern) | new lib + test, 2 wiring sites | Re-run ⇒ zero duplicates; restatement ⇒ append+supersede; disabled flag ⇒ zero writes; holdings refresh unaffected by ingest failure |
| **A3-4** (optional, small) | Daily-job wiring: extend `jobs/sync-banks.ts`-registered flow (or its investments sibling) to call ingest on the scheduled path | jobs registry | Scheduled run ingests without manual refresh |

Deliberately **out of A3:** webhooks (separate provider-plumbing workstream), CSV investment import (needs `InvestmentCsvColumnMap` — own slice), manual `OPENING_BALANCE` UI, any reader (A4/Time Machine/AI), any `Holding` change (A2), reconstruction.

---

## 11. Exact copy-paste Claude Code prompt for A3

```
Fourth Meridian — implement Slice A3-1 + A3-2 (Investment Event Foundation: schema + pure Plaid mapper).

Read first:
- FOURTH_MERIDIAN_A3_INVESTMENT_EVENT_FOUNDATION_INVESTIGATION_2026-07-11.md (the ratified design — follow §4 schema, §5 mapping, §10 slices exactly)
- prisma/schema.prisma: Transaction, Instrument, InstrumentAlias, PositionObservation, ImportBatch models
- lib/investments/instrument-resolver.ts and lib/investments/position-capture.ts (A1 patterns: pure core + thin DB binding, MC1 null doctrine, kill-switch gating)
- lib/transactions/plaid-transfer-evidence.ts (stage-1 adapter pattern)

Task 1 — Schema (A3-1):
- Add enum InvestmentEventType and model InvestmentEvent to prisma/schema.prisma exactly as specified in the investigation §4 (21 enum values; FM-signed amount; providerSecurityId; mapperVersion; @@unique([source, externalEventId]); the four indexes; relations to FinancialAccount (Cascade), Instrument (Restrict, nullable), ImportBatch (SetNull, nullable)).
- Add the corresponding back-relation lists on FinancialAccount, Instrument, ImportBatch. Do not alter any other column, index, or model.
- Create one additive migration (new enum type, not ALTER TYPE ADD VALUE). Run prisma generate.

Task 2 — Pure Plaid mapper (A3-2):
- Create lib/investments/plaid-investment-events.ts: a PURE, deterministic, total stage-1 adapter (no DB, no I/O, no Date.now). Export MAPPER_VERSION = 1.
- mapPlaidInvestmentTransactionToEvent(txn: InvestmentTransaction): canonical event fields per investigation §5:
  - type/subtype → InvestmentEventType exactly per the §5 table (all 48 SDK subtypes covered; 'trade' signed by quantity; unrecognized input → UNKNOWN — never throw, never drop).
  - Sign normalization: amount_fm = −txn.amount; quantity passed through; fees = Math.abs when non-null; currency = iso_currency_code ?? unofficial_currency_code.
  - Raw preservation: providerType, providerSubtype, providerSecurityId (raw security_id), description (raw name), externalEventId (investment_transaction_id), mapperVersion — verbatim, on every output including UNKNOWN.
  - date via the parsePlaidDate pattern; datetime nullable.
- Tests (mirror position-capture.test.ts style): every InvestmentTransactionSubtype value from the plaid SDK enum maps to a non-silent canonical type; sign-flip asserted; raw preservation asserted; unknown/future subtype → UNKNOWN with raw intact; determinism (same input twice → identical output).

Constraints:
- Additive only. Do NOT touch lib/plaid/refresh.ts, lib/plaid/exchangeToken.ts, the Holding writer, or anything A2 is changing — ingestion wiring is Slice A3-3, a separate task.
- No reader, no UI, no webhook, no CSV import, no reconstruction.
- MC1 doctrine: null = never provided; never fabricate a field Plaid didn't send (no ratio, no settlement state, no pending flag).
- Commit boundaries: one commit for migration + schema, one for mapper + tests.
- Stop conditions: prisma migrate + generate clean; full existing test suite green; new mapper tests green; zero rows written anywhere by this slice.
```

---

*Investigation complete. No code was written, no files modified, no migrations created.*
