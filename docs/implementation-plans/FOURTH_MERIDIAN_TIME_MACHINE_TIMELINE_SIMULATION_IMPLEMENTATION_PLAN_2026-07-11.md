# Fourth Meridian — Time Machine, Financial Timeline & Simulation Implementation Plan

**Date:** 2026-07-11
**Branch:** `feature/v2.5-spaces-completion`
**Type:** Architecture & implementation planning. No code written, no files modified, no migrations created.
**Established input:** `FOURTH_MERIDIAN_TIME_MACHINE_CROSS_PERSPECTIVE_INVESTIGATION_2026-07-11.md`
**Governing principle:** *"Did the data earn this?"*

**Target pipeline:** providers/imports → observations → canonical facts → historical state → timeline & change decomposition → forward simulation → persisted knowledge → LLM interpretation. **The LLM stays downstream — it explains deterministic results, it never computes financial truth.**

---

## 1. Executive recommendation

The repository has already built the spine this plan needs, twice. First, the `perspective-engine` is a deterministic, visibility-gated, non-persistent lens layer with an injected clock and a result that already carries `verdict`, `metrics`, `assumptions[].source`, `provenance{dataAsOf, tierCounts}`, and an `estimated` flag. Second, and more importantly, the **AI layer already implements the exact "LLM stays downstream" architecture the target pipeline demands**: `lib/ai/assemblers/*` produce deterministic domain data, `lib/ai/intelligence/annotations.ts#computeAssessment()` runs a *pure, no-LLM* pass that computes "math, classifications, confidence, and explainability," and only then does `lib/ai/provider.ts` (the single swappable OpenAI-boundary file) let the model "phrase, prioritize, and recommend." That is precisely the discipline this plan must preserve and extend.

Because that spine exists, the correct build is **not** a new intelligence platform. It is four thin, sequential capabilities layered on the existing engine, each of which is a *consumer* of the one below:

1. **Time Machine** = the existing lenses + an `asOf` axis + a completeness stamp. *(read-only, zero schema)*
2. **Financial Timeline** = a deterministic `FinancialTimelineDiff` that subtracts two Time-Machine states and attributes the delta to drivers/events, with an explicit `unexplainedDelta`. *(read-only, zero schema)*
3. **Simulation** = a deterministic forward engine that projects the *current* state under explicit, sourced assumptions — architecturally separate from historical truth, seeded and reproducible. *(light schema: `Scenario`, `ForecastRun` cache, `UserAssertion`)*
4. **Conversation** = tool-calling over the deterministic DTOs above, extending the existing assembler/assessment/provider chain. The model receives durable facts + evidence references, never raw transaction dumps, and never writes canonical state.

The single hardest constraint — the one the whole plan is organized around — is that **Investments cannot honestly join any of this until three new persisted facts exist** (`PriceObservation`, `PositionSnapshot`, `InvestmentEvent`), because today holdings are `deleteMany`+`create` on every sync and no historical security price series exists. Everything that does *not* depend on investment history should ship first, read-only, and be proven on real data **before any investment schema is written**. That stopping point (§17) is the most important scheduling decision in this document.

Recommended immediate next slice (§16): the **shared `asOf` + completeness seam proven through a read-only Wealth "as-of" over existing `SpaceSnapshot`** — zero migrations, and it forces the two reusable primitives into existence that every later phase reuses.

---

## 2. Product-layer architecture

Seven layers, strict downstream data flow, each with one responsibility and one interface to the next. Names follow existing repo conventions (`lib/perspective-engine`, `lib/data`, `LensResult`, `ComputeOptions`, `ConversionContext`).

### 2.1 Layer responsibilities

**L1 — Canonical facts** (`what was observed`). The append-only / correction-versioned record of reality: `Transaction` (event log, `@db.Date`), `FinancialAccount.balance` (current), `FxRate` (daily series), `DebtProfile` (user-asserted terms), and — later — `PriceObservation`, `PositionSnapshot`, `InvestmentEvent`. **No derivation lives here.** Corrections are new observations, not edits (except soft-delete/rollback already modeled via `deletedAt`/`ImportBatch.status`).

**L2 — Historical state** (`what was true at date D`). Per-perspective reconstruction from L1: cash/card walk-back (`lib/snapshots/backfill-core.ts` already implements `eod(d)=eod(d+1)−Σamount(d+1)` and the liability twin), plus the persisted `SpaceSnapshot` rollup for Wealth aggregates. Output is perspective-specific state + a completeness tier.

**L3 — Time Machine** (`the read API over L2`). The existing `perspective-engine` with an added `asOf` in `ComputeOptions` and a `completeness` envelope on `LensResult`. Answers **"what was true at a date or during a period?"** Period filtering (Cash Flow) already lives here.

**L4 — Financial Timeline** (`what changed between A and B, and why`). Deterministic diff of two L3 states, attributing the delta to drivers (per-perspective) and events (derived), reconciling `opening + Σdrivers + Σevents = closing + unexplainedDelta`. Answers **"what changed and what caused it?"** Never fabricates a driver to close the residual.

**L5 — Simulation / scenario engine** (`what could happen under explicit assumptions`). Deterministic forward projection from the *current* L3 state using sourced assumptions (observed averages, user assertions, market/inflation constants). **Physically separate module and storage from L1–L4.** Answers **"what could happen if…?"** Reproducible (seeded, input-hashed).

**L6 — Persistent knowledge** (`durable derived/asserted artifacts`). `Scenario` (+ assumptions), cached `ForecastRun`, `UserAssertion`, optionally cached `TimelineEvent`s and suggestion dismissals. Regenerable caches carry an `inputHash` for invalidation; user assertions are versioned by supersession. `KnowledgeVersion` (bitemporal) is deferred to the very end and only for *corrections*.

**L7 — LLM conversation** (`explain, compare, discuss`). Tool-calling over L3/L4/L5 DTOs + evidence references. Extends `assemblers → computeAssessment → provider`. Cites assumptions, distinguishes fact from scenario input, exposes uncertainty, requires confirmation before any L6 write, and **never** produces a balance/projection/classification itself.

### 2.2 Layer boundary distinctions (the four the prompt demands)

