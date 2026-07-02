> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D6.3C — Investment Intelligence Investigation

**Status:** Investigation only. No files changed. No implementation.
**Branch:** `feature/phase-2-architecture`
**Scope:** Design the first real investment intelligence slice for D6. Answer the nine questions, then propose the smallest safe implementation slice and slice order.

---

## TL;DR

The plumbing for investment intelligence already exists but the pipe is empty. `HOLDINGS_SUMMARY` is a declared context domain, it is requested by the intent classifier for INVESTMENT/RETIREMENT questions, and Investment Readiness already reads a `holdingsDomainPresent` flag off it — **but no assembler is registered for it, so the domain is always skipped and the flag is always `false`.** Meanwhile Plaid holdings *are* synced into the `Holding` table (symbol, qty, price, value), and the securities payload that carries asset type is fetched but discarded.

The smallest safe slice is therefore: **write the `HOLDINGS_SUMMARY` assembler over existing `Holding` rows**, computing allocation and concentration from balances alone. No schema change, no new Plaid scope, no UI change. Everything requiring cost basis, realized/unrealized gains, or true sector breakdown is provider-gated and deferred.

---

## 1. What holdings fields exist today?

`Holding` model (`prisma/schema.prisma:1100`):

| Field | Type | Notes |
|---|---|---|
| `id` | String | cuid |
| `accountId` | String? | legacy `Account` FK (D11 migration in progress) |
| `financialAccountId` | String? | canonical `FinancialAccount` FK |
| `symbol` | String | ticker (e.g. `VTI`) |
| `name` | String | security display name |
| `quantity` | Float | units held |
| `price` | Float | current per-unit price |
| `value` | Float | position market value |
| `change24h` | Float | 24h % change, default 0 |
| `isCash` | Boolean | synthetic uninvested-cash row, default false |
| `createdAt` / `updatedAt` | DateTime | |

Uniqueness: `@@unique([accountId, symbol])` and `@@unique([financialAccountId, symbol])` — one row per symbol per account.

**What is NOT stored:** asset class / security type (equity, ETF, mutual fund, bond, crypto), sector or industry, cost basis, purchase date/lot, CUSIP/ISIN, `security_id`, currency, or account tax treatment (taxable vs tax-advantaged). These fields do not exist on the model today.

**Cash handling:** `computeCashResidual` (`lib/sync/computeCashResidual.ts`) writes a synthetic `CASH` / "Uninvested Cash" `isCash=true` row equal to `accountBalance − Σ(real position values)`, so holdings always sum to the account balance. Residuals below $5 are dropped. *(Note: this helper still queries by `accountId` only, so it does not fire for FinancialAccount-anchored holdings — a latent D11 gap to confirm separately, out of scope here.)*

---

## 2. What investment account/holding data is assembled into AI context today?

**Holding-level data: none.** No assembler is registered for `HOLDINGS_SUMMARY` or `HOLDINGS_RAW`. Registered assemblers are only: `ACCOUNTS`, `TRANSACTIONS_SUMMARY`, `GOALS`, `SNAPSHOT_HISTORY` (`grep registerAssembler`). The context builder treats a missing assembler as "skip domain" (`lib/ai/assembler-registry.ts` — `getAssembler` returns undefined → skipped).

**What the AI does see about investments today** comes entirely from the `ACCOUNTS` domain (`lib/ai/assemblers/accounts.ts` → `classifyAccounts`):

- `totalInvestments` — sum of balances of `type: investment` accounts (one number)
- `counts.investments` — how many investment accounts
- These roll into `netWorth` / `totalAssets`

So the model knows *how much* is in investment accounts, but nothing about *what* is held — no positions, no allocation, no concentration.

**Downstream consumer already wired:** `computeInvestmentReadiness` (`annotations.ts:977`) reads
`holdingsDomainPresent = !!ctx.domains[HOLDINGS_SUMMARY]?.data` — today always `false`. Investment Readiness classification (`READY` / `CONDITIONALLY_READY` / `DEBT_FIRST` / `BUILD_LIQUIDITY_FIRST` / `BLOCKED_BY_DATA`) is derived purely from **liquidity + debt**, explicitly "without requiring holdings data." It is a *pre-condition* engine, not holdings analysis.

**Intent routing is also already wired:** the intent classifier requests `HOLDINGS_SUMMARY` via the `FINANCE_WITH_HOLDINGS` domain list for INVESTMENT and RETIREMENT categories (`lib/ai/domain-manifest.ts:56`, `lib/ai/intent/classifier.ts:113`). It asks for the domain; nothing answers.

**Conclusion:** the contract is defined and consumers exist. The only missing part is the assembler that turns `Holding` rows into a `HOLDINGS_SUMMARY` section.

---

## 3. What can be computed now, without investment transactions?

Everything below is derivable from existing `Holding` rows (`symbol`, `quantity`, `price`, `value`, `isCash`) plus account balances — no `/investments/transactions/get`, no schema change:

