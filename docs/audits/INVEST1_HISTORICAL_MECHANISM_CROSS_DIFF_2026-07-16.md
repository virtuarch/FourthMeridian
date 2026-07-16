# INVEST-1 — Historical Mechanism Cross-Diff and Consolidation Investigation

**Date:** 2026-07-16 · **HEAD:** `210150584958f003be6264db5e146576b0d7d9d8` · **Branch:** `feature/v2.5-spaces-completion`
**Type:** Read-only investigation. No history code changed, no engines merged, no as-of semantics altered, no persisted data modified, no commit, no push.

**Method.** Full source census of every historical mechanism at HEAD, cross-checked by a live execution of the canonical as-of resolver over its own deterministic fixtures (`lib/data/accounts-asof.fixtures.ts`), plus verbatim byte-comparison of the three `isReconstructableCard` copies and direct verification of the schema/population claims. Where production data access is unsafe, deterministic fixtures and the existing pinned unit tests are cited rather than re-run.

**Framing.** The 2026-07-16 staff architecture review claimed *"six distinct history mechanisms … three as-of semantics … demonstrably disagree."* This investigation confirms the count is real but refines the diagnosis: **most of the "disagreement" is load-bearing and intentional; the genuinely accidental surface is small and safely consolidatable.**

---

## 1. Full mechanism census

Twelve mechanisms + two persistence spines. Each row is cited to `file:line`.

### Persistence-writer cluster (`lib/snapshots/`)

| # | Mechanism | Purpose | Persistence | Time semantics | isEstimated |
|---|---|---|---|---|---|
| M1 | **regenerate.ts** (live/today) | Write TODAY's `SpaceSnapshot` from current balances | **UPSERT** `[spaceId,date]` (`regenerate.ts:149`) | LATEST_OBSERVATION | false (observed) |
| M2 | **backfill.ts** (30-day new-Space) | Reconstruct ≤30 days for a genuinely new Space | **CREATE-ONLY** `createMany({skipDuplicates})` (`backfill.ts:334`) | WALK_BACK (cash/card) + HELD_FLAT (rest) | true |
| M3 | **regenerate-history.ts / A9** | Re-derive an arbitrary window so investments come from A8 valuation, crypto from BTC price×qty | **UPSERT / overwrite** (`regenerate-history.ts:480`) | WALK_BACK (cash/card) + RECONSTRUCTED (inv/crypto) + HELD_FLAT | true (flip: `tier!=="observed"`) |
| M4 | **snapshot-amendment.ts** | Sanctioned consent-gated rewrite of a written range | Persists `SnapshotAmendment` + `SnapshotAmendmentDay`; **delegates all snapshot compute to M3** (`snapshot-amendment.ts:130,195`) | OTHER (inherits M3) | true (forced) |

**Census detail — M1 `regenerate.ts`.** Inputs `getAccounts({spaceId})` (`:57`) — the live dashboard data source. FX at latest close (`dates:[yesterdayUTCISO()]`, `:119-122`). Population = all links minus `CONSENT_REQUIRED` investment accounts (Part-B, `:59-87`); the former zero-transaction evidence gate is **removed** (REG-1, `:89-105`) so the row reconciles with the live KPI. `classifyAccounts` is sole authority. Consumers: `lib/plaid/refresh.ts:467,548`, account routes, `regenerateSnapshotsForAccounts` fan-out (`:180-193`).

**Census detail — M2 `backfill.ts`.** Inputs ACTIVE non-deleted `SpaceAccountLink` set (`:125-139`), earliest-tx floor (`:172-176`), per-day cash+card deltas. Per-day FX at each day's own rate (`classifyAccounts(dayAccounts, ctx, dISO)`, `:324`). New-Space gate `existingRows.length>1 ⇒ return 0` (`:120`). Never overwrites (belt-and-suspenders skip at `:308`). Consumers: `lib/plaid/backgroundHistorySync.ts:95` (app path), `scripts/backfill-snapshots.ts` (dev runners).

**Census detail — M3 `regenerate-history.ts`.** Strict superset of M2's math: imports M2's walk-backs **unchanged** (`:40-50`), then **replaces** investments with `getInvestmentValueAsOf({asOf:dISO, holdConstantBeforeEarliest:true, excludeDigitalAssetAccounts:true})` (`:382`) and crypto with `readBtcUsdAsOf(dISO)` × constant native quantity (`:400-407`). Honesty engine in `regenerate-history.core.ts:117-188`: FROZEN rows never touched (`:128-130`), NO-FABRICATION skip (`:150-155`), MEMBERSHIP-CHANGED skip (`:139-144`), FLIP `isEstimated=tier!=="observed"` (`:179`). Gated by `WEALTH_REGENERATION_ENABLED` (`:156`), bypassable only by `isAmendment`. Consumers: `regenerateWealthHistoryForAccounts` fan-out from sync jobs, wallet/sync routes, and M4.