- **Time Machine (L3):** *point-in-time truth.* Input: `(scope, asOf|period)`. Output: `LensResult` (+ completeness). No comparison, no future.
- **Financial Timeline (L4):** *change and cause.* Input: `(scope, from, to)`. Output: `FinancialTimelineDiff`. Pure subtraction + attribution over L3; introduces no new facts.
- **Simulation (L5):** *conditional future.* Input: `(currentState, Scenario)`. Output: `ForecastRun`. Never reads L4; never writes L1.
- **Conversation (L7):** *natural-language orchestration.* Input: user question + tool results. Output: prose grounded in L3/L4/L5. Writes only to L6, only on confirmation.

### 2.3 Exact interfaces between layers

All DTOs are serialisable (no `Date` instances — ISO strings), deterministic under an injected clock, and name-free in provenance (existing engine invariants). Illustrative signatures, repo-style:

```
// L1→L2  (data layer, per perspective adapter)
getAccountsAsOf(scope, asOf): Promise<AsOfAccountRow[]>          // reconstruction + tier stamp
getSnapshotAsOf(spaceId, asOf): Promise<SpaceSnapshot | null>   // exists via lib/data/snapshots

// L2→L3  (perspective-engine)
ComputeOptions { now: () => Date; asOf?: string; targetCurrency?: string }
LensResult { ...existing..., completeness: Completeness }
computePerspective(lensId, scope, options): Promise<LensResult>

// L3→L4  (timeline)
getTimelineDiff(scope, from, to, options): Promise<FinancialTimelineDiff>

// L1+L3→L5 (simulation)
runScenario(scope, scenarioId | ScenarioInput, options): Promise<ForecastRun>
compareScenarios(scope, [scenarioId...], options): Promise<ForecastComparison>

// →L7 (LLM tool contracts — thin wrappers over the above, evidence refs only)
getCurrentFinancialState · getStateAsOf · comparePeriods · getTimelineDiff
createScenario · runScenario · compareScenarios · explainForecastDriver · getEvidenceRows
```

`Completeness = { tier: "observed" | "derived" | "estimated" | "incomplete"; reason: string; coverageFrom?: string }` — a runtime envelope, **not** a table (the persisted seed is `SpaceSnapshot.isEstimated`).

---

## 3. Required schema / tables

Verdict-per-candidate against "did the data earn this?" Ordered by when (if ever) it is earned. **The three read-only capabilities (Time Machine, Timeline, Wealth/Liquidity/Debt as-of) require ZERO new schema** — they are runtime envelopes and compute-on-read over existing models.

| Candidate | New table? | Could an existing model carry it? | Classification | Mutability | Ownership / visibility | Migration + backfill | Earned? |
|---|---|---|---|---|---|---|---|
| **SnapshotCompleteness** | **No** | Yes — runtime field on `LensResult`; seed is `SpaceSnapshot.isEstimated` | derived envelope | recomputed | inherits result scope | none | **Yes, as a type** (not a table) |
| **PerspectiveSnapshot** | **No (reject universal)** | `SpaceSnapshot` covers Wealth aggregates; others compute-on-read | cached projection | — | — | — | **No** — resist a universal FinancialState table |
| **Scenario** | **Yes (simulation phase)** | No | user assertion + config | versioned (edit = new version or updatedAt) | Space-owned, member-visible; `createdByUserId`; can be private | additive table | **Yes, when simulation ships** |
| **ScenarioAssumption / PlannedFinancialAction** | **No — JSON on Scenario** | Structured JSON array on `Scenario` | scenario-only input | replaceable within scenario | with Scenario | none | **Yes, as embedded JSON** (a table only if cross-scenario reuse emerges) |
| **ForecastRun** | **Yes (simulation phase)** | No | cached projection (regenerable) | replaceable; `inputHash` for invalidation | with Scenario | additive | **Yes** — cache, not truth |
| **ForecastPoint** | **No — JSON series on ForecastRun** | Series stored as compact JSON on `ForecastRun` | cached projection | replaceable | with ForecastRun | none | **No table** (per-row would be 10²–10³ rows/run for no query benefit) |
| **ForecastDriver** | **No — JSON on ForecastRun/point** | Embedded in run output | derived | replaceable | with run | none | **No table** |
| **UserAssertion** | **Yes (when baseline needs user inputs)** | Partly — `DebtProfile` already holds APR/terms; goals hold targets | user assertion | versioned by supersession | Space or user scoped; sensitivity flag | additive | **Yes** — the canonical home for payroll/reserve/planned purchases/manual valuations |
| **FinancialEvent** | **No initially (derive)** | Derivable from `createdAt`/`deletedAt`/`SpaceAccountLink`/balance→0/transactions | derived | recomputed | inherits | none | **No table yet** — surface as derived stream |
| **TimelineEvent** | **No initially** | Same as FinancialEvent; a *cache* only if cost demands | derived / cached | recomputed | inherits | none | **No** until cost proves it |
| **EventEvidence** | **No** | Reference = array of `Transaction.id` / `SpaceSnapshot` keys on the DTO | reference | — | inherits | none | **No table** |
| **PriceObservation** | **Yes (investment phase)** | No — `FxRate` is the structural precedent, not a home | canonical fact | append-only | global (not tenant) | additive + provider fetchers | **Not yet** — gated |
| **PositionSnapshot** | **Yes (investment phase)** | No — `Holding` is overwritten each sync | canonical fact | append-only | account-scoped | additive + stop overwriting holdings | **Not yet** — gated |
| **InvestmentEvent** | **Maybe — extend `Transaction` first** | Partly — `FlowType` has INVESTMENT/INTEREST/FEE; corporate actions do not fit `Transaction` | canonical fact | append-only | account-scoped | additive | **Not yet** — gated; prefer extending the log where possible |
| **SimulationSuggestion** | **No initially** | Compute deterministically; persist only *dismissals* (reuse `Notification` dedupe/expiry, or a tiny table) | derived + user action | derived; dismissal persisted | Space-scoped | none/tiny | **No table for the suggestion**; persist acceptance/dismissal only |
| **KnowledgeVersion** | **Yes — last, corrections-only** | No | versioning stamp | append-only | inherits | additive stamp on corrections | **No** until backfills routinely rewrite shown history AND users anchor decisions to it |

**Smallest coherent schema, by phase:**

