# Multi-Currency Architecture Investigation

**Status:** Investigation only — no implementation, no schema change, no roadmap edit.
**Scope:** Determine the smallest architecture that supports users with accounts in multiple currencies while preserving historical accuracy and avoiding future rewrites.
**Branch context:** `feature/v2.5-spaces-completion` (baseline v2.4.5). This document is an architecture decision-input, not an approved plan.
**Governing rules honored:** investigation-first; preserve existing architecture; smallest implementation satisfying the long-term vision; no opportunistic refactors; additive before subtractive.

---

## 0. Executive summary

Fourth Meridian is **single-currency by construction, but multi-currency-aware by intention.** The codebase already carries a `currency` column on both `Account` and `FinancialAccount`, already captures Plaid's `iso_currency_code` at account creation, and already contains explicit "replace this when multi-currency lands" seams (`lib/currency.ts`, `lib/ai/types.ts`). What it does **not** have is any point at which two differently-denominated numbers are made comparable before they are added together. Every total in the product — net worth, cash, debt, snapshot rows, AI context — is produced by summing raw `Float` balances with **zero conversion**.

The single most important finding:

> **The currency code is captured and then discarded at exactly one layer: aggregation.** `sumBalances()` in `lib/account-classifier.ts` is the chokepoint. Fix the model that feeds it and the estimated ~90% of downstream currency correctness follows, because nearly every total in the app flows through `classifyAccounts()`.

Recommended storage model: **Option B (store original + normalized), with normalization computed at write/sync time using a versioned FX rate, and the reporting currency living on the Space.** This is the smallest model that preserves historical correctness without forcing a rewrite when providers, snapshots, or AI expand.

The smallest *safe* first step is **not** "convert everything." It is **make money self-describing**: attach a currency code to every monetary row (transactions, holdings, snapshots) so that no future migration has to guess what currency a historical number was in. Conversion can come later; **provenance cannot be backfilled** and therefore must come first.

---

## 1. Current assumptions — where the code assumes one currency

Every monetary value in the system is a bare `Float`. The assumption "all money is already comparable" is made structurally (by omission of a currency dimension) far more than it is made explicitly.

### 1.1 Persistence-layer assumptions (highest severity — cannot be backfilled)

| Location | Assumption | Severity |
|---|---|---|
| `Transaction.amount: Float` (schema ~L1137) | Transaction amounts carry **no currency**. A EUR transaction and a USD transaction are indistinguishable rows. | **Persistence** |
| `Holding.price / value / quantity: Float` (schema ~L1095) | Position value carries **no currency**. A holding priced in GBP is stored as a naked number. | **Persistence** |
| `SpaceSnapshot.*` all `Float` (schema ~L1314-1327) | Every historical snapshot field (`stocks, crypto, cash, savings, debt, netWorth, totalAssets, netLiquid, cashOnHand`) is a number with **no currency and no FX version**. History is frozen in an unknown denomination. | **Persistence** |
| `lib/plaid/syncTransactions.ts` (L220) | `amount = -txn.amount` is stored without reading `txn.iso_currency_code`. Currency is **available from Plaid and dropped**. | **Persistence** |
| `lib/plaid/refresh.ts` holdings loop (L258-279) | `value: h.institution_value` stored without `iso_currency_code` from the holding/security. Currency is **available and dropped**. | **Persistence** |

These are the assumptions that are *destructive*: once a mixed-currency user exists and a snapshot/transaction/holding row is written without a currency stamp, the original denomination is unrecoverable.

### 1.2 Calculation-layer assumptions

| Location | Assumption | Severity |
|---|---|---|
| `lib/account-classifier.ts` — `sumBalances()` (L97-98) | `accounts.reduce((s,a) => s + a.balance, 0)` — **the** aggregation chokepoint. Adds balances across currencies as if identical. | **Calculation** |
| `lib/account-classifier.ts` — `totalLiabilities` (L138) | Same additive assumption for debt. | **Calculation** |
| `lib/snapshots/regenerate.ts` — `regenerateSpaceSnapshot()` | Builds every snapshot field from `classifyAccounts()` output, propagating the mixed-currency sum into stored history. | **Calculation → Persistence** |
| `lib/space-hero.ts` (L44-105) | Hero headline metrics (`netWorth`, `totalCash+totalSavings`, `totalInvestments+totalCrypto`, `totalDebt`) read pre-summed cross-currency values. | **Calculation** |
| `lib/perspective-engine/lenses/liquidity.core.ts`, `debt.core.ts` | Lens math (`cashNow`, `marketable`, `illiquid`, `monthlyInterest`) operates on already-mixed totals. | **Calculation** |

