# MC1 — Multi-Currency Architecture — Full Implementation Roadmap

**Status:** ✅ **APPROVED 2026-07-05** — this is the governing MC1 phase structure (see §0.1 for the approved structure and decisions of record). Still planning-only: no implementation, schema, code, or migration is made or authorized by this document; per project rule each phase requires its own approved implementation checklist before work begins.
**Date:** 2026-07-05, designed against the working tree at STATUS.md checkpoint `f22de52`.
**Supersedes:** the 8-phase outline in `MC1_MULTI_CURRENCY_ARCHITECTURE_CHARTER.md` §"Approved implementation order" — restructured into 5 phases below (mapping in §2); the charter carries a matching amendment note. The charter's architectural *decisions* stand except where §4.1 records a deliberate revision.
**Companion:** `MC1_PHASE0_CURRENCY_PROVENANCE_PLAN.md` — Phase 0 is implementation-ready and **is not expanded by this document**.
**Model:** FlowType-style phasing — each phase independently shippable, independently revertible, gated on its own checklist, with a deliberately isolated cutover slice.

---

## 0. Executive summary

MC1 grows from Currency Provenance (Phase 0, already planned, intentionally tiny) into a complete multi-currency platform in four further phases: **FX Provider Layer** (rates exist), **Read-Time Conversion** (conversion exists, target still USD — behavior-neutral), **Reporting Currency** (the cutover — Spaces choose their currency), and **User Experience** (the product surfaces it). The load-bearing design move is in Phase 2: **conversion is a pure, deterministic, read-time function over immutable stored facts and an immutable dated rate archive — nothing stored is ever mutated by conversion.** This revises the charter's Option B (write-time-frozen normalized columns) — §4.1 explains why the revision is safe and strictly smaller: an immutable dated-rate archive gives read-time conversion the same historical determinism that frozen columns were buying, and snapshots (the one place freezing is architecturally forced, because they are written once) keep the frozen property automatically.

Five invariants make "world-class later without redesign" true (§9.3): every monetary fact self-describes its currency at row level (Phase 0); stored monetary facts are never mutated by conversion (Phase 2 principle); FX rates are immutable, dated, source-stamped (Phase 1); conversion is one pure function behind one service (Phase 2); every aggregate declares its unit (Phases 0/3). Every long-term capability in §9 — historical FX, realized/unrealized FX P&L, cost-basis currency — is a pure function over those five invariants, addable without touching what came before.

---

## 0.1 Approved structure and decisions of record (2026-07-05)

| Phase | Approved scope |
|---|---|
| **MC1 Phase 0** | **Currency exists** — provenance only: `Transaction.currency`, `Holding.currency`, `SpaceSnapshot.reportingCurrency`, writer stamping, backfill. Exactly as specified in `MC1_PHASE0_CURRENCY_PROVENANCE_PLAN.md` — intentionally small and behavior-neutral. **No FX conversion, no UI selector, no normalized converted values in Phase 0.** ✅ **Delivered 2026-07-05** (`298ef56`→`bf53507`; `MC1_PHASE0_CLOSEOUT_REPORT_2026-07-05.md`). |
| **MC1 Phase 1** | **FX provider/service** — provider abstraction, immutable dated rate archive (`FxRate`), deterministic rate service, failover, caching. No consumers yet. |
| **MC1 Phase 2** | **Read-time conversion** via the shared money service (`lib/money/` — `convertMoney()`), threaded through both aggregation families; target hardwired USD; behavior-neutral. |
| **MC1 Phase 3** | **Space/User reporting currency** — `Space.reportingCurrency` (authoritative) + `User.reportingCurrency` (copy-once default for new Spaces); the conversion-target flip. |
| **MC1 Phase 4** | **Currency selector and UX** — Space/User selectors, ephemeral view override, chart/snapshot display rules, AI presentation contract. |

Decisions explicitly recorded as part of this approval:

1. **Read-time conversion is preferred over write-time normalized columns for now.** Normalized columns remain available later as an additive, recomputable cache if profiling ever demands one — a performance option, never a correctness requirement (§4.1).
2. **Conversion must never mutate stored financial facts.** `Transaction.amount`, `Holding.price`/`value`, and account balances are immutable originals; conversion is a pure read-time function over them and the rate archive.
3. **Snapshots remain frozen computed totals with `reportingCurrency` stamps.** They are written once, never rewritten by conversion or currency changes, and self-describe their unit from Phase 0 onward.
4. **Historical FX and FX P&L (realized/unrealized) are future capabilities, not Phase 0 work.** The historical-FX foundation arrives with the Phase 1 archive; FX P&L is additionally gated on a future cost-basis/lot model and investment-transaction ingestion (§8) — outside MC1 entirely.