- **Read-only phases (Time Machine, Timeline, Wealth/Liquidity/Debt as-of):** **no new tables. Zero migrations.**
- **Simulation phase:** `Scenario` (assumptions + planned actions as JSON), `ForecastRun` (series + drivers as JSON, `inputHash`), and `UserAssertion` **only when** a baseline input needs a canonical home not already covered by `DebtProfile`/goals.
- **Investment phase (gated, last before narrative):** `PriceObservation`, `PositionSnapshot`, and either `InvestmentEvent` or `Transaction` extensions.
- **Deferred:** `KnowledgeVersion` (corrections), suggestion-dismissal persistence.

**Explicit ruling:** do **not** create a universal `FinancialState`/`PerspectiveSnapshot` table. The repository evidence points the other way — state is perspective-specific (balances vs positions vs owed), `SpaceSnapshot` already materializes the one aggregate worth persisting, and the engine's own doctrine is "all flexibility belongs in scope, never in what a lens computes."

---

## 4. Investment data contract (exact requirements)

Today: current `Holding` only, overwritten each sync (`lib/plaid/refresh.ts` `deleteMany`+`create`); no historical prices (only `FxRate`); `ProviderType` already has `EXCHANGE`/`BROKERAGE`; `Connection`/`ProviderAccountIdentity`/`ImportBatch` foundations exist. The contract below is what must exist **before Investments can join Time Machine or simulation**.

### 4.1 What each capability actually requires (separated, so we don't over-build)

| Capability | Requires |
|---|---|
| **1. Historical portfolio value** | `PositionSnapshot` (qty/date) + `PriceObservation` (price/date) + FX. **Nothing else.** |
| **2. Allocation history** | Same as (1) + instrument asset-class metadata. |
| **3. Contribution-vs-growth** | (1) + `InvestmentEvent` for contributions/withdrawals/dividends/fees (to separate external flows from market move). |
| **4. Realized-gain reporting** | (3) + cost basis + lot-selection policy. |
| **5. Tax reporting** | (4) + wash-sale rules + jurisdiction lot rules. **Explicitly out of scope for shipping historical value.** |

**Ruling:** ship (1) and (2) with `PositionSnapshot` + `PriceObservation` only. Add `InvestmentEvent` for (3). Do **not** build tax lots for (1)–(3).

### 4.2 Minimum canonical investment contract (proposed field-level schemas — earned only at the investment phase)

```
// Canonical, global, append-only — the FxRate twin.
PriceObservation {
  id            String   @id @default(cuid())
  instrumentId  String            // canonical instrument key (symbol+exchange or CUSIP/ISIN/coingecko id)
  date          DateTime @db.Date  // valuation date (market close) — intraday goes in a separate optional field
  price         Float
  currency      String            // ISO 4217 quote currency
  source        String            // "plaid" | "coinbase" | "schwab" | "csv" | "manual" | "<vendor>"
  closeType     String            // "MARKET_CLOSE" | "INTRADAY" | "DAILY_CRYPTO"
  fetchedAt     DateTime @default(now())
  @@unique([instrumentId, date, closeType])
  @@index([instrumentId, date])   // walk-back: latest ≤ asked
}

// Canonical, account-scoped, append-only — the honesty-valve mirror of SpaceSnapshot.isEstimated.
PositionSnapshot {
  id                 String   @id @default(cuid())
  financialAccountId String
  instrumentId       String
  quantity           Float
  date               DateTime @db.Date
  source             String            // provider adapter id
  isEstimated        Boolean  @default(false)  // observed(false) vs reconstructed(true)
  currency           String?           // native cash currency for cash positions
  isCash             Boolean  @default(false)  // brokerage cash sweep
  createdAt          DateTime @default(now())
  @@unique([financialAccountId, instrumentId, date, source])
  @@index([financialAccountId, date])
}

// Canonical, account-scoped, append-only. Prefer extending Transaction/FlowType
// where the shape fits; this table exists for the shapes that don't (corporate actions).
InvestmentEvent {
  id                 String   @id @default(cuid())
  financialAccountId String
  type               InvestmentEventType   // BUY SELL TRANSFER_IN TRANSFER_OUT CONTRIBUTION
                                           // WITHDRAWAL DIVIDEND INTEREST FEE STAKING_REWARD
                                           // REINVESTMENT SPLIT MERGER SPINOFF SYMBOL_CHANGE OTHER
  instrumentId       String?
  quantity           Float?
  price              Float?
  amount             Float?               // cash leg, FM-signed
  currency           String?
  date               DateTime @db.Date
  source             String
  externalId         String?              // provider dedupe key (mirrors plaidTransactionId)
  relatedInstrumentId String?             // splits/mergers/spinoffs/symbol changes
  ratio              Float?               // split/merger ratio
  isEstimated        Boolean  @default(false)
  createdAt          DateTime @default(now())
  @@index([financialAccountId, date])
  @@index([instrumentId, date])
}
```

Plus an `Instrument` identity note: reuse the `Merchant`/`ProviderAccountIdentity` pattern — a canonical `instrumentId` with provider-specific external ids mapped in, so Coinbase "BTC", Schwab CUSIP, and a wallet asset all resolve to one instrument.

### 4.3 Provider adaptation into the provider-neutral contract

Every provider adapts through a stage-1 normalizer (the existing `lib/transactions/plaid-transfer-evidence.ts` / TE-1 pattern): provider payload → canonical `PriceObservation` / `PositionSnapshot` / `InvestmentEvent`. Provider strings never leak past the adapter.

- **Plaid Investments:** `investmentsHoldingsGet` → `PositionSnapshot` (append instead of overwrite); `investmentsTransactionsGet` → `InvestmentEvent`; security metadata → `Instrument` + `PriceObservation`. Consent gating already exists (`PlaidInvestmentsConsent`).
- **Coinbase / exchanges (`EXCHANGE`):** account balances → `PositionSnapshot` (isCash for fiat legs); fills/trades → `InvestmentEvent` (BUY/SELL/STAKING_REWARD); spot prices → `PriceObservation` (`DAILY_CRYPTO`, 24h).
- **Schwab / brokerage (`BROKERAGE`):** positions → `PositionSnapshot`; transactions → `InvestmentEvent`; quotes → `PriceObservation` (`MARKET_CLOSE`).
- **Wallets (`WALLET`, xpub/watch-only):** on-chain balance per address → `PositionSnapshot`; on-chain movements → `InvestmentEvent` (TRANSFER_IN/OUT); price from a crypto price source → `PriceObservation`. Reuses the existing wallet identity spine (`ProviderAccountIdentity(provider=WALLET)`).
- **CSV import (`CSV`):** `ImportMappingProfile` maps columns → any of the three; `externalId` = the file's own row id (already modeled on `Transaction`).
- **Manual entry (`MANUAL`):** user asserts positions/valuations → `PositionSnapshot`/`PriceObservation` with `source="manual"`, `isEstimated=true` where a price is asserted rather than observed.