### 1.3 Reporting-layer assumptions

| Location | Assumption | Severity |
|---|---|---|
| `lib/data/snapshots.ts` — `getRecentSnapshots`, `getPortfolioHistory`, net-worth trend map (L26-105) | Chart series read snapshot `Float`s directly; no currency label travels with the series. | **Reporting** |
| `SpaceSnapshot` charts (Cash History, Banking History, Net Worth) | X/Y series assume a single implicit unit for the whole history. | **Reporting** |

### 1.4 AI-layer assumptions

| Location | Assumption | Severity |
|---|---|---|
| `lib/ai/types.ts` (L243-245, L652-653) | Documented in-code: *"All monetary values are in the Space's primary currency … Mixed-currency balances are summed without conversion — a known limitation until multi-currency support lands."* | **AI** |
| `lib/ai/assemblers/accounts.ts` (L204, L386-388) | `totalAssets/totalLiabilities/netWorth` come straight from `classifyAccounts()` — unconverted — while each per-account row *does* carry `currency` (L326, L371). The model is handed a correct per-account currency but an incorrect blended total. | **AI** |

### 1.5 Cosmetic assumptions (lowest severity)

| Location | Assumption | Severity |
|---|---|---|
| `lib/currency.ts` — `DEFAULT_DISPLAY_CURRENCY = "USD"` | Single hardcoded display currency; **explicitly designed as the future swap point** (see file header). | **Cosmetic** |
| `lib/format.ts` — `formatCurrency(amount, currency="USD")` | Locale fixed to `en-US`; currency defaults to USD but **accepts an override**, so per-account formatting already works. | **Cosmetic** |
| `app/api/accounts/wallet/route.ts` (L194) | Crypto wallet accounts hardcode `currency: "USD"` (the fiat valuation currency), which is defensible but not explicit. | **Cosmetic** |

### 1.6 The one place the system already does the right thing

`lib/account-privacy.ts` (L204-295) makes **currency part of the grouping key** for BALANCE_ONLY aggregation (`"balance-only:{ownerId}:{baseLabel}:{currency}"`). Mixed-currency accounts are never collapsed together in the privacy layer. This is the single existing precedent for "currency is a first-class grouping dimension," and the target model should generalize it rather than contradict it.

---

## 2. Current provider capabilities — what we already receive

### 2.1 Plaid

| Data | Field Plaid provides | Do we capture it today? |
|---|---|---|
| Account currency | `account.balances.iso_currency_code` (+ `unofficial_currency_code` for crypto/unsupported) | **Yes** — `lib/plaid/exchangeToken.ts` L276: `currency: acct.balances.iso_currency_code ?? "USD"` → `FinancialAccount.currency`. |
| Transaction currency | `transaction.iso_currency_code` / `unofficial_currency_code` | **No** — `syncTransactions.ts` never reads it. Available, dropped. |
| Investment holding currency | holding `iso_currency_code`; security `iso_currency_code` | **No** — `refresh.ts` holdings loop uses `institution_value`/`institution_price` directly, ignores the code. Available, dropped. |
| Investment transaction currency | `investment_transaction.iso_currency_code` | N/A — investment transactions not currently ingested. |
| Crypto support | Plaid reports crypto via `unofficial_currency_code`; native crypto is out-of-band (self-custody wallet path) | Partial — wallet path hardcodes USD valuation. |
| International account behavior | Plaid returns non-USD `iso_currency_code` for non-US institutions; balances are in the account's home currency | We store the code on the account but **treat the number as USD everywhere downstream**. |