**Census detail — M4 `snapshot-amendment.ts`.** Owns **no reconstruction math**. Persists `SnapshotAmendment` (who/what/when/kind/range/status, PENDING→APPLIED) and `SnapshotAmendmentDay` (stored before/after breakdown, `createMany`), one `AuditLog`. Consent (`consentedAt`) is "an auditable fact, not a boolean anyone could flip" (`schema.prisma:2730`). `financialAccountId` is a **soft ref with no FK** so a hard-deleted account can't cascade-destroy the amendment trail (`schema.prisma:2714-2721`). PERSONAL-space only in Phase 2. Consumer: `app/api/spaces/[id]/wealth/amend/route.ts`.

### As-of / reconstruction / valuation cluster

| # | Mechanism | Purpose | Persistence | Time semantics | FX |
|---|---|---|---|---|---|
| M5 | **getAccountsAsOf** (A5) `lib/data/accounts-asof.*` | Resolve every account balance to one asOf date, stamped `{method,tier}` | none | WALK_BACK (cash/card) + HELD_FLAT (rest) + observed (present) | **none** (raw balances) |
| M6 | **reconstruction-core / A4** `lib/investments/reconstruction-*.ts` | Backward event-sourced position **quantities** from observed anchor | Writes DERIVED `PositionObservation` + `PositionReconstruction` (`runner.ts:150-200`) | RECONSTRUCTED (backward-from-anchor) | none (quantities only) |
| M7 | **resolvePositionAsOf** (A4 read) `reconstruction-read.ts:143` | Pick the position row for a date | none | NEAREST_ON_OR_BEFORE + origin precedence | none |
| M8 | **getInvestmentValueAsOf / A8** `lib/investments/valuation.ts` | Point-in-time value = qty×price×FX | none | NEAREST_ON_OR_BEFORE (qty) + NEAREST_ON_OR_BEFORE-within-staleness-floor (price) | at asOf date |
| M9 | **A10 Investments Time Machine** `investments-time-machine.ts` | Holdings + valued portfolio + flows + reconciliation | none | OTHER (composition: A8×2 + events) | inherits A8 + per-event |

**Census detail — M5 `getAccountsAsOf`.** Present short-circuit → `observed` (`accounts-asof.core.ts:99,126`); cash/card → walk-back `derived` (`:135-149`); everything else → `held-flat`/`estimated` (`:153`); before floor → `before-coverage`/`incomplete`, `balance:0` (`:131-133`). Floor = `max(account.createdAt, link.createdAt)`. Includes investments/crypto but **holds them flat** — the valuation overlay is the caller's job. Consumers: Liquidity lens, Debt lens, liquidity splice (M11), asof-completeness lens.

**Census detail — M6/M7 reconstruction.** M6 walks quantities backward from the newest OBSERVED observation (anchor), reversing signed event quantities, stopping at un-invertible corporate actions; `unexplainedOpeningQuantity` is **never forced to 0** (`reconstruction-core.ts:9-17`). Writes gated by `INVESTMENT_RECONSTRUCTION_ENABLED`. M7 resolves reads as nearest row `≤ asOf` with `ORIGIN_RANK{OBSERVED:0,IMPORTED:1,DERIVED:2,USER_ASSERTED:3}` tie-break; no row ≤ asOf → `{quantity:null, tier:"incomplete"}`, a gap never a fabricated 0.

**Census detail — M8 `getInvestmentValueAsOf`.** Batched reads (one position window, one price window, one FX context — no N+1 *within a call*). Quantity via M7. Price via `readLatestOnOrBefore` within `minusDays(asOf, PRICE_MAX_STALE_DAYS=7)` floor (`:270,374-382`). `holdConstantBeforeEarliest` = A9's constant-quantity fallback. `excludeDigitalAssetAccounts` = the crypto-bucket split (see §3/§7). Three args make it three postures: display callers use `scope:"all"`+crypto-in; A9 uses `excludeDigitalAssetAccounts:true`; A10 uses `detailEligible`.

**Census detail — M9 A10.** Composes M8 at asOf and at compareTo (both `visibilityScope:"detailEligible"`, `:76-81`) + canonical `InvestmentEvent` flows over `(compareTo,asOf]`. Reconciliation identity `closing = opening + netExternalFlows + residualChange`; residual never a fabricated market gain. Owns no resolution semantics — inherits M8→M7→M6.

### Workspace-composition cluster

