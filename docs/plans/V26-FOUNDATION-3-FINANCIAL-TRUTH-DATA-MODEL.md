# V26-FOUNDATION-3 — Financial Truth Data Model

**Status:** Investigation. No code, no schema change, no migration produced by this pass.
**Audited against:** `v2.6` @ `146a0dd` (2026-07-28). 55 models, 3,165 schema lines. Every claim below verified from source.
**Reads with:** `V26-FOUNDATION-1` (frame) · `V26-FOUNDATION-2` (personal layer) · both FABLE 2.6 theses.

**Notation:** **[EXISTS]** verified in repo · **[ABSENT]** verified missing · **[PROPOSED]** this document's recommendation · **[INFERRED]** reasoned, not directly verified.

---

## 1 · Executive recommendation

**The current data model can support thorough financial truth for the *present tense*. It cannot support it for the *past tense*. That single asymmetry is the whole finding.**

The schema is far stronger than a greenfield assessment would suggest. It already contains, correctly built:

- an **observation-shaped history** for investments — `PositionObservation`, `PriceObservation`, `InvestmentEvent`, `PositionReconstruction` **[EXISTS]**
- a **provider identity layer** — `ProviderAccountIdentity` **[EXISTS]**
- a **security identity layer** with aliases — `Instrument`, `InstrumentAlias` **[EXISTS]**
- an **effective-dated correction overlay with consent** — `SnapshotAmendment` / `SnapshotAmendmentDay` **[EXISTS]**
- **historical FX by date** — `FxRate(date, base, quote)` **[EXISTS]**
- **versioned, confidence-bearing classification** on transactions — `classifierVersion`, `classificationConfidence`, `tiFactsVersion`, seven transfer-evidence axes **[EXISTS]**

Against that, one structural hole dominates everything else:

> **`FinancialAccount.balance` is a mutable `Float` overwritten on every sync, with no history table.** **[EXISTS — as a defect]**
> There is no `BalanceObservation` model. **[ABSENT]**

So the platform can tell you what an investment position was worth on 3 March, and **cannot tell you what your checking account held on 3 March**. The only historical financial record is `SpaceSnapshot` — a *derived daily aggregate* with no per-account detail, no provenance, and a single boolean `isEstimated` for confidence.

**Consequence for the governing architecture:** a Financial Context Frame sealed today and inspected in six months will carry evidence pointers into account balances that no longer hold their then-values. Frame reproducibility — architectural law #4 — is **not achievable** until account value has history. This is the gate.

### The recommendation

1. **Close the balance-history gap first.** It is the prerequisite for reproducible frames, historical assessments, decision history, and every longitudinal feature in the FABLE roadmap.
2. **Do not hash first.** Content-addressing a truth set whose inputs are mutable produces hashes that silently change meaning — the same hash input yielding a different real-world claim. Hashing must follow observation, never precede it. This reverses Candidate C.
3. **Adopt overlay-not-mutation for corrections**, generalising `SnapshotAmendment`, which already proves the pattern in production.
4. **Do not build all missing domains.** Real estate, vehicles, businesses, statements, obligations and splits are real gaps but not v2.6 gaps.

---

## 2 · Verified current financial-domain inventory

### 2.1 Core truth models

| Model | Real-world entity | Identity | Scope | Time semantics | Mutability | History |
|---|---|---|---|---|---|---|
| `FinancialAccount` **[EXISTS]** | an account at an institution | internal cuid; `plaidAccountId @unique`; `mask` | `ownerType` User\|Space | `lastUpdated`, `balanceLastUpdatedAt` | **mutable balance** | **none** |
| `Transaction` **[EXISTS]** | one ledger movement | cuid; `plaidTransactionId @unique`; `externalTransactionId` | via account | `date @db.Date`, `authorizedAt @db.Date` | **mutable category** | **none** |
| `PositionObservation` **[EXISTS]** | holding qty at a date | `(account, instrument, date, origin)` | via account | `date`, `institutionPriceAsOf` | append | **yes** |
| `PriceObservation` **[EXISTS]** | instrument price at a date | `(instrument, date, basis)` | global | `date`, `fetchedAt` | append | **yes** |
| `FxRate` **[EXISTS]** | rate at a date | `@@unique([date, base, quote])` | global | `date`, `fetchedAt` | append | **yes** |
| `SpaceSnapshot` **[EXISTS]** | derived daily aggregate | `@@unique([spaceId, date])` | Space | `date` | replace-on-regen | **yes (aggregate only)** |
| `DebtProfile` **[EXISTS]** | user-stated debt terms | `financialAccountId @unique` | via account | `promoAprEndDate` only | **mutable** | **none** |
| `Instrument` / `InstrumentAlias` **[EXISTS]** | a security | `cusip`/`isin` unique + aliases | global | — | mutable meta | none |
| `ProviderAccountIdentity` **[EXISTS]** | provider's handle on an account | `@@unique([provider, externalAccountId, financialAccountId])` | via account | `createdAt` | append | partial |
| `Merchant`/`MerchantAlias`/`MerchantRule` **[EXISTS]** | payee identity + user rules | alias table | global + user rules | — | mutable | via `MerchantMergeDecision` |
| `SnapshotAmendment` **[EXISTS]** | consented correction to history | id | Space + account | `fromDate`/`toDate`, `consentedAt`, `appliedAt` | append | **yes** |

### 2.2 What each core model can and cannot express