**Missing-price / stale handling (mirror FX):** walk back to the latest `PriceObservation ≤ asOf`; if none, the position value is `estimated` and the result's completeness degrades — exactly how `convertMoney` + `SpaceSnapshot` handle missing FX today. Crypto uses daily close; intraday is optional and separately typed.

---

## 5. User-provided data contract

**Zero-input answers (available the moment accounts connect):** historical Cash Flow (In/Out + economic spending, per period), net-worth trajectory (existing `SpaceSnapshot`), liquidity now + as-of, total debt + revolving-card balance history, recurring-income and recurring-spending *estimates* (derived from transaction cadence), and a **baseline** year-end cash/net-worth forecast built only from observed averages + known debt terms.

**Optional inputs that sharpen simulation** (every one carries: required/optional, source type, validity period, confidence, canonical-vs-scenario, edit/revoke path):

| Input | Req? | Source type | Validity | Confidence | Changes canonical truth? | Edit / revoke |
|---|---|---|---|---|---|---|
| Paycheck schedule / cadence | Optional | user-asserted (derivable estimate exists) | forward until superseded | high if asserted | No — baseline forecast input | `UserAssertion` supersede |
| Salary / expected income | Optional | user-asserted | period-bounded | medium | No | supersede |
| Bonuses (one-time) | Optional | scenario-only or asserted | dated | user-set | No | delete/one-off |
| Debt payoff plan | Optional | user-asserted (planned action) | forward | high | No (planned action) | edit plan |
| APR / debt terms | Optional | user-asserted → **already `DebtProfile`** | until changed | high (user) / medium (provider) | **Yes — canonical** (existing field) | edit `DebtProfile` |
| Recurring obligations | Optional | asserted or derived | forward | medium | No | supersede |
| Planned purchases | Optional | scenario-only / planned action | dated | user-set | No | delete |
| Emergency reserve target | Optional | user-asserted | until changed | high | No (drives a suggestion/threshold) | edit |
| Savings / investment goals | Optional | **already `SpaceGoal`** | target-dated | high | Yes — goals are canonical | edit goal |
| Business plan / revenue / costs | Optional | scenario-only (sensitive) | scenario horizon | user-set | No | scenario-scoped |
| Private assets / real estate / manual valuations | Optional | user-asserted (+ manual account) | until revalued | medium | **Yes** — manual account balance is canonical | edit account / assertion |
| Risk preference | Optional | user-asserted | until changed | n/a | No — selects scenario band | edit |
| Expected contributions / return assumptions | Optional | scenario-only | scenario horizon | explicit | No | scenario-scoped |

**Rule:** inputs that change **canonical truth** are few and already have homes (`DebtProfile`, `SpaceGoal`, manual `FinancialAccount`). Everything genuinely new is either a **`UserAssertion`** (durable, versioned, drives baseline) or **scenario-only** (lives on a `Scenario`, never touches truth).

**Minimum onboarding set (do not overwhelm):** ask for **nothing** up front. After connection, propose at most three high-leverage confirmations, each pre-filled from derived estimates: (1) "Is this your regular income?" (derived cadence), (2) "Confirm APR on this card" (unblocks debt interest/payoff), (3) "What's your target emergency reserve?" (unblocks the reserve suggestion). Everything else is offered contextually when a scenario needs it.

---

## 6. Financial Timeline / change-decomposition design (L4)

**Question:** "What changed between Date A and Date B, and why?" **Method:** subtract two L3 Time-Machine states; attribute the delta to deterministic drivers and events; never invent a driver to close the gap — expose the residual honestly.

### 6.1 Deterministic output contract

```
FinancialTimelineDiff {
  from: string; to: string;                 // ISO dates
  openingState: PerspectiveStateRef;         // L3 result @from
  closingState: PerspectiveStateRef;         // L3 result @to
  drivers: TimelineDriver[];                 // attributable, signed, per perspective
  events: TimelineEvent[];                    // discrete, dated, evidence-linked
  unexplainedDelta: number;                   // closing − opening − Σdrivers  (never hidden)
  completeness: Completeness;                 // worst tier among contributors
  evidence: EvidenceRef[];                    // Transaction ids / snapshot keys — not rows
}
TimelineDriver { perspective; kind; label; amount; tier; evidence: EvidenceRef[] }
TimelineEvent  { date; kind; label; amount?; evidence: EvidenceRef[] }
```

### 6.2 Reconciliation identity

`closingState = openingState + Σ drivers + Σ event impacts + unexplainedDelta`

The engine computes `unexplainedDelta` as the *residual*, not a plug: it is whatever the attributable drivers fail to explain. A large residual is a **feature** — it tells the user (and the LLM) "we can't fully account for this," which is the honest answer when data is incomplete.

### 6.3 Where decomposition is possible vs must report estimated/incomplete/unexplained

- **Fully attributable (observed/derived):** cash changes (income drivers, spending drivers, transfers — all from the event log via `flow-predicates`/`classifyLiquidity`); revolving-debt changes (purchases vs payments); account-opened/closed events (`createdAt`/`deletedAt`); debt-paid-off (balance→0).
- **Estimated:** currency effects (FX walk-back); interest accrual (balance×APR/12).
- **Incomplete / unexplained:** any window extending before transaction depth; **investment market movement** (no price history today → the entire non-cash delta lands in `unexplainedDelta` and is stamped incomplete until §4 ships); manual-asset revaluations without a dated assertion.

### 6.4 Cross-perspective composition

Each perspective adapter contributes its own drivers into one shared `FinancialTimelineDiff`: Cash Flow → income/spending/transfer drivers; Liquidity → tier-movement drivers; Wealth → asset/debt-composition drivers; Debt → purchase/payment/interest drivers; Investments → contribution/market/dividend/fee drivers **(only after §4)**. The shell composes them; the residual is the sum of each perspective's residual. **The LLM may narrate drivers but may never add one** — if a delta is unexplained, the LLM says so.

---

## 7. Forward simulation engine design (L5)