| # | Mechanism | Consumes | Persistence | Time semantics |
|---|---|---|---|---|
| M10 | **Wealth time machine** `lib/wealth/wealth-time-machine.ts` | **SpaceSnapshot series** (M1+M3 output) | none (pure) | NEAREST_ON_OR_BEFORE over a RECONSTRUCTED substrate |
| M11 | **Liquidity historical splice** `lib/liquidity/historical-splice.ts` | **M5 (getAccountsAsOf) + M8 (A8, scope 'all')** | none (pure) | RECONSTRUCTED composite (WALK_BACK + HELD_FLAT + NEAREST_≤) |
| M12 | **Debt space data** `lib/debt-space-data.ts` | **M5-derived lens + SpaceSnapshot series** | none (pure) | lens = point-in-time; history = STRICT window-clip |
| — | **Investments space data** `lib/investments/space-data.ts` | **M9 (A10) verbatim** | none | inherits A10 |

### Spines

- **`PositionObservation`** (`schema.prisma:1353-1398`) — the shared quantity spine for investments **and** crypto (P2-6). `@@unique([faId,instrumentId,date,origin,source])`; every read filters `deletedAt:null, supersededById:null`.
- **`SpaceSnapshot`** (`schema.prisma:2157`) — 13 stored money columns (see §3). No `realAssets` column (verified): it is folded into `totalAssets`/`netWorth` at write and must be back-derived as a residual on read.

---

## 2. Time-semantics matrix

The staff review's "three as-of semantics" undercounts. There are **five distinct balance/quantity resolution dialects** plus FX-nearest, and the load-bearing point is that they are **not interchangeable**.

| Dialect | Definition | Mechanisms | Staleness ceiling |
|---|---|---|---|
| **LATEST_OBSERVATION** | current provider balance; present == observed | M1; M5-present | n/a |
| **WALK_BACK** | `eod(d)=eod(d+1)∓Σamount(d+1)` from transaction deltas; held flat below earliest tx | M2, M3, M5 (cash + revolving cards) | none (holds flat below floor) |
| **HELD_FLAT** | non-cash carried at today's balance | M2, M3, M5 (inv/crypto/loans/no-tx cash) | none |
| **RECONSTRUCTED** | backward-from-anchor quantity replay (M6); or qty×price×FX re-derivation (M3 investments) | M3 (inv/crypto), M6 | stops at un-invertible action |
| **NEAREST_ON_OR_BEFORE** | last row/snapshot ≤ date (with origin precedence for M7) | M7, M8 (qty), M10 (snapshot pick) | **none for qty/snapshot** |
| **NEAREST_≤ within floor** | last price ≤ date but ≥ `asOf−7d` | M8 (price) | **7 days** (`PRICE_MAX_STALE_DAYS`) |
| **STRICT window-clip** | plot only rows in `[compareTo,asOf]`; no carry-forward, no pick | M12 (debt history) | n/a |
| **FX-nearest** | rate resolved at each row's own date; native pass-through on miss | stamp-conversion, all per-date conversions | walk-back per money layer |

**Key non-duplication facts.**
- M5 resolves **balances** by transaction walk-back; M7/M8 resolve **quantities** by nearest-observation. These are different data types and cannot share one primitive.
- Quantity/snapshot nearest-≤ carries **no staleness ceiling**; price nearest-≤ carries a **7-day** ceiling. A single "nearest-≤ resolver" would have to be ceiling-parameterized.
- M10 (Wealth) uses **nearest-≤ carry-forward** for a point-in-time card; M12 (Debt) uses **strict window-clip with no carry-forward** for a plotted trend — both read `Snapshot[]` but answer different questions.

---

## 3. Population semantics

Authority = `lib/account-classifier.ts:204-212`. Crypto boundary = `DIGITAL_ASSET_ACCOUNT_TYPES = ["crypto"]` (`:99`).

| Population | Predicate / definition | Where |
|---|---|---|
| all accounts | `getAccounts({spaceId})`, no filter; A8 `scope:"all"` | M1, M8 default |
| detailEligible | ACTIVE link with FULL per-item visibility; fails closed to ∅ | `account-scope.ts`; M9, M8 `scope:"detailEligible"` |
| investments only | `type==="investment"` → `totalInvestments` | classifier `:207` |
| investments + crypto | `totalInvestments + totalCrypto` (two **disjoint** buckets) | `space-hero.ts`, `portfolio-series.ts:64` |
| snapshot `totalInvestments` | `SpaceSnapshot.stocks = c.totalInvestments` — **excludes crypto** | `regenerate.ts:125` |
| snapshot `totalCrypto` | `SpaceSnapshot.crypto = c.totalDigitalAssets` | `regenerate.ts:126` |
| wealth total assets | `liquid + investments + digitalAssets + realAssets` | classifier `:250`; snapshot `totalAssets = stocks+crypto+cash+savings+realAssets` |
| marketable liquidity | `MARKETABLE_TYPES = {"investment","crypto"}` — **re-merges** crypto with investments | `liquidity.core.ts:108` |