**Conclusion for §2:** We already receive ISO 4217 currency codes for accounts (captured), transactions (ignored), and holdings (ignored). **No new provider integration is required to know the currency of most data — it is already on the wire and, for two of three record types, silently discarded.** This is the strongest possible argument for the "stamp currency at write time" first step: the data source is already giving us the answer.

### 2.2 Manual / wallet / CSV

- **Manual accounts** (`app/api/accounts/manual/route.ts`): already accept and persist a `currency` param (default `"USD"`, upcased). This path is *ahead* of the sync paths.
- **Wallets** (`app/api/accounts/wallet/route.ts`): hardcode `currency: "USD"` as the fiat valuation unit.
- **CSV import** (`lib/imports/csv.ts` L168): explicitly documents that per-row `currency` is **not** a supported column today.

---

## 3. Storage model investigation

Definitions:
- **Original value** = the amount in the account's native currency, as reported by the provider.
- **Normalized value** = the amount converted into a chosen reporting currency using an FX rate.

### Option A — Store only original values; convert on read

```
Transaction.amount = 1000 (EUR)   ──read──▶ convert(EUR→USD, rate@?)  ──▶ display
```

| Criterion | Assessment |
|---|---|
| Historical correctness | **Depends entirely on which rate `convert()` uses.** If it uses *today's* rate, all history silently rewrites itself every day (Jan net worth changes because EUR moved). If it uses historical rate, correctness is good but every read needs a dated rate lookup. |
| Complexity | **High at read time.** Every total, chart point, lens, and AI assembler must perform (and cache) conversions. `sumBalances()` alone fans out to dozens of call sites. |
| Reporting | Flexible — any reporting currency on demand. |
| Snapshots | **Broken unless snapshots also store the rate**, because a snapshot is a *read result frozen in time*; re-reading it later with new rates changes history. |
| AI | Assemblers must convert on every `buildContext()` — extra latency and a new failure mode (missing rate). |
| Future providers | Fine — providers only ever supply originals. |
| Migration risk | **Low to adopt, high to operate.** Cheap schema, expensive correctness. |

### Option B — Store original values **plus** normalized values (recommended)

```
Transaction: { amount: 1000, currency: "EUR",
               normalizedAmount: 1082.40, reportingCurrency: "USD",
               fxRateId: "rate_2026_01_15" }
```

| Criterion | Assessment |
|---|---|
| Historical correctness | **Strong.** The normalized value is computed once, at write time, against the rate in effect then, and frozen. January stays January. Original is retained for audit and re-reporting. |
| Complexity | **Moderate, and concentrated at write time.** Read paths simplify back toward "just add the normalized column." Conversion logic lives in the sync/write layer, not scattered across every reader. |
| Reporting | Good for the *default* reporting currency (precomputed). Ad-hoc reporting in a *different* currency still possible via the retained original + a rate lookup. |
| Snapshots | **Natural fit** — a snapshot becomes an immutable record of (original breakdown, normalized breakdown, rate version). See §5. |
| AI | Assemblers receive both; can state converted totals and cite originals (see §7). No per-request conversion required. |
| Future providers | **Survives all planned providers** — every provider supplies an original; normalization is provider-agnostic. See §8. |
| Migration risk | **Moderate.** Adds columns (additive). Backfill of `normalized` for historical rows is the only non-trivial step, and it degrades gracefully (flag as estimated). |

### Option C — Store only normalized values

```
Transaction.amount = 1082.40 (USD, always)   original EUR discarded
```

| Criterion | Assessment |
|---|---|
| Historical correctness | **Poor / irreversible.** Discarding the original destroys audit trail and makes re-reporting in another currency impossible. Any conversion error is permanent. |
| Complexity | Low at read time. |
| Reporting | **Locked** to the one currency chosen at write time. Different Spaces / different reporting currencies (§6) become impossible without a rewrite. |
| Snapshots | Simple but lossy. |
| AI | Cannot ever show the user "your account actually holds €1,000." |
| Future providers | Fine mechanically, but the product ceiling is low. |
| Migration risk | **Low to adopt, catastrophic to reverse.** This is the option that *causes* the future rewrite the brief asks us to avoid. |

### Recommendation: **Option B**

