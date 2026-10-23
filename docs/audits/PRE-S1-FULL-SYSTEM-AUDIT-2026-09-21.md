# Fourth Meridian — Pre-S1 Full System Code & Architecture Audit

**Date:** 2026-09-21 · **Branch:** `v2.6` · **HEAD audited:** `8ceafec` · **Mode:** investigation only. No fixes, refactors, test edits, database mutations or pushes were made. The only file this audit adds is this report.

**Method.** The audit started from the current code, not from plans. Eight independent read-only audit passes covered the 27 phases:
- forecast / liabilities
- transaction economics
- AI tools / orchestration / accounting
- state taxonomy / Memory V2
- providers / crypto / Plaid
- history / Brief / Markets / UI truth
- security / routes / concurrency / performance
- DB safety / tests / docs / dead code

Every P1, and every S1-blocking P2, was re-verified against source by the lead auditor (marked ✔ in the register). Supporting evidence:
- The canonical gate (`npm run ci`) was run on Node 24 against a throwaway Postgres.
- About 40 DB-free unit files were run individually.
- A handful of pure probe scripts were run from a session scratch directory. They import the real modules and touch no DB, network or repo file.
- The live `fintracker` database was never opened.

**Vocabulary.** Status labels:
- **IMPLEMENTED AND PROVEN** (IAP)
- **IMPLEMENTED BUT WEAKLY PROVEN** (IWP)
- **PARTIALLY IMPLEMENTED** (PARTIAL)
- **SCAFFOLD ONLY**
- **DEAD / SUPERSEDED**
- **DUPLICATED / OVERLAPPING**
- **DOCUMENTATION-ONLY**
- **UNKNOWN**

Severity runs P0–P4. Confidence is PROVEN / HIGH / MEDIUM / LOW.

---

## 1. Executive verdict

**Fourth Meridian's deterministic financial core is real and mostly trustworthy. Its edges — category semantics, answer-boundary verification, provider hygiene and one DB-safety seam — are not yet at the same standard.**

**What is genuinely built and proven:**
- **One** forward cash projection path, enforced by a CI source-scan: `assembleForecast(` has one production call site.
- A scenario ledger on top of it in which **L1 (liabilities), I1 (income changes) and the M1 liquid floor compose in one fold**. It is not merely coexistence.
- A canonical economic fold (income / gross spend / refunds / net), shared by UI and AI.
- The refund invariant (*card credits never become income*), enforced at every write path and gated by a REQUIRED audit.
- A four-state conversation taxonomy with no path from memory to financial truth.
- Memory V2 with closed payload schemas and a provenance gate.
- A historical reconstruction that never labels a rebuilt day "observed".
- A Daily Brief with an atomic claim, watermark/digest invalidation and a figure licence.
- A Plaid redirect authority that never reads request headers.
- A route surface with an owner or membership check on every handler.

**What is not yet trustworthy:**

1. **Category spending has no single authority.**
   - The UI computes it flow-aware and net; the AI computes it flow-blind and gross.
   - The vocabulary cannot represent Groceries, Medical, Transport and others.
   - The AI tool nevertheless advertises those categories and answers **$0.00 at observed completeness**.
   - S1 would build category-rate transforms on this. **This is the central pre-S1 finding.**
2. **"Code owns money" stops at the tool result.**
   - Nothing verifies the figures in a chat answer. The Brief has a licence; chat has none.
   - Every "never divide / never subtract" rule is prompt text.
3. **Two money defects in the forecast** (pure probes):
   - A paycheque that settled today is projected again.
   - A stated debt minimum is charged twice in a month when a rule falls off the month-end grid.
   - Net-worth identity tests cannot see either, because one is inside the spine and the other is a transfer.
4. **Two live P1 exposures that have nothing to do with S1:**
   - Raw Plaid errors are logged at five sites. That is the same leak class that exposed `PLAID-SECRET` in production on 2026-07-22.
   - The DB guard and backup inspect `DATABASE_URL` while Prisma Migrate targets `DIRECT_URL`, so a split environment can reset live again.
5. **Truthfulness gaps on the edges:**
   - stale bank balances written into a frozen "Observed" snapshot row;
   - an unpriced or unobserved wallet summed as $0;
   - an AI history tool that drops the reconstructed label;
   - a "Synced" chip that ignores balance age;
   - a Plaid null balance stamped as freshly verified.

**No P0 was found.** Three findings are P1:
- FM-AUDIT-001: Plaid secret logging.
- FM-AUDIT-002: DB guard target split.
- FM-AUDIT-003: unreachable categories answered as an observed $0.

**S1 verdict:** **NOT READY — READY AFTER GATE A.** Gate A is small and semantic:
1. one category authority and a reachable vocabulary;
2. a sign-correct fold;
3. `get_spending` aligned to net;
4. the paycheque and minimum-payment double counts;
5. a pure, CI-pinned composition harness;
6. harness isolation from live memory;
7. envelope size headroom.

No rewrite is warranted. Every Gate A item is a local correction.

---

## 2. Repository / CI baseline (verified, not assumed)

| Item | Expected | Verified |
|---|---|---|
| Branch | v2.6 | ✔ `v2.6` |
| local = origin | 8ceafec | ✔ `8ceafec15a0e…` both |
| Worktrees | one | ✔ one (`/Users/chrstn/dev/FourthMeridian`) |
| Untracked | status-drift file only | ✔ only `docs/audits/status-drift/STATUS-DRIFT-AUDIT-2026-09-21.md` (not touched, not claimed) |
| `.nvmrc` / `engines.node` | 24 / 24.x | ✔ |
| Global Node | 26 (must not be used) | ✔ v26.0.0 present. The gate ran on **v24.21.0** (npx cache), npm 11.12.1 |
| GitHub run 35634338072 | green at 8ceafec | ✔ `success`, jobs `test` + `Architecture audits` both success, headSha 8ceafec (via `gh run view`). The two prior runs (b68bce9, 8f863cd) were failures, as recorded |
| Workflows | ci.yml | ci.yml + `status-drift-guard.yml` (advisory, added 1699834, owned by the status-drift process) |

**`npm run ci` result (this audit, Node 24.21.0, clean depth-1 copy, throwaway postgres:16):**

| Job | Step | Result | Time |
|---|---|---|---|
| test | npm ci | ✓ | 15.5 s |
| test | prisma generate | ✓ | 3.5 s |
| test | test:unit | ✓ **588/588** | 55.9 s |
| test | typecheck | ✓ clean | 18.2 s |
| test | lint | ✓ **0 errors, 16 warnings** | 25.3 s |
| architecture | npm ci / generate | ✓ | 19.6 / 4.1 s |
| architecture | migrate deploy | ✓ | 3.5 s |
| architecture | db seed | ✓ | 9.1 s |
| architecture | audit:ci | ✓ **22/22 REQUIRED** | 14.8 s |

- **Container cleanup:** the throwaway container was removed after the run. The only remaining container is the developer's `fintracker-db`, which was never connected to.
- **First attempt failed, from my invocation:** the first gate attempt failed at `npx prisma generate`. Nesting `npx` inside `npx -p node@24 -c` leaks `npm_config_call` into the child, so this was an artifact of the invocation, not a repository defect. The second attempt put the Node 24 binary directly on `PATH` and passed.
- **Note for operators:** use `PATH=<node24 bin>:$PATH npm run ci`, not `npx -p node@24 -c 'npm run ci'`.

**Repository scale:**
- 2,305 tracked files
- 64 Prisma models, 106 migrations (newest `20260915180000_refresh_execution_source`)
- 168 `route.ts` files with 185 handlers; no server actions
- 90 top-level scripts
- 588 test files
- 2 Vercel crons
- Audit registry: 22 REQUIRED (18 DB + 4 source/git), 16 INFORMATIONAL, 16 OPERATIONAL, 22 RETIRED tombstones

---

## 3. Current system architecture map

### 3.1 Subsystem inventory

| Subsystem | Entry points | Canonical authority | Key models | AI exposure | Freshness / failure | Status |
|---|---|---|---|---|---|---|
| Runtime | Next 16 App Router; `proxy.ts` covers only `/dashboard`, `/admin` pages; `instrumentation.ts` boot env check | `lib/env.ts` (`PROD_REQUIRED_KEYS`) | — | — | boot fails without required prod keys | IAP |
| Auth / session | NextAuth credentials + TOTP; `requireUser`/`requireFreshUser`; revocation cache 30 s | `lib/auth.ts`, `lib/session.ts` | User, UserSession, RecoveryCode | — | JWT 30 d, per-request revocation | IAP |
| Spaces / membership | `requireSpaceRole`, `requireSpaceAction`, `resolveSpaceContext` | `lib/session.ts:360`, `lib/spaces/authorize.ts:98`, `lib/space.ts:181` | Space, SpaceMember, SpaceAccountLink (visibility tier) | chat 403 on Space mismatch | helpers ignore archived state (FM-AUDIT-057) | IAP (membership) |
| Accounts | `/api/accounts/**`, `lib/data/accounts.ts` | `FinancialAccount` + `account-classifier.ts` (tier, `amountOwed` clamp) | FinancialAccount, DebtProfile, AccountConnection | ACCOUNTS assembler | `lastUpdated`, `balanceLastUpdatedAt` | IAP; wallet fallback defect (FM-AUDIT-022) |
| Transactions | Plaid sync, CSV import, corrections; `queryTransactions` keyset | `classifyFlow` v5 (`flow-classifier.ts`) → `flowType`; `foldEconomicRow` (`cash-flow.ts:311`) | Transaction, TransactionEvent, TransactionObservation, Merchant* | TRANSACTIONS_SUMMARY, `get_transactions`, `measure_flows` | economic date; pending in UI only | IAP (fold); DUPLICATED (category) |
| Holdings / investments | Plaid holdings + investment txns, reconstruction | `lib/investments/*` (walk, residual, valuation) | Instrument, PositionObservation, InvestmentEvent, PositionReconstruction, PriceObservation | HOLDINGS_SUMMARY, `get_investments` | ≤7-day price carry, then unvalued | IAP |
| Liabilities | Debt page (`planPayoff`); scenario ledger | `lib/debt/effective-terms.ts` (DebtProfile > flat); `lib/debt/payoff.ts`; `scenario-ledger.ts` | DebtProfile | scenario tools | unknown APR ⇒ unmodelled, never 0% | IAP each; DUPLICATED semantics (FM-AUDIT-036) |
| Income | streams from INCOME/INTEREST rows | `lib/ai/forecast/streams.ts`, `cadence.ts`, `income-source.ts` (class attribution) | Transaction | `get_income`, `get_pay_dates`, I1 | cadence-derived | IAP; sign defect (FM-AUDIT-015) |
| Spending | fold + monthly buckets + category ledger | `clampEconomicSpend` (NET); `categorySpendLedger` (UI only) | — | `get_spending` (GROSS), `measure_flows` (GROSS category), `get_baselines` (NET) | settled-only in AI | PARTIAL (see §8) |
| Net worth (current) | SpaceSnapshot today-row; accounts assembler | `lib/snapshots/regenerate.ts` | SpaceSnapshot | `get_financial_snapshot`, `get_net_worth_history` | oldest-balance chrome freshness | IAP; stale "observed" (FM-AUDIT-021) |
| Cash flow | Cash Flow workspace | `cash-flow.ts` fold, `liquidity.ts` | — | `measure_flows` | pending included | IAP (headline) |
| Forecasting | `buildCashSpine` → `assembleForecast` → `projectCash` | `lib/forecast/projection.ts` (PROJECTION-1) | — | `project_cash` | as-of today | IAP; F-2 double count |
| Licensed forecast engine | `forecastCash` (`lib/forecast/engine.ts`) | — | — | disclosure only | never answers (no NET basis producer) | DEAD as answer path |
| Scenario engine | `prepareScenario` → `runScenarioLedger` | `lib/ai/conversation/scenario-ledger.ts` (zero imports) | — | `scenario_projection/crossing/goal_seek` | month-end grid | IAP (month-end); off-grid defects |
| Goal seek | `solveForTarget` bisection ≤80 | `scenario-ledger.ts:1265` | — | `scenario_goal_seek` | — | IWP |
| Measures / baselines | `lib/ai/measures/*` | `measure.ts`, `baseline.ts` (STATED > DECLARED > MEASURED) | — | `measure_flows`, `get_baselines` | population-aware completeness | IAP; category gross |
| Memory V2 | `remember`, silent projection checkpoint, panel | `memory-model.ts` (closed kinds), `memory-store.ts` | SpaceMemory | `remember`, `recall`, orientation memory line, `reconcile_projection` | no expiry; 180 d baseline STALE | IAP |
| Conversation state | sealed cookie `fm_ai_state` | `runtime-state.ts` (AES-256-GCM, HKDF) | none (cookie) | envelope + pending injected | 2 h TTL, 3,900-char cap | IAP; silent drop (FM-AUDIT-018) |
| Pending planning | `stage_assumptions` | `pending-plan.ts` | none (cookie) | pending system message | consumed on tool echo | IAP |
| Executed scenario | `captureActiveScenario` | `active-scenario.ts` | none (cookie) | trailing system message | cleared on failed recompute | IAP |
| AI runtime | `POST /api/ai/chat` → `runStatelessTurn` → `executeTurn` | `lib/ai/conversation/{engine,turn}.ts`, `gpt-5.1` hard-coded | — | 20 tools | ≤6 hops, no deadline | IWP |
| AI accounting | `recordOpenAiUsage` chokepoint | `lib/ai/provider.ts:93`, `lib/usage/pricing.ts` | AiInvocation, ApiUsageCounter | — | cost estimated at read | IAP (success path); PARTIAL (failures) |
| Daily Brief | GET inspect / POST ensure | `lib/ai/brief/*` (lifecycle, watermark, digest, licence) | DailyBrief | one structured model call | hourly bucket + watermark | IAP |
| Refresh / sync | `runFullRefresh`, dispatcher, manual refresh, webhook | `lib/plaid/refresh-execution.ts`, `lib/jobs/*` | RefreshExecution, RefreshEndpoint*, ProviderCall, JobRun, SyncIssue* | — | PlaidItem lease 360 s | IAP; idempotency SCAFFOLD |
| Plaid | link, exchange, sync, holdings, webhook | `lib/plaid/*` | PlaidItem, Connection | — | cursor-safety invariant | IAP; log leak (FM-AUDIT-001) |
| Crypto | wallet sync dispatch | `lib/crypto/*` | Connection, PositionObservation | ACCOUNTS | quote ≤6 h CURRENT, else close | PARTIAL (see §11) |
| Prices / FX | registry routes one provider per class | `lib/prices/registry.ts`, `lib/fx/service.ts` | PriceObservation, FxRate | via valuations | NO_PRICE / `amount:null`, never 0 / 1.0 | IAP |
| Historical reconstruction | regen-history, backfill, investments walk | `lib/snapshots/regenerate-history*.ts`, `lib/investments/reconstruction-core.ts` | SpaceSnapshot, SnapshotAmendment* | `get_net_worth_history` (label dropped) | observed rows frozen | IAP (labels in UI) |
| Markets | `?view=` workspace | `lib/markets/markets-mode.ts` | none | none | — | SCAFFOLD ONLY (honest) |
| Audit framework | `scripts/audit-registry.ts`, `run-audits.ts` | registry reconciled to disk (6 prefixes) | — | — | CI seeded corpus | IWP (no negative controls) |
| DB guard | `scripts/db-guard.ts`, `lib/db/live-guard.ts`, `lib/db.ts:27` | name-based live/clone classifier | — | — | armed by `FM_DB_GUARD` only | PARTIAL (FM-AUDIT-002) |
| CI | `ci.yml`, `npm run ci` | `scripts/lib/ci-contract.ts` (pinned to ci.yml) | — | — | Node 24, clean copy, throwaway PG | IAP |
| Jobs / scheduler | `/api/jobs/dispatch` (0,30 at 0,6,7,12,18 UTC), resume-stale-imports every 5 min | `lib/jobs/registry.ts` (10 jobs, incl. rate-limit-sweep) | JobRun | — | no slot idempotency | IAP; overlap SCAFFOLD |
| Platform Ops / admin | `/api/platform/**` (49), `/api/admin/**` (15) | `lib/platform/authorize.ts` (READ/WRITE/CONTROL), `requireSystemAdmin` | PlatformGrant, PlatformSetting, AuditLog | AI/Brief/Plaid readers | fresh guards on mutations | IAP; kill-switch gap |
| Migrations | 106 dirs; no migrate on build/deploy | `db:migrate:safe` doctrine | — | — | drift check manual (`db:drift`) | IWP |
| Repair scripts | 90 scripts; dry-run/`--apply` convention | registry for 6 prefixes | — | — | no auto-backup, 17 ungoverned mutators | PARTIAL |

### 3.2 Dependency / authority map (money path)