---

## 1. Findings that shape this roadmap (delta since the charter)

1. **There are now *two* aggregation families, not one.** The charter (2026-07-03) named `sumBalances()`/`classifyAccounts()` as *the* chokepoint. FlowType P5 (closed 2026-07-05) added a second currency-sensitive family: **transaction-sum rollups** — `lib/debt.ts` (`totalDebtPaid` + per-liability rollup), Banking/Space flow totals, and the AI assembler's monthly/merchant rollups all sum `Transaction.amount` directly, bypassing the classifier. Phase 2's conversion boundary must cover both families; a classifier-only cutover would leave flow surfaces mixing currencies.
2. **Verified callers of `classifyAccounts()`:** `lib/snapshots/regenerate.ts`, `lib/snapshots/backfill.ts`, `lib/perspective-engine/lenses/liquidity.core.ts`, `lib/ai/assemblers/accounts.ts`, plus dashboard components (`DashboardClient`, `KpiRow`). The perspective engine and AI consume classifier *output* — conversion upstream of them fixes them for free.
3. **The scheduler exists but is not wired** (`jobs/scheduler.ts` header: `startScheduler()` has no instrumentation hook; jobs run only when explicitly invoked). Phase 1's daily rate fetch must not silently depend on it — it needs the same explicit-invocation honesty, plus an on-demand fetch path.
4. **Snapshots already are Option B.** `regenerateSpaceSnapshot` computes totals at write time and freezes them; Phase 0 stamps each row's `reportingCurrency`. No new "normalized columns" are needed anywhere for snapshots to have the frozen-conversion property — they were born with it.

---

## 2. Phase map (charter 0–7 → this roadmap 0–4)

| Charter phase | This roadmap | Disposition |
|---|---|---|
| 0 Currency provenance | **Phase 0** | Unchanged — `MC1_PHASE0_CURRENCY_PROVENANCE_PLAN.md`, not expanded |
| 1 FX infrastructure | **Phase 1** | Same scope, fully designed here |
| 2 Currency-aware txns/holdings (write-time normalized values) | **Phase 2** | **Revised** — read-time conversion service; no normalized columns (§4.1) |
| 3 Space reporting currency | **Phase 3** | Same cutover role; adds `User.reportingCurrency` inheritance design |
| 4 Snapshot evolution (breakdown + rate version) | **Optional post-Phase-4 enhancement** (§8.4) | No longer load-bearing; snapshots self-describe from Phase 0 |
| 5 AI context evolution | **Phase 4** (absorbed) | Fix-once at assembler contract |
| 6 UX & reporting | **Phase 4** | Full UX design here |
| 7 Provider expansion | **Out of MC1** | Separate provider-track initiatives that *build on* MC1; MC1 closes at Phase 4 |

---

## 3. Phase 1 — FX Provider Layer

**Objective:** exchange rates exist as immutable, dated, source-stamped facts, fetched through a provider abstraction with failover — and nothing in the product consumes them yet. Rates begin existing, exactly as currency began existing in Phase 0.

### 3.1 Architecture

New module family `lib/fx/` (sibling of `lib/plaid/` — same "provider boundary behind a service" shape the repo already uses for Plaid and for the single LLM provider boundary):

```
lib/fx/
  types.ts        FxProviderAdapter interface + RateQuery/RateResult shapes
  registry.ts     ordered adapter registry (priority = failover order)
  providers/
    frankfurter.ts   (candidate first adapter — ECB daily reference rates, free, keyless)
    <next>.ts        (added later without touching consumers)
  archive.ts      read/write the FxRate table — THE only DB touchpoint
  service.ts      getRateForDate(from, to, date) — deterministic resolution (§3.3)
  fetch.ts        fetch-and-store job body (daily + on-demand backfill)
```

**Provider interface (conceptual):**

```ts
interface FxProviderAdapter {
  readonly source: string;                    // "frankfurter" | "openexchangerates" | ...
  fetchDailyRates(date: ISODate, base: "USD", quotes: string[]): Promise<RateResult[]>;
  readonly historicalDepth: ISODate;          // earliest date this source can serve
}
```

Adapters are dumb fetchers. Failover, storage, selection, and determinism live above them — a new provider is a new file plus a registry entry, satisfying the multiple-provider goal by construction.

### 3.2 Schema impact — one new table, no changes to existing tables

