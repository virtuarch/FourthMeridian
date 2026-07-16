# HIST-2 — Historical Writer / Valuation-Basis / Crypto-Read Investigation

**Date:** 2026-07-17 · **HEAD:** `755efcbec875eb872d1f98f7d5d0ed62bbbbe978` · **Branch:** `feature/v2.5-spaces-completion`
**Type:** READ-ONLY investigation. No history code changed, no engines merged, no valuation basis altered, no BTC read optimized, no commit, no push.

**Method.** Full re-read of every writer at HEAD (post-HIST-1: `032dc14` + `a23bf93` landed), cross-checked by two source-census sub-agents (all callers of M1–M4; the crypto/BTC valuation path + A8 crypto readiness). Line citations are to current HEAD. Prior INVEST-1 line numbers are NOT reused.

**Framing.** HIST-1 landed the low-risk consolidations (shared `isReconstructableCard`, shared `nearestOnOrBefore`, batched historical investment valuation `getInvestmentValueForWindow`, shared-Space scope disclosure). This audit answers the three deferred questions: (1) merge M2+M3; (2) unify today/history valuation basis; (3) batch BTC reads / generalize crypto. **Headline: the high-value, low-risk work is BTC batching + a small shared day-assembly core; the full M2/M3 merge and any basis-unification schema change are NOT justified.**

---

## 1. Current M1/M2/M3/M4 architecture (Part A)

Four writers over the single `SpaceSnapshot` cache (`@@unique([spaceId, date])`, 10 Float money columns + `isEstimated` + `reportingCurrency` + `amendedByAmendmentId`, `schema.prisma` SpaceSnapshot model). No `realAssets` column — folded into `totalAssets`/`netWorth` at write.

### M1 — `lib/snapshots/regenerate.ts` (live "today")
- **Exports:** `regenerateSpaceSnapshot(spaceId, date=todayUTC)` (`:53`), `regenerateSnapshotsForAccounts(ids)` (`:180`). **No `client` param — always `db`.**
- **Persistence:** UPSERT on `[spaceId,date]` (`:149`). Writes exactly today's row.
- **Population:** `getAccounts({spaceId})` (`:57`) minus CONSENT_REQUIRED investment accounts (Part-B, `:69-87`). REG-1 removed the old zero-tx cash gate (`:89-105`) so today reconciles with the live KPI.
- **Valuation:** `classifyAccounts(eligible, ctx)` over **`account.balance`** (provider-reported) for every bucket, incl. investments and crypto. FX at yesterday's close (`dates:[yesterdayUTCISO()]`, `:119-122`).
- **isEstimated:** `false` (observed).
- **Server chain:** **server-BOUND** — `getAccounts` → `@/lib/space` → `next/headers cookies()` + `next-auth`. App-runtime only; no CLI caller.
- **Callers (all app-runtime, default db):** `lib/plaid/refresh.ts:548,467`, `lib/plaid/exchangeToken.ts:605`, `lib/events/handlers/snapshot.ts:30` (share-change), `app/api/accounts/*` routes (manual/wallet/[id]/sync/restore).

### M2 — `lib/snapshots/backfill.ts` (new-Space 30-day backfill)
- **Exports:** `backfillSpaceSnapshots(spaceId, opts?)` (`:82`). **No `client` param — always `db`.**
- **Persistence:** **CREATE-ONLY** `createMany({skipDuplicates:true})` (`:308`). Never overwrites; belt-and-suspenders `existingDates` skip (`:273,282`).
- **Gate:** new-Space `existingRows.length > 1 ⇒ return 0` (`:94`); bypass via `ignoreNewSpaceGate` (dev only).
- **Window:** fixed 30 days (`BACKFILL_DAYS`, `:80,126`).
- **Population:** ACTIVE non-deleted `SpaceAccountLink` (`:89-114`), queried directly (NOT `getAccounts`) to stay off the server-only chain.
- **Valuation:** cash + revolving-card walk-back (backfill-core); **investments/crypto/loans HELD FLAT** at current balance; REG-2 held-flat cash/debt (`:163-165`); per-day FX (`buildSpaceConversionContext`, `:274-277`); `classifyAccounts` + `computeSnapshotFields` per day.
- **isEstimated:** `true` (all rows).
- **Guards:** none (create-only cannot clobber an observed row, so it needs none).
- **Server chain:** **server-only-FREE** by design (module header `:12-15`).
- **Callers:** `lib/plaid/backgroundHistorySync.ts:95` (app deferred pipeline), `scripts/backfill-snapshots.ts` ×4 (**plain tsx**, the off-server-chain path).