```
Providers ──► Plaid (accounts/tx/holdings/inv-tx) ─┐
              Esplora/blockchain.info (BTC)        │  lease + RefreshExecution
              Alchemy/Helius (ETH/SOL/BNB/AVAX)    │  (wallets: no lock)
              CoinGecko / Tiingo / OXR→Frankfurter ┘
                         │
                         ▼
DATA OWNS TRUTH:  FinancialAccount · Transaction(flowType v5, economicDate) · PositionObservation
                  PriceObservation · FxRate · DebtProfile · SpaceSnapshot (today row = live; past = rebuilt)
                         │
        ┌────────────────┼──────────────────────────────┬─────────────────────────┐
        ▼                ▼                              ▼                         ▼
 foldEconomicRow   account-classifier            regenerate-history        effective-terms (APR)
 (NET spend)       (tier, amountOwed)            (derived/estimated)             │
        │                │                              │                 ┌──────┴───────┐
        ▼                ▼                              ▼                 ▼              ▼
 assemblers (ACCOUNTS / TRANSACTIONS_SUMMARY / SNAPSHOT / HOLDINGS)   planPayoff     scenario-ledger
        │                                                              (Debt page)    (L1 in chat)
        ├──► measures (measure_flows GROSS cat, get_baselines NET)
        ├──► buildCashSpine ─► assembleForecast ─► projectCash (NET daily rate + dated income ⊕ I1)
        │                          └─► forecastCash (licensed; disclosure only)
        │                                   │
        │                                   ▼
        │              scenario ledger (minimums, ACT/365 on spine dates, waterfalls, floors, returns)
        │                                   ├─► crossings (month grain) ─► goal seek (bisection)
        │                                   └─► checkpoints (≤80, thinned) ─► envelope (sealed cookie)
        ▼
 CONTRACTS OWN SEMANTICS: 20 tool schemas + descriptions ─► MODEL OWNS MEANING (gpt-5.1) ─► prose
                                                              (no figure verifier on chat ✗;
                                                               Brief: licence ✓)
 Memory V2 (user-stated only) ──► orientation memory line (labelled "not in effect") — never into tool args
```

---

## 4. Financial authority matrix

The questions per value are:
1. Owner
2. Clock
3. Stale behaviour
4. Unavailable behaviour
5. Stale shown as current?
6. Approximate shown as measured?
7. User-stated shown as observed?
8. Remembered shown as current?
9. Reconstructed shown as observed?
10. Mixed clocks without disclosure?

| Value | Owner | Clock | Stale ⇒ | Unavailable ⇒ | Laundering risk |
|---|---|---|---|---|---|
| Bank balances | Plaid `accountsGet` → `FinancialAccount.balance` | `lastUpdated` (FM write) + `balanceLastUpdatedAt` (institution) | shell chip shows the oldest balance; the Accounts row chip still says "Synced" | **null current keeps old value but stamps `lastUpdated=now`, coverage COVERED** (`refresh.ts:222,226,234`); at connect null → **$0** (`exchangeToken.ts:330`) | **(5) YES**: FM-AUDIT-023, FM-AUDIT-030 |
| Credit cards / liabilities | same + `amountOwed` clamp (`account-classifier.ts:263`) | same | same | same | issuer credits never net against debt (IAP) |
| Investments / holdings | PositionObservation + PriceObservation | quantity date, price date | ≤7-day carry at `estimated`, then unvalued | "—", "N of M valued" | IAP |
| Crypto balance | Esplora (BTC single), blockchain.info (xpub, **includes unconfirmed**), Alchemy/Helius | observation time | VALUED keys on quantity freshness | **NO_PRICE / NO_OBSERVATION → stored column: 0 for ETH/SOL/BNB/AVAX, stale for BTC** | **(5)(6) YES**: FM-AUDIT-022 |
| Current prices | CoinGecko INTRADAY (crypto), Tiingo close (equity), Plaid capture | provider instant (`fetchedAt`) | "At <date> close" label in UI; **AI assembler drops the price-basis label** | NO_PRICE, never 0 | (5) partial on the AI side |
| Historical prices | CoinGecko market_chart, Tiingo | close date | — | insert-only | **possible one-day shift for >90-day backfill chunks** (FM-AUDIT-025, MEDIUM) |
| Income | INCOME/INTEREST rows → `attributeIncome` classes | economic date | — | — | **negative INCOME adds to income** (FM-AUDIT-015); card credits never income (IAP) |
| Spending | `foldEconomicRow` → NET | economic date | — | — | **sign-blind cost inflows** (FM-AUDIT-006); category GROSS vs NET (FM-AUDIT-004) |
| Refunds | REFUND flow; per-category ledger UI-only | economic date | — | — | IAP (headline) |
| Net worth (current) | today's SpaceSnapshot row from live balances | row date; no per-component clock | **written `isEstimated=false` even from stale balances, then frozen** | FX miss ⇒ `incomplete` | **(5)(10) YES**: FM-AUDIT-021 |
| Cash flow | fold + liquidity | economic date | — | — | pending: UI in / AI out (FM-AUDIT-013) |
| Historical wealth | rebuilt rows `derived`/`estimated`; observed rows frozen | row date | — | component preserved or day skipped, never zeroed | **(9) YES on the AI surface only** (FM-AUDIT-020); silent omission before account floor (FM-AUDIT-031) |
| Projected wealth | PROJECTION-1 + ledger | asOf | — | `unavailable` refusals | **today's paycheque double-counted** (FM-AUDIT-008) |
| Interest | ACT/365 on spine dates (ledger); per settlement (payoff); `apr/12` (interest-cost widget) | — | — | unknown APR ⇒ unmodelled | three conventions (FM-AUDIT-036) |
| Payoff timing | `planPayoff` (day, pro-rata) vs ledger (month-end, avalanche) | — | — | — | contradictory, undisclosed (FM-AUDIT-036) |
| Baseline expenses | STATED > DECLARED > MEASURED(NET) | window | 180 d baseline memory → STALE | per-rung `unavailable` | scenario floor has no DECLARED rung (P3, disclosed) |
| Liquidity | checking + savings (`totalLiquid`) | balance clocks | inherits bank staleness | — | inherits FM-AUDIT-023 |
| Snapshots | `regenerate.ts` (today), regen-history (past) | row date | inherits | — | see net worth |

**Direct answers to the laundering questions:**
- **(7) User-stated shown as observed:** no. Stated figures carry `STATED`/`ASSERTS_FACT` basis in tools and `REMEMBERED` in memory.
- **(8) Remembered shown as current:** no field can hold a balance. The residual risk is the free-text `statedAs` returned by `recall` (FM-AUDIT-046).
- **(10) Mixed clocks:** the today row blends Plaid balances of different ages, wallet values and prices under one `isEstimated=false`, and no per-component clock is stored. The chrome discloses the oldest clock only for the current view.

---

## 5. State taxonomy

| # | State | Carrier | Writer | Reader | Lifetime | Status |
|---|---|---|---|---|---|---|
| 1 | Financial authorities | DB via assemblers | sync pipelines only | tools | durable | IAP |
| 2 | Memory V2 | `SpaceMemory` (`schema.prisma:736`) | `remember` → `rememberStated`; silent `checkpointProjection` (project_cash, evidence-based only; `turn.ts:288`); owner panel retire/delete | orientation memory line, `recall`, `reconcile_projection`, Brief, starters | durable, no expiry | IAP |
| 3 | Pending plan | sealed cookie beside the envelope (`runtime-state.ts:76`) | `stage_assumptions` only | `mergeIntoArgs` in scenario setup; project_cash `planInPlay` guard; pending system message | 2 h, bound to user + space + tail | IAP |
| 4 | Executed scenario | `ActiveScenario {assumptions, ran, result, covers}` in the same seal | `captureActiveScenario` (scenario_projection; crossing only when it carries an assumption) | trailing system message | 2 h | IAP |

**Boundary proofs**

Code and tests, with 9 DB-free suites passing (runtime-state, pending-plan 65, memory-model 183, income-clause 38, chat-request 38, active-scenario 85, memory route 28, chat route 45, baseline 574):
- **Current turn beats pending:** "the call wins" (`pending-plan.ts:551-591`). IAP.
- **Pending beats memory:** memory is never merged, and the staging provenance gate refuses a remembered figure that was not restated. IAP.
- **Memory never auto-applies:** there is no code path from memory to tool arguments; `recallMemories(` has one call site, reconcile. However, the model may copy a remembered rule into `scenario_projection` arguments, which are ungated. This is prompt-mitigated only: measured 0/18, no automated test. IWP.
- **Activation / consumption:**
  - Only `scenario_projection` REPLACEs; goal seek, project_cash and remember are IGNORE.
  - Pending is consumed only for the ids the tool echo confirms.
  - Refused clauses stay held on the first run.
  - IAP.
- **Supersession / correction / retraction:**
  - pending: identity registry plus `replace`/`inAddition`;
  - memory: `supersedesId @unique` chain, `amend` merge, `retire` tombstone, delete-chain.
  - IAP.
- **Fresh-chat isolation:** a new chat has an empty tail, and a seal always binds a non-empty assistant digest. IAP.
- **Failed recompute clears the envelope:** IAP. **Gap:** a failed *re-run* after a successful one also forgets that a plan is in play, which re-opens the project_cash baseline path (FM-AUDIT-045).
- **Current-trend escape hatch:** `ignoreStaged` exists on project_cash only. Crossings and goal seeks always merge staged clauses. PARTIAL (FM-AUDIT-045).
- **Cookie sealing:**
  - AES-256-GCM under an HKDF subkey of `ENCRYPTION_KEY`.
  - Binding fields (user, space, tail, iat, v) sit inside the authenticated plaintext.
  - Tamper, cross-user, cross-Space, stale-after-switch and fresh-chat cases are all refused in tests.
  - **The cap is 3,900 chars**, not the ~3,000 recorded in older notes.
  - An oversize seal is dropped silently (FM-AUDIT-018).
  - Key rotation: SCAFFOLD, degrades safely.

**Forbidden-path search:**

| Path | Result |
|---|---|
| memory → financial truth | not found |
| memory → active scenario | not found automatically; only by model argument copying |
| pending → claimed execution | not found |
| label → execution authority | not found |
| executed scenario → durable memory | not found |
| stale pending → unrelated questions | **partial**: pending rides every turn for 2 h and merges into the next scenario call regardless of topic; disclosed as `fromEarlierInConversation` |

**One live boundary breach, operational rather than code:** the dogfood harnesses (`ai:chat`, `ai:baseline`, 14 of 16 `ai:*` checks) write real `SpaceMemory` and `AiInvocation` rows to whatever DB `.env.local` names, which is live. `FM_DB_GUARD` is not armed, and the harness header wrongly claims read-only (FM-AUDIT-019).

---

## 6. AI / tool architecture

### 6.1 Production tool surface — exactly 20 tools

`openAiToolSchemas()` exposes all of `TOOLS`, and `findTool` executes from the same array. The count is pinned at `baseline.test.ts:181`. There is no per-Space, role or question filtering.

| # | Tool | Authority | Money computed by code | Notes |
|---|---|---|---|---|
| 1 | get_financial_snapshot | ACCOUNTS / snapshot | reshape only | `basis` names provenance |
| 2 | **get_spending** | TRANSACTIONS_SUMMARY | **gross monthly mean computed in the adapter** (`tools.ts:411-431`) | contradicts its own description and the NET baseline (FM-AUDIT-007) |
| 3 | measure_flows | monthly rows → `measure.ts` | totals, per-month, compare | category line GROSS, debit-only, flow-blind; advertises unreachable categories (FM-AUDIT-003/004) |
| 4 | get_baselines | ladder STATED > DECLARED > MEASURED | NET | good pattern |
| 5 | get_transactions | `queryTransactions` | completes ≤100-row searches | `searchIsComplete`, coverage |
| 6 | get_income | streams | cadence | `sourceKey` feeds I1 |
| 7 | get_investments | composeInvestments | reshape | subset warning |
| 8 | get_net_worth_history | snapshots ≤1,100 rows | `observedChange` | **drops reconstructed label** (FM-AUDIT-020) |
| 9 | find_in_balance_history | snapshots full scan | exact first/last/min/max | good pattern |
| 10 | explain_net_worth_composition | `resolveExplorationNode` | composition only | renamed from "change" (ba47a82) |
| 11 | project_cash | cash spine | yes | refuses when a plan is in play; silent durable checkpoint |
| 12 | get_pay_dates | streams | cadence | consistent with get_income |
| 13 | investment_scenario | composeInvestments | today-only | boundary is description-only |
| 14 | scenario_projection | spine + ledger | yes | writes the envelope |
| 15 | scenario_crossing | same | forward walk ≤30 y | envelope when carrying an assumption |
| 16 | scenario_goal_seek | same + bisection | yes | IGNORE capture |
| 17 | reconcile_projection | SpaceMemory CHECKPOINT + history/spine | yes | settled vs in-flight |
| 18 | stage_assumptions | writes pending | — | provenance gate |
| 19 | recall | SpaceMemory | — | returns free-text `notedAs` |
| 20 | remember | writes SpaceMemory | — | provenance gate, no intent gate |

**Assessment:**
- **Dead:** none on the exposed surface. Behind it: `generateChatReply`, `context-builder.ts`, `domain-manifest.ts`, `domain-relevance.ts`, the `lib/ai/index.ts` barrel, a second `CHAT_MODEL='gpt-4o-mini'` constant, and evidence arms A0/A1/A3 (experiment scaffold).
- **Overlapping / contradictory:** "monthly spending" has **five figures on two bases** — get_spending (gross), measure_flows.perCompleteMonth (gross + `netOfRefunds`), get_baselines (net), project_cash daily rate (net) and the orientation `recent.spending` (90-day gross). Only get_spending has no net companion.
- **Too broad:** the three scenario tools each serialize the same ~11 KB `SCENARIO_INPUTS`. That is 38.5 KB, 57% of the 67,461-char (~16.9k-token) tool payload, and it is re-sent on every hop, up to 6 per turn.
- **Too narrow / intent taxonomy:** there are no pure question handlers. Many descriptions carry "Use it for '…'" example questions, and routing is demonstrably description-sensitive (the 0/5 → 5/5 swings recorded in project history).
- **Schema tricks the model must know:**
  - `compareTo.completeMonths` means "N months *before* period";
  - `monthsOfExpenses` vs `spendingWindow`;
  - `target:['highest_apr','investments']`;
  - `ignoreStaged`;
  - `granularity` vs `checkpoints`.
- **Argument hygiene:**
  - The 5 money tools refuse unknown arguments. The 12 read tools silently ignore them, and schemas are not sent `strict`.
  - A copied `asOf` on `get_net_worth_history` is dropped silently.

### 6.2 Verdict

The tool surface is **coherent in authority** (each tool reads one authority, and money is computed by code) but **not coherent in semantics**. The contradictory spending definitions, the unreachable category vocabulary and the reconstructed-label drop are the three places where two honest tools can give a user incompatible numbers.

---

## 7. Forecast / scenario architecture

### 7.1 Pipeline

| Stage | Where | Notes |
|---|---|---|
| Authoritative inputs | `loadForecastIncomeStreams` (`dateTo: asOf`); ACCOUNTS + TRANSACTIONS_SUMMARY | opening cash = `totalLiquid`; debt = `amountOwed` clamp |
| Normalization | `cadence.ts`, `stream-activity.ts`, `periodic-amount.ts` | amount basis always UNKNOWN ⇒ the licensed engine can never answer |
| Assembly | `assembleForecast` (`lib/ai/forecast/assemble.ts:201-512`) | one production call site (`tools.ts:1675`), CI-pinned |
| Periodic events | `occurrencesBetween` (**inclusive of asOf**) | → FM-AUDIT-008 |
| Scenario transforms | I1 `applyIncomeChanges` on events before both folds; spending override as an ASSERTS_FACT scalar | a dated spending change is not expressible |
| Fold | `foldWindow`: `closing = opening + Σ inflows − Σ outflows − dailyRate × days` | spending is one scalar NET rate |
| Spine | `spineFor`: independent `runTo(date)` per date, memoised per spending level | O(dates × events) |
| Liability dynamics + allocation | `settleMovements`: outflows → (spine dates only) ACT/365 interest + stated minimum → rules in stated order | → FM-AUDIT-009, FM-AUDIT-036 |
| Projection rows | `runScenarioLedger`: `liquid = spine − Σcontrib − Σoutflow − Σminimums` | identity pinned at every checkpoint |
| Crossings | `findScenarioCrossing`, month-end grain, `MONEY_EPSILON` | walk, never bisect |
| Goal seek | `solveForTarget` ≤80 bisection steps | refusals echo `assumptionsInForce` |
| Compaction | `planCheckpoints` ≤80, thinning with `omitted`; grouped excluded events | 30-yr payload 112 KB → 8.9 KB |
| Narration | `presentScenario`, `SCENARIO_QUALIFICATION`, `meaning` strings | several contracts live only here |

### 7.2 Capability matrix