Option B is the only model that satisfies all three stated constraints simultaneously — historical accuracy (originals + frozen normalized), smallest long-term footprint (write-time conversion concentrates change), and no future rewrite (originals are never discarded, reporting currency stays free). Option A is Option B minus the frozen column, and its snapshot problem forces you to add exactly that column anyway — so A converges on B under pressure. Option C is disqualified by the "preserve historical accuracy" requirement.

**Crucial nuance:** Option B's *original* columns are the part that cannot be backfilled and must be adopted first. The *normalized* columns can be added later and even recomputed. So Phase 1 of any future implementation is "adopt the originals half of Option B" — which is exactly the currency-stamping step in §10.

---

## 4. Historical exchange rates

Scenario: user held 10,000 AED in January; AED/USD moves; chart viewed in USD.

| Approach | Behavior | Tradeoff |
|---|---|---|
| **A. Use today's FX for the whole series** | January's 10,000 AED is drawn using *today's* rate. | **Rewrites history every day.** The chart's past shifts whenever FX moves, even though the user's AED balance never changed. Users perceive this as data corruption. Cheapest to build; wrong for a "historical accuracy" product. |
| **B. Use the historical FX in effect on each snapshot date** | January point uses January's rate; June point uses June's. | **Correct depiction of reality.** Requires a historical rate source and a dated lookup per point. The net-worth line now legitimately moves due to *both* balance changes and FX changes — which is true, and arguably a feature (FX exposure is real P&L for a multi-currency user). |
| **C. Store the converted value inside the snapshot at write time** | Each snapshot froze its own normalized total using the rate then in effect. Chart just reads it. | **Same correctness as B, but no read-time lookup and no dependency on a rate archive at chart time.** This is Option B applied to snapshots. Downside: a snapshot is normalized to *one* reporting currency at write time; re-viewing the whole history in a *different* currency requires the retained originals + historical rates (i.e. falls back to B for the non-default currency). |

**Recommendation:** **C for the default reporting currency, with B as the fallback for ad-hoc alternate-currency views.** Snapshots freeze normalized totals (fast, stable, correct history); the retained per-account originals + a rate archive allow re-reporting in another currency when explicitly requested. Approach A should be explicitly rejected — it is the option most in conflict with the product's stated commitment to historical accuracy.

**Corollary:** choosing C means the FX rate archive is only needed for (a) the write-time conversion and (b) rare alternate-currency re-reporting — not on the hot chart path. That keeps the rate-source dependency off the critical rendering path.

---

## 5. Snapshot architecture

`SpaceSnapshot` is the load-bearing model for all history and is **the second-most-important decision after §3**, because snapshots are *already immutable-by-convention* (`@@unique([spaceId, date])`, written once/day, never edited) but are **not currency-aware**.

Should a snapshot store:

| Candidate field | Verdict | Rationale |
|---|---|---|
| Original balances (per currency) | **Yes (as a breakdown)** | Preserves the ability to re-report and to show "you held X AED." Best stored as a per-currency sub-breakdown rather than flattening. |
| Normalized balances | **Yes** | The frozen, chart-ready totals (matches §4-C). |
| FX rate version / id | **Yes** | Makes the normalization auditable and reproducible; distinguishes "converted at Jan rate" from "converted at today's rate." |
| Reporting currency | **Yes** | A snapshot must declare *what currency its normalized totals are in*, so a later reporting-currency change (§6) doesn't silently reinterpret old rows. |
| Estimation flags | **Yes** | Marks rows whose normalized values were backfilled/estimated (e.g. history that predates rate coverage) so AI and UI can hedge honestly. |

**Should snapshots become immutable currency snapshots? — Yes.** The model is already immutable in practice; formalizing it as "an immutable record of (original breakdown, normalized breakdown, reporting currency, rate version, estimation flag)" is the cleanest evolution and directly enables §4-C. This is additive: existing `Float` fields remain the normalized totals; the new dimensions describe *how* those totals were derived.