**Verified crypto bucket split.** In `SpaceSnapshot`, `stocks` (investments) and `crypto` (digital assets) are **distinct columns**, `total = stocks + crypto` (`schema.prisma:2164-2166`). The split lives at the classifier / schema level and is **the same bug-scar in three places**:

1. **Snapshot regeneration** — `regenerate-history.ts:377-382` calls A8 with `excludeDigitalAssetAccounts:true`, then values crypto separately into `totalDigitalAssets`. The A8 contract (`valuation.ts:126-137`) states a caller assigning `valuedSubtotal` to `totalInvestments` **MUST** set this "or a crypto position on the shared PositionObservation spine (P2-6) is double-counted."
2. **Liquidity splice** — uses A8 `scope:"all"` **without** the flag, relying on **single-emission-per-account** (`historical-splice.ts:22-29`) — crypto valued once, in the `crypto→marketable` bucket.
3. **A10 / display** — default `excludeDigitalAssetAccounts:false`; crypto surfaces inline as a position (no separate bucket to collide with).

Pinned by tests: `backfill-core.test.ts:182-210` ("BTC counted EXACTLY ONCE"), `regenerate-history.test.ts:83`, `portfolio-series.test.ts:7`. **This is the concrete scar of the historical net-worth cliff** ([[btc-double-count-historical-valuation]]). The taxonomy differences are intentional and each is correct for its consumer.

**Two deliberately different crypto taxonomies coexist:** the SpaceSnapshot / net-worth axis **splits** crypto out of investments; the Liquidity `MARKETABLE_TYPES` axis and `accountTier()` **re-merge** crypto with investments. Neither feeds the other — this is by design, and `accountTier`'s own header warns it is not the investment-vs-digital-asset authority.

**Currency basis.** Snapshots are stamped `reportingCurrency` at write. Read-path conversion (`lib/data/snapshots.ts`) has a **homogeneous fast path** (all rows same stamp → `ctx:null`, byte-identical to pre-multicurrency); off-stamp rows convert each total at that row's own date; genuine rate misses set `fxMiss` and drop downstream, never blanking a card.

---

## 4. Cross-mechanism diff experiment (executed, not read)

I executed the canonical as-of **balance** resolver `resolveAccountsAsOf` over its own deterministic fixtures (`lib/data/accounts-asof.fixtures.ts`; `TODAY=2026-07-04`), covering the required account classes — **A** depository (`chk`,`sav`), **B** liability (`card` reconstructable, `loan` installment), **C** brokerage (`inv`), in one **E** mixed Space. Real output:

| asOf date | chk (depository) | sav (depository) | card (revolving) | loan (installment) | inv (brokerage) |
|---|---|---|---|---|---|
| **present 07-04** | 1000 observed | 5000 observed | 500 observed | 10000 observed | 20000 observed |
| **yesterday 07-03** | 1050 cash-walkback/derived | 5000 cash-walkback/derived | 500 card-walkback/derived | 10000 **held-flat/estimated** | 20000 **held-flat/estimated** |
| **in-coverage 07-02** | 850 cash-walkback/derived | 5000 cash-walkback/derived | 400 card-walkback/derived | 10000 held-flat/estimated | 20000 held-flat/estimated |
| **between-obs 06-20** | 850 derived | 5000 derived | 400 derived | 10000 estimated | 20000 estimated |
| **before inv floor 06-10** | 850 derived | 5000 derived | 400 derived | 10000 estimated | **0 before-coverage/incomplete** |
| **pre-all-floors 05-20** | 0 incomplete | 0 incomplete | 0 incomplete | 0 incomplete | 0 incomplete |

**What the run proves.**
- **Savings** resolves via the cash walk-back path but holds flat (no deltas) — method `cash-walkback`, not `held-flat`; a taxonomy nuance a code-read would miss.
- **Installment loan** is **held flat**, never walked (only revolving cards are transaction-driven) — confirms `isReconstructableCard` gates the card walk.
- **Investment** is held flat at current balance until its floor (06-15), then **`before-coverage/incomplete` with balance 0** — the honest-gap contract, not a fabricated value.
- Below all floors every account is `incomplete`/0 — no mechanism invents pre-existence.

**Valuation side (D crypto / brokerage value).** The **value** overlay for brokerage/crypto is M8's job, not M5's (M5 holds these flat). Re-running M8 requires DB position/price fixtures; instead the crypto-once and disjoint-bucket invariants are proven by the existing pinned unit tests cited in §3 (`backfill-core.test.ts:182-210`, `portfolio-series.test.ts:7`). The **stale/no-price date** behavior is M8's 7-day price floor → beyond it the instrument is `unvalued` (contributes no number), and M11 passes the account through held-flat rather than zeroing it (`historical-splice.ts:112-117`).