| Capability | Status |
|---|---|
| Ordinary cash projection | IAP, with the FM-AUDIT-008 double count |
| Explicit cash movements | IAP |
| Liquid floors (`liquidFloor` + `fractionOfExcess`) | IAP; M1 `liquidFloorMonthsOfExpenses` derivation IWP |
| Investment contributions (amount / fractionOfLiquid / surplusFraction) | IAP (conservation at 0% pinned) |
| Liability payments (stated minimums) | IMPLEMENTED; **defective off-grid** (FM-AUDIT-009), under-accrues off-grid (FM-AUDIT-036) |
| Highest-APR waterfall | IAP |
| Ordered waterfall `['highest_apr','investments']` | IAP |
| Income changes (SCALE / SET_RATE / STOP / START) | IAP pure; composition through tools IWP (manual clone-DB check only) |
| Goal seek | IWP; spending cut does not re-resolve a months-of-expenses floor (FM-AUDIT-011) |
| Threshold crossings | IAP (month grain, 30-yr cap) |
| Long horizons | PARTIAL: `scenario_projection.to` / `goal_seek.by` unvalidated and uncapped; `'2030-12'` silently becomes 2030-12-01 (FM-AUDIT-038) |
| Checkpoint compaction | IAP |
| Unknown APR | IAP in both engines (unmodelled, never 0%) |
| Dated spending change (S1) | **NOT IMPLEMENTED** |

### 7.3 Do L1, M1 and I1 compose?

**Yes, genuinely, in one fold:**
- I1 lives inside the spine closure (`tools.ts:1674-1687`), so floors, waterfall, crossing and goal seek all see it.
- L1 settles in the same `settleMovements` walk as floors and contributions.
- M1's floor becomes a dollar literal before the ledger runs.

**Two caveats:**
1. The end-to-end composition through `prepareScenario` is proven only by a manual clone-DB script (`scripts/ai-baseline/income-change.check.ts`), not in CI (FM-AUDIT-010).
2. M1's floor is resolved once from the uncut spending level, so goal seek on `monthlySpendingCut` holds a stale floor (FM-AUDIT-011). That is the exact dependency S1 will stress.

### 7.4 Contracts that live only in prose

- The surplus base ignores minimums and outflows.
- A GROSS income rule removes income (correct under the no-tax doctrine, but relies on narration).
- Crossing month grain ("say by the end of that month").
- The `project_cash` vs `scenario_projection` minimums difference.
- "Months of expenses" differs between `get_baselines` (has a DECLARED rung) and the scenario floor (does not).

All are disclosed in outputs. None is wrong by itself; together they are the reason a figure verifier is needed (FM-AUDIT-017).

### 7.5 Latent trap

If a NET amount-basis producer is ever added, the licensed engine succeeds, `projection` is omitted by design, and every consumer (which reads only `projection?.closing`) goes null. Unreachable today (FM-AUDIT-068).

---

## 8. Transaction economics

### 8.1 Classification pipeline

Provider category → `mapPlaidCategory` (`plaid-category.ts:64-128`) → sync rescues (card-payment, payroll, REFUND-1 merchant-credit) → `classifyFlow` v5 (PFC first, then category, then sign) → persisted `flowType / flowDirection / classifierVersion / flowAuthority`.

Readers fold by `flowType` predicates:
- COST_FLOWS = SPENDING, FEE, INTEREST
- serialized spending = SPENDING, FEE
- spend-ledger = SPENDING, REFUND

### 8.2 Refund invariant — VERIFIED (IAP)

`incomeUnlessLiabilityInflow` (`flow-classifier.ts:349-358`) applies on **both** INCOME paths: PFC INCOME and the `Income` category. It covers:
- Plaid create/update, including re-delivery
- USER_RULE overrides
- the correction route
- CSV (a card `Income` row becomes UNKNOWN, never INCOME)
- historical rows, via `repair-liability-income-credits.ts`

`audit-flow-desync` (REQUIRED) recomputes every CLASSIFIER-owned row and would fail on a stored liability INCOME row. Read-time second line: `foldEconomicRow` drops `NOT_INCOME`.

**One ordering hazard:** the remediation the desync gate prints (`backfill-flowtype --only-version=N`) turns an unrepaired liability INCOME row into UNKNOWN. The repair script selects `flowType=INCOME`, so it can no longer find the row, and the refund netting is lost permanently while the gate goes green (FM-AUDIT-016). Production repair status is UNKNOWN from code.

### 8.3 Spending aggregation implementations (nine)

| # | Implementation | Membership | Refunds | Sign | Pending |
|---|---|---|---|---|---|
| 1 | `foldEconomicRow` / `economicTotals` (UI + AI headline) | row flowType ∈ COST_FLOWS | netted, clamp ≥0 | **abs (sign-blind)** | UI in |
| 2 | `categorySpendLedger` (UI category list) | COST_FLOWS ∪ REFUND by `category` | per category + `refundsUnapplied` | abs | in |
| 3 | AI `byCategory` / monthly `categoryAgg` | **every debit row in the category** (flow-blind) | `netOfRefunds` beside | split | settled only |
| 4 | AI `expenseTotal` | fold #1 | `refundTotal` beside | abs | settled |
| 5 | `NON_SPENDING_CATEGORY_NAMES` | category probe `classifyFlow({category, amount:-1})` | — | — | — |
| 6 | annotations `monthlyEquivalent` | {SPENDING, REFUND} (Fee excluded) | **GROSS** | — | settled |
| 7 | FORECAST-6 `deriveSpendingBaseline` | {SPENDING, FEE} | ignored | abs | — |
| 8 | `computeDebtService` | liability cost flows | separate | abs | settled |
| 9 | liquidity REAL_COST / CASH_OUT | liquid-tier cost flows | REFUND = CASH_IN | **sign-blind** | in |