**`FinancialAccount`** — expresses: current balance, available balance, credit limit, native balance, currency, institution, mask, type (6-value enum), soft delete, owner, sync status, per-account APR/minimum (legacy columns). **Cannot express:** any past balance; statement balance; due date (in `DebtProfile`); principal vs interest split; joint/proportional ownership; whether it was excluded from planning; historical rename; closure date distinct from soft delete.

**`Transaction`** — expresses: date (day), amount (native), currency, raw descriptor + enriched merchant + resolved `merchantId`, category with `categorySource` and rule linkage, pending flag with `pendingTransactionRef`, `settlementState`, `authorizedAt`, flow classification with version and confidence, counterparty account, seven transfer-evidence axes, import batch, tombstone. **Cannot express:** time of day; posted-vs-authorized as distinct timestamps with time; refund→original linkage; reversal; chargeback; partial refund; splits; reimbursement linkage; category *history*; recurring-series membership; installment membership; business-vs-personal; tax relevance; the FX rate actually applied; the converted amount.

**`SpaceSnapshot`** — expresses: daily net worth and six category totals, reporting currency, a single `isEstimated` flag, amendment linkage. **Cannot express:** which accounts contributed; which prices or FX rates were used; what the compiler version was; per-figure confidence; what was unknown that day.

### 2.3 Absent models — verified by grep

`BalanceObservation` · `Statement` · `RecurringSeries` · `Obligation` · `OwnershipInterest` · `SourceRecord` · `RecordCorrection` · `CategoryAssignment` · `TransactionSplit` · `Valuation` · `IncomeEvent` · `Transfer` · `RealEstate` · `Vehicle` · `ManualAsset` — **all [ABSENT]**.

`AccountType` is a **6-value enum**: `checking | savings | investment | crypto | debt | other`. Real estate, vehicles, businesses and collectibles all collapse into `other`, with no valuation history, no liquidity class, and no encumbrance. **[EXISTS — as a limitation]**

---

## 3 · Current truth authority map

```
PROVIDER / USER INPUT
   Plaid · BTC chain · CSV import · manual entry · user forms
        │
   INGESTION  (mutating writes — no source record retained)
   syncTransactions · refreshBalances · btc-sync · imports/csv
        │
   CANONICAL STATE                          CANONICAL HISTORY
   FinancialAccount.balance   ← mutable     PositionObservation   ← append
   Transaction.category       ← mutable     PriceObservation      ← append
   DebtProfile.apr            ← mutable     FxRate                ← append
   Instrument meta            ← mutable     SpaceSnapshot         ← daily aggregate
        │                                   InvestmentEvent       ← append
   DERIVED READS
   queryTransactions · DayFacts · classifyAccounts
   resolveEffectiveDebtTerms · valuation · FX conversion
        │
   ASSESSMENT (pure)  →  FRAME (proposed, F-1)  →  EXPERIENCE
```

**The asymmetry is visible in the diagram**: the right column (investments, prices, FX) is append-only and reproducible; the left column (cash, credit, debt terms, categories) is mutable and unreproducible.

---

## 4 · Missing financial truths

### 4.1 Transaction truth

| Capability | Status |
|---|---|
| authorization vs posting date | **partial** — `authorizedAt` exists but both are `@db.Date`; no time; `date` is unnamed as posted |
| pending → posted identity | **[EXISTS]** — `pendingTransactionRef` + `settlementState` |
| reversal / chargeback | **[ABSENT]** — no linkage field |
| refund → original linkage | **[ABSENT]** — refunds are unlinked positive rows |
| partial refund | **[ABSENT]** |
| correction history | **[ABSENT]** — category overwritten in place |
| merchant normalization | **[EXISTS]** — `Merchant` + `MerchantAlias` + `MerchantMergeDecision` |
| user category override | **[EXISTS]** — `categorySource`, `categoryRuleId` (who, not what-before) |
| splits | **[ABSENT]** |
| reimbursement | **[ABSENT]** |
| business vs personal / tax relevance | **[ABSENT]** |
| fees / interest as first-class | **partial** — category values only |
| transfer without double-count | **[EXISTS]** — `FlowType.TRANSFER`, `counterpartyAccountId`, seven evidence axes |
| internal vs external transfer | **[EXISTS]** — `CounterpartyType`, `transferVenueClass` |
| recurring-series membership | **[ABSENT]** |
| installments / subscriptions | **[ABSENT]** |
| multi-provider evidence for one movement | **[ABSENT]** — the cross-provider folding problem |

### 4.2 Account truth

Present: current balance, available, credit limit, currency, native balance, minimum payment, APR, `debtSubtype`, soft delete, sync status, `dueDay`/`statementCloseDay` (on `DebtProfile`).
**Absent:** statement balance; principal vs accrued interest; fixed-vs-variable rate; maturity; collateral; delinquency; payoff quote; joint/proportional ownership; explicit "excluded from planning"; closed-vs-deleted distinction; **any balance history**.

### 4.3 Asset / investment truth

Strongest domain. Present: quantity, cost basis (aggregate), institution price + value + as-of, vested quantity, currency, `isCash`, origin, source, completeness, `unexplainedQuantity`, `evidenceRefs Json`, reconstruction version, full instrument identity with aliases, price observations by basis.
**Absent:** tax lots (only aggregate `costBasis`); realized vs unrealized split as stored fact; dividend/income events as distinct from `InvestmentEvent` generally **[INFERRED — not fully audited]**; liquidity class; encumbrance; lockup/vesting *schedule* (only `vestedQuantity`); manual valuation history for non-instrument assets.

### 4.4 Debt truth