### M3 — `lib/snapshots/regenerate-history.ts` (windowed re-derivation / A9)
- **Exports:** `regenerateWealthHistory(args)` (`:140`), `regenerateWealthHistoryForAccounts(ids, window)` (`:540`), `recentWealthWindow(now)` (`:528`), `wealthRegenerationEnabled()` (`:60`). **Accepts `args.client` (injectable, defaults `db`, `:141`).**
- **Persistence:** **UPSERT / overwrite** (`:489-493`).
- **Gate:** `applyWrites = !dryRun && (wealthRegenerationEnabled() || isAmendment)` (`:146`) — `WEALTH_REGENERATION_ENABLED` kill switch, bypassed only by `isAmendment`.
- **Window:** arbitrary `{fromDate,toDate}`.
- **Population:** same ACTIVE non-deleted link set as M2 (`:160-166`) + reads `nativeBalance` (crypto qty) + `positionObservation` for held instruments (`:207-213`).
- **Valuation:** cash/card walk-back (backfill-core, shared with M2); **investments = A8 batch** via `getInvestmentValueForWindow` (HIST-1C, `:349-356`); **crypto = `nativeBalance` (constant) × `readBtcUsdAsOf(day)`** (`:388-399`); per-day FX; every honesty decision delegated to `regenerate-history.core.regenerateDay`.
- **isEstimated:** flip `tier !== "observed"` (`.core:179`); amendment forces `true`.
- **Guards (`.core`):** FROZEN (skip observed rows, `.core:128`), MEMBERSHIP-CHANGED (skip since-revoked days, `.core:139`), NO-FABRICATION (keep flat when no A8 evidence, `.core:150`), FLIP, MONOTONE.
- **Diff/audit:** emits `WealthHistoryDiff[]` (per-day before/after) — M2 has none.
- **Server chain:** **server-only-FREE**.
- **Callers:** `lib/plaid/backgroundHistorySync.ts:195,199`, `jobs/sync-crypto.ts:54,56`, `jobs/sync-banks.ts:105,113,114`, `scripts/regenerate-wealth-history.ts` (**tsx**), and **M4** (passes a transaction client).

### M4 — `lib/snapshots/snapshot-amendment.ts` (consent/audit wrapper)
- **Exports:** `previewAmendment(req)` (`:123`, read-only dry-run), `applyAmendment(req)` (`:169`). Accepts `req.client`.
- **Owns NO reconstruction math** — delegates all compute to M3 with `isAmendment:true` (`:130,195`).
- **Responsibilities:** create `SnapshotAmendment` (PENDING→APPLIED), store `SnapshotAmendmentDay` before/after breakdown (durable, survives account hard-delete), one `AuditLog`, consent (`consentedAt`). PERSONAL-space only in Phase 2 (`:127,177`).
- **The ONLY path allowed to bypass** frozen + membership guards + the kill switch — gated by explicit consent instead.
- **Callers:** `app/api/spaces/[id]/wealth/amend/route.ts` only (the route does NOT pass a client; `applyAmendment` opens its own interactive transaction and forwards it into M3).

---

## 2. M2 / M3 semantic-diff matrix (Part B)

| Dimension | M2 `backfill.ts` | M3 `regenerate-history.ts` | Shared? |
|---|---|---|---|
| Input population | ACTIVE non-deleted links | ACTIVE non-deleted links (+ nativeBalance, held-instrument positions) | **YES** (same link set) |
| Time window | fixed 30 days back | arbitrary `{fromDate,toDate}` | NO |
| Cash walk-back | `reconstructDailyCashBalances` | `reconstructDailyCashBalances` | **YES (byte-identical, backfill-core)** |
| Card reconstruction | `reconstructDailyLiabilityBalances` + `isReconstructableCard` | same | **YES (backfill-core + HIST-1A)** |
| Floor rules | earliest-tx + link-floor (shared spaces) | earliest-tx + link-floor (shared spaces) | **YES (same logic)** |
| Held-flat behavior | `isHeldFlatBalanceAccount` (REG-2) | `isHeldFlatBalanceAccount` (REG-2) | **YES (backfill-core)** |
| Investment valuation | **HELD FLAT** | **A8 batch** (`getInvestmentValueForWindow`) | **NO** (M3 superset) |
| Crypto valuation | **HELD FLAT** | `nativeBalance × readBtcUsdAsOf` (BTC-specific) | **NO** (M3 superset) |
| FX context | `buildSpaceConversionContext`, per-day | same | **YES** |
| Snapshot classification | `classifyAccounts` + `computeSnapshotFields` | `classifyAccounts` + `computeSnapshotFields` (via `.core`) | **YES** |
| isEstimated | always `true` | flip `tier!=="observed"`; amendment→`true` | NO |
| Persistence | `createMany` **create-only** | `upsert` **overwrite** | NO |
| skipDuplicates | yes | n/a (upsert) | NO |
| Frozen protection | none (cannot clobber) | `skip-frozen` guard | NO |
| Membership-changed protection | none | `skip-membership-changed` guard | NO |
| No-fabrication guard | implicit (only writes missing dates) | explicit `skip-unsupported` guard | NO |
| Kill switch | new-Space gate (`≤1 snapshot`) | `WEALTH_REGENERATION_ENABLED` | NO |
| Amendment bypass | n/a | `isAmendment` bypasses guards + gate | NO |
| Client injection | none (always `db`) | `args.client` | NO |
| Audit / diff output | none | `WealthHistoryDiff[]` | NO |
| Failure semantics | whole run best-effort at call site | best-effort per sub-step (BTC/A8 non-fatal); per-day guards | NO |
| Script-runnability | yes (tsx) | yes (tsx) | **YES** |
| server-only chain | free | free | **YES** |