- **Total portfolio value** and **invested vs cash split** (`isCash` already separates them).
- **Per-position weight** = `value / totalPortfolioValue`.
- **Concentration risk** — top position weight, top-N weight, Herfindahl-style concentration, count of positions above a threshold (see Q5).
- **Position inventory** — symbol, name, value, weight, qty (respecting visibility rules).
- **Cash drag** — cash % of portfolio.
- **Account-type allocation** — split across investment accounts vs the rest of net worth (from `ACCOUNTS` totals already assembled).
- **Coarse asset-class allocation** — *only heuristically* from symbol patterns (see Q6); real classification is provider-gated.

**Cannot be computed now** (no source data): cost basis, unrealized/realized gains, time-weighted or money-weighted return, dividend income, tax-lot detail, contribution history, true sector/industry breakdown.

---

## 4. What requires `/investments/transactions/get` or future provider work?

**Requires `/investments/transactions/get` (Plaid investment transactions API — not currently called):**

- Cost basis and unrealized gain/loss (Plaid does not return cost basis on holdings; must be reconstructed from buy/sell history, and even then is approximate).
- Realized gains, dividends received, contribution/withdrawal flows.
- Any performance/return figure (TWR/MWR) — needs a cash-flow timeline.

**Requires enriching what we already fetch but currently discard** (cheaper than a new API — the data is already in the `investmentsHoldingsGet` response):

- **Security type / asset class.** `refresh.ts:226` and `exchangeToken.ts:375` read `securities[].type` (equity, etf, mutual fund, fixed income, cash, derivative, crypto) and use it only to *filter out* cash — then **discard it**. Persisting `sec.type` (and optionally `security_id`, `cusip`) would give real asset-class allocation with no new API call.

**Requires future provider work / third-party data (no reliable Plaid source):**

- **Sector / industry exposure.** Plaid's securities object does not carry GICS sector. True sector breakdown needs an external reference dataset (symbol → sector) or a data vendor. Defer.
- Robinhood/Schwab direct: per the context, these give balances/holdings reliably but investment *transaction* history is weaker — reinforces treating transactions/returns as a separate, later provider track.

---

## 5. How should concentration risk be detected?

Deterministic, in the assembler (matching the existing "compute in intelligence layer, LLM reasons from it" pattern). Over non-cash positions, weight `w_i = value_i / investedTotal`:

- **Single-position concentration** — flag when `max(w_i)` exceeds a threshold. Suggested bands: `≥ 40%` critical, `≥ 25%` warning, `≥ 15%` info.
- **Top-N concentration** — top-5 weight `≥ 60%` warning (portfolio effectively a handful of bets).
- **Herfindahl index** — `Σ w_i²`; `≥ 0.25` (roughly "< 4 effective positions") indicates high concentration. Good single scalar for confidence framing.
- **Effective number of holdings** = `1 / Σ w_i²` — intuitive companion to HHI.
- **Cash-adjusted:** compute concentration on invested (non-cash) value so a large cash residual does not mask stock concentration.

Output a `ConcentrationSection` with the numbers + a classification enum (`DIVERSIFIED` / `MODERATE` / `CONCENTRATED` / `HIGHLY_CONCENTRATED`) and the offending symbols, and let the LLM phrase the advice. **Data caveat:** two brokerages both holding `VTI` are distinct `Holding` rows; concentration must aggregate by `symbol` across accounts before weighting, or it will understate true concentration.

---

## 6. Can asset allocation be computed from current holdings?

**Two tiers:**

- **Value-based allocation — yes, now.** invested vs cash, and per-account-type allocation, are exact from existing data.
- **Asset-class allocation (equity / bond / fund / crypto) — only heuristically today.** With current fields the only signal is the `symbol` string, so any classification is a guess (e.g. known ETF symbol lists, `-USD` suffix → crypto). This is unreliable and should be labelled low-confidence or omitted.
  - **Clean path:** persist `securities[].type` from the Plaid payload we already fetch (Q4). Then asset-class allocation becomes exact and cheap. This is the natural *second* slice.

**Sector allocation — no.** No source field; requires external data. Defer.

---

## 7. What should be added to `FinancialAssessment`?

Additive only, mirroring the existing section pattern (`CapitalAllocationSection`, `InvestmentReadinessSection`, etc. in `annotations.ts`). Proposed new section on `FinancialAssessment`:

```ts
interface HoldingsSection {
  present: boolean;                    // holdings domain assembled & non-empty
  confidence: ConfidenceLevel;
  totalInvestedValue: number;          // non-cash
  cashValue: number;
  cashPct: number;
  positionCount: number;               // aggregated by symbol
  concentration: {
    classification: 'DIVERSIFIED' | 'MODERATE' | 'CONCENTRATED' | 'HIGHLY_CONCENTRATED';
    topSymbol: string | null;
    topWeight: number;                 // 0..1
    top5Weight: number;
    herfindahl: number;
    effectiveHoldings: number;
    flagged: { symbol: string; weight: number }[];
  };
  allocation: {
    byAccountType: Record<string, number>;   // exact
    byAssetClass: Record<string, number> | null;  // null until sec.type persisted
    assetClassConfidence: ConfidenceLevel;    // LOW while heuristic
  };
  dataLimits: string[];                // e.g. "No cost basis — returns unavailable"
}
```