```prisma
// MC1 Phase 1 — immutable dated FX rate archive. Rows for closed dates are
// never updated or deleted (append-only); this immutability is what makes
// read-time conversion (Phase 2) deterministic and history-stable.
model FxRate {
  id        String   @id @default(cuid())
  date      DateTime @db.Date     // valuation date (daily close granularity)
  base      String                // canonical base — always "USD" (§3.3)
  quote     String                // ISO 4217
  rate      Float                 // 1 base = rate quote (f64 ≈ 15 sig. digits — display-grade, §3.5)
  source    String                // adapter that supplied it — provenance
  fetchedAt DateTime @default(now())

  @@unique([date, base, quote])   // ONE canonical rate per (date, pair) — not per source
  @@index([quote, date])
}
```

`@@unique([date, base, quote])` — deliberately **not** including `source` — is the determinism anchor: for any (date, pair) the archive holds exactly one answer, forever. Which provider supplied it is provenance (`source`), not identity.

### 3.3 Deterministic rate selection

- **Canonical base:** all rows are USD-based. Any pair converts as `from → USD → to` (cross-rate via two lookups). Table stays `dates × currencies`, not `dates × currencies²`.
- **Resolution function** (pure, in `service.ts`): exact-date row → else walk back up to `MAX_STALE_DAYS` (weekends/holidays; ECB publishes ~260 days/yr) → else return a `RateMiss` the caller must handle (Phase 2 maps it to an estimation flag; never a throw on a read path).
- **Immutability rule:** the fetch job writes **closed dates only** (yesterday and earlier). Rows are insert-only (`skipDuplicates`); a re-fetch can never change an existing row. Determinism follows: resolution is a pure function of an append-only archive — the same query returns the same rate in 2030 as it does today. This is the property the charter bought with frozen normalized columns, obtained one table earlier.
- **Failover:** `fetch.ts` walks the registry in priority order per (date, batch); first adapter to return a complete batch wins; the whole batch stores under that one `source` (no mixed-source batches within a date). Partial results discarded, next adapter tried, failures recorded as a `SyncIssue`-style log (repo precedent: M1).

### 3.4 Caching strategy

Three layers, no new infrastructure: **the `FxRate` table is the cache** (a permanent one — the archive and the cache are the same thing, which is what immutability buys); a **request-scoped in-memory memo** inside `service.ts` (a `Map` keyed `date|from|to` — rate reads within one aggregation pass hit the DB once per distinct key); and **no external cache tier** (Redis etc.) — rejected as premature, the table is small (30 currencies × 30 years ≈ 330k rows, index-covered point reads).

Fetch cadence: daily job (registered alongside `sync-banks` in `jobs/scheduler.ts` — honestly documented as subject to the same "scheduler not wired" gap, finding §1.3) plus an idempotent on-demand backfill script (`scripts/backfill-fx-rates.ts`, dry-run/`--apply`, house pattern) to load historical depth and to self-heal gaps on demand.

### 3.5 Decisions recorded

- **`Float`, not `Decimal`, for `rate`** — f64 carries ~15 significant digits; FX reference rates publish 5–6. Fourth Meridian is a reporting product, not a ledger of record; every monetary value in the schema is already `Float`, and introducing Prisma `Decimal` objects into one table creates mixed-arithmetic friction everywhere the rate touches a balance. Revisit only if the product ever becomes accounting-grade.
- **Daily close granularity** — intraday rejected (charter open decision #1 resolved): no consumer surface needs it, and it would break the one-row-per-date determinism anchor.
- **First provider candidate:** Frankfurter (ECB reference rates — keyless, free, history to 1999). Final choice is an implementation-checklist decision; the architecture is indifferent by design.

### 3.6 Phase card

| | |
|---|---|
| **Objectives** | Immutable dated rate archive; provider abstraction + failover; deterministic resolution; daily fetch + historical backfill. Nothing consumes rates yet. |
| **Schema impact** | Additive: new `FxRate` table. Zero changes to existing tables. |
| **Implementation scope** | `lib/fx/*` (new, self-contained); one scheduler registration; `scripts/backfill-fx-rates.ts`; unit tests for resolution (exact date, walk-back, miss, cross-rate) and failover (adapter order, batch atomicity). |
| **Validation** | `tsc`/lint/`npm test`; archive spot-checks against the provider's published rates; determinism test (two resolutions of the same query, second from memo, byte-equal); gap report from the backfill script. |
| **Rollback** | Trivial — drop the table, delete `lib/fx/`. Zero consumers exist by definition of the phase. |
| **Dependencies** | None on Phase 0 (parallelizable in principle; sequenced after it to keep migrations serialized). Phases 2–4 depend on it. |

---

## 4. Phase 2 — Read-Time Conversion

**Objective:** a single, shared, deterministic conversion capability exists and is threaded through both aggregation families — **with the target currency still hardwired to USD**, so behavior is provably unchanged. Phase 2 builds the machine; Phase 3 turns the dial.

### 4.1 The architectural revision — read-time over write-time, recorded honestly

The charter approved Option B: store originals *plus* normalized values frozen at write time. This roadmap revises that to **originals only + deterministic read-time conversion**, because the two reasons Option B existed are both satisfied without normalized columns:

1. **History stability.** Option B froze values so history couldn't rewrite itself when rates moved. But the Phase 1 archive is *immutable and dated* — converting a January amount at the January rate returns the same answer forever. Freezing the *rate archive* subsumes freezing the *converted values*. (The charter's real enemy — "convert history at today's rate" — remains rejected; see §4.4.)
2. **Snapshot correctness.** Snapshots are read results frozen at write time — `regenerateSpaceSnapshot` already stores computed totals once. When Phase 3 makes that computation currency-aware, snapshots freeze *converted* totals automatically, stamped by Phase 0's `reportingCurrency`. The one place write-time freezing is architecturally necessary already does it structurally.