**Reading of the matrix.** Every *compute primitive* is already shared (walk-backs, card predicate, floors, held-flat, FX, classify, computeSnapshotFields) — HIST-1 finished that. The remaining divergence is entirely **persistence posture + valuation richness + safety guards + gate + governance**, and M3's math is a strict superset of M2's (held-flat = A8/BTC-disabled). The genuinely *unshared code* that still duplicates is the **per-day account-assembly scaffolding** — filter accounts by floor, overlay walk-back cash/card maps, build `dayAccounts`, base-`classifyAccounts` — hand-rolled in both (`backfill.ts:279-301` vs `regenerate-history.ts:333-357`).

---

## 3. Safety-property matrix + valid-mode analysis (Part C)

| Property | Owner | Must survive any consolidation | How enforced today |
|---|---|---|---|
| Never overwrite an observed row | M2 (structurally) + M3 (guard) | **YES** | M2: create-only; M3: `skip-frozen` |
| Create-only safety | M2 | **YES** | `createMany skipDuplicates` |
| Script-runnable (off server-only) | M2, M3 | **YES** | no `getAccounts`/`@/lib/space` import |
| New-Space gate | M2 | YES | `existingRows>1 ⇒ 0` |
| Overwrite/upsert capability | M3 | YES | `upsert` |
| Historical valuation (A8+BTC) | M3 | YES | `getInvestmentValueForWindow`, `readBtcUsdAsOf` |
| Frozen-row protection | M3 | **YES** | `.core skip-frozen` |
| Membership-change protection | M3 | **YES** | `.core skip-membership-changed` |
| No-fabrication | M3 | **YES** | `.core skip-unsupported` |
| Amendment bypass (consent-gated) | M3+M4 | **YES** | `isAmendment` + M4 consent/audit |
| Kill switch | M3 | YES | `WEALTH_REGENERATION_ENABLED` |
| Durable audit trail | M4 | **YES** | `SnapshotAmendmentDay` + `AuditLog` |

### Valid-mode matrix (if forced into one writer with axes `{persistence, valuation, guards, gate}`)

| persistence | valuation | guards | gate | Valid? | Note |
|---|---|---|---|---|---|
| create-only | flat | off | new-Space | ✅ | = **M2** |
| upsert | A8+crypto | on | kill-switch | ✅ | = **M3 automatic** |
| upsert | A8+crypto | **bypassed** | consent | ✅ | = **M3 amendment (via M4)** |
| create-only | A8+crypto | off | new-Space | ⚠️ | *meaningful but unused* (rich-valued new-Space backfill) |
| create-only | flat | **on** | any | ❌ | **nonsensical** — create-only never clobbers, so frozen/membership guards are dead code |
| upsert | any | **off** | any | ❌ | **DANGEROUS** — overwrite with no frozen protection destroys observed rows |
| create-only | any | **bypassed(amendment)** | consent | ❌ | **nonsensical** — amendment exists to *revise* existing rows; create-only can't |
| upsert | flat | on | kill-switch | ⚠️ | would *downgrade* history to flat — a regression, never wanted |

**Conclusion:** the mode space has exactly **3 valid points** (M2, M3-auto, M3-amend) out of ~16, and the invalid region contains the two most dangerous combinations (`upsert + guards-off`, `create-only + amendment`). The safety of the current design comes precisely from the fact that **create-only and guarded-overwrite are two different code paths that cannot be misconfigured into each other.** A `persistenceMode` flag deletes that structural guarantee.

---

## 4. One writer vs shared core — verdict (Part D)