Present: APR (two sources, resolved by `resolveEffectiveDebtTerms`), minimum payment, `dueDay`, `statementCloseDay`, `promoAprEndDate`, `debtSubtype`, balance semantics (owed vs credit, `lib/debt/balance-semantics.ts`).
**Absent:** variable-rate indicator and index; amortization schedule; secured vs unsecured; collateral; maturity; prepayment penalty; delinquency state; payoff quote; **APR history** (mutable column).

### 4.5 Income / expense truth

Present: `FlowType` (SPENDING, INCOME, REFUND, DEBT_PAYMENT, TRANSFER, INVESTMENT), flow direction, classification confidence and version, descriptor-evidence rescues for payroll and card payments.
**Absent:** gross vs net; salary vs bonus vs irregular; loans received; essential vs discretionary; future obligations; user-confirmed income adjustments; recurring-series identity.

### 4.6 Currency and geography truth

Present: native `currency` per transaction and account; `Space.reportingCurrency`; `FxRate` by date with source; `isEstimated` on snapshots; `fxApplied` flag.
**Absent:** the **converted amount actually used**; the **specific `FxRate` row applied**; conversion confidence per figure; historical conversion *policy* version; any residence/geography field (see V26-F2 §2.3).

### 4.7 Ownership and household truth

Present: `ownerType` (User\|Space), `SpaceAccountLink` with visibility levels, `SpaceMember` roles, `AccountConnection.connectedByUserId`.
**Absent:** legal vs beneficial owner; joint ownership; proportional interest; jointly-owed debt apportionment. Ownership is binary and singular.

---

## 5 · Time-semantics audit

| Clock | Present today | Gap |
|---|---|---|
| `occurredAt` | `Transaction.date` **@db.Date** | **no time of day** — cannot order intra-day or match cross-provider transfers by timestamp |
| `authorizedAt` | **[EXISTS]** @db.Date | day precision only |
| `postedAt` | **[ABSENT]** — `date` implicitly serves | ambiguous by name |
| `effectiveAt` | only `SnapshotAmendment.fromDate/toDate`, `promoAprEndDate` | absent on APR, category, account metadata |
| `valuedAt` | `PositionObservation.institutionPriceAsOf`, `PriceObservation.date` | **absent for cash balances** |
| `observedAt` | `PriceObservation.fetchedAt`, `FxRate.fetchedAt`, `balanceLastUpdatedAt` | balance has the stamp but not the value |
| `recordedAt` | `createdAt` on most models | adequate |
| `updatedAt` | present | **destroys the prior value** |
| `supersededAt` | **[ABSENT]** everywhere | no supersession chain |
| `deletedAt` | **[EXISTS]** on Transaction, FinancialAccount, AccountConnection | good |

**Can the model answer the six questions?**

| Question | Answer |
|---|---|
| What was true on a given day? | **Partially** — investments yes; cash/credit **no** |
| What did Fourth Meridian *know* that day? | **No** — no knowledge-time record; `SpaceSnapshot` has no provenance |
| What was later corrected? | **Only for snapshots** (`SnapshotAmendment`) and merchants (`MerchantMergeDecision`) |
| What value did the assessment use? | **No** — assessments are not persisted at all |
| Which provider data arrived late? | **Partially** — `RefreshExecution`/`ProviderCall` ledgers exist, but are not linked to the values they produced |
| Truth changed vs policy changed? | **No** — neither the value used nor the policy version is recorded |

**Four clocks at the truth layer.** F-1's doctrine maps down cleanly:
- **source freshness** → `balanceLastUpdatedAt`, `PriceObservation.fetchedAt`, `FxRate.fetchedAt` — *partially present*
- **valuation freshness** → `institutionPriceAsOf`, `PriceObservation.date` — *present for investments only*
- **compilation freshness** → frame `compiledAt` — *proposed in F-1*
- **confidence/materiality** → `classificationConfidence`, `completeness`, `isEstimated` — *present but unsystematic; three different vocabularies*

---

## 6 · Identity and deduplication audit

| Object | Current identity | Robustness |
|---|---|---|
| `FinancialAccount` | cuid + `plaidAccountId @unique` + `ProviderAccountIdentity` + mask/institution fingerprint | **Good.** Survives reconnect via identity table; `DuplicateAccountCandidate` + `mergeArchivedDuplicateIntoCanonical` handle merges |
| `Transaction` | `plaidTransactionId @unique`; `externalTransactionId` + B4 partial unique index (active rows); fingerprint fallback on `(account, date, amount, pending, raw descriptor)` | **Good for Plaid and BTC.** ⚠️ B4's index covers **zero Plaid rows** (all have null `externalTransactionId`) — Plaid rests on `plaidTransactionId` + fingerprint |
| `Security` | `Instrument` with `cusip`/`isin` unique + `InstrumentAlias` | **Strong** |
| `Holding` | legacy `Holding` + canonical `PositionObservation` | dual model — legacy bridge still open (P2-6) |
| `Liability` | = `FinancialAccount` with `type: debt` | no distinct identity |
| `Merchant` | `Merchant` + `MerchantAlias` + `MerchantMergeDecision` | **Strong** |
| `RecurringSeries` | **[ABSENT]** | — |
| `ProviderConnection` | `Connection` + `PlaidItem` | good |
| `Valuation` | **[ABSENT]** as an entity | — |

**Where identity leans too hard on provider IDs:** `Transaction.plaidTransactionId` is the primary identity for the largest data class, and Plaid does not guarantee its stability across re-pulls — the DF-1→DF-4 incident is exactly this failure, and the mitigation (raw-descriptor fingerprint) is heuristic, not identity. **The canonical recommendation** is a stable internal identity plus a *set* of provider handles (the `ProviderAccountIdentity` pattern, applied to transactions), rather than one provider column carrying identity. **[PROPOSED]**