What the revision buys: **no normalized columns on `Transaction`/`Holding` (the widest tables), no write-time FX dependency in the Plaid sync path** (a sync must never fail or stall because a rate fetch is down — with read-time conversion the sync never touches FX at all), **no backfill of normalized values, no estimated-backfill policy** (charter open decision #2 dissolves rather than resolves), and **`convertMoney()` as the single seam** instead of conversion logic split between write path and read path. Cost: rate lookups on the read path — bounded by the request-scope memo (§3.4) and the small distinct-key space of any one request (per-currency subtotals × a handful of dates for balances; transaction rollups add one key per distinct transaction date, still memo-friendly). If profiling ever disproves this, materialized normalized columns can be *added* later as a cache — they are additive and recomputable, exactly the kind of decision that is safe to defer. Deferring the other direction (adding columns now, removing later) is not symmetric.

### 4.2 Where conversion lives — the placement decision

| Candidate home | Verdict | Why |
|---|---|---|
| Perspective engine | ✗ | Consumes classifier output; conversion there would fix lenses but leave hero, snapshots, AI, and flow totals mixed. Wrong side of the boundary. |
| Account classifier | ✗ as *home* (✓ as call site) | Covers the balance family only — finding §1.1: flow rollups bypass it entirely. "The classifier is the chokepoint" stopped being fully true when FlowType P5 shipped. |
| AI assemblers | ✗ | Per-assembler conversion scatters policy N ways and leaves the UI unconverted. The AI must *inherit* converted totals, not manufacture them. |
| Reporting layer | ✗ | Too late in the pipe — misses AI and snapshot writes; converts presentation while leaving stored-adjacent aggregates mixed. |
| **Shared monetary service** | **✓ Recommended** | One pure mechanism, consumed at the two aggregation entry points. Mirrors FlowType's proven shape: `classifyFlow` is one function, every writer calls it. |

**Recommended architecture — mechanism vs. policy:**

- **Mechanism** — new `lib/money/` service:
  ```ts
  type Money = { amount: number; currency: string };
  // Pure. Same archive + same asOf date ⇒ same output, forever.
  convertMoney(m: Money, to: string, asOf: ISODate, rates: RateResolver): Converted
  // Converted = { amount, currency, estimated: boolean }   // estimated ⇐ RateMiss/walk-back
  convertAndSum(items: Money[], to, asOfPerItem): ConvertedTotal   // convert-then-sum, never sum-then-convert
  ```
  Identity fast path: `from === to` returns unchanged with `estimated: false` — the USD-only era costs zero lookups.
- **Policy (call sites)** — exactly the two aggregation families:
  1. **Balance family:** `sumBalances()`/`classifyAccounts()` gains an optional conversion context `{ target, resolver }`; absent context = today's raw-float behavior, byte-identical. Every classifier consumer (hero, lenses, dashboard, snapshot writers, AI accounts assembler) inherits.
  2. **Transaction family:** the flow rollup entry points — `lib/debt.ts` rollups, Banking/Space flow totals, AI assembler monthly/merchant rollups — gain the same optional context, converting each row at its own transaction-date rate.

Per-row inputs come from Phase 0 stamps (`Transaction.currency`, `Holding.currency`, account `currency`), with `null` (pre-backfill residue) treated as account-currency fallback + `estimated: true` — provenance honesty propagating into arithmetic.

### 4.3 Conversion boundaries and the zero-mutation guarantee

- **Read-path only.** No writer calls `convertMoney()` in Phase 2. `Transaction.amount`, `Holding.value`, `FinancialAccount.balance` are never rewritten — they are the immutable originals the charter's "never discard originals" rule protects. The only converted values ever *stored* are snapshot totals, which were always stored computed values (and Phase 0 stamps their unit).
- **Aggregation strategy:** convert-then-sum. Group by row currency, convert each group (or row, for date-varying transaction sets) into the target, then sum; any `estimated` member marks the aggregate `estimated`. Single-currency sets short-circuit through the identity path.
- **In Phase 2 the target is always `"USD"`** — behavior-neutral by the identity fast path (all current data is USD-stamped). The phase's cutover risk is therefore ~zero; the risky flip is deliberately deferred to Phase 3 where it is one setting away from revert.

### 4.4 Historical vs. current valuation boundary

| Aggregate | Valuation rule |
|---|---|
| Live balances (net worth now, hero, lenses) | Latest closed rate (yesterday's close) — "current valuation" |
| Historical series (charts) | **Stored snapshot totals as-is** — they are frozen read results in their stamped currency; never re-derived on the hot path |
| Transaction rollups (spend, debt paid, monthly) | Each row at **its own date's** rate — historical FX per row, deterministic via the archive |
| Snapshot writes (from Phase 3) | Converted at write date's rate, frozen, stamped — Option B semantics surviving exactly where they belong |

"Convert history at today's rate" remains architecturally forbidden (charter decision #5): nothing in the design ever resolves a past-dated amount against a current rate.

### 4.5 Phase card

| | |
|---|---|
| **Objectives** | `lib/money/` conversion service (pure, deterministic, estimation-aware); optional conversion context threaded through the balance family and the transaction family; target hardwired USD; zero behavior change; zero mutation of stored facts. |
| **Schema impact** | **None.** |
| **Implementation scope** | `lib/money/*` (new); signature-additive changes to `lib/account-classifier.ts`, `lib/debt.ts`, Banking/Space flow total call sites, AI assembler rollup entry; unit tests: identity path, mixed-set convert-then-sum, estimation propagation, null-stamp fallback, determinism. |
| **Validation** | `tsc`/lint/`npm test` incl. flow + classifier suites green; golden-output test: full dashboard/AI context assembled with and without conversion context is byte-identical in USD-only data (the neutrality proof); perf spot-check on rollup-heavy AI requests (memo hit rate). |
| **Rollback** | Trivial — remove the optional context (defaults reproduce current behavior); delete `lib/money/`. No schema, no stored-data implications. |
| **Dependencies** | Phase 0 (row stamps are the conversion input), Phase 1 (rates). Blocks Phase 3. |

---

## 5. Phase 3 — Reporting Currency

**Objective:** the dial. Users get per-Space reporting currencies; the Phase 2 machine converts into them; snapshots freeze converted totals with correct stamps. This is MC1's equivalent of FlowType's P5 read cutover — deliberately isolated because it is small in code and large in consequence.

### 5.1 Schema

```prisma
// Space — MC1 Phase 3. Authoritative reporting currency for every aggregate,
// snapshot, chart, and AI total computed within this Space.
reportingCurrency String @default("USD")

// User — MC1 Phase 3. Default only: seeds reportingCurrency for Spaces this
// user creates, and denominates any future cross-Space personal surface.
// NEVER consulted for an existing Space's totals — the Space is authoritative.
reportingCurrency String @default("USD")
```

### 5.2 Inheritance and override rules

```
resolution for a Space-scoped total:
  Space.reportingCurrency                    ← authoritative, always present (defaulted)
resolution at Space creation:
  creator's User.reportingCurrency → copied once into the new Space
resolution for cross-Space / pre-auth surfaces:
  User.reportingCurrency → else "USD"
ephemeral view override (Phase 4):
  display-only, never persisted, never consulted by writers
```

- **Copy-once, not live inheritance.** A Space's currency is set from the creator's default at creation and thereafter owned by the Space. Changing `User.reportingCurrency` later never retroactively re-denominates existing Spaces — a user with `USD` default and a `EUR` business Space must not have the business books flip because they edited a personal preference. (Chris's example set — personal USD, business EUR, family SAR, investment AED — is four Spaces with four explicit values; the User default only decided what each was *born* as.)
- **Snapshots stamp the Space's currency at write time** (`regenerateSpaceSnapshot` and `lib/snapshots/backfill.ts` switch their Phase 0 constant `DEFAULT_DISPLAY_CURRENCY` stamp to `space.reportingCurrency`). History accumulates correctly denominated rows from the flip onward.
- **Currency change is forward-only.** Changing a Space's reporting currency re-denominates *live* aggregates immediately (read-time conversion — no data migration at all) and affects snapshots *from the next write*. Existing snapshot rows keep their stamps — history is never rewritten. Mixed-stamp chart rendering is a Phase 4 display concern (§6.4); the data model is already unambiguous because every row declares its unit.

### 5.3 The cutover

One slice, FlowType-P5-style: pass `{ target: space.reportingCurrency, resolver }` as the conversion context at the two family entry points (balance + transaction), and switch the snapshot writers' stamp. For every existing user this is a no-op (`USD` → identity path) — the flip is validated in production by *nothing changing*, then exercised by test Spaces with non-USD currencies. Behavior-affecting surface: everything downstream of the two families — which is exactly why Phases 0–2 exist so that this diff stays small enough to review line-by-line.

### 5.4 Phase card

| | |
|---|---|
| **Objectives** | `Space.reportingCurrency` + `User.reportingCurrency` (copy-once inheritance); conversion context flipped from hardwired USD to the Space's currency; snapshot stamps switch to the Space's currency; forward-only currency-change semantics. |
| **Schema impact** | Additive: two defaulted `String` columns (`Space`, `User`). No backfill (default `USD` is true for all existing rows). No index (point-read via already-loaded rows). |
| **Implementation scope** | Migration; Space-creation path (copy-once); the two conversion-context call sites; `lib/snapshots/regenerate.ts` + `backfill.ts` stamp source; a Space settings **API** field (PATCH validation: ISO 4217 allowlist) — UI itself is Phase 4. |
| **Validation** | Full suite; golden-output neutrality check on USD Spaces (must be byte-identical pre/post); non-USD test Space: totals, lenses, snapshot stamp, AI context all coherent in the Space currency; currency-change test: live totals flip, old snapshots retain stamps. |
| **Rollback** | Set all `reportingCurrency` back to `USD` (data-level revert restores identity-path behavior instantly, even before code revert); columns are additive and can stay. Snapshot rows written under a non-USD stamp remain valid — they self-describe. |
| **Dependencies** | Phases 0, 1, 2. Blocks Phase 4. |

---

## 6. Phase 4 — User Experience

**Objective:** surface what Phases 0–3 built. Rule inherited from the original investigation and kept: **itemized views show native currency; aggregated views show the reporting currency, labeled.** Never silently convert a single itemized value; never mix currencies inside one aggregate.

### 6.1 Currency selector

- **Authoritative selector:** Space settings — sets `Space.reportingCurrency` (persisted; the Phase 3 API). Placement beside existing Space configuration. Changing it shows a forward-only explainer ("history keeps the currency it was recorded in").
- **User default selector:** profile settings — sets `User.reportingCurrency` (persisted; affects new Spaces + cross-Space surfaces only, and says so).
- **Ephemeral view override:** the `USD ▼ / EUR / SAR / AED / GBP` dropdown on aggregate surfaces (dashboard header, charts) — re-renders the *view* through `convertMoney()` without writing anything. Session-lifetime, per-Space scope, resets on reload. Never persisted — the charter's "ephemeral display override only" rule, now with a concrete home.

### 6.2 When does conversion happen?

| Option | Verdict |
|---|---|
| Immediately (live, per render) | **✓** — conversion is a pure read-time function; "switching" currency is just re-rendering with a different target. Nothing to apply, nothing to migrate, nothing to wait for. |
| Per session | Only as the *lifetime of the ephemeral override* — not as a conversion event. |
| Per Space | **✓ as the persistent authority** (Phase 3) — the Space's currency *is* where meaning lives. |
| Per dashboard | ✗ — a dashboard is a view of a Space; giving it its own persisted currency would fragment snapshot semantics (original investigation's "Dashboard: too transient" verdict stands). |

There is deliberately **no** "convert my data" moment anywhere in the product — that is the payoff of the zero-mutation architecture.

### 6.3 Surface rules

| Surface | Behavior |
|---|---|
| Account list | Native per account (`€1.240,50`, `SAR 12,000`) via `lib/format.ts` (already accepts a currency override); optional muted converted subvalue |
| Transactions | **Always native** — a €12 coffee is €12. No conversion, ever, on itemized rows |
| Holdings | Native per position (IBKR-style honesty); portfolio total in reporting currency, labeled |
| Net worth / hero / lenses | Reporting currency, single unit, explicit label |
| Daily Brief / AI | Reporting currency totals + label; material native holdings may be *mentioned* (§6.5) |

### 6.4 Charts and snapshots

- Snapshots are **never rewritten** — charts read stored totals with their stamps.
- **Homogeneous history** (all stamps = display currency): render as-is. The normal case.
- **Mixed-stamp history** (Space changed currency mid-history, or ephemeral override active): convert each snapshot's stored total from its stamped currency into the display currency **at the snapshot's own date rate**, and mark those points `estimated` (visually: dashed segment or footnote). Recorded honestly: converting a *summed* total is an approximation — the per-currency composition inside old snapshots wasn't stored. If real users hit this enough to care, the remedy is the optional snapshot-breakdown enhancement (§8.4), not a redesign.
- Axis carries the currency label; a one-line note ("includes exchange-rate effects") appears whenever any non-native accounts are in scope — FX exposure being visible in a net-worth line is truth, not noise.

### 6.5 AI presentation

Fix-once at the assembler contract (charter Phase 5, absorbed here): assemblers emit totals in the Space reporting currency + the currency label + estimation flags; per-account/per-transaction rows keep native currency (already partly true — per-account `currency` flows today). Prompt contract: reason and compute in reporting currency; cite native values when material ("incl. €40k in EUR savings"); never state an estimated conversion as exact. Retire the `lib/ai/types.ts:243–245, 696–697` "summed without conversion" limitation comments — they finally stop being true. Every AI surface (Brief, Story, Analyst, future agents) inherits from the one contract, matching how KD-18/P5 fixes propagated.

### 6.6 Phase card

| | |
|---|---|
| **Objectives** | Space + User currency selectors; ephemeral view override; itemized-native/aggregate-reporting rules across UI; mixed-stamp chart handling; AI contract evolution + limitation-comment retirement. |
| **Schema impact** | **None.** |
| **Implementation scope** | Space settings UI + profile settings UI; header/chart override component; account list/holdings/hero label passes; chart axis labels + estimated-segment rendering; `lib/ai/assemblers/*` contract fields + prompt serializer additions; `lib/format.ts` locale hardening (currency-appropriate symbol/decimal rendering). |
| **Validation** | Full suite; visual QA across a USD-only Space (must look unchanged), a non-USD Space, and a mixed-currency Space; AI membership-validator + attribution suites green with the new contract; copy review of estimation disclosures. |
| **Rollback** | UI-only revert per surface; the AI contract change reverts independently of UI. No schema, no data implications. |
| **Dependencies** | Phases 0–3 all complete. |

---

## 7. Roadmap at a glance

| Phase | Name | Schema | Behavior change | Cutover risk | Rollback |
|---|---|---|---|---|---|
| **0** | Currency Provenance | 3 columns | None | ~0 | Drop columns |
| **1** | FX Provider Layer | 1 new table | None | ~0 | Drop table |
| **2** | Read-Time Conversion | **None** | None (USD identity) | ~0 | Remove optional context |
| **3** | Reporting Currency | 2 defaulted columns | **The flip** (no-op for USD users) | Contained (one context + stamps) | Data-level: reset to USD |
| **4** | User Experience | **None** | UI + AI presentation | Per-surface | Per-surface revert |

Sequencing rule carried from FlowType: schema before writers, writers before readers, readers before the flip, the flip before the UI — and at every boundary the repo is healthy and shippable.

---

## 8. Long-term capability analysis

### 8.1 Capability × architecture matrix

| Capability | Needs | Provided by | Gap |
|---|---|---|---|
| **Historical FX** | Immutable dated rates + dated facts | Phase 1 archive + Phase 0 stamps + dated rows | None |
| **Reporting currency** | Per-boundary declared unit | Phase 3 | None |
| **Native currency** | Row-level provenance | Phase 0 | None |
| **Valuation currency** | Holding price/value unit distinct from asset | Phase 0 (`Holding.currency` = valuation unit; asset lives in `symbol`/`quantity`) | None |
| **Unrealized FX** (open positions: value change attributable to FX vs. price) | Native value + acquisition-date rate + current rate | Phases 0+1 give both rates and the native value | **Cost basis + acquisition date do not exist on `Holding` at all** — a lot/cost-basis feature, not a currency feature |
| **Realized FX** (closed positions/settled flows) | Disposal events with native amounts + rates at open/close | Same as above + sell-transaction ingestion (investment transactions are not currently ingested) | Lot model + investment-transaction ingestion |
| **Cost basis currency** | Currency stamp on the (future) lot record | Pattern established by Phase 0 — one `currency String?` on the future `HoldingLot` | The lot table itself |

### 8.2 Verdict on realized/unrealized FX

**Support later, build nothing now.** The blocker is not currency architecture — it is that Fourth Meridian has no cost-basis/lot model and no investment-transaction ingestion (both product features with their own initiatives-worth of scope). The currency layer's only job is to not foreclose them, and after Phases 0–1 it cannot: FX P&L decomposes as `(qty × price_now × rate_now) − (qty × price_then × rate_then)` split into price effect (at constant rate) and FX effect (at constant price) — every term is a pure function of native values (Phase 0), dated immutable rates (Phase 1), and future lot data. When a `HoldingLot` model arrives it carries `currency` + `acquiredAt` per the Phase 0 pattern, and FX attribution is arithmetic, not architecture.

### 8.3 The five invariants (the "no redesign" guarantee)

1. **Row-level self-description** — every monetary fact carries its currency (Phase 0; extended by pattern to any future monetary table).
2. **Immutable originals** — conversion never mutates stored facts (Phase 2 principle; the only stored converted values are snapshots, which are frozen-by-construction and stamped).
3. **Immutable dated rates** — append-only, source-stamped, one canonical rate per (date, pair) (Phase 1).
4. **One pure conversion seam** — `convertMoney()` behind one service; deterministic; estimation-honest (Phase 2).
5. **Declared aggregate units** — every boundary that sums money declares its target currency (Phases 0/3).

Any capability in §8.1 is a pure function over (1)–(5). That is the precise sense in which Phase 0 "naturally grows into" the full platform: each phase only ever adds — a table, a service, two columns, a UI — and never revisits a prior phase's decisions.

### 8.4 Optional enhancement (explicitly not scheduled)

**Snapshot per-currency breakdown** (the old charter Phase 4): store an original-breakdown alongside snapshot totals so mixed-stamp history re-reports losslessly instead of §6.4's flagged approximation. Additive whenever wanted; justified only by observed user demand for lossless historical re-reporting after currency changes. Parked, not killed.

---

## 9. Risks

- **R1 — Rate archive gaps** (provider outage, thin history for exotic pairs): mitigated by failover chain, walk-back resolution, `estimated` propagation, and the self-healing backfill script. A gap degrades honesty flags, never correctness of stored facts.
- **R2 — Read-path cost of conversion:** bounded by identity fast path (the entire USD-only era), request-scope memo, and small distinct-key spaces. Escape hatch: additive materialized normalized columns later (§4.1) — a cache, not a redesign.
- **R3 — Phase 3 flip blast radius:** the same risk FlowType P5 carried, managed the same way — everything upstream landed first, the flip is one reviewable diff, USD users are provably no-op, revert is data-level (`reset to USD`) before it is code-level.
- **R4 — Mixed-stamp chart confusion:** §6.4's estimated-segment rendering + forward-only explainer copy; worst case triggers §8.4, not rework.
- **R5 — `Float` precision skepticism:** recorded decision §3.5 — display-grade product, f64 headroom, revisit trigger defined (accounting-grade ambitions).
- **R6 — Scheduler not wired** (pre-existing gap): Phase 1's fetch job inherits it; the on-demand script keeps the archive operable regardless; wiring instrumentation is an independent ops item, not an MC1 dependency.

## 10. Open decisions (each resolved at its phase's checklist, not now)

1. Final FX provider choice + failover order + supported currency set — Phase 1 checklist.
2. `MAX_STALE_DAYS` walk-back bound and the estimation threshold — Phase 1.
3. Exact conversion-context signature (param vs. context object) through the two families — Phase 2 checklist.
4. ISO 4217 allowlist scope for the selector (all ~180 vs. curated list) — Phase 3/4.
5. Estimated-point visual treatment in charts — Phase 4 design pass.

---

*End of roadmap. Approved 2026-07-05 as the governing MC1 phase structure (§0.1); the charter's phase table carries the matching amendment. No implementation, schema, code, or migration change is made or authorized by this document. Phase 0 remains exactly as specified in `MC1_PHASE0_CURRENCY_PROVENANCE_PLAN.md`. Per project rule, each phase requires its own approved implementation checklist before any work begins — Phase 0 Slice 1 is the next such step.*