Then:

- Set `investmentReadiness.holdingsDomainPresent` truthfully (it already reads the flag).
- Add a Risk candidate `CONCENTRATED_HOLDINGS` and wire it into `computeRisksAndOpportunities` with `affectedSections: ['holdings']` (same pattern as existing risk codes).
- Keep every performance/return/gain field **out** of the interface for now — no source data, and shipping a null-filled block invites the LLM to hallucinate.

**Do not** change `InvestmentReadinessSection`'s classification logic — it is intentionally holdings-independent. Holdings analysis is a *new, parallel* section.

---

## 8. What should be deferred?

- **Investment transaction sync** (`/investments/transactions/get`) and everything it unlocks: cost basis, unrealized/realized gains, dividends, contributions.
- **Any performance / return metric** (TWR, MWR, YTD return) — blocked on the above.
- **Sector / industry exposure** — no reliable provider source; needs external reference data.
- **Forecasting / projections** (growth modelling, Monte Carlo, retirement glidepath) — depends on returns + contributions, i.e. the deferred transaction track. Hard boundary until transaction sync exists.
- **Heuristic asset-class labelling as a shipped feature** — acceptable as an interim low-confidence signal, but the real answer is persisting `sec.type`; don't over-invest in symbol-guessing.
- **New provider adapters for investments** (Schwab/Robinhood direct transaction history) — later, gated on D2/D13 provider layer.
- **UI for holdings intelligence** — out of scope for the first slice (assembler + assessment only); the existing holdings/investments pages are untouched.

---

## 9. What is the smallest safe implementation slice?

**Slice 1 — `HOLDINGS_SUMMARY` assembler (value-based intelligence only).**

Rationale: it is the single missing link in an already-wired chain (domain declared, intent routing requests it, Investment Readiness already reads its presence flag). It requires **no schema migration, no new Plaid scope, no UI change** — purely additive to the AI context layer.

Scope of Slice 1:
- New `lib/ai/assemblers/holdings.ts`; `registerAssembler(HOLDINGS_SUMMARY, …)`.
- Read holdings via the existing `getHoldings()` path, honouring Space visibility (mirror `accounts.ts` visibility handling — do not leak positions for BALANCE_ONLY / SUMMARY_ONLY accounts).
- Aggregate by `symbol` across accounts; compute invested/cash split, per-position weights, concentration metrics (Q5), value-based + account-type allocation (Q6 tier 1).
- Return `null` when there are no holdings (so the domain is cleanly "empty", exactly as `accounts.ts` does).
- Emit `dataLimits` strings ("no cost basis", "asset class heuristic/unavailable") so the LLM never implies returns.

Validation (per project working style): `npx prisma generate` (no schema change expected), `npx tsc --noEmit`, `npm run lint`, plus a targeted test that an INVESTMENT-intent context now contains a populated `HOLDINGS_SUMMARY` and that `holdingsDomainPresent` flips to `true`.

### Recommended slice order

1. **Slice 1 — HOLDINGS_SUMMARY assembler** (above). No schema change. Delivers allocation + concentration immediately.
2. **Slice 2 — `HoldingsSection` in FinancialAssessment** + `CONCENTRATED_HOLDINGS` risk code. Consumes Slice 1. Still no schema change.
3. **Slice 3 — persist `securities[].type`** (additive nullable `Holding.assetType`, backfilled on next sync; capture in `refresh.ts` + `exchangeToken.ts`). Upgrades asset-class allocation from heuristic to exact. First schema touch — own impact map / rollback / validation, per project rules; keep additive before subtractive.
4. **Deferred track (separate initiative):** investment transactions → cost basis / returns → forecasting. Gated on provider work; do not begin under D6.3C.

Each slice is independently shippable and reversible, and none removes legacy tables or renames anything (consistent with the Phase 2 additive-before-subtractive rule).

---

## Key file references

- `prisma/schema.prisma:1100` — `Holding` model
- `prisma/schema.prisma:665` — `FinancialAccount` (D11 fields)
- `lib/ai/assemblers/accounts.ts` — only investment signal today (`totalInvestments`) + visibility pattern to mirror
- `lib/ai/assembler-registry.ts` — missing assembler ⇒ domain skipped
- `lib/ai/domain-manifest.ts:56` — `FINANCE_WITH_HOLDINGS` requests `HOLDINGS_SUMMARY`
- `lib/ai/intent/classifier.ts:113` — INVESTMENT/RETIREMENT intent → holdings domain
- `lib/ai/intelligence/annotations.ts:977` — `computeInvestmentReadiness`, reads `holdingsDomainPresent`
- `lib/plaid/refresh.ts:178` & `lib/plaid/exchangeToken.ts:345` — holdings sync; `securities[].type` fetched then discarded
- `lib/sync/computeCashResidual.ts` — synthetic cash row (accountId-only; latent D11 gap)
- `lib/data/accounts.ts:148` — `getHoldings()` read path (dual-anchor, D11-aware)