A deterministic engine, **physically separate from L1–L4**, that projects the *current* L3 state forward under explicit, sourced assumptions. Precedent for the discipline already exists: `lib/goals/goal-trajectory.ts` computes a required-contribution back-solve and **explicitly refuses pace-based projection because the data doesn't support it** — the simulation engine inherits exactly this honesty.

### 7.1 Core shape

```
Scenario { id; spaceId; name; kind; assumptions: Assumption[]; plannedActions: PlannedAction[]; horizonMonths; resolution: "MONTHLY"|"DAILY"; createdByUserId; visibility; version }
Assumption { key; value; source: "observed"|"provider"|"user"|"estimate"|"scenario"; confidence; validFrom?; validTo? }
PlannedAction { kind: "RECURRING"|"ONE_TIME"; label; amount; cadence?; date?; affects: perspective }
ForecastRun { id; scenarioId; inputHash; computedAt; series: ForecastPoint[]; drivers: ForecastDriver[]; assumptionsUsed; completeness }
ForecastPoint { date; cash; netWorth; debt; investments?; band?: { low; high } }
```

### 7.2 Scenario types

- **Baseline:** observed averages + known debt terms + no new user actions. Zero-input. The default forecast.
- **Conservative / Aggressive:** the same baseline with a documented delta to return/inflation/spending assumptions — presented as explicit bands, not hidden stochastics.
- **Custom:** user-authored assumptions + planned actions.
- **Comparison:** N scenarios projected on the same horizon/clock for side-by-side.

### 7.3 Inputs and their sourcing (never silently promote history to fact)

Current state (L3, observed), historical averages (derived, **labeled** "based on your last N months"), payroll cadence (user or derived-estimate), recurring obligations (derived/asserted), debt terms (`DebtProfile`), planned actions (scenario), investment/return assumptions (scenario or global constant), inflation/FX/market returns (global constants, explicitly cited). **Every historical average is flagged as an assumption with its window and confidence — never as a guaranteed future.**

### 7.4 Deterministic vs probabilistic