**Cross-mechanism agreement on the same account/date.** For an investment account on a covered date: M5 says `held-flat/estimated` at *balance*; M8 says qty×price×FX at *value*; M11 **replaces** M5's held-flat estimate with M8's value for exactly that account (once). So the three do **not** disagree — they answer balance / value / composed-liquidity respectively, and M11 is the seam that reconciles them.

---

## 5. Specific overlap audit — `backfill.ts` (M2) vs `regenerate-history.ts` (M3)

| Question | Answer |
|---|---|
| Same walk-back semantics? | **YES, byte-for-byte** — both import `reconstructDailyCashBalances`/`reconstructDailyLiabilityBalances` from `backfill-core.ts`, M3 "unchanged" (`regenerate-history.ts:13-16`) |
| Same card reconstruction? | **YES** — identical `isReconstructableCard`, both exclude pending, same liability-ADD walk |
| Same held-flat / floor predicates? | **YES** — single shared `isHeldFlatBalanceAccount` (`backfill-core.ts:170`); near-identical floor logic |
| Same FX basis? | **YES** — both `buildSpaceConversionContext` + per-day `classifyAccounts(_, ctx, dISO)` |
| Same populations? | **MOSTLY** — same ACTIVE non-deleted link set; M3 additionally values crypto + held-investments historically, M2 holds them flat |
| Create-only vs overwrite the **only** difference? | **NO** |

**Enumerated divergences (not just persistence):**
1. **Persistence** — M2 CREATE-ONLY (`createMany skipDuplicates`) vs M3 UPSERT/overwrite.
2. **Investment/crypto valuation** — M2 HELD-FLAT vs M3 A8 `getInvestmentValueAsOf` + BTC as-of. **This is M3's entire raison d'être.**
3. **Honesty guards** — M3 runs frozen/unsupported/membership/flip; M2 has none (it only writes missing dates, so it *cannot* clobber an observed row).
4. **Gate** — M2 new-Space `≤1 snapshot`; M3 `WEALTH_REGENERATION_ENABLED` kill switch.
5. **Window** — M2 fixed 30 days back; M3 arbitrary `{fromDate,toDate}`.
6. **Client injection** — M3 accepts a tx `client`; M2 always `db`.
7. **Diff/amendment emission** — M3 only.

**Could one windowed regenerator with modes replace both?** **Architecturally yes, but not a trivial merge.** M3's math is a strict superset of M2's (held-flat is what you get with the A8/BTC override disabled), and the walk-backs, floors, held-flat predicate, and FX basis are already shared through `backfill-core`. A single engine parameterized by `{persistence: create-only|upsert, valuation: flat|as-of, guards: on|off, gate}` would subsume both. **Blockers that must survive any merge:** (a) create-only is a genuine safety property — M2 must never clobber an observed row; (b) M2 is deliberately kept off the `server-only` import chain so it runs from a plain `tsx` script (`backfill.ts:13-16`). **Classification: SHARE_PRIMITIVE now; INVESTIGATE_FURTHER for full engine merge** — they materially overlap but are not duplicates.

---

## 6. Shared predicate duplication — `isReconstructableCard`

**Four live representations** of the same financial predicate:

```ts
// The identical body in all three named copies:
if (a.type !== "debt") return false;
if (a.debtSubtype === "credit_card") return true;
if (a.debtSubtype === null && a.creditLimit != null) return true;
return false;
```

| Copy | Location | Form |
|---|---|---|
| 1 | `lib/snapshots/backfill.ts:69` | named fn, multi-line param type |
| 2 | `lib/snapshots/regenerate-history.ts:67` | named fn, inline param type; self-labeled *"Parity copy of backfill.ts#isReconstructableCard"* |
| 3 | `lib/data/accounts-asof.core.ts:69` | named fn, `AsOfAccountInput` param; self-labeled parity copy |
| 4 | `lib/data/accounts-asof.ts:121` | **inline** expression duplicate (unnamed) |

**Byte-identical?** No — the three named copies differ only in whitespace/param-type formatting. **Semantically identical?** Yes — same signature shape, same four branches, same returns. The stated reason for duplication is that `backfill.ts` is on the `server-only` chain and cannot be imported into a plain script.

**Recommended canonical owner: `lib/snapshots/backfill-core.ts`.** Decisive fact: **all three copy-holding modules already import from `backfill-core.ts`** (the pure, `server-only`-free walk-back module — M2, M3, and `accounts-asof.core` all depend on it). Moving the predicate there and importing it four ways is a zero-risk consolidation that **eliminates the stated blocker entirely** (backfill-core is exactly the shared pure home the `server-only` argument was reaching for). **Classification: SHARE_PRIMITIVE — safe now.**

---

## 7. Wealth vs Investments history