```
SpaceSnapshot (evolved, conceptual — NOT a schema proposal)
┌─────────────────────────────────────────────────────────┐
│ date, spaceId                                            │
│ reportingCurrency: "USD"        ← what normalized totals │
│ fxRateVersion:     "2026-01-15" ← reproducible           │
│ estimated:         false        ← honesty flag           │
│                                                          │
│ normalized: { netWorth, cash, savings, debt, ... }  ← charts read this
│ originalBreakdown: [ {currency:"AED", cash, ...},         │
│                      {currency:"USD", cash, ...} ]  ← audit / re-report
└─────────────────────────────────────────────────────────┘
```

---

## 6. Reporting currency — where it belongs

Candidate homes, evaluated:

| Home | Fit | Notes |
|---|---|---|
| **User** | Partial | A user with a US personal life and a Saudi business genuinely needs *different* reporting currencies per context. A single user-level currency forces one of them to be wrong. |
| **Space** | **Best** | Spaces are already the aggregation and snapshot boundary (`SpaceSnapshot.spaceId`, `classifyAccounts()` runs per-space). A Space is the natural "book." Different Spaces → different reporting currencies is not just possible, it is the *motivating* use case. |
| **Dashboard** | No | Too transient; would fragment snapshot semantics. |
| **Chart** | View-only | Fine as an *ephemeral display override* ("show this chart in EUR") layered on top of retained originals — never as the system of record. |
| **AI session** | View-only | Same as chart — a presentation preference, not storage. |

**Can different Spaces have different reporting currencies? — Yes, and they should.** The example maps directly onto the Space model:

```
User "Chris"
├── Space "Personal"          reportingCurrency = USD
├── Space "Saudi Business"    reportingCurrency = SAR
└── Space "Rental Property"   reportingCurrency = GBP
```

Because snapshots, classification, and hero metrics are **already Space-scoped**, putting reporting currency on the Space requires no new aggregation boundary — it *labels an existing one*. This is the cleanest architecture and the one that fits the current code with the least disturbance.

**Layering rule:** Space owns the *authoritative* reporting currency (drives snapshots and stored totals). Chart / AI-session may request an *ephemeral* re-report in another currency, computed from retained originals. Never store a chart/session override.

---

## 7. AI implications

Every AI surface consumes `buildContext()` output, which today blends currencies silently and *documents that it does so* (`lib/ai/types.ts`).

| AI feature | Current currency behavior | Target behavior |
|---|---|---|
| **Daily Brief** | `scopeHint='brief'` uses `classifyAccounts` totals only — blended, unconverted. | Consume normalized (converted) totals + the Space reporting currency label. |
| **Financial Story** | Narrative over blended totals. | Narrate in reporting currency; may *mention* notable original-currency holdings ("incl. €40k in your EUR savings"). |
| **Meridian Analyst** | Per-account rows carry `currency`; totals do not match those rows' mixed units. | Receive both; reason in reporting currency, cite originals when material. |
| **Future AI agents** | Would inherit the same blended assumption. | Inherit the corrected context contract — fix once, at the assembler. |

**Should prompts receive original, converted, or both? — Both, with a clear contract.** The assembler should hand the model: (1) **converted totals** in the Space reporting currency as the primary numbers it reasons and computes with, (2) **per-account originals with their currency codes** so it can be specific and honest, and (3) **the reporting currency + an estimation flag** so it never states a converted figure as if it were exact when the rate was estimated.

Concretely, the fix is **localized to the AI context contract, not each feature**: correct the totals in `lib/ai/assemblers/accounts.ts` (and the snapshot assembler) to emit normalized values plus a currency label, and update the `AccountsSectionData` doc-comment that currently says "summed without conversion." Every AI feature improves at once because they all read the same contract.

---

## 8. Future provider compatibility

The proposed Option B model ("every money row stores original amount + currency; normalization is computed centrally") is **provider-agnostic by design**, because it only asks a provider for the one thing every provider knows: the native amount and its currency.