- **Deterministic by default:** given the same assumptions + seed + clock, byte-identical output (the engine's existing determinism invariant extends forward).
- **Probabilistic only when explicitly requested and labeled:** market-return uncertainty may be shown as a **band** (conservative/aggressive as deterministic bounds first; Monte-Carlo confidence intervals are a *later* opt-in, always tagged "probabilistic," never mixed into the deterministic figure).

### 7.5 Mandatory forecast transparency

Every `ForecastRun` exposes: `assumptionsUsed` (with source + confidence), major `drivers`, `completeness` (omitted/incomplete data), and a **sensitivity** readout (which one or two assumptions move the outcome most). No forecast is ever presented as a single certain number without its assumption set.

---

## 8. Suggested-simulation design (§8)

Fourth Meridian should **offer** simulations after connection, under strict earned-ness rules. Recommendation: **rule-based triggers first** (deterministic, from canonical facts); **model-assisted phrasing later** (the LLM may reword a suggestion the deterministic layer already earned — it may never *originate* one). This mirrors `computeAssessment` (deterministic) → provider (phrasing).

**A suggestion is earned only if** it is derived from canonical facts, deterministic, explainable (links to evidence), dismissible, never auto-applied, and never written to canonical state without confirmation.

| Field | Rule |
|---|---|
| **Trigger** | A deterministic predicate over L1/L3 (e.g. `card.balance / avgMonthlySurplus < 6` → payoff-compare; `reserve < 3 × avgMonthlySpend` → reserve suggestion; income CV below threshold → year-end forecast offer). |
| **Required evidence** | The exact facts/rows behind the trigger, attached as `EvidenceRef[]`. |
| **Confidence threshold** | Suggestion suppressed unless its underlying facts meet a minimum coverage/tier (e.g. ≥ N months of data, income stability below a variance bar). |
| **Suppression** | Not shown when data is incomplete for the claim, or when the user dismissed it within a cooldown. |
| **Expiration** | Time-boxed; re-evaluated on new data (reuse `Notification.expiresAt` semantics). |
| **Deduplication** | `dedupeKey` on the condition identity (reuse `Notification.dedupeKey` pattern). |
| **Acceptance** | Creates a `Scenario` pre-filled from the trigger; user edits before saving. Never runs silently against canonical state. |
| **Dismissal** | Persisted (small dismissal record or `Notification` read/archive) so it doesn't reappear. |
| **Audit trail** | `AuditLog` row on suggestion surfaced/accepted/dismissed (append-only, existing `AuditAction` string registry — no migration to add an action). |

Suggestions are **not** a persisted table initially: compute them deterministically on read; persist only acceptance/dismissal.

---

## 9. New Space tab / product surface (§9)

**Recommended name: "Plan."** Rationale vs alternatives: *Forecast* and *Outlook* imply a single predicted number (over-promises certainty); *Scenarios* is jargon-y and hides the baseline; *Future* is vague. **"Plan"** correctly frames the surface as *user-directed, assumption-driven, editable* — it invites action ("make a plan") without asserting the future is known, and it houses baseline + scenarios + suggestions naturally.

Add `PLAN` to the `SpaceDashboardTab` enum (existing: OVERVIEW/GOALS/ACCOUNTS/DEBT/INVESTMENTS/RETIREMENT/ACTIVITY/SETTINGS) and render it through the existing `SpaceDashboard` `SectionRegistry` + perspective-adapter pattern — **not a separate mini-app.**

**First version (V1):** baseline forecast chart (cash + net worth) reusing the existing chart presenters; a small set of suggested-scenario cards; an assumption editor (the confirm-3 onboarding set); completeness/trust badges (shared envelope); the shared evidence/assumption drawer (`TransactionSliceDrawer` already exists). It consumes L3 (as-of) and L5 (baseline `ForecastRun`).

**Later:** custom scenario authoring, scenario comparison view, debt-payoff-path and investment-contribution-path visualizations, probabilistic bands, business-scenario templates, LLM-driven "explain this forecast."

**Reuse:** period/as-of control (shared shell), `ConversionContext` (currency), visibility tiers (privacy), `PerspectivesWidget`/adapters (rendering), `SpaceDashboardSection` (layout persistence).

---

## 10. LLM conversation architecture (L7)

Extend the existing chain — `assemblers → computeAssessment → provider` — with **tool-calling** over the deterministic DTOs. The model orchestrates and explains; the deterministic layers compute. Keep `lib/ai/provider.ts` as the **single** provider boundary (swap `gpt-4o-mini` freely; the contracts are model-neutral).

**Tool contracts the LLM receives** (thin wrappers over L3/L4/L5; repo-conventioned names, illustrative):

```
getCurrentFinancialState(spaceId)                → LensResult[]      (L3, asOf=now)
getStateAsOf(spaceId, date)                      → LensResult[]      (L3)
comparePeriods(spaceId, periodA, periodB)        → CashFlowDiff      (L4, cash-flow)
getTimelineDiff(spaceId, from, to)               → FinancialTimelineDiff (L4)
createScenario(spaceId, ScenarioInput)           → Scenario (DRAFT, requires confirm to persist)
runScenario(spaceId, scenarioId)                 → ForecastRun       (L5)
compareScenarios(spaceId, [scenarioId...])       → ForecastComparison(L5)
explainForecastDriver(runId, driverId)           → DriverExplanation + EvidenceRef[]
getEvidenceRows(evidenceRef)                     → redacted Transaction rows (on demand only)
```

**Contract discipline (all enforced, mirroring existing invariants):**

- The model receives **durable facts + evidence references, not raw transaction history.** `getEvidenceRows` fetches specific rows only when the user drills in — this is the token-cost lever (§12).
- The model **cites the assumptions it used**, distinguishes **facts from scenario inputs**, and **exposes uncertainty** (completeness tier + confidence come through in the DTOs).
- The model **never mutates canonical truth**; `createScenario`/planned-action writes are **DRAFT** until the user confirms in-UI (the write happens through a normal authenticated route, not from the model).
- **Every material conclusion links to a deterministic output or evidence ref.** `output-validator.ts` (exists) should gate that numbers in the reply trace to a tool result.
- **Model-neutral:** all tool inputs/outputs are plain serialisable DTOs, so a cheaper/local model consumes the identical contracts. No provider-specific shapes leak into the ontology.

**Answering the prompt's example questions:** "Why am I not a millionaire yet?" → `getTimelineDiff` + baseline `runScenario` + `explainForecastDriver`. "What if I invest $2,000/month?" → `createScenario`(planned recurring contribution) → `runScenario` → compare to baseline. "Show me the transactions behind this" → `getEvidenceRows`. The model narrates; the numbers are the engine's.

---

## 11. Immediate usability after connection (§11)

**With zero additional setup, immediately available (and trustworthy as observed/derived):** historical Cash Flow, net-worth trajectory (`SpaceSnapshot`), liquidity now, total debt + revolving-card balance path, and — labeled as estimates — recurring-income and recurring-spending figures.

**Available immediately but requiring confirmation before they're *trusted*:** the baseline year-end forecast (rests on "your average holds" + APRs); debt payoff dates (need confirmed APR); anything investment-historical (**blocked** until §4).

**Progressive onboarding (value before questionnaire):**

1. Connect data. 2. Fourth Meridian computes all zero-input historical facts. 3. It **shows completeness** honestly (e.g. "history begins Apr 3 — that's as far back as your bank shares"). 4. It **proposes** the ≤3 high-leverage confirmations (income / APR / reserve), pre-filled from derived estimates. 5. User confirms or edits (writes `UserAssertion`/`DebtProfile`). 6. Baseline forecast sharpens. 7. Conversation and suggestions become fully personalized. The user gets a working Cash Flow + net-worth + liquidity view **before answering a single question.**

---

## 12. Data / compute / cost analysis (§12)

Order-of-magnitude, per the investigation's volumes (transactions 10²–10⁴/Space/yr; `SpaceSnapshot` ~365 rows/Space/yr ≈ kilobytes).

| Workload | Cost | Recommendation |
|---|---|---|
| Position snapshots (future) | append-only per sync; accounts×symbols×frequency — the only meaningful growth | **event-driven writes** (on holdings change), not blind daily rows; retention policy at design time |
| Historical prices (future) | symbols×trading-days, same shape as `FxRate` | persisted series, cached per request; **on-demand fetch + backfill** |
| Daily Wealth snapshots | negligible | keep the existing **persisted rollup**; keep event-driven "today" write + bounded backfill |
| Timeline diffs | O(days×accounts) fold | **compute-on-read**; no persistence |
| Forecast runs | O(horizon×resolution) arithmetic | **cache `ForecastRun` by `inputHash`**; recompute on demand or on material state change |
| Scenario persistence | tiny | persist `Scenario`; assumptions/series as JSON |
| Recompute after new transactions | cheap for cash; snapshots frozen | **stamp, don't eagerly regenerate history** (eager regen is the road to bitemporal) |
| Recompute after corrections | rare | invalidate affected `ForecastRun` caches by `inputHash`; leave historical snapshots stamped |
| LLM explanation calls | the dominant marginal cost | **the canonical contracts are the cost control** |

**How the canonical model cuts LLM cost:** the model consumes compact DTOs (a `LensResult`, a `FinancialTimelineDiff`, a `ForecastRun`) plus evidence *references* instead of raw transaction pages. `computeAssessment` already pre-digests the math so the prompt carries conclusions, not ledgers. `getEvidenceRows` pulls specific rows only on drill-in. Net effect: bounded, near-constant token cost per turn regardless of history depth.

**Recompute automatically vs on demand:** auto-recompute the **baseline** forecast when material state changes (new income event, debt payoff) via the existing `lib/events` bus; recompute **custom scenarios only on demand** (user opens/edits). Never recompute every scenario on every transaction.

---

## 13. Security, privacy, auditability (§13)

- **Space visibility:** all new reads inherit the existing KD-19 tier model (`getAccountsWithVisibility`, `SpaceAccountLink`) and the perspective-engine's fail-closed posture. No new visibility vocabulary.
- **Scenario ownership & sharing:** `Scenario.createdByUserId` + Space scope; a `visibility` field lets a scenario be **private to its author** even within a shared Space (scenarios can be more sensitive than transactions — a business plan, a divorce plan). Default **private**; explicit opt-in to share into the Space.
- **Private assumptions / business plans:** stored on the `Scenario`/`UserAssertion` with a sensitivity flag; **excluded from AI serialization** unless the requesting viewer owns them. Extends `lib/ai/visibility.ts`.
- **AI serialization boundaries:** the assembler layer already redacts by tier and is name-free in provenance; scenario/assumption assemblers must apply the same gate and never serialize another member's private scenario.
- **Cross-Space non-inference:** enforced structurally — every query is `spaceId`-scoped (existing invariant); no aggregate, forecast, suggestion, or assumption may read across Spaces. One Space can never infer another's plans, balances, or forecasts.
- **Audit:** append `AuditAction` strings (no migration) for scenario create/run/share, assumption change, suggestion accept/dismiss — reusing the `AuditLog` append-only model and `AI_CONTEXT_ASSEMBLED` precedent.
- **Deletion / export / correction:** scenarios and assertions join the existing account-deletion purge (`lib/account-deletion/purge.ts`) and data-export (`lib/export/*`, `DATA_EXPORTED` audit); corrections follow the append-a-new-observation rule.
- **Model-provider isolation:** the single `lib/ai/provider.ts` boundary keeps model choice swappable and prevents provider SDKs leaking into business logic — already enforced by the engine's import tripwires.

---

## 14. Phased Claude Code implementation roadmap (§14)

Evaluated against actual repo dependencies. The prompt's 17-step list is **mostly right but reordered**: the Timeline diff (step 4) depends only on the as-of seam, so it can precede Liquidity/Debt as-of; and **all schema-bearing phases wait until the read-only capabilities they build on are proven on real data.** For each slice: title · purpose · investigation · files · schema/migration · tests · runtime validation · real-data validation · stop condition · commit boundary · rollback.

**Read-only block (no schema — do first, prove on real data):**

1. **Shared as-of + completeness seam.** Purpose: add `asOf` to `ComputeOptions` and a `completeness` envelope to `LensResult`. Files: `lib/perspective-engine/types.ts`, `engine`/`registry`, `lib/data/*`. Schema: **none.** Tests: determinism, kill-switch (no `asOf` ⇒ byte-identical), tier derivation. Stop: existing lenses unchanged when `asOf` omitted. Rollback: pure revert (additive). *Commit boundary: 1.*
2. **Wealth as-of** (reads `SpaceSnapshot`). *This is the smallest next slice — §16.* Schema: none. Rollback: revert.
3. **Cash Flow "Then vs Now."** Diff two `DayFacts` periods. Files: `lib/transactions/cash-flow-projection.ts` (read), new compare adapter. Schema: none. **May run in parallel with 2.**
4. **Timeline diff contract (L4).** `FinancialTimelineDiff` over as-of states; cash/debt drivers first; `unexplainedDelta` honest. Schema: none. Depends on 1.
5. **Liquidity as-of.** Feed reconstructed rows into `liquidity.core`. Schema: none. Depends on 1. **Parallel with 6.**
6. **Debt as-of (balances only).** Card reverse-walk into `debt.core`; loans stamped flat; **no** principal/interest. Schema: none. Depends on 1.

**→ PROVE THE READ-ONLY BLOCK ON REAL DATA BEFORE ANY SCHEMA (see §17).**

**Light-schema block (simulation):**

7. **Scenario + UserAssertion contracts.** Schema: `Scenario` (+assumptions JSON), `UserAssertion`. Migration: additive. Backfill: none. Tests: ownership/visibility, serialization gate. Rollback: drop additive tables (no reads before this). *Wait until 1–6 proven.*
8. **Baseline cash/net-worth forecast (L5).** Deterministic engine over current state + observed averages + `DebtProfile`. Schema: `ForecastRun` cache (JSON series, `inputHash`). Depends on 7. Tests: determinism/seed, assumption transparency, sensitivity.
9. **Plan tab UI.** Add `PLAN` to `SpaceDashboardTab`; render baseline + suggestion cards + assumption editor via `SectionRegistry`. Schema: enum value (additive). Depends on 8.
10. **LLM simulation tools (L7).** Tool-calling in `provider.ts`; wrappers over L3/L4/L5; evidence-ref discipline; confirm-before-write. Schema: none. Depends on 4 + 8.
11. **Suggested simulations.** Deterministic triggers; dismissals via `Notification` pattern; `AuditLog` strings. Schema: none/tiny. Depends on 8.

**Gated investment block (schema-heavy — last before narrative):**

12. **Investment event normalization.** `InvestmentEvent` (or `Transaction`/`FlowType` extension) + provider adapters. Schema: additive. Backfill: forward-only. *Wait until read-only + simulation proven.*
13. **Position history.** `PositionSnapshot`; **stop `deleteMany`+`create`** in `lib/plaid/refresh.ts` → append. Schema: additive. Migration risk: change to a hot sync path — gate behind a flag + observation window.
14. **Price observations.** `PriceObservation` + fetchers (FX-twin). Schema: additive.
15. **Investment Time Machine.** `investments` lens over 12–14 with completeness; valuation degrades like FX. Depends on 12–14.

**Narrative + deferred:**

16. **Cross-perspective Financial Narrative.** LLM composes L4 across all perspectives (now including investments). Depends on 4 + 15.
17. **Knowledge versioning (corrections-only).** `KnowledgeVersion` stamp on corrections. **Only if** backfills routinely rewrite shown history AND users anchor decisions to it (§3). Likely never in this program.

**Parallelism:** {2,3} parallel; {5,6} parallel; 4 after 1; the light-schema block strictly after the read-only block is proven; the investment block strictly after simulation is proven. **Every schema-bearing phase (7,8,9,12,13,14,17) waits on its read-only predecessor being validated on real data** — this is the core scheduling rule.

---

## 15. What Christian must provide

**A. Product decisions** (needed to finalize UI/behavior, not to start):

- Tab label — recommendation **"Plan"** (confirm or override).
- Default forecast horizon — recommendation **12 months** (year-end + rolling).
- Confidence presentation — bands + a plain-language tier, or numeric %? (recommend bands + tier).
- Scenario save behavior — auto-save drafts, or explicit save only? (recommend explicit save; drafts ephemeral).
- Recommendation tone — how assertive should suggestions read? (recommend "offer, never advise").
- Do business scenarios live in the **same** Space (private scenario) or a dedicated Business Space? (recommend same Space, private scenario, revisit if it gets heavy).

**B. Data Christian can optionally provide for his own account** (sharpens *his* forecasts; all optional):

- Expected payroll (amount + cadence); debt payoff plan; goals (or confirm derived ones); business assumptions (revenue/costs) if modeling a business; large future expenses; private/manual assets + valuations (real estate, etc.).

**C. Provider / data integrations** (external dependencies for the investment block only):

- Coinbase / exchange access; brokerage (Schwab/Plaid Investments consent); wallet addresses (already supported); a **historical price source** for securities + crypto (the one genuinely new external dependency); a corporate-actions source (later); CSV mapping profiles for manual imports.

**D. Safely deferred:** tax lots / cost basis / wash sales; probabilistic Monte-Carlo; knowledge versioning; corporate-actions handling; multi-Space business modeling; anything investment-historical.

**What Claude Code can implement with NO input from Christian:** the entire read-only block (phases 1–6) — shared as-of seam, Wealth/Liquidity/Debt as-of, Cash Flow Then-vs-Now, and the Timeline diff — plus the deterministic baseline-forecast math (phase 8 logic) using only observed data and existing `DebtProfile`. Product-decision items in (A) only gate final UI polish, not the engines beneath.

---

## 16. Exact prompt for the smallest next Claude Code slice

> **Task: Phase 1 — shared `asOf` + completeness seam, proven through a read-only Wealth "as-of" over existing `SpaceSnapshot`. Branch `feature/v2.5-spaces-completion`.**
>
> **Do not** add or modify Prisma models or run migrations. `SpaceSnapshot.isEstimated` / `reportingCurrency` already exist — use them. Read-only: no writes to historical data; no interpolation that could read as observed.
>
> **1. Investigate and report inline first:**
> - `lib/perspective-engine/types.ts` — `ComputeOptions`, `PerspectiveScope`, `LensResult`, `LensProvenance`, `assumptions[].source`, existing `estimated`; registration in `registry.ts`/`index.ts`; visibility via `getAccountsWithVisibility`.
> - `lib/data/snapshots.ts` — `getRecentSnapshots`/`getPortfolioHistory` and available `SpaceSnapshot` fields (`netWorth`, `totalAssets`, `debt`, `cash`, `savings`, `isEstimated`, `reportingCurrency`, `date`).
> - Shell/adapter wiring: `components/dashboard/SpaceDashboard.tsx`, `components/space/widgets/wealth-adapters.tsx`, and how `CashFlowPeriodSelector` feeds a single period today.
>
> **2. Add the shared primitives (minimal, additive):**
> - `asOf?: string` (YYYY-MM-DD) on `ComputeOptions`. Absent ⇒ byte-identical current behavior (kill switch).
> - `completeness: { tier: "observed" | "derived" | "estimated" | "incomplete"; reason: string; coverageFrom?: string }` on `LensResult`. Derive `tier` deterministically: snapshot present + `isEstimated=false` ⇒ observed; `isEstimated=true` ⇒ estimated; carry-forward from an earlier snapshot ⇒ derived; no snapshot on/before the date ⇒ incomplete. Deterministic, serialisable, name-free; honor all engine invariants (no `Date.now()` in lenses, no Prisma import in the engine dir, fail-shaped).
>
> **3. Add a read-only net-worth "as-of" lens:**
> - Pure core `lenses/networth.core.ts` + binding `lenses/networth.ts`: given `asOf`, read the nearest `SpaceSnapshot ≤ date` via the data layer; return net worth / total assets / debt as metrics + the completeness stamp. Carry-forward allowed only with `tier: "derived"`/`"incomplete"` and an explicit reason; a date with no prior snapshot returns a shaped partial/empty result. **No interpolation.** Preserve currency via the existing stamp-aware conversion.
>
> **4. UI (shell, minimal):** a shared as-of date control that sets one `asOf` (Wealth reads it; other perspectives ignore it this slice); render the completeness badge from `completeness`, keeping ontology terms internal ("Reconstructed", "No history before …").
>
> **5. Tests (mirror existing suites):** `lenses/networth.test.ts` — determinism (fixed clock + `asOf` ⇒ byte-identical JSON), tier privacy, completeness-tier derivation (observed/estimated/incomplete), empty/gap states, estimated-never-shown-as-observed; plus a kill-switch guard that `asOf`-less calls stay byte-identical.
>
> **6. Real-data validation:** a Space with ≥30 snapshot days including ≥1 `isEstimated` row and ≥1 gap. Verify observed vs reconstructed labeling and that gaps never render as a smooth canonical line.
>
> **Stop conditions:** as-of net worth reads correctly for snapshotted dates; gaps/estimates stamped, not interpolated; no schema/migration; all engine invariants and existing tests pass. **Do not** implement change-decomposition, forecasting, per-account reconstruction, or any other perspective in this slice. **Commit boundary:** one commit for the seam + lens + tests. **Rollback:** pure revert — everything is additive and kill-switched.

---

## 17. Exact stopping point before schema-heavy investment work

**STOP after Phase 11 (Suggested simulations) and before Phase 12 (Investment event normalization).**

Concretely, the following must be **shipped and validated on real data** before a single investment table is created:

1. Shared `asOf` + completeness seam (Phase 1)
2. Wealth as-of (Phase 2)
3. Cash Flow Then-vs-Now (Phase 3)
4. Financial Timeline diff contract (Phase 4)
5. Liquidity as-of (Phase 5)
6. Debt as-of, balances only (Phase 6)
7. Scenario + UserAssertion contracts (Phase 7)
8. Baseline cash/net-worth forecast (Phase 8)
9. Plan tab (Phase 9)
10. LLM simulation tools (Phase 10)
11. Suggested simulations (Phase 11)

**Why here:** everything above earns its keep from data the platform **already has** (transactions, snapshots, FX, debt terms) and needs at most three light additive tables (`Scenario`, `ForecastRun`, `UserAssertion`) — none of which touch a hot sync path. Phase 12+ requires reversing the holdings overwrite in `lib/plaid/refresh.ts`, introducing a global price series, and normalizing multi-provider investment events — a materially higher-risk, higher-cost body of work that should begin **only once the read-only and simulation capabilities have proven the shared architecture on real users.** Crossing this line early would build investment history before the framework consuming it is validated — precisely the "elegant abstraction the data hasn't earned" the governing principle forbids.

At the stop point, Fourth Meridian already answers: *what was I worth / liquid / owing at any date; what changed and why (for cash and debt); what's my baseline forecast; what scenarios should I consider; and a grounded LLM conversation over all of it* — with investments shown at current value and honestly stamped incomplete for history. That is a complete, shippable product **before** the investment schema is written.

---

*End of implementation plan. No code was written, no files modified, no schema or migrations created.*