| | Wealth (M10) | Investments (space-data → A10/M9) |
|---|---|---|
| Substrate | `SpaceSnapshot` series (reconstruction already baked at write time by M3) | A10 replay of A8 at query time |
| Why | Whole-portfolio net worth = fields already on the snapshot; "introduces no valuation/pricing/reconstruction" (`wealth-time-machine.ts:11-13`) | Per-instrument holdings are **not stored** in snapshots; "historical truth belongs EXCLUSIVELY to A10" (`space-data.ts:22`) |
| Crypto | **excluded** from `totalInvestments`, separate `totalCrypto` bucket | **included inline** (default `excludeDigitalAssetAccounts:false`); no separate bucket |
| Visibility scope | snapshot values **all** accounts | A10 forces **detailEligible** (`:76-81`) |
| Current/historical seam | current = live lens; historical = nearest-≤ snapshot | current = `getCurrentPositions`; historical = A10 as-of; never cross-derived |

**Why Wealth *can* use snapshots:** the expensive reconstruction (A8 valuation, BTC pricing, cash walk-back) was **already performed at snapshot-write time** by M3 and persisted into `SpaceSnapshot.stocks/crypto/cash/...`. Wealth is a pure nearest-≤ read over that earned record. **Why Investments *must* use A10:** snapshots carry no per-instrument holdings, so per-holding history has to be replayed live.

**Actual contradictions found — two, both by-design but one under-surfaced:**

1. **The today/yesterday basis kink (real, intentional, honestly surfaced).** Today's snapshot row (M1) is the **live provider balance** (`isEstimated=false`); yesterday's and earlier rows (M3) are **qty×price×FX reconstructions** (`isEstimated=true`). There is a genuine valuation-basis discontinuity at the today boundary — but it lives in the **snapshot writers**, not in Wealth. Wealth passes it through honestly, labeling estimated rows **"Reconstructed"** vs "Observed" (`wealth-time-machine.ts:286-291`). Not a defect; a disclosed seam.

2. **`detailEligible` (A10) vs `all` (snapshot) scope on shared Spaces (real, intentional, NOT surfaced).** On a shared Space, "what were my investments worth on date D" is answered over **all** accounts by the Wealth/snapshot surface but over **detailEligible-only** accounts by the Investments surface (KD-21a member-facing redaction). The divergence is deliberate (privacy), but the resulting **same-date cross-surface numeric disagreement is not reconciled or disclosed to the user**. This is the one Wealth/A10 divergence that is intentional in mechanism yet accidental in effect.

**Digital-asset handling** differs exactly as §3 describes — the same A8 engine parameterized per consumer; the divergence is precisely what prevents the BTC double-count cliff.

---

## 8. Liquidity history — is the splice a duplicate engine?

**No. It is a legitimate consumer composition.** `historical-splice.ts` "answers ONE composition question and NO valuation question" (`:5-11`); "introduces NO valuation, NO classifier, and NO liquidity math of its own" (`space-data.ts:6-7`).

| Check | Result |
|---|---|
| Replacement semantics | **REPLACE (not add)** — `balance := cov.valuedSum` for accounts A8 valued; else pass through M5 balance (`historical-splice.ts:127-153`) |
| Crypto exactly once | **YES** — each account appears once in the M5 universe and is emitted once; A8 only replaces that one row; no parallel digital-asset total to add (`:22-29`). Uses `scope:'all'` **without** `excludeDigitalAssetAccounts` — correct, since there is no competing bucket here |
| Held-flat fallback | **YES** — unvalued/balance-only/non-investment accounts pass through M5's balance+tier; "NEVER zeroed" (REG-1/REG-2) |
| Trust/completeness | **YES** — spliced tier = `worstTier(cov.tiers)` (incomplete if any instrument unvalued); envelope rebuilt over contributing accounts only, so a withheld account's tier never leaks |

**One documented FX deferral:** foreign-currency **cash** is converted at today−1's rate, not the as-of-date rate (`space-data.ts:126-133`). Single-currency Spaces are exact; this is the only historical leg that is not per-date-correct, and it is explicitly flagged. **Classification: KEEP_DISTINCT** (composition, owns no history engine).

---

## 9. Debt history — coherent contract?

**Yes — coherent, via two deliberately decoupled axes** (`debt-space-data.ts`):

1. **`lens`** — the debt lens computed **at asOf** (M5-based: cards walked back, loans held flat), carries its own completeness; **prose-only in the UI**.
2. **`history`** — the snapshot series **strict-clipped** to `[compareTo,asOf]` (`clipDebtHistory:91-105`): survives only if `compareTo ≤ date ≤ asOf`; no carry-forward, no nearest-≤ pick.