| Provider | Native currencies | Survives Option B? | Notes |
|---|---|---|---|
| Coinbase | Crypto assets + fiat quote (often USD/EUR/GBP) | **Yes** | Crypto amount is the "original"; fiat valuation is a normalized-style figure. Model handles both if crypto is treated as a currency/asset with a rate. |
| Kraken | Crypto + multi-fiat | **Yes** | Same shape as Coinbase. |
| Schwab | Mostly USD; some multi-currency | **Yes** | Holdings carry a currency; identical to Plaid holdings path. |
| Fidelity | Mostly USD | **Yes** | Trivial case. |
| Interactive Brokers | **Heavily multi-currency** (positions in many currencies within one account) | **Yes — and this is the stress test.** | IBKR is precisely why per-*holding* currency (not just per-account) matters. Option B stores currency at the row level, so a single account holding USD, EUR, and JPY positions is representable. Option C or account-only currency would fail here. |
| CSV imports | Arbitrary / per-file | **Yes** | Currency becomes a mappable column (extends `lib/imports/csv.ts`). Absent → default to account/reporting currency with an estimation flag. |
| Manual assets | User-declared | **Yes** | Already stores `currency`. |
| Wallet providers | Crypto native | **Yes** | Replace hardcoded USD with the wallet asset's currency + fiat valuation. |

**Conclusion:** the model survives all planned providers, and the hardest case (Interactive Brokers, mixed currencies inside one account) is the specific reason to put currency at the **row level** (transaction/holding), not only the account level. An account-only currency model would *not* survive IBKR — a concrete argument against stopping at "currency on the account."

---

## 9. UX investigation — visible vs. invisible conversion

Guiding principle: **conversion should be invisible where the user thinks in one currency, and visible where two currencies genuinely meet.**

| Surface | Conversion visible? | Rationale |
|---|---|---|
| Account list | **Show native** per account (€, £, $ as-is); optionally show a subtle converted value. | Users recognize their accounts by native balance. Converting the list confuses. |
| Individual transactions | **Native currency**, always. | A €12 coffee is €12, not "$13.01." Converting individual transactions is the most jarring possible choice. |
| Charts (net worth / history) | **Reporting currency, invisible conversion**, with a currency label on the axis and a note that FX is included. | A single-currency line is the point of a chart; mixing units breaks it. Label prevents the user thinking a EUR account "grew" when only FX moved. |
| Net worth headline | **Reporting currency**, single number. | This is the canonical "one number" and must be one currency. |
| Holdings | **Native per holding**; portfolio total in reporting currency. | IBKR-style mixed portfolios must show each position honestly, then a converted total. |
| Snapshots (under the hood) | Invisible; store both (§5). | Not a user surface directly; feeds charts. |
| Daily Brief | Reporting currency, with the option to name material native holdings. | Narrative wants one primary unit; specifics add trust. |

**Rule of thumb:** *itemized* views (accounts, transactions, individual holdings) show **native**; *aggregated* views (net worth, charts, portfolio totals, brief) show **reporting currency** with an explicit label. Never silently convert a single itemized value; never mix currencies inside a single aggregate.

---

## 10. Migration strategy — launch USD-only, add multi-currency cleanly later

If the product ships USD-only first, the cleanest path to first-class multi-currency later depends on **one distinction**:

> **What must be decided now (irreversible) vs. what can wait (reversible).**

### 10.1 Decide/act now (cheap now, impossible later)

The only genuinely irreversible loss is **denomination provenance**. Any monetary row written today without a currency stamp is, forever, "assumed USD with no proof." Therefore the recommended *now* action — even in a USD-only launch — is the **additive, non-behavioral** stamping of currency onto the record types that currently lack it:

- Stamp `currency` on `Transaction` (Plaid already sends `iso_currency_code`; today it is dropped).
- Stamp `currency` on `Holding` (Plaid already sends it; today it is dropped).
- Stamp `reportingCurrency` (and, ideally, a rate-version placeholder) on `SpaceSnapshot`.

In a USD-only launch these all default to `"USD"` and change **no** behavior, no math, no UI. But they mean that when multi-currency lands, **there is no ambiguous historical data to repair** — the hardest part of every currency migration (deciding what old rows meant) is eliminated in advance.

This is "additive before subtractive" applied perfectly: add the columns now, populate them trivially, activate them later.

### 10.2 Can wait (safely deferrable)