Merge/split/supersession: merge **[EXISTS]** for accounts and merchants; **split [ABSENT]** everywhere; **supersession [ABSENT]** everywhere.

---

## 7 · Provenance and correction audit

**How much provenance survives normalization?** More than expected, unevenly.

Survives: `Transaction.categorySource`, `categoryRuleId`, `classifierVersion`, `classificationConfidence`, `classificationReason`, all seven transfer-evidence axes, `tiFactsVersion`; `PositionObservation.origin`/`source`/`evidenceRefs`/`completeness`; `PriceObservation.source`/`basis`; `FxRate.source`; `ImportBatch` linkage.

Lost: the **raw provider payload** (never retained); the **prior value** of any mutated field; **which sync run** produced a given value (`RefreshExecution` exists but is not linked to the rows it wrote); the **FX rate applied** to any converted figure.

**On the proposed concepts:**

- `SourceRecord` — **do not adopt as raw-payload retention.** Plaid's terms, PII surface, storage cost and GDPR erasure obligations all argue against storing raw provider responses. **[PROPOSED]** instead: a `ProviderCall`-linked *ingestion receipt* recording endpoint, timestamp, record count and a content hash of the payload — enough to prove what arrived without retaining it. `ProviderCall` **[EXISTS]** and is the natural host.
- `CanonicalRecord` — already exists implicitly; no new concept needed.
- `RecordRevision` — **[PROPOSED]**, but only for fields that carry judgment: category, APR, account exclusion. Not for every column.
- `EvidencePointer` — already contracted in F-1 §4; reuse, do not redefine.
- `TransformationRun` — **[EXISTS]** in substance as `RefreshExecution` / `JobRun` / `ImportBatch`. Recommend *linking* rows to these rather than a new model.
- `UserCorrection` — **[PROPOSED]**, generalising `SnapshotAmendment`.

**Correction philosophy — recommendation: overlay, not mutation.** Provider truth is preserved; a user correction is an effective-dated overlay row; derived reads resolve the two. `SnapshotAmendment` already proves this works in production, with consent capture and audit linkage. Where impractical: high-cardinality low-value fields (account display name) may keep mutating — the overlay is reserved for fields that change a *judgment*.

---

## 8 · Currency and valuation audit

**Present:** native currency on transactions and accounts; `Space.reportingCurrency` (authoritative) seeded copy-once from `User.reportingCurrency`; `FxRate` by `(date, base, quote)` with source; USD as canonical base; `isEstimated` on snapshots; V25-FINAL-1 doctrine — an unavailable conversion is `amount: null`, never a fake zero.

**The six questions:**

1. *Is a historical frame reproducible if rates later change?* **No.** Rates are looked up by date at read time. If an `FxRate` row is refetched or corrected, every historical conversion silently changes.
2. *Does the system store the value used?* **No.** Only native amount + a `fxApplied` boolean.
3. *Can it distinguish truth-changed from valuation-changed?* **No.** Both appear as a different number.
4. *Is confidence represented?* **Partially** — `isEstimated` (snapshot-level, boolean), `completeness` (positions). Nothing per-figure.
5. *Are native and converted both preserved?* **Native yes, converted no.**
6. *Authority order?* **[PROPOSED]** below.

**Proposed valuation authority order** (highest first), not implemented:

```
1. User-confirmed manual valuation, effective-dated       (overlay)
2. Provider-reported value with its own as-of stamp       (institutionValue / balance)
3. Canonical price × quantity at the valuation date       (PriceObservation)
4. Last-known value, explicitly marked stale with its age
5. UNAVAILABLE — null, disclosed, never zero, never imputed
```

FX resolution: exact-date rate → most recent prior rate within a bounded window, marked estimated → unavailable. **The resolved rate and its source must be recorded with any persisted converted figure** — otherwise rule 1 of reproducibility fails.

---

## 9 · Historical and archival audit

| Can it reconstruct… | Answer |
|---|---|
| account state 6 months ago | **No** — balance overwritten; only `SpaceSnapshot` category totals |
| exact net worth shown on a prior date | **Yes** — `SpaceSnapshot` |
| the assessment that existed then | **No** — assessments never persisted |
| data freshness at that time | **No** |
| the recommendation surfaced | **No** — `AiAdvice` has zero production writers |
| evidence supporting it | **No** |
| the decision the user later made | **No** — no decision record exists |