**Option 1 (one mode-parameterized writer): REJECTED.** It converts a structural guarantee (two paths that can't be confused) into a runtime invariant (a mode combination that must be validated), and the dangerous invalid combos are the ones a flag makes reachable. Judged against the criteria:
- correctness: ↓ (invalid modes become representable)
- readability: ↓ (one function branching on 4 axes vs two named contracts)
- invalid-state prevention: ↓↓ (the whole point of Part C)
- testability: ↓ (combinatorial mode surface vs two small contracts)
- script boundary / auditability / extension: neutral
- The only gain is file count — explicitly rejected as a reason.

**Option 2 (shared pure compute core + two thin persistence entry points): RECOMMENDED.** The entry points already exist (`backfillSpaceSnapshots`, `regenerateWealthHistory`) and are already thin-ish. The residual duplication is the per-day **base-totals assembly** (floor-filter accounts → overlay walk-back maps → `dayAccounts` → base `classifyAccounts`/`computeSnapshotFields`). Extract that into one pure helper (candidate: `buildDailyBaseSnapshots(accounts, floors, dailyCash, dailyCard, ctx, window)` in `backfill-core` or a new `historical-days-core.ts`); M2 persists it create-only-flat, M3 overlays A8/BTC + guards + upsert. This shrinks duplication **without** collapsing the two safety contracts, keeps both create-only and guarded-overwrite as distinct code, and is behavior-preserving.

**Verdict: shared compute core = YES; one mode-parameterized writer = NO; M2/M3 full merge = PARTIAL (share the day-assembly core, keep two entry points).**

---

## 5. Required parity suite before any consolidation (Part E)

A fixture harness (deterministic, DB-free where possible; the DB-coupled legs validated on seeded data) asserting M2 and M3 outputs per case. Byte-identical where the *base reconstruction* is the same; intentionally different where M3 adds valuation/guards.

| # | Case | Expected M2 | Expected M3 | Byte-identical base? |
|---|---|---|---|---|
| 1 | New Personal Space, cash-only | 30 rows create-only, cash walked, `isEstimated=true` | same cash + investments A8 (∅) → same numbers, upsert | **YES** (cash/debt fields) |
| 2 | Existing Space w/ observed rows | gate → 0 rows (new-Space gate) | observed rows `skip-frozen`; estimated rows re-derived | **N/A** (M2 no-ops) |
| 3 | Revolving credit card | card walk-back (ADD) | identical card walk-back | **YES** |
| 4 | Installment debt (loan) | held flat | held flat | **YES** |
| 5 | Brokerage (with position history) | investment **flat** | investment **A8-valued** | **NO (intended)** |
| 6 | Crypto (BTC wallet) | crypto **flat** | crypto **nativeBalance×BTC** | **NO (intended)** |
| 7 | Mixed multi-account | flat inv/crypto + walked cash/card | A8 inv + BTC crypto + walked cash/card | cash/card **YES**, inv/crypto **NO** |
| 8 | Membership changed (revoked account) | M2 (create-only) writes only missing dates from current set | M3 `skip-membership-changed` leaves stored value | **NO (intended)** |
| 9 | Frozen rows present | M2 never touches (create-only) | M3 `skip-frozen` | both preserve — **YES (both leave frozen intact)** |
| 10 | Missing historical price | crypto/inv flat (no price needed) | A8/BTC `no-evidence` → `skip-unsupported`/flat kept | inv/crypto: M3 keeps flat = **YES on that field** |
| 11 | Missing FX rate | native pass-through + `estimated` | native pass-through + `estimated` | **YES** |
| 12 | Before account floor | account excluded from day | account excluded from day | **YES** |
| 13 | Amendment flow | n/a (M2 not in amendment path) | `isAmendment` bypasses guards, forces `isEstimated=true`, stamps `amendedByAmendmentId` | **N/A** |

**Ratchet:** for cases 1,3,4,7(cash/card),9,11,12 the *cash/card/floor/held-flat base fields* must be byte-identical between the extracted core as consumed by M2 and by M3 (that is the parity proof the shared-core extraction needs). Cases 5,6,8,10,13 are the intentional divergences and must be asserted to **differ** in the documented way.

---

## 6. Today/yesterday basis kink — quantification (Parts F, G)

**The kink.** Today (M1) values investments and crypto at **`account.balance`** (provider-reported), `isEstimated=false`. Yesterday/history (M3) values investments at **Σ qty×`RAW_CLOSE`×FX** (A8) and crypto at **`nativeBalance`×`readBtcUsdAsOf`**, `isEstimated=true`. Both persist to the same `SpaceSnapshot` columns and both are read as one series by `WealthTimeMachine` (`resolveState` nearest-≤ over `Snapshot[]`), which labels estimated rows **"Reconstructed"** vs **"Observed"** (`wealth-time-machine.ts` completeness).

**Modeled magnitude (deterministic; no unsafe prod reads).** The two bases differ by exactly `providerAccountBalance − Σ(qty × archiveClose × FX)`. Contributors, by cause:

| Boundary/case | Basis A (provider today) | Basis B (reconstructed close) | Typical Δ | Dominant cause |
|---|---|---|---|---|
| Today vs yesterday, liquid equity, market day | live account mark | prior close ×qty | small (intraday drift) | **intraday price movement** (real, not error) |
| Weekend / holiday | Friday provider mark | Friday close | ~0 | none (same close) |
| Last market close vs "today" | provider EOD mark | our RAW_CLOSE | cents–low-% | **provider mark timing / delayed quote** |
| Stale security price (>7d) | provider mark (fresh) | A8 `unvalued` (7-day floor) | **large** (instrument drops out) | **unvalued instrument** — B omits it, A includes it |
| Foreign-currency instrument | provider mark in reporting ccy | native×FX at that date | small–med | **FX timing** (provider vs our archive rate) |
| Crypto (24/7) | live sync USD balance | `nativeBalance × BTC close` | med (24/7 vs daily close) | **crypto 24/7 pricing** + provider mark |
| Cash sweep in brokerage | provider includes sweep cash | A8 values positions only | med | **cash sweep / balance-only holdings** |
| Balance-only investment (no holdings) | provider account balance | A8 `∅` (no positions) → held-flat/omitted | **large** | **balance-only holdings** |

**Classification of the kink:** it is a **real, disclosed valuation-basis discontinuity**, not a corrupted number. The two bases *should* differ for legitimate reasons (intraday movement, provider mark timing, 24/7 crypto). The **materially confusing** cases are the ones where the reconstructed basis **omits value the provider includes** — a stale/unvalued instrument, a balance-only investment account, or brokerage sweep cash — producing a visible today→yesterday *drop* that reads as a loss. Those are coverage gaps, not basis philosophy.

---

## 7. Product-semantics decision — what "today" should mean (Part H)

The live surfaces (InvestmentsWorkspace hero, Wealth hero, Net-Worth KPI, live account cards) all read the **provider-reported current balance** — and REG-1 (`regenerate.ts:89-105`) *deliberately* re-aligned today's snapshot to reconcile with the live KPI after the ~$9k regression. Snapshot doctrine holds today's row as **"the observed truth of what balances said that day"** (`.core:20-21`).

**Decision: today's Wealth/Net-Worth SHOULD match the provider-reported current balance** (interpretation #1 — "provider-reported current account value"), because:
- it is the number every live surface already shows (hero, KPI, account cards); making the snapshot disagree would re-open the class of bug REG-1 just closed;
- it is the most *honest* statement of "what you have right now" — the provider is the authority on current account value;
- reconstructed market value (#2) is a *derivation*, correct for history where per-holding truth must be replayed, but strictly weaker than the provider's own current mark.

**Therefore the current+historical charts should NOT be forced onto one basis at the cost of today disagreeing with the provider.** The seam is legitimate; the fix is **legibility**, not unification. This is the product/honesty call, and it points at Strategy A/E below, not B/C.

---

## 8. Basis-unification strategy comparison (Part I)

| Strategy | Financial honesty | User expectation | Chart continuity | Provider variance | Schema | Perf | Crypto | FX | Investments consistency | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| **A — keep observed-today / reconstructed-history, surface basis** | ✅ highest (provider = current truth, derived labeled) | ✅ hero matches provider | ⚠️ visible seam (disclosed) | ✅ preserved | none | none | ok | ok | ✅ matches live KPI | **RECOMMENDED** (+ disclosure) |
| B — reconstruct today via A8 too | ⚠️ today would DISAGREE with provider/KPI (re-opens REG-1) | ❌ hero ≠ account cards | ✅ smoothest | ❌ hides provider mark | none | +cost daily | ok | ok | ❌ breaks live-KPI reconciliation | **NO** |
| C — store both `providerObservedValue` + `reconstructedValue` | ✅ both truths retained | neutral | ✅ (pick per surface) | ✅ | **+2 columns ×? +migration** | +write | ok | ok | ✅ | **NO** (schema cost unjustified for a disclosed seam) |
| D — reconstructed last-close for chart, live provider for hero | ✅ | ✅ | ✅ | ✅ | none | none | ok | ok | ✅ | ≈ **current state** (already effectively this) |
| E — A + explicit basis transparency (reuse HIST-1D-style note) | ✅ | ✅ | seam **explained** | ✅ | none | negligible | ok | ok | ✅ | **RECOMMENDED refinement of A** |

**Recommendation: Strategy A refined by E** — keep the basis exactly as-is (observed-today, reconstructed-history), and add a concise, reusable **basis-transparency note** (the WealthTimeMachine already computes the "Observed vs Reconstructed" tier; surface *why* the today point may differ from yesterday, and specifically flag the *coverage-gap* cases from §6 — a stale/unvalued instrument or balance-only account that the reconstructed basis omits). No schema change. No stored-basis change.

---

## 9. BTC per-day read profile (Part J)

- **Reader:** `readBtcUsdAsOf(dateISO, maxStaleDays=7)` (`lib/crypto/btc-price.ts:75`) → `priceArchive.readLatestOnOrBefore(btcInstrumentId, RAW_CLOSE, dateISO, 7)`.
- **Data source:** the **generic `PriceObservation`** table (NOT a BTC-specific table, NOT a live API at read time), one canonical `Instrument` (BTC, RAW_CLOSE), same archive A8 uses.
- **Query shape:** `findFirst` `{instrumentId, basis:RAW_CLOSE, date:{lte, gte:floor}}` `orderBy date desc` — one indexed point read, walk-back floor = `date − 7d`.
- **Fallback/staleness:** nearest close ≤ date within 7 days; else `null` (flat kept, never fabricated).
- **FX basis:** returns **USD only**; USD→reporting FX happens later in `classifyAccounts`.
- **Quantity source:** `FinancialAccount.nativeBalance` (BTC amount) held **constant** across the window (block explorer is current-balance-only).
- **Scope:** all `type==="crypto"` accounts with `nativeBalance != null`, valued at the **single** BTC price.
- **Why one read per day:** M3 loops `candidateDates` and calls `readBtcUsdAsOf(dISO)` once per day (`regenerate-history.ts:389`) — no window batch exists.

**DB cost (crypto-bearing Space):**

| Window | BTC point reads (`findFirst`) | vs. one `readRange` |
|---|---|---|
| 7-day | 7 | 1 |
| 30-day | 30 | 1 |
| 90-day | 90 | 1 |
| 365-day | 365 | 1 |

`backfillBtcPrices(from,to)` already does one ranged CoinGecko fetch + one `writeBatch` per run — only the **reads** are per-day.

---

## 10. BTC batching options (Part K)

The archive already exposes `readRange(instrumentIds, basis, fromISO, toISO)` (`archive.ts:85`) returning `{instrumentId,dateISO,price,currency}[]` — the exact window shape A8's `getInvestmentValueForWindow` consumes, resolved in memory with the same nearest-≤-within-floor semantics (and the HIST-1B `nearestOnOrBefore` helper exists).

| Option | What | Reuses source/semantics? | Generalizes to ETH/SOL? | Risk | Verdict |
|---|---|---|---|---|---|
| **1 — batch the existing BTC reader** | add `readBtcUsdForWindow(from,to)` = one `readRange([btc], RAW_CLOSE, from−7, to)` + in-memory nearest-≤ per day | ✅ same archive, date rule, 7-day staleness, USD passthrough, constant qty | ❌ still single-scalar BTC | **LOW** | **safe now** |
| **2 — move crypto historical valuation into A8** | value crypto via `getInvestmentValueForWindow` scoped to digital-asset accounts, `holdConstantBeforeEarliest:true`; write result to `totalDigitalAssets` | ✅ A8 is the price authority; per-instrument | ✅ **yes** | **MEDIUM** | the long-term answer |
| 3 — BTC-specific valuation but share a generic price-window resolver | keep `nativeBalance×price` but feed it from a shared window resolver | ✅ | partial | LOW-MED | intermediate; less clean than 2 |

**Critical distinction (per the mission):** valuation *authority* ≠ snapshot *bucket placement*. Option 2 uses A8 to *value* crypto while M3 still *writes* it to `totalDigitalAssets` separately — the intentional bucket split (which prevents the historical BTC double-count, `valuation.ts:126-137`) is preserved by scoping the A8 call to digital-asset accounts and assigning its subtotal to the crypto bucket, exactly mirroring how the investment call is scoped with `excludeDigitalAssetAccounts:true` today.

**Key precondition for Option 2 (verified):** crypto prices ARE already in the generic archive (RAW_CLOSE, same canonical Instrument as the position spine — `btc-price.ts:63-67`, `crypto-instrument.ts`), and crypto quantities ARE on the shared `PositionObservation` spine via `captureWalletPosition` (gated `INVESTMENT_OBSERVATIONS_ENABLED`). A8 with `holdConstantBeforeEarliest:true` reproduces M3's constant-quantity×close semantics **generically**. **Gap:** `getInvestmentValueForWindow` currently offers only `excludeDigitalAssetAccounts` (investments-only) — Option 2 needs the **inverse** (a `digitalAssetsOnly` scope) added to the window entry point.

---

## 11. Crypto-generalization findings (Part L)

**The M3 historical crypto path is BTC-SPECIFIC and would MIS-VALUE non-BTC.** It reads one scalar `readBtcUsdAsOf(day)→BTC-USD` and multiplies **every** `type==="crypto"` account's `nativeBalance` by that single BTC price (`regenerate-history.ts:388-399`). An ETH or SOL wallet account (also `type==="crypto"`) would have its ETH/SOL quantity valued at the BTC price — a silent, large error.

- **Supported today: BTC only.** `BTC_ASSET` is the only `CryptoAsset`; `btc-sync.ts` hardcodes BTC. The `crypto-instrument.ts` resolver is generic ("ETH/SOL land by adding a descriptor") but no ETH/SOL adapter or sync exists.
- **What must generalize before non-BTC ships:** (a) M3's crypto valuation must become **per-instrument** (Option 2 above solves this for free — A8 is already per-instrument); (b) the crypto sync must write per-asset `PositionObservation` + `nativeBalance`; (c) per-asset RAW_CLOSE price backfill (today only `backfillBtcPrices` exists — a generic crypto price backfill would be needed).
- **This is more important than optimizing `readBtcUsdAsOf`:** batching a wrong-for-ETH scalar is polishing a landmine. **Option 2 (crypto→A8) both batches AND generalizes AND removes the BTC-specific reader** — it is strictly the better long-term move, at MEDIUM risk.

---

## 12. Performance profile (Part M)

M3 per D-day window, crypto-bearing Space:

| Cost | Before HIST-1C | After HIST-1C (now) | After hypothetical BTC batch |
|---|---|---|---|
| Account/link reads | ~1 (links) + 1 (space) | same | same |
| Transaction reads | earliest-tx groupBy (1) + cash deltas (1) + card deltas (1) + revoked (1) | same | same |
| Investment window reads | **~7 × D** (per-day `getInvestmentValueAsOf`) | **~7 once** (`getInvestmentValueForWindow`) | ~7 once |
| Crypto reads | **D** (`readBtcUsdAsOf` per day) | **D** (unchanged) | **1** (`readRange`) |
| Held-instrument position read | 1 | 1 | 1 |
| FX reads | 1 ctx build | 1 ctx build | 1 ctx build |
| Existing-rows read | 1 | 1 | 1 |
| Writes | **D** upserts (write-days) | D upserts | D upserts |

**Dominant remaining cost after HIST-1C:** for crypto Spaces, the **D `readBtcUsdAsOf` point reads** are now the only per-day *read* hot path — the exact analogue of the investment N×date cost HIST-1C already killed. After BTC batching, the remaining O(D) cost is the **D `spaceSnapshot.upsert` writes**, which are semi-inherent (one row per day; overwrite semantics preclude a single `createMany`), though they could be wrapped in one transaction to cut round-trips (minor, separate).

**Headline: BTC batching is the last N×date READ hot path in M3.**

---

## 13. Recommended implementation slices (Part N)

Derived from findings, ordered by value/risk:

1. **HIST-2C — BTC/crypto historical valuation via A8 (generic, batched).** Add a `digitalAssetsOnly` scope to `getInvestmentValueForWindow`; value crypto through it with `holdConstantBeforeEarliest:true`, assign the subtotal to `totalDigitalAssets`. **Simultaneously** kills the D `readBtcUsdAsOf` reads (batched), removes the BTC-specific scalar path, and generalizes to ETH/SOL — one move solving Parts J/K/L. Preconditions to verify first: crypto `PositionObservation` reliably populated (`INVESTMENT_OBSERVATIONS_ENABLED`), and a parity gate proving A8-crypto == current `nativeBalance×BTC` for the BTC case. *(If those preconditions are not yet met, fall back to **HIST-2C-lite**: batch the existing BTC reader via `readBtcUsdForWindow` — LOW risk, keeps the scalar path, does NOT generalize.)*
2. **HIST-2A — shared day-assembly compute core.** Extract the per-day base-totals assembly duplicated by M2 and M3 into one pure helper; both consume it. Behavior-preserving, needs the §5 parity ratchet. LOW risk.
3. **HIST-2E — today/history basis transparency.** Strategy A+E: a concise, reusable note surfacing why the today point may differ from reconstructed history, especially the coverage-gap cases (stale/unvalued instrument, balance-only account, brokerage sweep). No schema change. LOW risk.

**NOT recommended:** HIST-2B (thin entry points already exist — folded into 2A), HIST-2F (basis unification — rejected in §7/§8), any `SnapshotAmendment`-touching merge, one mode-parameterized writer.

---

## 14. Risk classification (Part O)

| Slice | Risk | Affected authorities | Schema | Persisted-data impact | Migration | Parity tests | Rollback |
|---|---|---|---|---|---|---|---|
| HIST-2C (crypto→A8 generic+batch) | **MEDIUM** | A8 valuation (add scope), M3 crypto path, `getInvestmentValueForWindow` | none | none (same numbers if parity holds) | none | **required** — A8-crypto == BTC-scalar for BTC; ETH/SOL correctness; bucket-split (crypto→`totalDigitalAssets`, no double-count) | easy (revert; BTC reader still present) |
| HIST-2C-lite (batch BTC reader) | **LOW** | BTC reader only | none | none | none | window==per-day parity | trivial |
| HIST-2A (shared day core) | **LOW** | M2, M3 (compute only) | none | none | none | §5 base-field byte-parity ratchet | easy |
| HIST-2E (basis transparency) | **LOW** | none (UI/disclosure only) | none | none | none | copy/gating unit test | trivial |
| ~~M2/M3 one-writer merge~~ | **HIGH** | M1–M4 | none | high (overwrite paths) | none | full ×13 matrix | hard |
| ~~Basis unification / store-both~~ | **HIGH** | M1, snapshot doctrine | +columns | rewrites basis | **yes** | huge | hard |

---

## Verdict

**M2/M3 full merge justified?** **PARTIAL** — share the residual day-assembly compute core; keep two persistence entry points. Do NOT fuse into one writer.

**Shared compute core justified?** **YES** — extract the duplicated per-day base-totals assembly (HIST-2A). Small, behavior-preserving, low-risk.

**One mode-parameterized writer safer than two thin entrypoints?** **NO** — the mode space has only 3 valid points of ~16 and makes the two most dangerous combinations (`upsert+guards-off`, `create-only+amendment`) representable; two named paths are a structural safety guarantee.

**Today/yesterday valuation kink materially harmful?** **PARTIAL** — a real, honestly-disclosed basis discontinuity; not a corrupted number. Materially confusing only in the coverage-gap cases (stale/unvalued instrument, balance-only account, brokerage sweep) where the reconstructed basis omits value the provider includes.

**Valuation basis should be unified?** **NO** (for the stored basis) / **PARTIAL** (unify the *disclosure*, not the numbers). Reconstructing today would make Wealth disagree with the provider balance and the live KPI — re-opening the REG-1 class of bug. Keep observed-today/reconstructed-history; add transparency (HIST-2E).

**Schema change justified?** **NO** — every recommended slice is schema-free; store-both (Strategy C) and basis unification are rejected.

**BTC per-day reads materially inefficient?** **YES** — D indexed point reads per window where one `readRange` suffices; the last N×date read hot path in M3.

**BTC batching safe?** **YES** — reuse `priceArchive.readRange` + in-memory nearest-≤ (same source, date rule, 7-day staleness, USD passthrough, constant quantity). No second authority.

**BTC-specific historical path should survive long-term?** **NO / PARTIAL** — the single-scalar `readBtcUsdAsOf(date)→BTC-USD` is what makes M3 BTC-only and would mis-value ETH/SOL; it should be replaced by the generic A8 per-instrument path. (PARTIAL only in that `readBtcUsdAsOf` may remain a convenience reader for the live "today" crypto valuation, not the historical writer.)

**Generic crypto historical valuation justified?** **YES** — via A8 (crypto already shares the `PositionObservation` spine and the RAW_CLOSE archive); this is the correct home and generalizes to ETH/SOL. Gated on verifying crypto-spine population and a BTC-case parity proof.

**Safe implementation work available now?** **YES** — HIST-2A (shared day core), HIST-2E (basis transparency), and HIST-2C-lite (batch the BTC reader) are all LOW-risk and available immediately; HIST-2C (crypto→A8 generic) is MEDIUM and available once its preconditions are verified.

**Recommended next slices (ordered):**
1. **HIST-2C** — crypto historical valuation via A8 (generic + batched; add `digitalAssetsOnly` window scope, preserve the `totalDigitalAssets` bucket split). Fall back to **HIST-2C-lite** (batch the BTC reader) if the crypto-spine/parity preconditions aren't yet met.
2. **HIST-2A** — extract the shared per-day base-assembly compute core consumed by both M2 and M3 (§5 parity ratchet).
3. **HIST-2E** — today/history basis-transparency disclosure (Strategy A+E; no schema change).

*No implementation. No commit. No push.*