**Status notes:**
- #7 is **DEAD**: no production caller.
- #1, #2 and #4 agree on the headline net.
- **#2 and #3 disagree on category lines** (FM-AUDIT-004).
- There are three category-membership rules (#2 row-flow, #5 {SPENDING, FEE}, #6 {SPENDING, REFUND}) (FM-AUDIT-005).

### 8.4 Other misclassification classes

Probe outputs come from real modules:

| Input | Result | Finding |
|---|---|---|
| Fee reversal (+$3) | spend $106 instead of $100 | FM-AUDIT-006 |
| Card interest reversal | INTEREST/OUTFLOW, counted as spend | FM-AUDIT-006 |
| Payroll clawback (−$500 on +$2,000) | income $2,500 | FM-AUDIT-015 |
| PFC `FOOD_AND_DRINK_GROCERIES` | **Dining** | FM-AUDIT-003 |
| MEDICAL, TRANSPORTATION, ENTERTAINMENT, PERSONAL_CARE, GENERAL_SERVICES, HOME_IMPROVEMENT, GOVERNMENT_AND_NON_PROFIT | **Other** | FM-AUDIT-003 |
| RENT | Utilities | — |
| User override "Shopping" on a PFC TRANSFER_OUT row | stays TRANSFER; PFC outranks the user | FM-AUDIT-014 |
| Card purchase vetoed from LOAN_PAYMENTS | SPENDING with category still "Payment" (27 live "Transfer"-labelled SPENDING rows per the desync audit header) | FM-AUDIT-005 |
| Checking refunds filed `INCOME_OTHER_INCOME` | counted as OTHER_INCOME (included), not netted | P3, noted |
| CSV `"deposit"` | → Income on any account | P3/P4, noted |

### 8.5 What S1 inherits (exact)

| Question | Today | Status |
|---|---|---|
| Current total spending | `foldEconomicRow`/`clampEconomicSpend`, NET per window/month | single authority; sign-blind (FM-AUDIT-006) |
| Baseline total spending | NET mean over reliable complete months; forecast rate = last-3-complete-month NET mean | IAP. **The older note "expense baseline still GROSS" is superseded** |
| Category spending | UI: row-flow, NET · AI: flow-blind, debit-only, GROSS | **DUPLICATED, divergent** |
| Category baseline | only annotations: GROSS, Fee excluded | weak / absent |
| Gross/refund/net | refund counts in its dated month, no purchase pairing; conservation `Σgross − Σrefunds = Σnet − ΣrefundsUnapplied` pinned | IAP |
| Category identity | `TransactionCategory` enum: stable but coarse; `pfcPrimary`/`pfcDetailed` persisted per row as a finer latent key; `PFC_SPEND_BUCKET` categorySource has no writer | PARTIAL |
| Category drift | forward-only user rules, re-derivation on Plaid modify, no version stamp | unmanaged (FM-AUDIT-012) |
| Date basis | economic date on both surfaces | IAP |
| Pending | UI in / AI out | divergent (FM-AUDIT-013) |
| Events vs rates | forecast spending = **one scalar daily RATE**, no categories, no dates | as expected by the S1 concept |

---

## 9. Liability architecture

| Dimension | L1 scenario ledger | `lib/debt/payoff.ts` (Debt page) | Same? |
|---|---|---|---|
| APR source | effective terms (DebtProfile > flat), per-scenario override | same resolver | ✔ |
| Unknown APR | accrue 0, `unmodelled`, basis NONE/PARTIAL | accrue 0 labelled, PRINCIPAL_ONLY/PARTIAL | equivalent arithmetic, different vocabulary |
| Interest formula | `round2(bal × apr/100 × days/365)` | identical | ✔ |
| Accrual dates | **spine dates only**; off-grid payments reduce the balance before accrual | each settlement on the outstanding balance | ✗ (ledger ~8% low: $2,217 vs $2,419 on $6k at 29.99%) |
| Minimums | fixed stated minimum on **every** spine date, on top of allocations | none; payment = total budget | ✗ (and the double charge, FM-AUDIT-009) |
| Allocation | avalanche / named / ordered; no pro-rata | pro-rata only | ✗ |
| Final payment | `min(amount, balance)`; unplaced stays liquid | day-precise, `unusedPaymentCapacity` | ✗ |
| Payoff date | month-end grain | exact day | ✗ |
| Non-amortising | **no warning** | `non_amortizing` status | ✗ (FM-AUDIT-037) |
| Aggregate / withheld debt | withheld + Σ line closings; `amountOwed` clamp | Space account balances | ✔ |

A third convention exists in `lib/debt/interest-cost.ts`: `apr/12` (30/360-like), used by the interest-cost widget. It is descriptive only.

**Measured contradiction.** Two cards ($3k at 29.99%, $3k at 9.99%) with $300/month:
- Debt page: **2028-10-13, $1,412 interest**.
- Chat: **end of August 2028, $879 interest**.

Neither surface names its convention.

**Is keeping two engines justified?** Yes, as products: a single-budget pro-rata planner and a cash-position scenario with minimums and waterfalls answer different questions. What is not justified:
- the undisclosed divergence;
- the accrual gap;
- the missing non-amortisation signal in the ledger.

The recommendation is a shared "accrue-to-date-then-pay" settlement primitive plus stated conventions on both surfaces. A merge is not recommended.

---

## 10. Provider / refresh architecture

| Provider | Authority | Timeout | Retry | Paging / high-water | Dedupe | Freshness |
|---|---|---|---|---|---|---|
| Plaid (SDK/axios) | bank balances, tx, holdings, inv-tx, item health | **none** | 2 attempts, 1 s | tx cursor persisted per fully-persisted page; inv-tx offset reconciled to provider total | plaid txn id + fingerprint; `externalItemId` unique | `lastUpdated` + `balanceLastUpdatedAt` |
| blockstream Esplora | BTC single-address confirmed balance + history | 10 s | 429/503 ×4 exponential, Retry-After | 25/page ≤40 pages, full re-fetch | txid + partial unique index + skipDuplicates | reconciled to 1 sat |
| blockchain.info | BTC xpub balance/discovery | 10 s | same | 50 addrs/call, discovery cursor | — | **includes unconfirmed** |
| Alchemy (ETH) | position; history by state bisection | position 10 s; **history none** | throttle only | 50k-block chunks, no persisted cursor | delete+recreate in tx | withheld from net worth until complete |
| Alchemy / SOL_RPC / Helius | SOL position + history | position 10 s; **history none** | none | 5×1000 sigs, no cursor | — | PARTIAL unless reconciled |
| Alchemy BNB/AVAX | balance only | 10 s | none | — | — | syncable, not creatable |
| CoinGecko | crypto INTRADAY quote + daily closes | **none** | none (429 → THROTTLED) | 365-day backfill chunks | PriceObservation unique, insert-only | provider instant |
| Tiingo | US equity close + splits | **none** | none | range | same | close date |
| OXR → Frankfurter | FX | 15 s | chain fallback | — | FxRate unique | date; weekend relabel refused |

**Orchestration:**
- **RefreshExecution:** every Plaid path goes through `runFullRefresh`. Status is SKIPPED / FAILED / PARTIAL / SUCCEEDED by a closed rule. IAP. Orphaned RUNNING rows are never closed (FM-AUDIT-049).
- **Scheduler:** slot-based dispatcher behind `CRON_SECRET` (fails closed). There is no `(job, slot)` idempotency, so a duplicate cron delivery runs a job twice. Item lease and unique indexes prevent corruption.
- **Policies:** BANK 24 h / WALLET 6 h. Cadence must be a multiple of the derived attempt period; the old "8 h accepted, 12 h delivered" hole is closed. IAP.
- **Manual refresh:** rate limit 20/h → admission → 60-min cooldown → lease → 409. A 409 still consumes the cooldown (P3).
- **Plaid item lease:** `syncLockedAt` conditional `updateMany`, TTL 360 s, used by every Plaid caller. No owner token.
- **Wallets:** no lock; unique-index backstops only.
- **No synchronous provider call on page render or AI tool paths.** Three user POST routes await provider work inline with no timeout and no `maxDuration`: `accounts/[id]/sync`, `accounts/wallet`, `connections/build-intelligence`.

---

## 11. Crypto

Current authority map from code. Commits edfde14, 9c27fc9, 493d3a3 and caf2699 are all in HEAD and behave as their messages state.

| Chain | Balance | Tx history | Current price | Historical price |
|---|---|---|---|---|
| BTC single | Esplora confirmed | Esplora `/txs/chain` | CoinGecko INTRADAY | CoinGecko RAW_CLOSE |
| BTC xpub | blockchain.info multiaddr (incl. unconfirmed) | Esplora per derived address | same | same |
| ETH | Alchemy `eth_getBalance` | state bisection (no tx import), withheld from net worth | same | same |
| SOL | getBalance finalized | signatures + getTransaction, withheld | same | same |
| BNB / AVAX | Alchemy `eth_getBalance` | none | same | same |

| Known issue | Verdict | Evidence |
|---|---|---|
| Stale current valuation | **PARTIAL** | quote used only if valuation date = quote date = today (CURRENT ≤6 h, then DELAYED). VALUED keys on quantity freshness, so a ≤7-day close yields a "fresh" value; the AI assembler drops the price-basis label |
| Current-price authority | **FIXED** (493d3a3) | `coingecko.ts:401-439` |
| Tx-history authority | **FIXED** for BTC; **OPEN** for ETH/SOL | FM-AUDIT-052 |
| Position-before-history | **FIXED** (caf2699) | `btc-sync.ts:879` before `:952` |
| Price timestamp (two clocks) | **PARTIAL** | provider instant stored; `fetchedAt` semantics differ between INTRADAY and close (documented) |
| Snapshot consistency | **PARTIAL** | BTC regen decision ignores today's quote (P4) |
| Historical depth | **OPEN** (limited) | CoinGecko Demo 365-day floor |
| NOT_PRICEABLE separation | **PARTIAL** | engine emits NO_PRICE correctly; consumers fall back to the stored column (FM-AUDIT-022) |
| xpub vs single-address | **PARTIAL** | documented, not reconciled; a malformed multiaddr 200 → 0 BTC (FM-AUDIT-053) |
| ETH history pending (Alchemy -32000) | **OPEN** | any non-429 JSON-RPC error is fatal, no batch shrink |

---

## 12. Plaid

| Area | Status |
|---|---|
| **Redirect URI** | **IAP.** `resolvePlaidRedirectUri()` = `PLAID_REDIRECT_URI` (dev override, drift-warned) else `env.NEXT_PUBLIC_APP_URL + /plaid-oauth-return`; `NEXT_PUBLIC_APP_URL` required in production. A grep of every Plaid route/lib/return page for Host / Origin / X-Forwarded-* finds **zero hits**. Both call sites use the resolver. `redirect-uri.test.ts` passes. |
| Link token | IMPLEMENTED; rate-limited; 730 days requested |
| Update / reconnect | IMPLEMENTED; ownership-checked; same-item heal on exchange |
| Token exchange | IMPLEMENTED; admission before spending the one-time token; duplicate-institution gate (check-then-act race, P4) |
| Access-token encryption | IAP (AES-256-GCM, HKDF per purpose); stored twice (PlaidItem + Connection, rotated together) |
| Transactions sync | IAP (cursor held on persistence failure). MUTATION_DURING_PAGINATION restarts from the mid-loop cursor (P3, MEDIUM) |
| Holdings / investment tx | IAP (COMPLETE only at provider total) |
| ITEM_LOGIN_REQUIRED | PARTIAL: detected only when a sync hits it; cron/manual select ACTIVE only, so LOGIN_REPAIRED is never observed; ITEM webhooks ignored (FM-AUDIT-051) |
| Webhooks | signature IAP (ES256, alg pinned, body sha256, 5-min iat); coverage PARTIAL (TRANSACTIONS + HOLDINGS DEFAULT_UPDATE only) |
| Historical expansion | admin-only, 730-day cap |
| **Log hygiene** | **PARTIAL: FM-AUDIT-001 (P1)** |

**Operational only, not code defects:**
- the preview-deployment return URL must be registered in the Plaid dashboard;
- `PLAID_REDIRECT_URI` must stay unset on Vercel;
- whether `PLAID_SECRET` was rotated after the 2026-07-22 exposure is **UNKNOWN from code**.

---

## 13. Historical reconstruction

| Period / asset | Label | Classification |
|---|---|---|
| Today's row | `isEstimated=false` ("Observed"); `incomplete` only on an FX miss; crypto `stale` flag | **OBSERVED, but may be stale-sourced** (FM-AUDIT-021) |
| Past days with an existing observed row | frozen, skipped | AUTHORITATIVE |
| Past days, auto regen | `isEstimated=true`; cash `derived`/`estimated`; crypto `estimated`; investments A8 tier | RECONSTRUCTED |
| Component unsupported, stored row exists | stored component kept, tier ≥ `incomplete` | PARTIAL |
| Component unsupported, no row | not written | UNKNOWN (gap) |
| Crypto without historical price | `cryptoValuationStatus='unavailable'`; AI net worth null with reason | NOT PRICEABLE |
| Accounts before their transaction floor | **silently excluded; tier stays `derived`** | should be PARTIAL (FM-AUDIT-031) |
| Investment positions before walk start | held constant at `estimated`; refused if the walk FAILED | RECONSTRUCTED |
| Stale price | ≤7 days `estimated`, then unvalued | RECONSTRUCTED → NOT PRICEABLE |
| Backfill rows | `isEstimated=true`, no tier (reads `unknown`) | RECONSTRUCTED |

**Conservation:**
- The investment walk stores `unexplainedOpeningQuantity` and never forces zero. It is COMPLETE only within 1e-6.
- A negative residual from a non-COMPLETE walk is refused at valuation.
- There is no mid-walk non-negativity check (P3, LOW).
- The cash/liability backward walk is posted-only `derived`: IWP.
- UNKNOWN: whether Plaid card balances are posted-only, which decides whether the card walk-back is exact.

**Wiring:**
- Production triggers exist: `reconstructAccount` from background sync, and regen from sync, wallet and background paths.
- DEAD: the read model `describeReconstruction` (the "N shares already held before…" disclosure) is test-only.
- SCAFFOLD: the three-axis depth vocabulary (UNREACHABLE / BACK_PROJECTED) is script-only.
- The UI carries labels per point (IAP). **The AI does not** (FM-AUDIT-020).

---

## 14. Daily Brief

**IAP overall.** Pinned by lifecycle, state, watermark, digest, store, licence, generate, package, load and relevance tests; all pass.

| Aspect | Implementation |
|---|---|
| GET | inspect-only; **never calls the model** (pinned by `brief-authority.test.ts`) |
| POST | ensure: NO_DATA / FRESH / watermark-only refresh / cooldown (3 min) → atomic claim (90 s lease, fencing token) → one structured call (75 s budget) → validate → persist. Failure never touches content |
| Persistence | `DailyBrief @@unique(spaceId, ownerUserId, briefDay)` |
| Watermark | 25 inputs (links, accounts, debt profiles, connections, items, tx/events, positions + 7-day hash, reconstruction hash, prices 14 d, FX, 1,100 snapshot rows, Space, declared expenses, memory, refresh policy) + **hourly clock bucket** |
| Digest | $1k buckets <$50k, 2% geometric above; verdict codes; activity signatures; versioned `brief-material-v3` |
| Version | `BRIEF_GENERATION_VERSION='brief-generation-4'` hand-bumped; `BRIEF_PROMPT_HASH` diagnostic, pinned |
| Deterministic vs model | metric row + data health are deterministic on every GET; prose from one call; headline refused on an unlicensed figure; observations dropped for unlicensed / evidence-less / freshness-only; `quiet` derived, not trusted |
| Fallback | prior Brief ≤2 days old, and only if its balance anchor has not gone STALE |
| Economics | cost computed at read from AiInvocation usage; previously measured ≈ $0.003/Brief |

**Can it become inconsistent with newly refreshed data?** Yes, bounded:
- A refresh moves the watermark, so the next GET returns CHECK_REQUIRED, the client POSTs, and a material digest change regenerates.
- Below materiality ($1k / 2%), the old prose keeps its exact figures while the metric row beside it shows the new snapshot figure. Only "Brief updated HH:MM" explains the gap (FM-AUDIT-060).
- A degraded package (failed holdings read) is not disclosed and reads as "0 unvalued" (FM-AUDIT-060).
- The licence checks the value set, not what each figure refers to.

---

## 15. Markets

**SCAFFOLD ONLY: honest and clearly labelled.**
- The code is `lib/markets/markets-mode.ts` (48 lines) and `MarketsWorkspace.tsx`.

| View | Real data | Persistence | API | AI | UI |
|---|---|---|---|---|---|
| Portfolio | none | none | none | none | honest empty state |
| Research | none | none | none | none | honest empty state |
| Fundamentals | none | none | none | none | honest empty state |
| Technicals | none | none | none | none | honest empty state |
| Watchlist | none (no model) | none | none | none | honest empty state |

- **Real:** navigation, `?view=` URL state, and an empty trust envelope so no chip lingers. All tested.
- **No fake quotes, charts or tickers.** No dead API paths.
- **Estimate: ≈5% real (routing and state) / 95% scaffold (product functionality 0%).**
- Security data exists elsewhere (holdings, prices, concentration) and is shown under Net Worth → Assets.

---

## 16. UI truthfulness

| Value | Source → display | Verdict |
|---|---|---|
| Net worth hero | snapshot → `computeWealthTimeMachine` → `WealthHero` (cents, resolved date, Observed/Reconstructed chip) | correct for its source; inherits FM-AUDIT-021 |
| Brief net worth | snapshot summary (whole dollars outside the Space, per contract) | correct |
| Account balances | `lib/data/accounts.ts` → `AccountsLedger` | **"Synced" ignores balance age** (FM-AUDIT-030); **unpriced or unobserved wallet shown as a number** (FM-AUDIT-022) |
| Cash Flow tiles | one fact set for hero and tiles; coverage note on capped reads | correct; minor sign rendering (P4) |
| Debt / payoff | `amountOwed` positive everywhere; unknown APR disclosed | "by {date}" on an estimate and the hero's "Est. interest" lacks a known-APR qualifier (P3); `/dashboard/credit`: "−$0", whole dollars in Space, own "available" (P3) |
| Investments | unpriced "—", "Nd stale", "N of M valued" | correct; Investments hero vs Wealth "Investments & crypto" parity UNKNOWN |
| Freshness chrome | oldest balance, value-weighted, no "Live" wording | correct; Spaces manage panel labels snapshot date "Updated" (P3) |
| Liquidity | names declared vs measured baseline | correct |
| FX miss | "≈ $0.00" in ledger; InterestCost substitutes 0 | P3 (production currently all-USD) |
| Zero rendering | "−$0.00" red / "+$0.00" green | P4 (`lib/currency.ts` rounds after sign) |
| Scenario vs actual | chat only; envelope separates `assumptions`; `SCENARIO_QUALIFICATION` prose | no UI confusion found |
| Measured vs declared | liquidity, get_baselines basis | correct |

---

## 17. Security

**Sound:**
- Every one of 185 handlers has a guard: platform (49) `requirePlatformAccess` with fresh WRITE/CONTROL on mutations; admin (15) `requireSystemAdmin`; Space routes check ACTIVE membership in the DB; owner checks on accounts/Plaid/connections; `CRON_SECRET` fails closed; Plaid webhook ES256; public routes IP-rate-limited.
- No `$queryRawUnsafe` / `$executeRawUnsafe` / `Prisma.raw`; no `child_process`; no SSRF (fixed hosts, encoded path params).
- No scripts reachable over HTTP; platform operations use a closed registry.
- No mutation on GET.
- Plaid tokens AES-256-GCM with HKDF; invite and reset tokens stored as SHA-256 hashes.
- HSTS, XFO DENY, nosniff, Referrer-Policy and Permissions-Policy set.
- Chat Space binding: 403 on named-Space mismatch.

**Findings:**
- **FM-AUDIT-001 (P1):** Plaid secret and tokens in logs.
- **FM-AUDIT-027 (P2):** import rollback lacks the visibility-tier gate that import has; batch ids leak through the activity feed. Result: a Space ADMIN can soft-delete another user's BALANCE_ONLY/SUMMARY_ONLY-shared history.
- **FM-AUDIT-028 (P2):** open redirect via `callbackUrl` (`//evil.example` passes `startsWith("/")`).
- **FM-AUDIT-029 (P2):** `/api/users/search` enumerates the user directory and is a membership oracle for any Space id.
- **P3:** FM-AUDIT-054 (owner self-leave / PERSONAL DELETE), FM-AUDIT-055 (`DISABLE_SYSTEM_ADMIN` not applied to platform authorization), FM-AUDIT-056 (two IP authorities, `cf-connecting-ip` trusted first), FM-AUDIT-059 (CSP Report-Only with unsafe-inline/eval).

**Weakly proven:**
- CSRF rests on NextAuth's default SameSite=Lax cookie plus JSON bodies, with no pin.
- Route auth is proven by regex source scans; only 3 tests import a route handler.
- A false security comment claims "buildContext() validates Space membership before invoking any assembler" (`assemblers/transactions.ts:42`, `snapshot.ts:32`). `buildContext` is dead; the real gate is the route's `resolveSpaceContext` + 403.

**UNKNOWN:** whether Cloudflare fronts production with origin lock-down; the runtime behaviour of `router.push("//host")` (framework knowledge, not executed).

---

## 18. Database / migration safety

| Script | Guard | Guard/backup inspect | Prisma hits |
|---|---|---|---|
| `db:migrate` | refuses non-interactive runs on a populated/unknown DB | `DATABASE_URL` | **`DIRECT_URL`** |
| `db:reset` | `ALLOW_DESTRUCTIVE_DB=true` only | `DATABASE_URL` | **`DIRECT_URL`** |
| `db:migrate:safe` | backup only | backup of `DATABASE_URL` | `DIRECT_URL` |
| `db:seed` | refuses prod/preview and any non-demo user (override `SEED_ALLOW_DESTRUCTIVE=1`) | `DATABASE_URL` | same (then unscoped `deleteMany`) |
| `db:wipe` | env flag + pg_dump + typed `host/db` + Plaid teardown | `DIRECT_URL ?? DATABASE_URL` (consistent) | same |
| `dev:reset-test-state --apply` | dry-run default only | — | **defaults to the operator's own account**; Plaid `itemRemove` + hard deletes, no backup |
| `build` / Vercel deploy | no migrate | — | — |

**Verified OK:**
- no `db push`, `--force-reset` or `--accept-data-loss` outside docs;
- `$executeRaw` is tagged and scoped;
- the only DDL is `db-wipe`'s `DROP SCHEMA`;
- `db:migrate` fails closed on an unreachable DB;
- `npm run ci` never touches a developer DB (strips URLs, arms clone-only, container only).

**How the guard works:**
- `lib/db/live-guard.ts` classifies by DB **name**: `fintracker`/`postgres` = LIVE, `fintracker_*` = clone, anything else UNKNOWN.
- It is armed only by `FM_DB_GUARD=clone-only`, and only in `lib/db.ts:27` on the runtime `DATABASE_URL`.
- `scripts/db-guard.ts` never consults it.

**Answer — can a supported repo command still accidentally destroy the live DB?** **Yes, under one realistic misconfiguration:**
- `DATABASE_URL` points at a clone while `DIRECT_URL` still names `fintracker`.
- The documented clone recipe (`database-safety.md` §4a) rewrites only `DATABASE_URL`, and `.env.local` sets both to `fintracker`.
- In that state `ALLOW_DESTRUCTIVE_DB=true npm run db:reset` backs up the clone and resets live.
- An empty clone also lets `db:migrate` run `migrate dev` non-interactively against live.
- With both URLs on the same DB, the guards work as designed.
- ✔ Verified structurally: `schema.prisma:12` `directUrl`, `db-guard.ts:75`, `db-backup.ts:25`. Not executed.

**Also:**
- the README tells people to run `npx prisma migrate dev`, the incident command (`README.md:109,142`; `deployment.md:205`), and `cp .env.example .env`;
- the safety doc overclaims clone enforcement ("Not by convention: the guard refuses otherwise");
- the printed restore command omits the PG16 `transaction_timeout` filter;
- no restore drill has ever been performed;
- 17 mutating scripts sit outside the registry's 6 governed prefixes.

---

## 19. API / routes

- **Inventory:** 168 route files, 185 handlers, no server actions. The API boundary is per-handler; `proxy.ts` covers pages only.
- **Highest-risk endpoints:**

| Endpoint | Risk |
|---|---|
| `POST /api/imports/[id]/rollback` | cross-user soft delete (FM-AUDIT-027) |
| `GET /api/users/search` | enumeration (FM-AUDIT-029) |
| `DELETE /api/spaces/[id]/members/[userId]` | owner self-leave → lockout (FM-AUDIT-054) |
| `POST /api/accounts/[id]/import` | no caps, non-atomic, no concurrency guard; a timed-out batch stays PROCESSING and cannot be rolled back (FM-AUDIT-058) |
| `POST /api/spaces/[id]/wealth/amend` | unbounded `fromDate` (46k-day loop + provider backfill) (FM-AUDIT-038) |
| `POST /api/ai/chat` | no turn deadline, no cost budget, admin rate-limit exempt (FM-AUDIT-039/044) |
| `GET /api/spaces/[id]/expense-baseline` | mixes Spaces for archived Spaces (FM-AUDIT-057) |
| `GET /api/spaces/[id]/transactions` | up to 5,000 rows per response (P3 perf) |

- **Validation:** ad hoc, with 0 zod imports. 38 bare `await req.json()` calls return 500 on malformed JSON. Raw `e.message` is returned in wealth/amend and merchant-ops (P4).
- **Status codes / swallowed errors:** mostly consistent. Chat maps all failures to sentences and keeps details server-side. The exception is tool errors, whose raw message is fed to the model (FM-AUDIT-041).

---

## 20. Concurrency / idempotency

| Operation | Mechanism | Verdict |
|---|---|---|
| Plaid refresh (double-click, tabs, scheduler + manual, webhooks) | DB lease `syncLockedAt`, 360 s | IAP within ≤300 s callers; no owner token; release clears `syncIncompleteAt` (FM-AUDIT-024) |
| Wallet sync | none (unique-index backstops) | PARTIAL |
| Scheduled jobs | fresh UUIDs, no slot key | SCAFFOLD (duplicate delivery ⇒ double run) |
| resume-stale-imports | every 5 min, no backoff | retries a failing item forever (FM-AUDIT-048) |
| RefreshExecution after kill | stays RUNNING | orphan (FM-AUDIT-049) |
| Daily Brief | conditional claim + lease + fencing + unique day row | IAP |
| Memory writes | `supersedesId @unique` → P2002 → 409 | IAP |
| Scenario state (tabs) | sealed cookie, last-writer-wins, mismatch ⇒ no state | benign loss, not corruption |
| Platform policies | `expectedUpdatedAt` optimistic token, one tx + audit | IAP |
| Admin security settings | no token, not transactional | P4 |
| Import rollback | conditional status claim in tx | IAP (auth gap separate) |
| CSV import | no claim, no DB uniqueness | double submit ⇒ duplicate rows (FM-AUDIT-058) |
| Invites / beta redemption | unique + upsert / conditional update in user-create tx | IAP |

**Answer — can concurrent operations corrupt or duplicate state?**
- Corrupt: **no path found** for financial ledgers.
- Duplicate: **yes, in two places.** CSV transaction import on double submit, and duplicate job executions (extra provider calls; possible double alert emails).
- Lost signals, not corruption: `syncIncompleteAt` erasure and cookie state loss.

---

## 21. Performance

| Path | Evidence | Class |
|---|---|---|
| AI turn | ≤6 model calls; ~16.9k-token tool payload re-sent each hop; history ≤160k chars; sequential tool execution; four full assemblers + activity frame per turn; OpenAI SDK default 10-min timeout, 2 retries | USER-VISIBLE (latency and cost) |
| Goal seek / long horizons | ≤80 bisection runs × monthly spine (forced by liabilities) × independent `runTo` per date; `to`/`by` uncapped | THEORETICAL → USER-VISIBLE |
| Wealth amendment | day loop from an unbounded `fromDate` + provider backfill | USER-VISIBLE (self-scoped) |
| CSV import | several sequential queries per row, no cap | USER-VISIBLE |
| Transactions list | up to 5,000 rows (multi-MB) | USER-VISIBLE |
| ETH history | full rebuild 50k-block chunks, no cursor (incremental path exists for checkpoints) | BACKGROUND |
| SOL history | ≤5,000 sequential `getTransaction` per sync, newest-first rescan | BACKGROUND |
| 06:00 dispatch slot | sync-banks all items with no budget before sync-crypto in one 300 s function | BACKGROUND (scale-dependent) |
| `[sctx]` logging | 4–6 unconditional `console.log` lines per `getSpaceContext` in production ("temporary — perf audit") | BACKGROUND (log cost) |
| Daily Brief | one call; watermark = 25 queries; cheap | fine |
| Snapshot regen on mutation | sequential per Space | USER-VISIBLE, bounded |

No measurement was run against live data. All classifications are static.

---

## 22. Tests / audits

**Inventory:**
- 588 `*.test.ts` files; each is a tsx script in its own process, with no framework.
- Distribution: lib/transactions 76, components 70, lib/ai 62, lib/investments 52, lib/platform 46, lib/crypto 25, lib/snapshots 20, lib/plaid 18, lib/prices 16, lib/data 15, lib/forecast 11, app 9, scripts 7, plus a long tail.
- **All unit tests are DB-free.** DB-backed checks exist only as REQUIRED audits and as manual harnesses (16 `scripts/ai-baseline/*.check.ts`, not in CI).
- Mutation tests: 4 suites (forecast engine, operating-state, periodic-amount, policy) through `lib/test-support/mutant-module.ts`.
- Golden tests: 13 files.

**Quality concerns:**
- **Source scans dominate:** 326 of 588 files read source text, 173 import no product module at all, and 17 pin exact `aria-label` strings. These pass while behaviour is wrong, for example the right call on the wrong branch, and they break on harmless refactors.
- **Route-level auth/403 is proven only by regex.** Only 3 of 168 route files are imported by a test.
- **Tests pinning wrong behaviour:**
  - `projection.test.ts` I4/I7 pin "income dated from asOf" (FM-AUDIT-008).
  - `brokerage-cash.test.ts:50,58` pins a non-canonical completeness value.
  - Privacy proofs exercise `computePayoffAggregate`, which the product never calls; the live payoff engine has no privacy proof (FM-AUDIT-064).
- **Money fixtures never contain:**
  - a positive FEE or INTEREST row (FM-AUDIT-006);
  - a negative INCOME row (FM-AUDIT-015);
  - an off-month-end spine date with a minimum (FM-AUDIT-009);
  - a stream settling on asOf (FM-AUDIT-008);
  - a pending row in UI↔AI parity (FM-AUDIT-013);
  - a PFC row with a user category override (FM-AUDIT-014).

**REQUIRED audits (22):**
- flow-desync
- crypto-banking-leak
- banking-population
- economic-date-persistence
- chronology-basis
- chronology-cutover
- event-identity
- event-reader-cutover
- pending-posted-desync
- lifecycle-identity
- ui-truth-convergence
- debt-payment-attestation
- cashflow-debt-defect
- ai-read-parity
- transfer-identification
- snapshot-window-claims
- transfer-authority
- check-snapshot-integrity
- goals-tombstone (source)
- crypto-holding-tombstone (source)
- read-identity-consumers (source)
- forecast-slice-provenance (source + git objects)

All assert invariants, which is correct. However:
- **None has a negative control.** No audit is shown to fail on a planted violation.
- CI runs them on a seeded corpus of 4 users, 8 Spaces, 21 accounts and ~360 transactions.
- `audit-seed-coverage.ts` admits `audit-event-identity` and `audit-snapshot-window-claims` pass vacuously on it.
- Verdict: the gate is **IWP** (FM-AUDIT-035). The 4 source/git audits are meaningful regardless of corpus.

**Important invariants with no executable pin:**
- migrate target = guarded/backed-up target (FM-AUDIT-002);
- a backup restores (FM-AUDIT-062);
- production schema = committed migrations at deploy (manual `db:drift` only);
- each REQUIRED audit can fail;
- route-level auth behaviour;
- `npm test` never reaches a DB (run-tests does not scrub URLs);
- harnesses do not write live;
- chat answer figures are licensed;
- category spend parity UI↔AI;
- composition I1 × L1 × M1 × goal seek in CI;
- Plaid log redaction.

**Does `npm run ci` meaningfully represent production correctness?** Partially:
- It faithfully represents *GitHub CI* (same steps, Node, clean copy), and CI is green for a real reason.
- It represents *production correctness* only for deterministic pure logic plus invariants on a small seeded corpus.
- It does not exercise:
  - routes as requests;
  - the model boundary (routing, prose arithmetic);
  - providers;
  - real-data category and classification distributions;
  - schema-vs-production drift;
  - restore.

---

## 23. Documentation drift

| Doc | Stale claim | Code truth | Sev |
|---|---|---|---|
| `docs/systems/ai-foundation.md:22-25,369-378` | chat returns `503 AWAITING_REDESIGN`; stateless; no orchestration; memory not built | live 20-tool engine, SpaceMemory, DailyBrief, AiInvocation; the test asserts "the redesign refusal is gone" | P2 |
| `STATUS.md` (status-drift process owns it) | AI reset / 503; "Recently landed" stops 08-17; 163 routes, 77 scripts, 88 migrations | 168 routes, 90 scripts, 106 migrations; M1/I1/L1, Memory V2, CI parity unmentioned | P2 (reported, not claimed) |
| `README.md:109,142,154,90`; `deployment.md:205` | `npx prisma migrate dev`; `cp .env.example .env`; `db:migrate` = "run pending migrations" | the incident command; `.env.local`; doctrine is `db:migrate:safe` | P2 |
| `README.md:34` | seven chains (BTC, ETH, SOL, BNB, MATIC, ADA, XRP) | product offers BTC/ETH/SOL; ADA/XRP don't exist | P3 |
| `README.md:10,19,119,126` | `doctrine/`, `design/` dirs; goals; two demo users; `admin@example.com` | none exist; goals retired; 3 users + `sysadmin@example.com` | P3 |
| `docs/systems/forecast.md:205` | "both the model path and the guard are gone"; no I1 / L1 / scenario ledger | all exist | P3 |
| `docs/systems/debt.md:14-26` | `computePayoffAggregate` is the figure of record | dead; `lib/debt/payoff.ts` + `DebtProfile.apr` undocumented | P3 |
| `docs/systems/platform-operations.md` | no CONTROL / Policies / RefreshExecution | all exist | P3 |
| `docs/operations/database-safety.md:42-43,127` | guard blocks unless ALLOW_DESTRUCTIVE_DB; "Not by convention" | migrate-dev mode differs; guard inert unless armed; DIRECT_URL not mentioned | P3 |
| `.env.example:164-167` | "nothing issues a chat completion"; retired AI_* flags | live; flags removed from code (still set in `.env.local`) | P4 |

**Code comments (P4, one security-relevant):**
- `route.ts:5` "sixteen tools / Clip 6"
- `tools.ts:4-5` "thirteen adapters"
- `provider.ts:13-14,63,179-180` (gpt-4o-mini; "NO production caller … 503")
- **`assemblers/*.ts` "buildContext() validates Space membership" (false premise)**
- `memory-tools.ts:12` "NO MEMORY IS INJECTED INTO ANY PROMPT"
- `route.ts:27-31` "Nothing about a conversation is stored"
- `scenario-ledger.ts:34` / `scenario.ts:13` "research code under scripts/"
- `run-tests.ts:100` lists a deleted test
- `flow-classifier.ts:84` references a deleted repair script
- `plaid-oauth-return/page.tsx:19`
- `sync-lock.ts:40-42` "60s budget"
- active-scenario test "3,000 chars"

**Project-memory notes superseded by current code:**
- "expense baseline still GROSS" (now NET);
- "all 6 flags default to OLD" (flags removed);
- "cookie ~3000" (3,900);
- "I1 bare-turn composition 1/6" (pending plan now carries it, 6/6);
- "AiInvocation SDK bypass" (single chokepoint now).

Node 24 is documented consistently.

---

## 24. Dead / duplicated / superseded code

| Item | Class | Confidence |
|---|---|---|
| `lib/ai/intelligence/debt-payments.ts` | DEAD (orphaned by the AI reset) | high |
| `lib/ai/{context-builder,domain-manifest,domain-relevance}.ts`, `lib/ai/index.ts` barrel, `generateChatReply`, provider `CHAT_MODEL` | DEAD | high |
| `components/brief/{BriefModal,BriefLogo,HeroRegionProvider}.tsx`, `lib/hero-region.ts` | DEAD | high |
| `components/space/widgets/{TimelineWidget,AssetValueWidget,ProgressWidget}.tsx`, `GlassModal`, `InlineFilter`, `atlas/tones.ts`, `UserButton` | DEAD | high |
| `computePayoffAggregate` | DEAD in product (test-only) | high |
| `lib/forecast/spending-baseline.ts` `deriveSpendingBaseline` | DEAD (gross; must not be revived as an authority) | high |
| Licensed engine `forecastCash` as an answer path | DEAD (disclosure only) | high |
| `reconstruction-read.ts` read model | DEAD (test-only; worth wiring) | high |
| `compaction.ts` (Clip 6) on the production route | harness-only | high |
| evidence arms A0/A1/A3 | SCAFFOLD (experiment) | high |
| `lib/forecast/obligation.ts`, `lib/platform/capability-classification.ts` | SCAFFOLD by design (documented) | high |
| `fetchAddressTxCount` (btc-explorer) | DEAD | high |
| Schema: `SpaceGoal`, `GoalCheckIn`, `GoalContribution`, `Holding`, `AiAdvice` | DEAD schema awaiting a migration train | high |
| `cloudflared/config.yml` | DEAD scaffold | high |
| Retired AI flags in `.env.local` / `.env.example` | DEAD config | high |
| Per-job routes beside the dispatcher | DUPLICATED (intentional fallback) | high |
| Liability engines (ledger vs payoff) | DUPLICATED semantics (justified products, undisclosed divergence) | high |
| Nine spending aggregations (§8.3) | DUPLICATED (#2 vs #3 divergent) | high |
| Two client-IP authorities | DUPLICATED | high |
| Plaid token stored twice | DUPLICATED (rotated together) | high |
| `_v26pre_bundle/`, `prototype/`, `tmp/`, `backups/` | untracked local artefacts (0 tracked files) | high |

---

## 25. S1 readiness

**Question: is the architecture ready for S1, category spending changes?**

**The engine is ready. The spending semantics are not.**

- **Canonical current spending authority:** `foldEconomicRow` / `clampEconomicSpend` (`lib/transactions/cash-flow.ts:311-337`). It is NET, economic-dated, and shared by UI and AI. It is sign-blind for cost inflows (FM-AUDIT-006).
- **Baseline spending authority:**
  - forecast: `deriveObservedSpendingRate`, the last ≤3 reliable complete months of NET spend (`observed-spending.ts:113-141`, `assemble.ts:486-494`);
  - measures: `economicSpendingOf` (NET);
  - liquidity: `meanPerReliableMonth` over all reliable months (a different window, disclosed).
- **Gross/refund/net:** a refund counts in its dated month with no purchase pairing. Per-category net clamps with `refundsUnapplied` (UI only). Conservation is pinned at the aggregate. **Σ per-category net ≠ month-level net whenever refunds exceed a category's charges**, so S1 must choose one definition and pin the reconciliation.
- **Category identity:**
  - `TransactionCategory` enum, stable but coarse.
  - Groceries and the six MI1 categories are unreachable from Plaid.
  - Dining absorbs groceries, and Other absorbs about seven PFC primaries.
  - `pfcPrimary`/`pfcDetailed` are persisted on every Plaid row and are the natural finer key.
- **Category change over time:** unversioned. User rules apply forward only, and Plaid re-delivery re-derives categories.
- **Events vs rates:** forecast spending is **one scalar daily rate**, NET, constant over the horizon, with no categories and no dates. This matches the expected S1 concept (spending is a rate).
- **Where S1 attaches** (single seam, parallel to I1):
  1. generalise `foldWindow`/`dailyRateOf` in `lib/forecast/projection.ts:93-139` to `spendBetween(from, to)` over a piecewise schedule, so interval ≡ cumulative still holds;
  2. build the schedule in the adapter as a typed `spendingChanges` input, parallel to `incomeChanges` (`assemble.ts:400-419`), not as an ASSERTS_FACT scalar;
  3. place it inside `buildCashSpine`'s closure (`tools.ts:1674-1687`) so floor, waterfall, crossing and goal seek inherit it;
  4. the ledger needs no change.
- **Dependents that read the scalar and must be re-specified:**
  - the M1 months-of-expenses floor (FM-AUDIT-011);
  - goal-seek `monthlySpendingCut` base and upper bound (cut relative to which segment?);
  - projection `range`;
  - the licensed engine's `spending.dailyRate` (refuse or ignore explicitly);
  - the envelope (new arrays against the 3,900-char seal, FM-AUDIT-018).
- **Assumptions S1 would inherit:**
  - the category ledger is net and flow-aware in the UI but gross and flow-blind in the AI;
  - categories are coarse and drift silently;
  - pending is excluded from AI measures;
  - fee/interest reversals add to spend;
  - today's paycheque is double counted on paydays, which contaminates every S1 before/after comparison;
  - off-grid spine dates double-charge minimums (S1 adds change dates to the spine).

**Must be repaired before S1 (Gate A):** FM-AUDIT-003, 004, 005, 006, 007, 008, 009, 010, 011, 012 (disclosure), 013 (if S1 covers the current month), 018, 019.

**Can safely wait (not S1 foundation):**
- all provider, crypto, Plaid, history, Brief and UI items;
- security items (but see the immediate list in §27);
- liability engine convergence;
- the chat figure verifier (desirable in parallel);
- test-style debt;
- docs;
- dead code.

---

## 26. Findings register

**Column legend:**
- **Sev/Conf:** severity P0–P4 / confidence (PROVEN, HIGH, MEDIUM, LOW). ✔ means re-verified in source by the lead auditor.
- **Reach:** whether the defect is reachable today.
- **When:** BEFORE-S1 / AFTER-S1 / BACKLOG. **IMMEDIATE** means S1-independent: fix now, do not wait for or on S1.

### P1

**FM-AUDIT-001 — Raw Plaid errors still logged at five sites; PLAID-SECRET and access tokens can reach runtime logs**
- **Sev/Conf:** P1 / PROVEN ✔ · **Subsystem:** Plaid / security
- **Evidence:** c28d853 (2026-07-23) documented the production leak and added `redactedErrorForLog` (`lib/plaid/errors.ts:252`). Surviving raw `err` logging:
  - `lib/plaid/retry.ts:59-62` fires on **every retryable failure**, including routine MUTATION_DURING_PAGINATION;
  - `lib/plaid/backgroundHistorySync.ts:550-553`;
  - `jobs/sync-banks.ts:153`, reintroduced after the fix;
  - `lib/plaid/exchangeToken.ts:215` and `:509`.
- **Impact:** live Plaid secret and per-item access tokens in Vercel logs, and possibly Sentry.
- **Reach:** yes, any retryable Plaid error. **Mitigation:** none; no test pins redaction.
- **Remediation:** route all five through `redactedErrorForLog`. Rotate `PLAID_SECRET` if any fired since the last rotation (rotation status UNKNOWN).
- **When:** IMMEDIATE.
- **Pin:** a fake AxiosError with the secret in `config.headers` and a token in `config.data` passed through `withPlaidRetry` must leave no secret in captured console output; plus a source scan forbidding `console.*(…, err)` in `lib/plaid`, `app/api/plaid`, `app/api/admin/plaid` and `jobs/sync-banks.ts`.

**FM-AUDIT-002 — DB guard and backup inspect `DATABASE_URL`; Prisma Migrate/reset targets `DIRECT_URL`**
- **Sev/Conf:** P1 / HIGH ✔ (structure verified; failure not executed) · **Subsystem:** DB safety
- **Evidence:** `prisma/schema.prisma:12` `directUrl = env("DIRECT_URL")`; `scripts/db-guard.ts:75` and `scripts/db-backup.ts:25` read `DATABASE_URL` only; the §4a clone recipe rewrites `DATABASE_URL` only; `.env.local` sets both to `fintracker`.
- **Impact:** in a clone-for-DATABASE_URL / live-for-DIRECT_URL environment, `db:reset` (with the env flag) backs up the clone and **resets live**, and `db:migrate` on an empty clone runs `migrate dev` on live. This is the 2026-09-15 incident class.
- **Reach:** requires an environment split; operator error, as the incident was.
- **Mitigation:** both URLs are identical in `.env.local`.
- **Remediation:** guard and back up the effective target (`DIRECT_URL ?? DATABASE_URL`); refuse when the two name different DBs; classify both with live-guard; honour `FM_DB_GUARD`; document DIRECT_URL in §4a.
- **When:** IMMEDIATE.
- **Pin:** a `decideDbGuard` case with `dbUrl=clone, directUrl=live` → refused; a package-script scan that the guard receives DIRECT_URL.

**FM-AUDIT-003 — Category vocabulary cannot represent Groceries / Medical / Transport / Entertainment …; `measure_flows` advertises them and answers $0.00 at observed completeness**
- **Sev/Conf:** P1 / HIGH ✔ · **Subsystem:** transaction economics / AI
- **Evidence:**
  - `plaid-category.ts:106` and `merchant-resolver.ts:216` map `FOOD_AND_DRINK` → Dining, so groceries become Dining;
  - MEDICAL, TRANSPORTATION, ENTERTAINMENT, PERSONAL_CARE, GENERAL_SERVICES, HOME_IMPROVEMENT and GOVERNMENT_AND_NON_PROFIT → Other;
  - no Plaid-path writer for Groceries / Medical / Entertainment / Transport / PersonalCare / Services / Education (`flow-classifier.ts:208-215`);
  - the `measure_flows` category description lists "Groceries, … Medical, Entertainment, Transport" (`tools.ts:856-858`);
  - `measure()` treats a month with no rows as a real 0 (`measure.ts:207-217`), with completeness from coverage.
- **Impact:** "how much did I spend on groceries / medical?" gets a confident, false $0.00. Dining is inflated. S1 deltas on these lines would be meaningless.
- **Reach:** every Plaid user. **Mitigation:** none; `pfcDetailed` is persisted, so a finer key exists.
- **Remediation:** either map PFC detailed → canonical categories (the `PFC_SPEND_BUCKET` categorySource exists without a writer) with a version-gated re-derivation, or refuse unreachable categories as "not tracked". In both cases remove them from the tool description.
- **When:** BEFORE-S1.
- **Pin:** mapper golden (`FOOD_AND_DRINK_GROCERIES` → Groceries or explicit refusal); `measure_flows({category:'Groceries'})` on a corpus with no such writer ⇒ refusal, not `0`.

### P2

**FM-AUDIT-004 — Category spending computed two incompatible ways (UI net and flow-aware vs AI gross and flow-blind)**
- **Sev/Conf:** P2 / PROVEN
- **Evidence:** UI `categorySpendLedger` (`cash-flow.ts:629-653`) admits rows by flowType and reports NET. AI `byCategory` / `categoryAgg` (`lib/ai/assemblers/transactions.ts:825-834,1437-1443`) sums every debit row in the category regardless of flowType and reports GROSS. `resolveCategoryArg` accepts Payment / Transfer / Income, so `sharePct` can exceed 100% (`tools.ts:817-823`).
- **Impact:** the Cash Flow page and chat disagree on the same category and window. S1 has no single category authority.
- **Remediation:** one category-ledger authority (UI semantics, net and gross), rebuilt monthly in the assembler; restrict `measure_flows` to spending categories.
- **When:** BEFORE-S1.
- **Pin:** parity test feeding one row set through both, including a TRANSFER row in Shopping and a SPENDING row labelled Payment.

**FM-AUDIT-005 — Spending rows keep non-spending labels; three category-membership rules**
- **Sev/Conf:** P2 / PROVEN
- **Evidence:** CCPAY-2B leaves category "Payment" and CF-4 leaves "Transfer" on SPENDING rows (`flow-classifier.ts:290-304,398-400`; 27 live "Transfer" rows per the `audit-flow-desync` header). "Interest" is spending in the UI (COST_FLOWS) but not in the AI (`spending-categories.ts:29-33`). Annotations exclude Fee.
- **Impact:** S1 shows or hides Payment / Transfer / Interest / Fee deltas inconsistently.
- **Remediation:** when a veto flips flow to SPENDING, also write a spend category ("one decision, two columns"); adopt one membership rule.
- **When:** BEFORE-S1.
- **Pin:** classifier case asserting the category is rewritten; a single membership predicate imported by all three sites (source scan).

**FM-AUDIT-006 — Economic fold is sign-blind: fee and interest reversals are added to spending**
- **Sev/Conf:** P2 / PROVEN
- **Evidence:** `foldEconomicRow` adds `abs(amount)` for any COST_FLOW (`cash-flow.ts:326`). The classifier yields positive FEE and INTEREST rows (`flow-classifier.ts:409-410,466-469,485-486`). Probe: [−3 FEE, +3 FEE, −100] → spend 106. Liquidity counts +FEE as CASH_OUT.
- **Impact:** conservation break on Cash Flow, measures, baselines, the Fee/Interest lines and Cash Out.
- **Remediation:** classify cost inflows as REFUND-like (classifier v6 + desync-gated repair) or subtract signed inflows in the fold.
- **When:** BEFORE-S1.
- **Pin:** fold over {−3 FEE, +3 FEE} → net 0; classifier cases for +Fee and +Interest on a card.

**FM-AUDIT-007 — `get_spending` returns a GROSS monthly mean computed in the adapter, contradicting the NET baseline and its own description**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `tools.ts:411-431` (mean of `expenseTotal`, gross, with "Use these rather than dividing a window total") vs description `tools.ts:386-391`, `measures/baseline.ts:18-26` (NET) and `assemble.ts:488-493` (NET).
- **Impact:** two monthly-spending figures in one conversation, with no reconciling field.
- **Remediation:** drop `monthlySpending`, or source it from `economicSpendingOf` (net + gross sibling).
- **When:** BEFORE-S1.
- **Pin:** fixture with refunds: get_spending monthly figure equals get_baselines measured, or is absent; source scan that no `/ whole.length` arithmetic remains in tools.ts.

**FM-AUDIT-008 — A paycheque that settled today (or early) is projected again**
- **Sev/Conf:** P2 / PROVEN for the generator (probe), HIGH for the end effect
- **Evidence:** `occurrencesBetween` is inclusive of asOf (`cadence.ts:266,284`); the event horizon starts at asOf (`assemble.ts:389-391`); `foldWindow` counts ≥ asOf (`projection.ts:131`); `lastSatisfiedOccurrenceISO` is computed but unused (`stream-activity.ts:306`). The projection's own comment says today's balance already contains today (`projection.ts:276-278`). Probes: biweekly settled 09-18 → occurrences start 09-18; paid early on the 24th → the 24th appears.
- **Impact:** on paydays and in the early-settlement window, every projection, crossing, goal seek, floor sweep and S1 comparison carries one extra paycheque (≈$5.3k on the real Space).
- **Pinned wrongly:** `projection.test.ts` I4/I7.
- **Remediation:** generate strictly after the last satisfied occurrence; decide overdue-unsettled handling explicitly.
- **When:** BEFORE-S1.
- **Pin:** a stream settling on asOf yields no asOf event; an early settlement suppresses the scheduled date.

**FM-AUDIT-009 — Stated minimum charged on every spine date, so it is paid twice in a month when a rule or horizon falls off the month-end grid**
- **Sev/Conf:** P2 / PROVEN (probe: $200 vs $100 by 06-30)
- **Evidence:** `scenario-ledger.ts:905` settles interest and minimum on every spine date; `tools.ts:2587-2591` adds `fractionOfLiquid` / surplus / floor dates to the spine; the horizon is a spine point (`scenario-ledger.ts:462`).
- **Impact:** cash understated, debt reduction overstated, debt-free crossing too early. Invisible to identity tests (a transfer).
- **Remediation:** minimums on the monthly cadence only (or a per-line last-minimum-month guard); interest accrues on every settlement date (ties to FM-AUDIT-036).
- **When:** BEFORE-S1 (S1 adds change dates to the spine).
- **Pin:** spine {06-15 non-checkpoint, 06-30, 07-31} ⇒ `minimumPaymentsToDate` 100 / 200.

**FM-AUDIT-015 — A negative INCOME row increases income**
- **Sev/Conf:** P2 / PROVEN
- **Evidence:** PFC INCOME → INCOME/INFLOW for any sign (`flow-classifier.ts:381-387`); `attributeIncome` rung 4 → included MISC_INFLOW for amount<0 (`income-source.ts:187-190`); fold adds abs. Probe: +2000, −500 → 2500.
- **Impact:** clawbacks and reversals inflate income, savings rate and income baselines.
- **Remediation:** negative income → NOT_INCOME/reversal, or signed netting.
- **When:** AFTER-S1.
- **Pin:** the probe as a fold test.

**FM-AUDIT-016 — The remediation printed by the REQUIRED desync gate irreversibly loses REFUND-1 netting on unrepaired DBs**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `audit-flow-desync.ts:227-240` prints `backfill-flowtype --only-version=N`; `backfill-flowtype.ts:262-275` re-classifies from the stored category (liability `Income/INCOME` → `Income/UNKNOWN`); `repair-liability-income-credits.ts:62` selects `flowType=INCOME`, so the row is skipped forever and the gate goes green.
- **Reach:** any DB written by the v4 pipeline and not yet repaired; production status UNKNOWN.
- **Remediation:** route those keys to the repair script, or make the backfill refuse liability-inflow INCOME rows.
- **When:** BEFORE any production repair run (Gate B).
- **Pin:** unit test that the backfill plan for a liability INCOME row is refused or delegated.

**FM-AUDIT-017 — No deterministic verification of chat answers; "code owns money" stops at the tool result**
- **Sev/Conf:** P2 / HIGH (absence verified)
- **Evidence:** `app/api/ai/chat/route.ts:159-161` returns `turn.answer` raw; no licence in engine/turn/route. The Brief has `lib/ai/brief/licence.ts`. The rules exist only in prompt/description text (`turn.ts:54-66`, `tools.ts:390,838-840,909,2944-2948,2975`, `evidence.ts:226`).
- **Impact:** prose arithmetic, cross-instant sums and future figures without qualifiers reach users undetected. Project history records reproductions.
- **Remediation:** observe-only figure licence (answer numbers vs this turn's tool results, orientation and envelope) → log; enforce later with horizon/instant tags (the PARITY-3 precedent).
- **When:** AFTER-S1, in parallel (observe-only early).
- **Pin:** licence unit test on a recorded transcript containing a divided figure.

**FM-AUDIT-018 — Sealed scenario + pending state is dropped silently above 3,900 chars; envelope size is unbounded**
- **Sev/Conf:** P2 / HIGH (mechanism), MEDIUM (frequency)
- **Evidence:** `runtime-state.ts` `MAX_SEALED_CHARS=3_900` → null → cookie cleared (`route.ts:169-178`), with no signal to model or user. Hex encoding roughly halves capacity. The probe measured 8 outflows + 4 liabilities = 3,661 chars; ~9 outflows exceed. The size test's "worst case" has one outflow.
- **Impact:** multi-clause plans lose continuity invisibly; the project_cash guard re-opens.
- **Remediation:** base64 + compact envelope + cardinality caps; surface `sealDropped` on the turn; or move to a short-TTL server store keyed by the seal.
- **When:** BEFORE-S1 (S1 adds `spendingChanges` arrays to the same envelope).
- **Pin:** maximal-cardinality envelope round-trips, or a visible refusal is returned.

**FM-AUDIT-019 — Dogfood/baseline harnesses write live SpaceMemory and AiInvocation; guard not armed; header claims read-only**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `scripts/ai-baseline/run.ts:82-95` and `interactive.ts:55-66` expose `remember`; every turn runs `checkpointProjection` (`turn.ts:288`); `package.json` `ai:chat`/`ai:baseline`/`ai:*-check` use `--env-file=.env.local` with no `FM_DB_GUARD`; guard inert unless armed (`live-guard.ts:118`); header `scripts/ai-conversation-baseline.ts:22-24` says read-only. 14 of 16 checks write.
- **Impact:** probe goals and projections become the operator's real memory; `reconcile_projection` grades probes. S1 will be dogfooded.
- **Remediation:** arm `FM_DB_GUARD=clone-only` in write-capable `ai:*` scripts, and/or `ToolContext.memoryWrites:false`; fix the header.
- **When:** BEFORE-S1.
- **Pin:** source scan that the scripts arm the guard or flag; unit test that `remember` and `checkpointProjection` no-op under the flag.

**FM-AUDIT-020 — AI history tool and Brief package drop the reconstructed/estimated label**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `lib/ai/assemblers/snapshot.ts:121-152` (no per-point `isEstimated`/tier); `get_net_worth_history` `pt()`/coverage carry only the crypto reason (`tools.ts:1209-1260`); the Brief package never reads `snapshot.estimated`.
- **Impact:** rebuilt history narrated as observed fact on the AI surface; the UI labels it correctly.
- **Remediation:** per-point `basis` + tier, `coverage.reconstructedPoints`; basis on Brief change-window endpoints.
- **When:** AFTER-S1 (early; small).
- **Pin:** tool-payload test over a mixed series asserting `basis` on every point.

**FM-AUDIT-021 — Live snapshot row stamps stale bank balances as "Observed", then freezes them**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `lib/snapshots/regenerate.ts:216-296` (always `isEstimated=false`, staleness not recorded); ungated callers `jobs/sync-crypto.ts:104`, `jobs/fetch-security-prices.ts:155`, `app/api/accounts/[id]/sync/route.ts:98`, `lib/plaid/refresh.ts:430`; only the all-items path excludes tarnished Spaces, and its comment names this hazard (`refresh.ts:556-601`); frozen after midnight (`regenerate-history.core.ts:333-340`).
- **Impact:** during a stuck connection, permanent "observed" history from weeks-old balances, then a one-day jump on reconnect (chart, `get_net_worth_history`, Brief d1).
- **Remediation:** mark the live row non-observed (e.g. `completenessTier:'estimated'`) or skip when a material balance is STALE.
- **When:** AFTER-S1.
- **Pin:** a Space with a STALE Plaid balance gets a non-observed row from sync-crypto.

**FM-AUDIT-022 — Unpriced / unobserved wallet summed as the legacy balance column ($0 for ETH/SOL/BNB/AVAX, stale for BTC)**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `lib/data/accounts.ts:233-234` and `lib/snapshots/space-accounts.ts:222-244` fall back to `financialAccount.balance` when `!hasKnownValue`; wallet create writes `balance: 0` (`app/api/accounts/wallet/route.ts:312`), and ETH/SOL/BNB/AVAX never update it; the AI assembler drops the state (`lib/ai/assemblers/accounts.ts:253-265`).
- **Impact:** the NO_PRICE state (correct in the engine) becomes $0 or a stale figure in net worth, the UI and AI context, undisclosed.
- **Remediation:** carry `state` on the DTO, exclude from sums, disclose (`cryptoUnpriced`), stamp the snapshot.
- **When:** AFTER-S1.
- **Pin:** force NO_PRICE ⇒ totals exclude it and disclose.

**FM-AUDIT-023 — Plaid null current balance keeps the old value but stamps it freshly verified; connect-time null → $0**
- **Sev/Conf:** P2 / HIGH (code), MEDIUM (frequency)
- **Evidence:** `lib/plaid/refresh.ts:222` (`?? fa.balance`), `:226` `lastUpdated: new Date()`, `:234` COVERED/`freshnessAdvanced`; `exchangeToken.ts:330` `?? 0`.
- **Remediation:** do not advance clocks or coverage on null (SKIPPED `PROVIDER_NULL_BALANCE`); store unknown at connect.
- **When:** AFTER-S1 (small).
- **Pin:** `accountsGet` fake with `current:null` ⇒ coverage not COVERED, `lastUpdated` unchanged.

**FM-AUDIT-024 — Successful Plaid lock release clears `syncIncompleteAt`, defeating the first-run rule and dropping mid-pipeline HISTORICAL_UPDATE webhooks**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `lib/plaid/sync-lock.ts:103` vs `syncTransactions.ts:1004-1006,1019`.
- **Impact:** new connections flip to ready early; deeper history waits up to 24 h. No data loss.
- **Remediation:** clear only if the marker predates the claim.
- **When:** AFTER-S1.
- **Pin:** claim → stamp after claim → release(ok) ⇒ marker survives.

**FM-AUDIT-025 — CoinGecko backfill (365-day chunks) likely stores the next day's 00:00 point as the prior day's close**
- **Sev/Conf:** P2 / MEDIUM (CoinGecko granularity >90 days not verified live)
- **Evidence:** `lib/prices/backfill.ts:150`, `coingecko.ts:15-17,288-297`, `coingecko.test.ts:57`.
- **Impact:** backfilled crypto history is shifted one day; insert-only, so it never self-corrects.
- **Remediation:** verify against the live API; chunk ≤90 days for CoinGecko, or re-date daily points; repair script.
- **When:** verify BEFORE-S1 (cheap), fix AFTER-S1.
- **Pin:** fixture of daily 00:00 points >90 days.

**FM-AUDIT-026 — No request timeouts on Plaid, CoinGecko, Tiingo, ETH-history or SOL-history transports; some on user POST paths without `maxDuration`**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `lib/plaid/client.ts:52-60`; `coingecko.ts:253,425`; `tiingo.ts:151`; `eth-history.ts:366-379`; `sol-history.ts:240-247`; user routes `accounts/[id]/sync`, `accounts/wallet`, `connections/build-intelligence`.
- **Impact:** a hung socket holds a user request or a cron slot until platform kill, which then orphans a RefreshExecution.
- **Remediation:** shared `AbortSignal.timeout`, axios `timeout`, deadlines, `after()` for rebuilds.
- **When:** AFTER-S1 (Plaid + CoinGecko first).
- **Pin:** a never-resolving fetch throws within the timeout; source scan that every provider `fetch(` carries `signal`.

**FM-AUDIT-027 — Import rollback lacks the visibility-tier gate; batch ids leak through the activity feed**
- **Sev/Conf:** P2 / PROVEN ✔ (static)
- **Evidence:** `app/api/imports/[id]/rollback/route.ts:116-129` checks the ACTIVE link and `isCreator || canManage`, not `visibilityLevel`; import requires FULL for non-owners (`lib/imports/authorize.ts` Step 2b); `app/api/spaces/[id]/activity/route.ts:467-483` + `normalize-import-batch.ts:59` expose batch ids to all members.
- **Impact:** a Space ADMIN can soft-delete another user's imported history shared at BALANCE_ONLY / SUMMARY_ONLY. Recovery needs manual DB work.
- **Remediation:** apply the import authorizer to rollback; filter import events to FULL links.
- **When:** IMMEDIATE (small).
- **Pin:** rollback authorizer denies a non-owner ADMIN on BALANCE_ONLY; the feed emits no `importbatch:` for non-FULL links.

**FM-AUDIT-028 — Post-login open redirect via `callbackUrl`**
- **Sev/Conf:** P2 / HIGH ✔ (check verified; navigation from framework knowledge)
- **Evidence:** `app/(auth)/login/page.tsx:323-325` (`startsWith("/")` admits `//evil.example`, `/\evil`).
- **Impact:** phishing chain straight from a genuine login.
- **Remediation:** a same-origin helper (`new URL(dest, origin).origin === origin`, reject `//` and `/\`).
- **When:** IMMEDIATE.
- **Pin:** helper unit test.

**FM-AUDIT-029 — `/api/users/search` enumerates the user directory and is a membership oracle for any Space id**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `app/api/users/search/route.ts:15-57`: `requireUser` only, 1-char queries, no rate limit, no role/deactivated filter; `exclude=<spaceId>` loads members of any Space without a membership check.
- **Remediation:** require ADMIN of `exclude`; minimum length 3 or exact username; filter admins and deactivated users; `limitByUser`.
- **When:** AFTER-S1 (BEFORE if the user population widens).
- **Pin:** route source contains the role check and length floor.

**FM-AUDIT-030 — Accounts list shows a green "Synced" regardless of balance age; rows show no age**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `lib/sync/status.ts:~196-206`; `AccountsPerspective.tsx:72`; `AccountsLedger.tsx:511-558`.
- **When:** AFTER-S1.
- **Pin:** a stale balance renders a warning-tone "Checked Nd ago".

**FM-AUDIT-031 — Reconstructed days silently omit accounts older than their transaction floor; tier stays `derived`**
- **Sev/Conf:** P2 / MEDIUM
- **Evidence:** `lib/snapshots/regenerate-history.ts:871-872,1055`; `backfill.ts:~287`.
- **Impact:** net-worth cliffs at provider-depth floors, labelled "Reconstructed", never "partial".
- **When:** BACKLOG.
- **Pin:** regen-history core test with an excluded balance-bearing account ⇒ tier `incomplete`.

**FM-AUDIT-032 — `db:reset` is gated only by an env var (no name, population or typed confirmation)**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `scripts/lib/db-guard.core.ts:94-112`, vs `db-wipe`'s typed `host/db`.
- **When:** IMMEDIATE (with FM-AUDIT-002).
- **Pin:** `decideDbGuard` refuses LIVE names in reset mode without a typed confirmation.

**FM-AUDIT-033 — README and deployment doc instruct the incident command (`npx prisma migrate dev`) and a wrong env file**
- **Sev/Conf:** P2 / PROVEN
- **Evidence:** `README.md:90,109,142,154`; `docs/operations/deployment.md:205`.
- **When:** IMMEDIATE (doc edit).
- **Pin:** doc lint / source scan forbidding `prisma migrate dev` outside `database-safety.md` prohibitions.

**FM-AUDIT-034 — `dev:reset-test-state --apply` defaults to the operator's real account; irreversible Plaid `itemRemove` + hard deletes, no backup or confirmation**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** `scripts/dev-reset-test-state.ts:60,239-272`.
- **When:** IMMEDIATE.
- **Pin:** the script refuses without an explicit `--email` and typed confirmation.

**FM-AUDIT-035 — REQUIRED audit gate has no negative controls; two audits pass vacuously on the CI seed**
- **Sev/Conf:** P2 / HIGH
- **Evidence:** zero planted-violation or self-test mechanisms across the 22; `scripts/audit-seed-coverage.ts:9-14`; seed of 4 users / 8 Spaces / 21 accounts / ~360 tx.
- **When:** AFTER-S1.
- **Pin:** a CI step per audit that plants one violating row and requires exit 1 (start with flow-desync, pending-posted, event-identity, snapshot-window-claims).

### P3

| ID | Title | Conf | Evidence | When | Pin |
|---|---|---|---|---|---|
| FM-AUDIT-010 | I1 × L1 × M1 × goal-seek composition not CI-pinned (only a manual clone-DB check) | HIGH | `prepareScenario`/`buildCashSpine` DB-bound (`tools.ts:1594-1611`); `income-change.check.ts` | **BEFORE-S1** | pure `composeScenario(inputs)` fixture: raise + highest_apr + floor + monthsOfExpenses + goal seek |
| FM-AUDIT-011 | Goal-seek `monthlySpendingCut` keeps the M1 months-of-expenses floor at uncut spending | HIGH | floor resolved once (`tools.ts:2385-2402`); `run` rebuilds only the spine (`:2551-2563,3287`) | **BEFORE-S1** | floor re-resolved per spending level, or combination refused |
| FM-AUDIT-012 | Categories drift with no version stamp (forward-only rules, re-derivation on modify) | PROVEN | `TransactionCorrection.tsx:140`; `syncTransactions.ts:680-682`; no category version column | **BEFORE-S1 (disclosure)** | S1 completeness carries a category-source/version census |
| FM-AUDIT-013 | Pending rows in UI totals, excluded from AI folds | PROVEN | `banking-population.ts:165-191` vs `assemblers/transactions.ts:658-664` | **BEFORE-S1 if S1 covers current month**; else AFTER | UI↔AI parity with a pending row |
| FM-AUDIT-014 | User category correction cannot move a PFC-labelled row into or out of spending | PROVEN | `flow-classifier.ts:443-446`; `merchant-corrections.ts:128-144`; tests use `pfcPrimary:null` | AFTER-S1 (decide precedence) | correction on a PFC row changes flow as specified |
| FM-AUDIT-036 | Liability engines diverge undisclosed (pro-rata/day vs avalanche/month-end, minimums on top), and ledger spine-only accrual under-states interest ~8% | PROVEN | `payoff.ts:45-52` vs `scenario-ledger.ts:786-791,818-823`; probes 2028-10-13/$1,412 vs 2028-08/$879; $2,419 vs $2,217 | AFTER-S1 | single-liability parity (no minimum) + explicit divergence test |
| FM-AUDIT-037 | Ledger has no non-amortisation warning | HIGH | warnings only for negative cash/investments (`scenario-ledger.ts:1157-1165`) | BACKLOG | per-line warning when interest ≥ payments over 12 settlements |
| FM-AUDIT-038 | Scenario `to`/`by` unvalidated and uncapped (`'2030-12'` → Dec-01); wealth-amend `fromDate` unbounded | PROVEN | `tools.ts:2966,3232`; `wealth/amend/route.ts:60-66`, `regenerate-history.ts:710,762` | AFTER-S1 | ISO validation + 30/50-yr cap; amend 400 over cap |
| FM-AUDIT-039 | Chat turn has no end-to-end deadline; SDK defaults (10-min timeout, 2 retries) under ≤5×60 s 429 waits, inside maxDuration 300 | HIGH | `turn.ts:248-250`, `rate-limit-retry.ts:31-36`, `provider.ts:42` | AFTER-S1 (cheap) | `executeTurn` passes `deadlineAt`; fake-clock test |
| FM-AUDIT-040 | Six-hop exhaustion discards all tool work; no final no-tools answer | HIGH | `turn.ts:246-263,329`; `route.ts:148-153` | AFTER-S1 | fake provider always calling tools ⇒ a final prose call is made |
| FM-AUDIT-041 | Raw tool exception text (possible SQL) fed to the model | MEDIUM | `turn.ts:273-276` vs route redaction `route.ts:180-186` | AFTER-S1 | throwing tool ⇒ tool message contains no SQL/stack |
| FM-AUDIT-042 | Tool payload ~16.9k tokens per hop; `SCENARIO_INPUTS` serialized 3× (57%); prompt budget evaded by relocating doctrine into descriptions | HIGH | measured 67,461 chars; `tools.ts:2934-2942`; `turn.ts:40-44` | BACKLOG | schema-bytes and description-chars budget pins |
| FM-AUDIT-043 | AI accounting gaps: failures/retries unrecorded; fire-and-forget writes not in `after()`; no user/Space attribution; per-turn record discarded; correlationId collision | HIGH/MEDIUM | `invocation.ts:7-11`; `provider.ts:102,110,118`; `route.ts:151,198-200` | AFTER-S1 | outcome column on catch path; `after(` source scan |
| FM-AUDIT-044 | No per-user token/cost budget; SYSTEM_ADMIN exempt from chat rate limit | MEDIUM | `route.ts:84-87`; `request.ts:37-39` | BACKLOG (before wider beta) | over-budget user gets 429 + sentence |
| FM-AUDIT-045 | Planning-continuity edge losses: a failed re-run forgets the plan is in play (baseline path reopens); any error turn drops scenario and pending (client posts error bubble as assistant); no `ignoreStaged` on crossing/goal seek | HIGH | `active-scenario.ts:186-195`, `turn.ts:302-309`, `tools.ts:1817`; `AnalyzeClient.tsx:262-265`; `tools.ts:1776,2237` | AFTER-S1 | success → failed re-run ⇒ project_cash still refuses; error bubbles excluded; crossing + `ignoreStaged` ⇒ IGNORE |
| FM-AUDIT-046 | Free-text `statedAs` (≤280 chars, unvalidated) returned by `recall` as `notedAs`: the one memory surface a balance can survive | HIGH | `memory-store.ts:196`; `memory-tools.ts:168,183,366` | AFTER-S1 | `presentRecall` never includes `statedAs`, or figures gated |
| FM-AUDIT-047 | Memory panel lists 50 newest across kinds (checkpoints crowd out goals the model still sees); SpaceMemory absent from user data export | MEDIUM | `memory-store.ts:446-450`; `lib/export/assemble.ts` | BACKLOG | 60 checkpoints + 1 goal ⇒ goal listed; export includes memory |
| FM-AUDIT-048 | `resume-stale-imports` retries a failing item forever (~5 min), no backoff, not health-monitored | HIGH | `jobs/resume-stale-imports.ts:63-66,129-145`; `health.ts:381` | AFTER-S1 (bounds Plaid cost) | always-failing stub ⇒ spaced attempts, terminal state |
| FM-AUDIT-049 | Refresh/job idempotency gaps: no (job, slot) key (duplicate cron ⇒ double run); orphaned RUNNING executions; item lease without owner token; wallets unlocked | HIGH | `lib/jobs/dispatch.ts:95-106`; `projections-core.ts:108-110`; `sync-lock.ts:100-105`; `btc-sync.ts:460-468` | BACKLOG | concurrent dispatch ⇒ each body once; owner-token release test |
| FM-AUDIT-050 | Price and FX jobs report "ok" when every provider call failed | HIGH | `lib/prices/fetch.ts:137-141`; `jobs/fetch-security-prices.ts:137-162`; `jobs/fetch-fx-rates.ts:53-57` | AFTER-S1 | THROTTLED adapter ⇒ degraded status |
| FM-AUDIT-051 | Plaid ITEM webhooks ignored; NEEDS_REAUTH excluded from every sync, so LOGIN_REPAIRED is never observed | HIGH | `webhook/route.ts:74-80`; `sync-banks.ts:165` | BACKLOG | ITEM codes → `setPlaidItemHealth` |
| FM-AUDIT-052 | ETH history: -32000 fatal, no batch shrink, no persisted cursor; SOL rescans newest-first each sync | HIGH | `eth-history.ts:444-451,681`; `wallet-history-refresh.ts:64` | BACKLOG | -32000 for batch>N ⇒ completes at smaller batch |
| FM-AUDIT-053 | xpub balance includes unconfirmed; malformed multiaddr 200 parses to 0 BTC | HIGH | `btc-explorer.ts:291-316` | AFTER-S1 (zero case) | `{}` 200 ⇒ error, not 0 |
| FM-AUDIT-054 | Space OWNER can leave own Space; DELETE has no PERSONAL guard ⇒ ownerless Space or `findFirstOrThrow` lockout | HIGH | `members/[userId]/route.ts:127-135`; `lib/space.ts:213-216` | AFTER-S1 (cheap; IMMEDIATE acceptable) | DELETE source has owner and PERSONAL refusals |
| FM-AUDIT-055 | `DISABLE_SYSTEM_ADMIN` not enforced in platform authorization (30-day JWT) | HIGH | `lib/platform/authorize.ts`; `lib/session.ts:283-297` | BACKLOG | `decidePlatformAccess(..., {systemAdminDisabled:true})` false |
| FM-AUDIT-056 | Two client-IP authorities; `cf-connecting-ip` trusted first (spoofable at origin) | MEDIUM | `lib/api.ts:70-81`, `lib/auth.ts:156-159` vs `lib/rate-limit.ts:247-253` | BACKLOG | single helper source scan |
| FM-AUDIT-057 | Space helpers ignore archived/trashed state; `expense-baseline` mixes Spaces via `resolveSpaceContext` fallback | HIGH | `lib/session.ts:360-376`; `expense-baseline/route.ts:100-121` | BACKLOG | every named `resolveSpaceContext(` followed by an equality check |
| FM-AUDIT-058 | CSV import: no size/row cap, per-row sequential queries, non-atomic, no concurrency guard; timed-out batch stuck PROCESSING | MEDIUM | `accounts/[id]/import/route.ts:183-620`; `rollback/route.ts:88-92` | BACKLOG | row cap enforced; rollback accepts stale PROCESSING |
| FM-AUDIT-059 | CSP Report-Only with `'unsafe-inline' 'unsafe-eval'` | HIGH | `next.config.ts:14-35` | BACKLOG | — |
| FM-AUDIT-060 | Brief: degraded package undisclosed (failed holdings ⇒ "0 unvalued"); kept prose can disagree with the metric row; licence binds values, not referents | HIGH | `load.ts:140-150`, `package.ts:363`; `lifecycle.ts:230-238`; `licence.ts:47-77` | BACKLOG | degraded reaches `dataQuality`; "Figures as of" when watermark moved |
| FM-AUDIT-061 | UI money presentation: FX miss "≈ $0.00"; `/dashboard/credit` "−$0", whole dollars, own "available"; payoff "by {date}" / hero interest unqualified; Spaces panel "Updated" = snapshot date | HIGH/MEDIUM | `AccountsLedger.tsx:91,557`; `DebtClient.tsx:32-35,757,799`; `DebtHero.tsx:136-140`; `SpacesClient.tsx:745-747` | BACKLOG | per-surface render tests |
| FM-AUDIT-062 | Backup/restore unproven: printed restore omits PG16 filter; integrity = ">100 bytes"; no drill ever | HIGH | `db-backup.ts:26,53,56`; `db-wipe.ts:30` | AFTER-S1 | restore-into-throwaway step in `npm run ci` |
| FM-AUDIT-063 | Script governance narrow (6 prefixes; 17 mutators ungoverned); test harness denylist admits `127.0.0.1:5432/fintracker` then unscoped `deleteMany`; `run-tests` doesn't scrub DB URLs | HIGH | `run-audits.ts:58-62`; `test-incident-transaction-safety.ts:42-44,78-80`; `run-tests.ts:149` | BACKLOG | allowlist; `withoutDatabaseUrls` in run-tests |
| FM-AUDIT-064 | Payoff privacy proven on dead `computePayoffAggregate`; live `lib/debt/payoff.ts` unproven | HIGH | `account-privacy.proof.test.ts:63,105`; `balance-semantics.test.ts:148-152` | AFTER-S1 | privacy proof on `planPayoff` inputs |
| FM-AUDIT-065 | Test suite dominated by source scans (326/588 read source; 173 import no product code; 17 aria-label pins); route auth proven by regex only | HIGH | §22 | BACKLOG (convert auth boundaries first) | request-level route tests for chat/memory/rollback |
| FM-AUDIT-069 | Brokerage cash writes non-canonical completeness (pinned wrong); opening-position route accepts negative/future quantities | HIGH | `brokerage-cash.ts:148,216`, test `:50,58`; `opening-position/route.ts:54` | BACKLOG | `assertCanonicalCompleteness`; 400 on negative |
| FM-AUDIT-066 | Documentation drift (§23), including a **false security comment** that buildContext validates membership | PROVEN | §23 | AFTER-S1 (security comment + README earlier) | source scan: no tool count other than `TOOLS.length` |

### P4

| ID | Title | When |
|---|---|---|
| FM-AUDIT-067 | Dead code / schema residue / dead config (§24): delete in one slice, after moving the payoff privacy proof | BACKLOG |
| FM-AUDIT-068 | Licensed engine runs on every spine point for disclosure only; latent all-null trap if a NET basis producer is added (`assemble.ts:462-468`) | BACKLOG (pin before adding a basis producer) |
| FM-AUDIT-070 | Production `[sctx]` logging (4–6 lines per `getSpaceContext`, "temporary") in `lib/space.ts:80-146,173-178` | BACKLOG |
| FM-AUDIT-071 | Read tools silently ignore unknown/copied arguments (no `strict`, no `ignoredArguments` echo) | BACKLOG |
| FM-AUDIT-072 | Security hygiene: non-fresh guards on destructive admin Plaid routes; raw `e.message` in wealth/amend and merchant-ops; `CRON_SECRET` compared non-constant-time; webhook key cache never expires / future `iat` accepted; invites never expire; merchant-ops authority from ordinary Space membership | BACKLOG |
| FM-AUDIT-073 | Zero rendering "−$0.00"/"+$0.00" (sign before rounding, `lib/currency.ts:43-57`) | BACKLOG |

(IDs are grouped by severity. Numbering follows first discovery and is not strictly sequential within a tier.)

---

## 27. Remediation roadmap

### GATE A — MUST FIX BEFORE S1

S1 builds directly on these semantics.

| Order | Finding(s) | Why it blocks S1 | Size |
|---|---|---|---|
| A1 | **FM-AUDIT-003** reachable category vocabulary (PFC detailed → canonical, version-gated) or explicit refusal | S1 transforms category rates; a category that cannot exist cannot change | M |
| A2 | **FM-AUDIT-004 + 005** one category-ledger authority + one membership rule, UI↔AI parity pinned | S1 must read and write one definition of "dining spend" | M |
| A3 | **FM-AUDIT-006** sign-correct cost inflows | S1 deltas on Fee/Interest lines and all totals | S |
| A4 | **FM-AUDIT-007** `get_spending` aligned to NET (or removed) | S1 answers compare against "current spending" | S |
| A5 | **FM-AUDIT-008** paycheque double count | contaminates every before/after projection | S |
| A6 | **FM-AUDIT-009** minimums on monthly cadence | S1 change dates join the spine | S |
| A7 | **FM-AUDIT-010** pure `composeScenario` + CI composition fixture | S1 adds a fourth transform to an unpinned composition | M |
| A8 | **FM-AUDIT-011** floor re-resolved per spending level (or refused) | S1 changes spending over time; the M1 floor reads it | S |
| A9 | **FM-AUDIT-018** envelope headroom + visible drop | S1 adds arrays to the sealed envelope | S |
| A10 | **FM-AUDIT-019** harness isolation from live memory | S1 will be dogfooded | S |
| A11 | **FM-AUDIT-012** category-drift disclosure; **FM-AUDIT-013** pending doctrine (only if S1 measures the current month) | honesty of S1 deltas | S |

**Explicit S1 design decisions to make at the start of S1 (not defects):**
- gross vs net per category, and how per-category net reconciles with month-level net;
- cut relative to which segment (goal seek);
- licensed-engine refusal of a piecewise rate;
- category key (enum vs PFC detailed).

### GATE B — FIX SOON AFTER / PARALLEL TO S1

**B-now (S1-independent live exposures: do first, in parallel; small):**
- FM-AUDIT-001 (Plaid secret logging + possible rotation)
- FM-AUDIT-002 + 032 (DB guard target and reset confirmation)
- FM-AUDIT-033 (README incident command)
- FM-AUDIT-034 (dev reset default account)
- FM-AUDIT-027 (rollback tier gate)
- FM-AUDIT-028 (open redirect)
- FM-AUDIT-054 (owner self-leave)

**B-soon:**
- FM-AUDIT-017 (observe-only chat figure licence)
- FM-AUDIT-020 (AI reconstructed label)
- FM-AUDIT-016 (desync remediation hazard, before any production repair)
- FM-AUDIT-025 (verify CoinGecko granularity)
- FM-AUDIT-022, 023 (unpriced wallet, null balance)
- FM-AUDIT-021 (stale "observed" today-row)
- FM-AUDIT-024 (lock release marker)
- FM-AUDIT-026 (timeouts)
- FM-AUDIT-039, 040, 041 (turn deadline, hop exhaustion, error redaction)
- FM-AUDIT-048, 050, 053 (retry storm, false-ok jobs, 0-BTC parse)
- FM-AUDIT-015 (negative income)
- FM-AUDIT-014 (correction precedence)
- FM-AUDIT-029 (user search)
- FM-AUDIT-030 (Synced chip)
- FM-AUDIT-066 (security comment + ai-foundation doc)

### GATE C — PRODUCT / ARCHITECTURE BACKLOG

- FM-AUDIT-036, 037 (liability convergence: shared settlement primitive, disclosed conventions, non-amortisation)
- FM-AUDIT-035 (negative controls for REQUIRED audits)
- FM-AUDIT-031 (floor omission label)
- FM-AUDIT-038 (horizon caps)
- FM-AUDIT-042 (tool payload/schema dedupe; measure routing before and after)
- FM-AUDIT-043, 044 (AI accounting completeness, cost budget)
- FM-AUDIT-045, 046, 047 (continuity edges, `statedAs`, panel/export)
- FM-AUDIT-049, 051, 052 (job idempotency, Plaid ITEM webhooks, ETH/SOL history)
- FM-AUDIT-055–060 (security hardening, CSV import, Brief disclosure)
- FM-AUDIT-062, 063, 064, 065 (restore drill, script governance, payoff privacy proof, route-level tests)
- FM-AUDIT-069

### GATE D — CLEANUP

- FM-AUDIT-067 (dead code/schema/config deletion slice)
- FM-AUDIT-068 (licensed-engine pin)
- FM-AUDIT-070 (`[sctx]` logs)
- FM-AUDIT-071, 072, 073
- FM-AUDIT-061 (UI money presentation)
- remaining documentation drift (§23)

**No rewrite is recommended.** Every item is a local correction to an otherwise sound architecture.

---

## 28. Explicitly deferred / non-issues

**Deferred by design (documented decisions, not defects):**
- **Durable income expectations and durable future planning assumptions in Memory V2.** They remain intentionally unsupported (`memory-model.ts:172` has no income field; planning-continuity closure §12, §25). "Remember my raise" honestly writes nothing.
- The executed envelope is not recomputed per turn; it changes only when a tool re-runs.
- Direct scenario arguments are ungated while staging is gated. This is intentional and prompt-mitigated (0/18 measured).
- No tax model: a GROSS income rule removes income, and the echo says so.
- `project_cash` excludes liabilities, and says so.
- Crossings are month grain, and say so.
- Two liability engines as *products* (the divergence is the finding, not the existence).
- Markets is an honest scaffold.
- Per-job cron routes beside the dispatcher are an intentional fallback.
- `obligation.ts` and `capability-classification.ts` are documented scaffolds.

**Checked and found not to be problems:**
- **RateLimit table growth:** pruned by the `rate-limit-sweep` job (`lib/jobs/registry.ts:214`, `jobs/sweep-rate-limits.ts`). One audit pass reported "no pruning"; that claim is **refuted**.
- **AiInvocation SDK bypass:** gone. `provider.ts` is the only OpenAI SDK importer, with one recording chokepoint.
- **Six V26 AI flags:** removed from code; residue exists only in env files.
- **Plaid redirect URI:** never derived from request headers.
- **Missing prices and FX:** never become 0 or a 1.0 rate.
- **No provider call blocks a page render or AI tool.**
- **Brief GET:** never calls the model.
- **Rebuilt history:** never "observed" in the UI.
- **Liability sign:** consistent everywhere (`amountOwed` positive).
- **No raw-SQL injection surface, no server actions, no mutation on GET.**
- **CI/local parity:** `npm run ci` is faithful to GitHub CI and never touches a developer DB.

**Gaps from the 2026-09-15 DB rollback (data loss, not code):**
- The dev `AiInvocation` table postdates the 2026-08-26 restore dump. Dev rows written 09-09 → 09-15, and `ApiUsageCounter` rows 08-26 → 09-15, are gone.
- The dev cost ledger starts at about 2026-09-15 17:00Z.
- Production is a separate database and was not inspected.
- The accounting code defects (FM-AUDIT-043) are independent of the restore.

**UNKNOWN (requires external verification):**
- whether `PLAID_SECRET` was rotated after 2026-07-22;
- production application status of the refund repair;
- CoinGecko >90-day granularity;
- whether Cloudflare fronts production with origin lock-down;
- `router.push("//host")` runtime behaviour;
- whether Plaid card balances are posted-only;
- Investments hero vs Wealth "Investments & crypto" parity;
- production row counts for positive FEE/INTEREST and negative INCOME rows;
- real envelope sizes in use;
- rate-card currency beyond the 2026-09-08 fetch.

---

## Answers to the twenty questions

1. **Is current financial truth trustworthy?**
   - **Mostly yes, with named exceptions.**
   - Balances, holdings, prices and FX come from single authorities that refuse rather than invent.
   - The exceptions are all places where stale or absent data can present as current:
     - a Plaid null balance stamped fresh (023);
     - an unpriced or unobserved wallet summed as $0 (022);
     - a "Synced" chip that ignores age (030);
     - stale balances in an "observed" today-row (021).
2. **Is historical financial truth trustworthy?**
   - **In the UI, yes as labelled.** Rebuilt days are never "observed" and missing components are never zeroed.
   - **In the AI, not yet:** the reconstructed label is dropped (020).
   - Weaknesses:
     - accounts before their transaction floor are silently omitted (031);
     - stale-sourced today-rows are frozen as observed (021);
     - backfilled crypto closes may be shifted a day (025, MEDIUM).
3. **Are scenario projections mathematically trustworthy?**
   - **The fold and ledger are sound and conservation is pinned.**
   - Two proven double counts must be fixed first: today's paycheque (008) and minimums off the month-end grid (009).
   - Off-grid interest is under-accrued by about 8% (036).
   - Horizons are unvalidated (038).
   - Month-end-grid scenarios without a same-day paycheque are correct.
4. **Is conversation/planning state correctly isolated?**
   - **Yes in code:** four carriers, sealed binding, no forbidden path.
   - Continuity can be lost silently: seal overflow (018), error turns, failed re-runs (045).
   - Operationally, the dogfood harness writes live memory (019).
5. **Is Memory V2 correctly isolated from financial truth?**
   - **Yes.** Kinds are closed, no field can hold a balance, the provenance gate requires the user's own words, and the memory line is labelled "not in effect".
   - The only residual is free-text `statedAs` echoed by `recall` (046).
6. **Are L1, M1 and I1 genuinely composable?**
   - **Yes, in one fold.** I1 is in the spine closure, L1 in the same ledger walk, and M1 becomes a literal.
   - The composition is not CI-pinned end to end (010).
   - M1's floor goes stale under a goal-seek spending cut (011).
7. **Is the AI tool surface coherent?**
   - **In authority, yes; in semantics, not yet.**
   - "Monthly spending" has five figures on two bases.
   - Category lines are gross and flow-blind and advertise unreachable categories.
   - The tool payload is 16.9k tokens with a thrice-copied schema.
   - Exactly 20 tools, none dead on the exposed surface.
8. **Are provider failures represented truthfully?**
   - **RefreshExecution status is truthful**, and NO_PRICE and FX-null are refused honestly.
   - Untruthful spots:
     - price and FX jobs report "ok" on total failure (050);
     - a Plaid null balance is stamped fresh (023);
     - a malformed multiaddr becomes 0 BTC (053);
     - a lock release erases the incomplete marker (024);
     - orphaned RUNNING executions (049).
9. **Can stale or partial data masquerade as current or complete?**
   - **Yes, in the specific places listed in 1, 2 and 8.**
   - Also: a degraded Brief package reads as complete (060), and an unreachable category reads as an observed $0 (003).
10. **Are liabilities represented consistently?**
    - **Balances and signs are consistent everywhere.**
    - Payoff answers are not: the Debt page (pro-rata, day, budget) and chat (avalanche, month-end, minimums on top) give different dates and interest for the "same" plan, undisclosed (036).
11. **Can concurrent operations corrupt or duplicate state?**
    - **No corruption path was found.**
    - Duplication is possible in CSV import on double submit (058) and in duplicate job executions (049).
    - Signals can be lost: `syncIncompleteAt` (024) and cookie state.
12. **Can a supported repo command still accidentally destroy the live DB?**
    - **Yes, when `DATABASE_URL` and `DIRECT_URL` diverge** (002, P1): `db:reset` or `db:migrate` guard one DB and migrate the other.
    - The README still instructs the incident command (033).
    - `dev:reset-test-state --apply` defaults to the operator's account (034).
13. **Are authentication/authorization boundaries sound?**
    - **Largely, yes:** every handler is guarded and no IDOR was found in membership or ownership.
    - One cross-user write exists: import rollback without a tier gate (027).
    - Also: an open redirect (028), a user-directory oracle (029), and the kill switch not applied to platform authorization (055).
    - Route-level auth is proven by source scan only.
14. **Does `npm run ci` meaningfully represent production correctness?**
    - **It faithfully represents GitHub CI, and green means something** for pure deterministic logic and for invariants on a small seed.
    - It does not cover:
      - route behaviour as requests;
      - the model boundary;
      - providers;
      - real-data category and classification distributions;
      - schema drift;
      - restore.
    - The REQUIRED audits have no negative controls (035).
15. **What percentage of Markets is real vs scaffold?**
    - **About 5% real** (navigation, URL state, empty trust envelope) **and 95% scaffold.** Product functionality is 0%, and it is honest about it.
16. **What are the five highest-risk technical debts?**
    1. Category spending semantics: two authorities plus an unreachable vocabulary (003/004/005).
    2. No figure verification on chat answers (017).
    3. The DB guard / migrate target split, plus weak reset confirmation and an unproven restore (002/032/062).
    4. Provider hygiene: secret logging, no timeouts, false-ok jobs (001/026/050).
    5. Staleness laundering into "observed" and "current" (021/022/023/030).
17. **What must be fixed before S1?**
    - Gate A: 003, 004, 005, 006, 007, 008, 009, 010, 011, 018, 019; plus 012 as disclosure, and 013 if S1 measures the current month.
    - The B-now P1/P2 exposures (001, 002, 032, 033, 034, 027, 028, 054) should be fixed immediately in parallel. They are small and unrelated to S1.
18. **What should explicitly NOT delay S1?**
    - liability engine convergence;
    - Markets;
    - ETH/SOL history;
    - Plaid ITEM webhooks;
    - the Brief disclosure refinements;
    - the stale today-row and history labels;
    - AI accounting completeness;
    - tool payload dedupe;
    - REQUIRED-audit negative controls;
    - test-style debt;
    - dead code;
    - documentation drift (other than the README incident command).
19. **If development stopped today, what would you trust with real financial decisions?**
    - current account, holding and liability balances where fresh (read the freshness chip, not the "Synced" chip);
    - the headline NET monthly spending and income figures;
    - the refund economics;
    - transaction search (complete ≤100-row searches);
    - net-worth history in the UI with its labels;
    - month-end-grid cash projections and debt scenarios, not on a payday;
    - the Debt page payoff planner on its own stated terms;
    - `get_baselines`;
    - the Daily Brief metric row.
20. **What would you not trust yet?**
    - any category-level spending figure, especially from chat;
    - `get_spending`'s monthly mean;
    - chat prose arithmetic not directly from a tool;
    - projections run on a payday;
    - scenarios mixing minimums with off-month-end rules;
    - chat vs Debt page payoff dates side by side;
    - AI-narrated history (label dropped);
    - crypto values when unpriced or unobserved;
    - net worth on days a bank connection was stuck;
    - AI cost totals as a complete ledger.