The header explicitly documents that lens and history "can legitimately disagree" (the lens may see `DebtProfile` terms the snapshot array lacks), and resolves it by **sourcing every visible number from the client array and keeping the lens prose-only** (`:26-30,56-61`). FICO passes through. FX is a separate per-date pass `convertDebtHistory` that **drops** any point whose rate walked/missed (matching Wealth's fxMiss-drop for plotted series).

The only cross-mechanism subtlety: Debt history uses **strict window-clip** where Wealth uses **nearest-≤ carry-forward** — both over `Snapshot[]`. This is justified (Debt *plots a trend*; Wealth *resolves a state card*), and each is internally consistent. **Debt history is coherent; it does not mix incompatible semantics into one number.**

---

## 10. Amendment boundary

**`SnapshotAmendment` (M4) is a consent/audit boundary, not a historical engine.** It owns no reconstruction math — every value it writes comes from `regenerateWealthHistory(isAmendment:true)` (M3). Its own responsibilities are pure governance:

- **Consent** — `consentedAt` recorded as an auditable fact.
- **Authorization** — the *only* path allowed to bypass frozen + membership-changed guards and the kill switch, gated by explicit consent instead.
- **Durable audit** — `SnapshotAmendmentDay` stores the before/after breakdown so it "stays true forever even after the account is hard-deleted"; `financialAccountId` is a soft ref with no FK precisely so a cascade can't erase the trail.

**Consolidation must never absorb or bypass it.** A "one windowed regenerator" change (§5) concerns the *compute* engines beneath M4; M4 sits above them as the consent wrapper. **Classification: KEEP_DISTINCT.**

---

## 11. Consolidation candidates

| Pair / target | Verdict | Rationale |
|---|---|---|
| **M2 backfill + M3 regenerate-history** | **SHARE_PRIMITIVE now; INVESTIGATE_FURTHER (full merge)** | Materially overlap (share all walk-backs/floors/FX via backfill-core); M3 is a superset. A unified windowed engine is feasible but must preserve create-only safety + the script/`server-only` boundary + honesty guards as explicit modes. |
| **`isReconstructableCard` predicate** | **SHARE_PRIMITIVE — safe now** | 4 copies, logic-identical; canonical owner `backfill-core.ts` (already imported by all three modules); the `server-only` blocker dissolves there. |
| **Shared `nearest-on-or-before` helper** | **SHARE_PRIMITIVE (small)** | M7 and M10 each hand-roll the same "last row ≤ date" linear pick. A tiny ceiling-parameterized helper could serve both (and M8's price floor as a variant). |
| **Single universal asOf primitive (all mechanisms)** | **KEEP_DISTINCT / NO** | Balance-walk-back (M5) ≠ quantity-nearest (M7/M8) ≠ snapshot-nearest (M10) ≠ strict-clip (M12). Different data types and staleness contracts; one primitive would erase load-bearing distinctions. |
| **M6 event/position reconstruction** | **KEEP_DISTINCT** | Event-sourced quantity truth; nothing else reproduces it. |
| **M8 read-time valuation** | **KEEP_DISTINCT** | The single valuation authority; already the shared engine — consumers differ only by args. |
| **M4 consent amendment** | **KEEP_DISTINCT** | Governance boundary (§10). |
| **M11 liquidity splice / M12 debt / Investments space-data** | **KEEP_DISTINCT** | Consumer compositions over the shared engines; not history engines. |
| **M10 Wealth** | **KEEP_DISTINCT** | Pure read over persisted snapshots. |

---

## 12. Performance profile

| Mechanism | Per-date cost | N×date behavior | Repeated reads |
|---|---|---|---|
| M5 getAccountsAsOf | one delta query, walk once over window | **no** — single call resolves any one date | one FX-free pass |
| M8 getInvestmentValueAsOf | batched (1 position window + 1 price window + 1 FX ctx) | **no N+1 within a call** | none within call |
| M9 A10 | 2× M8 (asOf + compareTo) + 1 flows query | constant (2) | minimal |
| M10 Wealth | pure O(n) over already-fetched snapshots | none | none |
| **M3 regenerate-history** | **calls M8 once per day** in the window loop (`:382`) + BTC read per day (`:400`) | **YES — N×date A8 invocations** | **position + price windows re-read per day** |
| M2 backfill | per-day classify over prefetched deltas | linear, no A8 | one context prefetched |

**Headline finding.** M3 is the only genuine `N×date` hot path: for a `D`-day window it invokes `getInvestmentValueAsOf` `D` times, each re-reading the PositionObservation and PriceObservation windows for overlapping ranges. **Consolidation opportunity:** hoist a single window-wide position+price read and value all days from it in memory (M8 already reads *ranges* internally — exposing a batch "value across `[from,to]`" entry point would collapse `D` queries to O(1) per table). This is the highest-leverage performance win and is **independent** of the correctness consolidations. The FX context is already prefetched once per window (good); the repeated cost is the per-day DB round-trips, not FX math.

---

## 13. Final recommended historical stack

The current architecture already approximates a clean layering; the load-bearing distinctions must be **preserved**, not collapsed:

```
Live truth  (provider/user balances; today's observed row — M1)
        │
Canonical asOf ACCOUNT reconstruction  (balances: cash/card walk-back + held-flat — M5)   ← shared predicate lives here-adjacent (backfill-core)
        │
Event/position reconstruction  (QUANTITIES, backward from anchor — M6 → PositionObservation spine → M7 read)
        │
Historical VALUATION  (qty × price × FX, single authority — M8; parameterized per consumer, not forked)
        │
Snapshot PERSISTENCE  (ONE windowed writer with modes: live-upsert | create-only-backfill | overwrite-regenerate — subsumes M1/M2/M3)
        │
Workspace-specific historical COMPOSITION  (Wealth reads snapshots · Investments=A10 · Liquidity=M5+M8 splice · Debt=lens+clip)

        ⟂  SnapshotAmendment (M4) — orthogonal consent/audit boundary wrapping the persistence layer; never merged in.
```

**What changes vs today:** collapse M1/M2/M3 into one mode-parameterized persistence writer (preserving create-only safety + script boundary + honesty guards); hoist the shared `isReconstructableCard` and a `nearest-≤` helper into pure cores; add a batch "value across window" entry to M8 to kill the M3 N×date cost. **What must NOT change:** the balance/quantity/valuation/composition layer separation, the crypto bucket split, the consent boundary, and the M5-holds-flat / M11-overlays-value seam.

---

## 14. Verdict

**Historical layer coherent?** **PARTIAL.** The layering is sound and the divergences are overwhelmingly load-bearing; the accidental surface is small (duplicated predicate, M3 N×date cost, one under-surfaced shared-Space scope divergence). No incoherence that corrupts a number was found.

**Backfill (M2) and A9 (M3) materially overlap?** **YES** — they share all walk-back/floor/FX primitives and M3 is a strict superset of M2's math. They are **not duplicates**: persistence safety, valuation basis, honesty guards, gate, and window all differ.

**Single asOf primitive justified?** **NO** — not one universal primitive. Balance-walk-back, quantity-nearest-≤, price-nearest-≤-within-ceiling, snapshot-nearest-≤, and strict-window-clip answer different questions over different data with different staleness contracts. (A small shared *nearest-≤ helper* for the two hand-rolled pickers is justified — that is not a single universal primitive.)

**Shared reconstructable-card predicate justified?** **YES** — 4 logic-identical copies; canonical owner `lib/snapshots/backfill-core.ts`, already imported by every copy-holder; zero-risk.

**Wealth/A10 divergence intentional?** **PARTIAL.** The substrate choice (snapshots vs A10 replay) and the crypto-bucket handling are intentional and correct. The today/yesterday basis kink is intentional and honestly surfaced ("Reconstructed"). The `detailEligible`-vs-`all` scope divergence is intentional in mechanism but produces an **unreconciled, undisclosed** same-date disagreement on shared Spaces — intentional in cause, accidental in effect.

**Liquidity splice is duplicate authority?** **NO** — a pure consumer composition (M5 + M8), crypto counted once, held-flat fallback intact, no valuation/classifier/history math of its own.

**Debt history coherent?** **YES** — two deliberately decoupled axes (prose-only as-of lens + strict window-clipped snapshot trend), no incompatible semantics folded into one number.

**Safe to begin historical consolidation?** **YES — for the scoped low-risk set below.** The engine merge is *not* yet safe without a design that preserves create-only safety, the script/`server-only` boundary, and the honesty guards.

**Consolidations safe to start now:**
1. Extract `isReconstructableCard` to `lib/snapshots/backfill-core.ts`; replace all 4 copies with an import (pure move, no behavior change).
2. Extract a shared `nearest-on-or-before` helper for `resolvePositionAsOf` (M7) and Wealth's `resolveState` (M10); optionally parameterize the price-staleness ceiling.
3. Add a batch "value across `[from,to]`" entry point to M8 and have M3 read the position+price windows once, killing its N×date DB cost (behavior-preserving optimization).
4. Surface the shared-Space `detailEligible`-vs-`all` scope divergence to the user (a disclosure fix, not a numeric change).

**Consolidations that require further evidence (do NOT start now):**
1. Merging M2 + M3 into one windowed writer — needs a mode design proving create-only safety, script-runnability, and honesty-guard preservation, plus a byte-parity ratchet against both current writers.
2. Any collapse touching M4 (consent amendment), M6 (event reconstruction), or M8 (valuation authority) — keep distinct absent contradicting evidence.
3. Unifying the today/yesterday snapshot valuation basis — first quantify the real-data discontinuity magnitude before deciding whether it warrants a write-time change.

*No implementation. No commit. No push.*