**Records whose absence blocks a decision history:** `BalanceObservation`, a persisted assessment (F-1's frame), a persisted decision/insight with lifecycle, and a link from any output to the inputs it used. Four gaps, of which the first is the true prerequisite — the others can be built on top once account value is reproducible.

---

## 10 · Proposed target domain model

Boundaries first. **[PROPOSED]** throughout; relationship to current models given.

| Concept | Responsibility | Identity | Scope | Time | Relationship to today |
|---|---|---|---|---|---|
| **`FinancialAccount`** | the account as a durable entity | internal + provider handle set | User\|Space | `openedAt`/`closedAt` | **exists** — remove value columns from the identity role |
| **`BalanceObservation`** | account value at a point | `(account, observedAt, source)` | via account | `valuedAt` + `observedAt` | **new** — mirrors `PositionObservation` |
| **`Transaction`** | one ledger movement | internal + handle set | via account | `occurredAt`/`postedAt` w/ time | **exists** — needs time precision + revisions |
| **`CategoryAssignment`** | a categorisation, dated | `(transaction, effectiveFrom)` | via transaction | effective-dated | **new** — replaces mutable column |
| **`TransactionRelation`** | refund/reversal/split/reimbursement links | `(fromTx, toTx, kind)` | via account | — | **new** — one table, several kinds |
| **`RecurringSeries`** | a repeating obligation | internal | via account/Space | `effectiveFrom/To` | **new** |
| **`Statement`** | a billing period's closing truth | `(account, periodEnd)` | via account | `periodStart/End` | **new** |
| **`DebtTerms`** | APR/schedule, dated | `(account, effectiveFrom)` | via account | effective-dated | **exists as mutable `DebtProfile`** — needs history |
| **`Holding` / `Security` / `PriceObservation`** | investment truth | as today | — | as today | **exists, correct** |
| **`Valuation`** | value of a non-instrument asset | `(asset, effectiveFrom, source)` | via account | effective-dated | **new** — for the `other` type |
| **`OwnershipInterest`** | who owns what share | `(account, party)` | User/Space | effective-dated | **new** |
| **`Obligation`** | a known future outflow | internal | Space | `dueAt` | **new** |
| **`RecordCorrection`** | consented user overlay | as `SnapshotAmendment` | varies | effective-dated | **generalise existing** |
| **`IngestionReceipt`** | proof of what arrived | via `ProviderCall` | — | `receivedAt` | **extend `ProviderCall`** |

**Rejected:** a polymorphic `FinancialRecord` table. The repository's existing separation (transactions / positions / prices / rates) is working, guard-tested and query-efficient; collapsing it would destroy index locality and type safety for no gain.

---

## 11 · Content-addressing and hashing design

**Recommendation: adopt artifact-level content addressing with an explicit dependency chain — but only after §18's foundation lands.**

**Why not first.** Hashing computes an identity over content. If the content's *inputs* are mutable and unrecorded, the same hash can denote different real-world claims at different times, and a matching hash becomes a false guarantee. Content-addressing a mutable substrate is worse than no hashing, because it manufactures unearned confidence. **This is the decisive argument against Candidate C as the first slice.**

**Design:**

```
TruthSetHash        = H(canonical serialization of the observation set used)
ValuationSetHash    = H(price + FX rows actually applied, with their ids)
AssumptionSetHash   = H(confirmed ContextAssumption[] — V26-F2)
        ↓  + compilerSchemaVersion + compilerBehaviorVersion
FrameHash
        ↓  + assessmentPolicyVersion
AssessmentHash
        ↓  + decisionPolicyVersion
DecisionHash
        ↓  + attentionPolicyVersion + intent
AttentionPlanHash
        ↓  + experienceProfile + rendererVersion
PresentationHash
```

**Rules.**
- **Canonical serialization** — a versioned, stable field order; explicit numeric formatting; UTC ISO-8601; excluded volatile fields (`compiledAt`, `durationMs`, request ids). The serialization rule itself is versioned, and a hash is meaningless without its `serializationVersion`.
- **Algorithm** — SHA-256, hex. Not for secrecy; for identity.
- **Merkle vs flat** — **flat artifact hashes with explicit parent references**, not a Merkle tree. A tree buys tamper-evidence the threat model does not require, and costs comprehensibility. Each artifact stores its parents' hashes, which gives the same invalidation reasoning.
- **Invalidation** — any parent hash change invalidates children by construction; recompute rather than patch.
- **Collisions** — SHA-256 collision is not a practical concern; a hash is nevertheless never a primary key. Every hash accompanies a real row id.
- **Authorization** — a hash grants no access. Resolution goes through the same Space/visibility checks as the underlying records. **A hash is an identity, never a capability.**

**Privacy constraints, binding.** Do not hash low-entropy personal values as pseudonymous identifiers — a residence country or a birth date is trivially brute-forced from its hash, making the hash a membership oracle. Hashing is never a substitute for encryption or deletion (§17). A content hash must not survive as a route to deleted content.

**Persist vs regenerate.** Persist: `FrameHash`, `AssessmentHash`, `DecisionHash` (small, referenced by outputs, needed for "what did the AI know"). Regenerate: `PresentationHash` (cheap, high-churn, tied to renderer version). `TruthSetHash` and `ValuationSetHash` persist **as fields on the frame**, not as their own tables.

**The worked answer to "how does chat reference the same assessment as the Brief":** both read the frame row whose `AssessmentHash` is X. Neither recomputes; both cite X. If they render different prose, the prose differs and X does not — which is precisely the consistency guarantee F-1 is built to give, now externally checkable.

---

## 12 · Data-quality and confidence contract

**Confidence belongs at all three levels, with different meanings** — collapsing them is the mistake:

- **Source record** — *reliability of this datum* (provider-reported vs reconstructed vs user-stated). `PositionObservation.origin`/`completeness` already does this **[EXISTS]**.
- **Canonical record** — *identity and currency certainty* (is this the right account? is the currency known?).
- **Aggregate/derived** — *conclusion confidence* (input completeness × freshness × estimation). `FinancialAssessment` section confidence already does this **[EXISTS]**.

Dimensions: source reliability · freshness · completeness · identity certainty · currency certainty · valuation certainty · correction state · conflict state.

**Propagation is monotonic downward** — a derived claim can never exceed the confidence of its weakest necessary input. Worked example, exactly as the brief frames it:

```
APR missing on one debt account
  → DebtTerms.confidence = LOW for that account
  → debt-carry-cost confidence LOW
  → payoff comparison marked imprecise (cannot rank by true cost)
  → attention severity CAPPED at NOTABLE (never URGENT)   ← F-1 §7 materiality rule
  → Experience Engine discloses: "I don't know the rate on X, so this ordering is provisional"
```

The cap is the important part: **a low-confidence conclusion may not produce an urgent insight.** That rule already appears in F-1 §7 and should be enforced in one place.

---

## 13 · Financial Assessment input contract

Requires, per Space, as-of a compile time:

| Measure | Truth records required | Available today? |
|---|---|---|
| runway | liquid balances + monthly expense | balances **current only** |
| cash flow | classified transactions over a window | **yes** |
| debt affordability | balances + minimum payments + income | yes (mutable terms) |
| debt carry cost | balances + **APR with confidence** | yes, confidence partial |
| debt spread | APR vs expected return constant | yes |
| balance-sheet strength | all account values | **current only** |
| asset accessibility | liquidity class per asset | **[ABSENT]** — `other` has no class |
| concentration | positions + prices | **yes** |
| obligation load | future obligations | **[ABSENT]** |
| income stability | income events over time | partial (flow classification only) |
| data freshness | per-source as-of stamps | **partial** |

**Two hard blockers for a *historical* assessment: balance history and liquidity class.** Everything else degrades gracefully with confidence.

---

## 14 · Decision Engine input/output contract

**Input:** the sealed frame + confirmed constraints (`MIN_RUNWAY_MONTHS`, debt aversion) + option-generation policy version.

**Output [PROPOSED]:**

```
DecisionOption {
  id, kind: 'DEBT_PAYOFF' | 'SAVE' | 'INVEST' | 'REFINANCE' | 'NO_ACTION',
  economics: { costDelta, interestSaved, runwayAfter, breakEvenMonths },
  constraintsViolated: Constraint[],        // why it is unsuitable
  reversibility: 'REVERSIBLE' | 'COSTLY' | 'IRREVERSIBLE',
  confidence, evidence: EvidencePointer[],
  suppressedReason?: SuppressionReason
}
```

Requires: debt terms with confidence, liquid balances, expense run-rate, obligations. **Post-action simulation requires balance history** to validate the model against what actually happened — another dependency on §18's first package.

---

## 15 · Attention Policy input/output contract

**Input:** frame delta (F-1 §7) + decision options + user proactivity preference + acknowledgement state.

**Output [PROPOSED]:** `AttentionItem { claimId, consequence, urgency, actionability, novelty, confidence, materiality, status: detected|surfaced|acknowledged|dismissed|resolved, suppressedReason? }`.

Requires a **persisted surfacing history** — otherwise novelty and suppression cannot be computed, and the platform re-surfaces yesterday's news. Today nothing is persisted (F-1 §2.4), so this is blocked until frames land.

---

## 16 · Experience Engine preference model

Three categories that must **never** be merged into one "AI personality" setting:

| Category | Examples | May influence | Scope | Precedence |
|---|---|---|---|---|
| **Communication** | direct/supportive/analytical/educational, formal/casual, concise/detailed | tone, verbosity, ordering, examples, modality | User default → Space override → conversation override | conversation wins |
| **Attention** | quiet / balanced / proactive | *frequency and threshold* of unsolicited surfacing | User default → Space override | Space wins |
| **Financial constraint** | min runway, debt aversion, interest-bearing-finance restriction, risk tolerance, horizon | **decision ranking and option filtering** | User (person-level), confirmed only | explicit confirmation required |

**These are not tones.** Communication and Attention live in the Experience layer. **Financial constraints live in the Intelligence layer as confirmed `StatedFact`s** (V26-F2 §5) and are the *only* preference class permitted to change decision output.

**On "aggressive" / "conservative" labels — recommendation: forbid them.** They are ambiguous across all three axes and invite exactly the silent reasoning change the constraints prohibit. If such vocabulary is ever exposed, it must resolve to a named, confirmed financial constraint with a number attached ("minimum runway: 3 months"), never to a personality slider.

**Current models [EXISTS]:** `AiAgent` has `name`, `agentScope[]`, `lastActiveAt` — no preference capability at all. `NotificationPreference` is per-user-per-category and is the closest existing precedent for the Attention axis. `Space.reportingCurrency` demonstrates the User-seed → Space-authority precedence pattern that Communication preferences should copy.

---

## 17 · Privacy, retention, and deletion design

**The tension:** historical reproducibility requires retention; the right to erasure requires deletion. Resolve per artifact class, never globally.

| Artifact | On user deletion | On fact deletion |
|---|---|---|
| Canonical rows (Transaction, Account) | **hard-deleted** by `purgeUser` **[EXISTS]** | — |
| `BalanceObservation` **[PROPOSED]** | cascade with account | — |
| Sealed frames | **redacted, not deleted** — structure and hashes retained, values nulled | pointer retained, value nulled |
| Assessments / decisions | redacted alongside their frame | — |
| Evidence pointers | retained as dangling; reader renders "evidence no longer available" | same |
| Hashes | **retained** — but a hash whose content is redacted must be marked `CONTENT_REDACTED` and must never resolve | same |
| `AuditLog` | `userId` SET NULL — survives anonymised **[EXISTS]** | — |
| Exports | must include personal facts with provenance **[EXISTS]** for DOB precedent | — |

**Three binding rules:**
1. **A content hash must never become a retention loophole.** If content is redacted, the hash is tombstoned with it. Never keep "just the hash" of deleted sensitive data as a way to still recognise it later — that is a membership oracle.
2. **Redaction preserves shape, destroys value.** A six-month-old frame must remain *interpretable as a frame* (so history is not corrupted) while carrying no deleted personal value.
3. **`purgeUser` must cascade every new model** — `BalanceObservation`, frames, assessments, decisions, stated facts. This is the same audit gap flagged in F-1 §10.2 and F-2 §11.2; by v2.6 it has three dependents and should be a single reviewed checklist.

---

## 18 · Current architectural debt

| # | Debt | Classification |
|---|---|---|
| 1 | `FinancialAccount.balance` mutable, no history | **Must fix before frame** |
| 2 | Converted value + FX rate used are never stored | **Must fix before frame** |
| 3 | Assessment not persisted; no output→input linkage | **Must fix during frame adoption** (F-1) |
| 4 | Brief's four inline judgment rules | **Must fix during frame adoption** (F-1 WP-2) |
| 5 | Weighted APR computed in 3 places | Must fix during frame adoption |
| 6 | `Transaction.date` day-precision, no `postedAt` | **Must fix before cross-provider folding**; defer otherwise |
| 7 | Category mutated in place, no history | Must fix during frame adoption |
| 8 | `DebtProfile` mutable, no APR history | Can defer |
| 9 | `AccountType` 6 values; illiquid assets → `other` | Can defer (blocks asset accessibility) |
| 10 | `amount Float` — money as floating point (DEC-0) | Can defer — deliberate, tracked |
| 11 | Legacy `Holding` vs `PositionObservation` duality (P2-6) | Can defer |
| 12 | `ApiUsageCounter` no user/space dimension | Can defer (blocks cost attribution) |
| 13 | Raw provider payloads not retained | **Should not fix** — privacy/terms/cost |
| 14 | Polymorphic record table | **Should not fix** — current separation is correct |

---

## 19 · v2.6 foundation

**Ships:**
1. **`BalanceObservation`** — append-only account value history, modelled on `PositionObservation`. *(schema + ingestion; the one migration worth making)*
2. **Valuation record on persisted figures** — when a converted value is stored, store the rate id and source with it. *(contract + ingestion)*
3. **Truth-layer contract facade** — pure domain types over existing models, so the frame consumes an interface rather than Prisma rows. *(pure contract)*
4. **Frame provenance fields** consuming 1–2 (F-1's `FrameProvenance.inputs[]` becomes real rather than aspirational). *(contract)*
5. **Confidence vocabulary unification** — one scale replacing `isEstimated` / `completeness` / `classificationConfidence` at the *reporting* boundary, without touching their sources. *(pure contract)*

**Explicitly deferred:** hashing (needs 1–2 first), `CategoryAssignment` history, `Statement`, `RecurringSeries`, `Obligation`, `OwnershipInterest`, transaction splits/refund linkage, sub-day timestamps, manual-asset types, decision and attention persistence.

**Challenge to the expected list:** the brief proposes a content-addressed artifact contract in v2.6. **Recommend deferring** — §11 explains why hashing a mutable substrate is actively harmful. Hashes become valuable the moment `BalanceObservation` exists, and misleading before it.

---

## 20 · v2.7+ roadmap

`CategoryAssignment` history and the correction overlay generalised from `SnapshotAmendment` · content-addressed artifacts and the full dependency chain · sub-day transaction timestamps + cross-provider transfer folding · `RecurringSeries` and `Obligation` (unlocks obligation-aware liquidity) · `Statement` · tax lots and realized/unrealized · manual-asset types with `Valuation` and liquidity class · `OwnershipInterest` and household apportionment · decision and attention persistence (the decision history) · `IngestionReceipt` on `ProviderCall`.

---

## 21 · Ordered migration work packages

| # | Package | Objective | Affected | Flag | Validation | Rollback | Changes outputs? |
|---|---|---|---|---|---|---|---|
| **T-1** | Truth contract facade | pure domain types + adapters over current models | new `lib/truth/` | none | type-level; adapter round-trip | delete | **No** |
| **T-2** | `BalanceObservation` shadow write | append an observation on every balance write | schema (additive), `refreshBalances`, `btc-sync`, imports | `BALANCE_OBS_WRITE` | row count vs refresh count; no dupes | stop writing; drop table | **No** |
| **T-3** | Historical balance reader | `balanceAsOf(accountId, date)` | `lib/truth/` | — | reconcile against `SpaceSnapshot` totals | delete | **No** |
| **T-4** | Backfill from snapshots | seed observations where derivable | script | dry-run default | reconciliation report | soft-delete backfilled rows | **No** |
| **T-5** | Valuation provenance | store rate id + source with persisted converted figures | snapshot writer | `FX_PROVENANCE` | replay equality | flag off | **No** |
| **T-6** | Frame consumes truth facade | F-1's frame reads `lib/truth/`, not Prisma | frame compiler | — | frame equality before/after | revert import | **No** |
| **T-7** | Confidence unification | one reporting scale | `lib/truth/` | — | mapping table tests | revert | presentation only |

Every package is **output-neutral by design** — this foundation must not change a single number a user sees.

---

## 22 · Founder decisions

**D1 (inherited, blocking).** Liquidity semantics: coverage-months vs percent-of-net-worth.

**D8 — Balance observation cadence.** Every write, or daily close? Every write is truthful and unbounded; daily close is bounded and lossy. **Recommendation: every write, with a retention policy (D9).** Volume estimate: accounts × refreshes/day.

**D9 — Retention floor.** What is the minimum historical window the product promises? This determines storage cost and what "financial memoir" can honestly claim. **Recommendation: daily for 24 months, monthly thereafter, forever for month-end.**

**D10 — Backfill honesty.** Observations derived from `SpaceSnapshot` are *reconstructions*, not observations. **Recommendation: write them with `origin: RECONSTRUCTED` and never present them as observed** — the `PositionObservation.origin` precedent already does exactly this.

**D11 — Raw payload retention.** Confirm the recommendation to **not** retain provider payloads, and to record ingestion receipts instead.

**D12 — Do "aggressive/conservative" AI labels ever ship?** Recommendation: no. Requires a product decision because it forecloses a common competitor pattern.

**D13 — Does deletion redact or destroy sealed frames?** Recommendation: redact (preserve shape, null values). Legal review advisable.

---

## 23 · Exact first implementation ticket

**Chosen candidate: D — Historical balance observations**, with A's facade folded in as the consuming interface.

*Why not the others:* **A alone** delivers no capability and fixes nothing. **B** is largely pre-solved — F-1 §4 already contracts `EvidencePointer`. **C is actively harmful first** (§11): hashing a mutable substrate manufactures false confidence. **D closes the #1 gap, has a proven in-repo template, is purely additive, and is the prerequisite for A, B and C to mean anything.**

> **V26-F3-1 · `BalanceObservation` — shadow write + historical reader**
>
> Give account value the same historical treatment investments already have. Purely additive; **no existing column or row is modified; no user-visible output changes.**
>
> **1. Schema (one additive migration)**
> - `BalanceObservation`: `id`, `financialAccountId`, `observedAt DateTime`, `valuedAt DateTime`, `balance Float`, `availableBalance Float?`, `creditLimit Float?`, `nativeBalance Float?`, `currency String`, `origin` (`PROVIDER` | `MANUAL` | `IMPORT` | `RECONSTRUCTED`), `source String`, `providerCallId String?`, `createdAt`.
> - `@@index([financialAccountId, valuedAt])`, `@@index([valuedAt])`.
> - **Model it on `PositionObservation`** — same origin/source/append-only shape, deliberately.
> - No column removed. No existing model altered except the back-relation.
>
> **2. Shadow write — behind `BALANCE_OBS_WRITE`, default off**
> - Append an observation wherever `FinancialAccount.balance` is written today: the Plaid balance refresh path, `btc-sync`, and the import path. Enumerate the write sites first and record them in the PR description — **if a write site is missed, history is silently incomplete**, which is worse than no history.
> - `providerCallId` links to `ProviderCall` where one exists, giving each value a traceable arrival.
>
> **3. Reader — `lib/truth/balance.ts`**
> - `balanceAsOf(accountId, date): { value, currency, origin, valuedAt, confidence } | null`
> - Returns `null` rather than a guess when no observation precedes the date. **No imputation, no carry-forward without marking it stale** — the V25-FINAL-1 `amount: null` doctrine applies.
>
> **4. Tests**
> - Every balance write site produces exactly one observation (no duplicates, no misses).
> - `balanceAsOf` returns null before the first observation; returns the latest at-or-before otherwise.
> - Append-only: no code path updates or deletes an observation.
> - Cascade: deleting an account removes its observations; `purgeUser` cascades.
> - Flag off ⇒ zero rows written, zero behaviour change.
>
> **5. Out of scope:** backfill (T-4), hashing, frame integration, any read by a user-facing surface.
>
> **Done when:** suite green, `tsc` clean, lint clean, flag off ⇒ byte-identical behaviour, flag on in preview ⇒ observation count reconciles against refresh executions.

---

## 24 · Verification index

| Claim | Evidence |
|---|---|
| `FinancialAccount.balance` mutable, no history | `prisma/schema.prisma:863-983` — `balance Float @default(0)`, `balanceLastUpdatedAt`; no history model |
| No `BalanceObservation` | grep `^model .*(Balance\|Observation)` → only `PositionObservation`, `PriceObservation` |
| `PositionObservation` is the good pattern | `schema.prisma:1397` — `date`, `origin`, `source`, `completeness`, `evidenceRefs`, `institutionPriceAsOf` |
| `PriceObservation` historical | `schema.prisma:1612` — `date`, `basis`, `source`, `fetchedAt` |
| `FxRate` historical by date | `schema.prisma:2609` — `@@unique([date, base, quote])`, `source`, `fetchedAt` |
| `Transaction` day-precision only | `schema.prisma:1806` — `date @db.Date`, `authorizedAt @db.Date` |
| Transaction has rich classification provenance | `classifierVersion`, `classificationConfidence`, `categorySource`, 7 transfer-evidence axes |
| No refund/split/series linkage | grep — `TransactionSplit`, `RecurringSeries` absent |
| `SpaceSnapshot` aggregate-only, one confidence bit | `schema.prisma:2220` — 6 category totals, `isEstimated Boolean` |
| `SnapshotAmendment` = correction precedent | `schema.prisma:3103` — `fromDate`/`toDate`, `consentedAt`, `appliedAt`, `auditLogId` |
| `ProviderAccountIdentity` identity layer | `schema.prisma:801` — `@@unique([provider, externalAccountId, financialAccountId])` |
| `Instrument`/`InstrumentAlias` security identity | `schema.prisma:1338,1377` — `cusip`/`isin` unique |
| `AccountType` only 6 values | `enum AccountType` — checking, savings, investment, crypto, debt, other |
| 15 target concepts absent | grep per model name — all absent |
| `AiAgent` has no preference capability | `schema.prisma:646` — `name`, `agentScope`, `lastActiveAt` |
| B4 index covers zero Plaid rows | V26-PRE audit — 3,964 Plaid rows, 0 with `externalTransactionId` |