- FX rate source/archive.
- The `normalized` columns' *values* (can be backfilled; can be recomputed).
- Reporting-currency selection UI.
- Conversion in classifier / assemblers / charts.
- Provider expansion.

### 10.3 The migration itself (when approved)

1. Columns already exist and are USD-populated (from 10.1) → no schema scramble.
2. Introduce FX rate archive + write-time conversion → populate `normalized`.
3. Flip `classifyAccounts()` (and only it, plus `regenerateSpaceSnapshot`) to sum `normalized`. Backfill snapshots as `estimated` where rate history is thin.
4. Introduce Space reporting currency (default USD → no visible change for existing users).
5. Expand UI, AI, providers.

**Key schema decision to make now:** whether to add the currency-stamp columns (Transaction/Holding/Snapshot) in the USD-only era. **This investigation recommends yes** — they are additive, behavior-neutral, and they convert the future migration from "data archaeology" into "column activation." *(Recommendation only — no schema change is made by this document.)*

---

## 11. Difficulty assessment

Effort to reach *first-class* multi-currency, by subsystem (assuming Option B + Space reporting currency + §10 provenance done first):

| Subsystem | Effort | Why |
|---|---|---|
| **Schema** | **Low** | Additive columns only (currency stamps, normalized fields, snapshot metadata). No table renames, no destructive change. The single hardest constraint — provenance — is a trivial default in USD-only. |
| **Sync (Plaid)** | **Medium** | Capture already-available `iso_currency_code` on transactions + holdings; add write-time conversion. Localized to `syncTransactions.ts` and `refresh.ts`. |
| **Snapshots** | **Medium** | Evolve `regenerateSpaceSnapshot` to compute + freeze normalized totals and store rate version; backfill history as estimated. |
| **Charts** | **Low–Medium** | Read normalized fields (already the shape of today's `Float`s) + add a currency axis label. Mostly labeling once snapshots carry normalized values. |
| **AI** | **Low–Medium** | Fix once at the assembler contract (`accounts.ts`, snapshot assembler); every feature inherits. Update the doc-comments that currently admit the limitation. |
| **Reporting (currency selection)** | **Medium** | Add Space reporting currency, selection UI, ephemeral chart/session override. |
| **Spaces** | **Low** | Reporting currency *labels* an existing boundary; no new aggregation logic. |
| **Imports (CSV)** | **Medium** | Add currency as a mappable column + default/estimate when absent. |
| **Providers (future)** | **High** (aggregate) | Not one task — it is per-provider adapter work (Coinbase, Kraken, IBKR…). The *model* is ready (§8); the integrations are the cost. IBKR mixed-currency-per-account is the trickiest. |

Overall shape: **the model is Low; the sync/snapshot plumbing is Medium; provider breadth is the only High, and it is High by count of providers, not by architectural risk.**

---

## 12. Proposed phased roadmap (input only — not a roadmap edit)

Adjusted from the example sequence based on the finding that **provenance must precede conversion** and that **the classifier is the leverage point**. Presented as the smallest safe order if/when approved.

```
Phase 0 — Provenance (do even in USD-only launch)      [Low]
  Stamp currency on Transaction + Holding (Plaid already sends it).
  Stamp reportingCurrency on SpaceSnapshot. All default USD. Zero behavior change.
  → Eliminates the only irreversible migration risk.

Phase 1 — Currency-aware accounts + rate archive        [Low–Medium]
  Formalize account currency (already captured); introduce FX rate source/archive.
  Still no conversion in totals. Reporting currency defaults to USD on Space.

Phase 2 — Currency-aware transactions & holdings         [Medium]
  Persist normalized values at write time (Option B) for new rows; backfill
  historical rows as `estimated`.

Phase 3 — Reporting currency on Space                    [Medium]
  Space.reportingCurrency selectable. Flip classifyAccounts() + regenerateSpaceSnapshot
  to sum normalized. This is the single highest-leverage cutover (one chokepoint).

Phase 4 — Snapshot evolution                             [Medium]
  Snapshots store normalized + original breakdown + rate version + estimation flag.
  Charts read normalized; add currency axis labels.

Phase 5 — AI                                             [Low–Medium]
  Assembler contract emits converted totals + originals + reporting currency label.
  Retire the "summed without conversion" limitation note.

Phase 6 — UX polish                                      [Medium]
  Native-per-item vs. reporting-per-aggregate rules (§9); ephemeral chart/session
  re-report override.

Phase 7 — Provider expansion                             [High, per-provider]
  Coinbase / Kraken / Schwab / Fidelity / IBKR / richer CSV. Model already supports.
```

**Why this differs from the example order:** the brief's example put "historical FX" at Phase 4 and "snapshot evolution" at Phase 5. This investigation moves **provenance to Phase 0** (before anything, because it is the only irreversible step) and pairs **historical FX with the rate archive early (Phase 1)** since conversion is impossible without it. The classifier cutover (Phase 3) is deliberately isolated as its own phase because it is one function touching almost every total — high leverage, and therefore worth its own controlled change.

---

## Recommendation (consolidated)

1. **Storage:** Option B — store originals + write-time-frozen normalized values.
2. **Reporting currency:** lives on the **Space**; different Spaces may differ; chart/AI overrides are ephemeral only.
3. **Historical FX:** freeze converted values into snapshots at write time (§4-C); retain originals + rate archive for alternate-currency re-reporting.
4. **Snapshots:** become immutable currency snapshots (normalized + original breakdown + reporting currency + rate version + estimation flag).
5. **AI:** fix once at the assembler contract; feed converted totals + originals + currency label.
6. **Leverage point:** `sumBalances()` / `classifyAccounts()` is the chokepoint — the cutover is one function, not a sprawl.
7. **Do now even in USD-only:** stamp currency on Transaction, Holding, and Snapshot. This is the single decision that prevents a painful future migration.

---

## Identified risks

- **R1 — Irreversible provenance loss (highest).** Every day the product runs without currency stamps on transactions/holdings/snapshots adds historical rows whose true denomination is unrecoverable. Mitigation: Phase 0.
- **R2 — Silent history rewrite.** If conversion ever uses *today's* rate for historical points (Option A / §4-A), users see past net worth change daily and lose trust. Mitigation: §4-C frozen snapshots.
- **R3 — FX source reliability.** A rate archive introduces an external dependency and a new failure mode (missing/rate-gap). Mitigation: estimation flags; keep rates off the hot chart path (§4 corollary).
- **R4 — Backfill accuracy.** Historical `normalized` values backfilled without dense rate history are approximate. Mitigation: mark `estimated`; surface honestly in UI/AI.
- **R5 — Classifier cutover blast radius.** `classifyAccounts()` feeds nearly every total; changing its summation touches dashboards, hero, lenses, snapshots, AI at once. Mitigation: isolate as its own phase (Phase 3) with the normalized column already populated and validated first.
- **R6 — Crypto/asset "currency" overload.** Treating crypto as a currency vs. an asset with a fiat quote is a modeling ambiguity (wallets currently hardcode USD). Needs an explicit decision before Coinbase/Kraken.
- **R7 — Per-account vs. per-row currency.** Stopping at account-level currency looks sufficient until IBKR (mixed currencies in one account). Row-level currency is required (§8) — deciding this late forces rework.

---

## Open decisions requiring approval

1. **Adopt Phase 0 provenance stamping during the USD-only era?** (Recommended yes — additive, behavior-neutral, prevents the irreversible risk.) *Requires a future, separately-approved schema change; not made here.*
2. **Confirm Option B** over A/C as the storage model.
3. **Confirm Space as the reporting-currency home** (vs. User), accepting per-Space currencies.
4. **Choose the FX rate source** and the required historical depth/granularity (daily close vs. intraday).
5. **Crypto modeling:** currency vs. asset-with-quote — resolve before wallet/exchange provider expansion (R6).
6. **Row-level vs. account-level currency granularity** — confirm row-level to survive IBKR (R7).
7. **Backfill policy** for historical snapshots/transactions predating rate coverage (estimate-and-flag vs. leave null).

---

*End of investigation. No implementation, schema, migration, code, or roadmap change is proposed or made by this document. Per project rules, the next step is a per-decision implementation checklist only after explicit approval.*
