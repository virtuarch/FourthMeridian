# MC1 Phase 1 — FX Provider Layer — Implementation-Ready Plan

**Status:** ✅ **IMPLEMENTED & CLOSED 2026-07-05** — delivered as approved: Slice 1 `8689e2d`, Slice 2 `fa7f196`, Slices 3–4 in the closing commits. Live-validated against Open Exchange Rates (4-day backfill, 96 rows, `--verify` 0 mismatches). Exit evidence and residual debt: `MC1_PHASE1_CLOSEOUT_REPORT_2026-07-05.md`. Retained as the implementation record; the sections below are point-in-time design.
**Date:** 2026-07-05, verified against the working tree (Phase 0 complete: `298ef56`→`bf53507` + closeout).
**Governing doc:** `MC1_MULTI_CURRENCY_ROADMAP.md` §3 (approved). This plan turns §3 into slices and resolves its two open decisions (provider choice, `MAX_STALE_DAYS`) plus two findings that revise §3 details (§1 below).
**Phase 1 goal (restated):** exchange rates exist as immutable, dated, source-stamped facts, fetched through a provider abstraction with failover. **Nothing consumes rates.** No conversion, no UI, no reporting currency, no AI change, no behavior change.

---

## 0. Executive summary

Phase 1 is one new table, one new self-contained module family (`lib/fx/`), two provider adapters behind a priority registry, one backfill script, and one Vercel Cron route. Zero consumers — the phase is validated entirely by its own unit tests, archive spot-checks, and determinism proofs, and is disabled by removing a cron entry. Two investigation findings adjust the roadmap's sketch: **(1)** the daily fetch is a **Vercel Cron route** (`app/api/jobs/fetch-fx-rates`), matching the shipped `sync-banks` pattern — not a `jobs/scheduler.ts` registration (that scheduler remains unwired); **(2)** the first-adapter candidate (Frankfurter/ECB) **cannot serve SAR or AED** — the roadmap's own motivating Space examples — so the primary adapter is **Open Exchange Rates** (USD-base native, ~170 currencies, keyed) with Frankfurter as the keyless failover for its ECB subset.

## 1. Investigation findings (delta vs. roadmap §3)

1. **Job execution reality.** Production cadence = Vercel Cron → `app/api/jobs/<name>/route.ts` guarded by `Authorization: Bearer ${CRON_SECRET}`, schedule in `vercel.json` (`sync-banks` daily at 06:00 UTC is the live precedent; `maxDuration = 60`). `jobs/scheduler.ts` is registered-but-never-started (its own header says so). The FX fetch follows the cron-route pattern. **Caveat:** Vercel Hobby allows max 2 cron jobs and once-per-day schedules — adding `fetch-fx-rates` uses the second slot.
2. **Currency coverage forces the provider order.** ECB reference rates (Frankfurter) cover ~31 currencies — no SAR, no AED, both named in the approved roadmap's Space examples (§5.2). Open Exchange Rates (openexchangerates.org): USD base native (= our canonical base), ~170 currencies, historical endpoint on the free plan, 1,000 req/mo free (daily fetch ≈ 31 req/mo). Requires `OXR_APP_ID` (new env, `.env.example` entry — house has 20+ such keys).
3. **Error recording.** `SyncIssue` is provider-generalized (`provider String @default("PLAID")`) but `SyncIssueKind` is Plaid-shaped. Extending the enum is a schema change beyond `FxRate` — **rejected for Phase 1** (smallest additive). Fetch failures log to console (observability counters are already named v2.4.5 debt); an `FX_FETCH_FAILED` kind is noted as a future option.
4. **Test discovery is automatic.** `scripts/run-tests.ts` discovers any `*.test.ts` under `lib/` — `lib/fx/*.test.ts` self-registers into `npm test` and CI.
5. **No fetch conventions to inherit.** No raw `fetch()` in `lib/`/`jobs/` today (providers use SDKs). Adapters use global `fetch` (Node 18+/Next), 15s timeout via `AbortSignal.timeout`, no retry wrapper in Phase 1 (one attempt per adapter; failover *is* the retry).

## 2. Decisions of record

| # | Decision | Resolution |
|---|---|---|
| D1 | First adapter | **Open Exchange Rates** (`OXR_APP_ID`), USD base native, covers SAR/AED. Frankfurter (keyless, ECB) ships in the same slice as failover #2 — a real second adapter proves the registry with zero extra vendor risk. |
| D2 | Failover semantics | Registry priority `[openexchangerates, frankfurter]`. A fetch batch = one adapter's **complete** answer for the quotes it serves on that date; partial results are discarded and the next adapter is tried; the stored batch stamps its true `source`. Failover to Frankfurter narrows coverage to the ECB subset for that day — missing quotes are simply absent rows, handled by walk-back/`RateMiss`, never fabricated. |
| D3 | `Float` for `rate` | **Confirmed** (roadmap §3.5 rationale unchanged: display-grade product, f64 ≈ 15 sig digits vs 5–6 published, no Prisma `Decimal` mixed-arithmetic friction). |
| D4 | Granularity | Daily close only; the fetch job requests **yesterday (UTC)** — closed dates only, which is what makes insert-only immutability sufficient for determinism. |
| D5 | `MAX_STALE_DAYS` | **7** — covers the longest routine market-closure runs (ECB Easter ≈ 4 days) with margin; beyond 7 the resolver returns `RateMiss` (typed result, never a throw). |
| D6 | Supported quotes | Curated `SUPPORTED_QUOTES` constant (~24: EUR GBP JPY CHF CAD AUD NZD CNY HKD SGD INR SAR AED SEK NOK DKK PLN CZK TRY ZAR MXN BRL KRW ILS), config in `lib/fx/config.ts`. USD is the base, never a quote. Expanding later is additive (append-only archive). |
| D7 | Backfill depth | Default `--from = MIN(Transaction.date) − 30d`, capped at **365 days** initially (OXR free-tier quota math: 365 backfill + 31/mo daily ≈ fits month one; the archive is append-only, so deepening later is trivial and needs no redesign). Overridable `--from/--to`. |
| D8 | Immutability enforcement | Application-level: fetch/backfill write via `createMany({ skipDuplicates: true })` (insert-only; `@@unique` makes re-fetch a no-op) and only for dates ≤ yesterday UTC. No DB trigger (out of house style). Nothing in the codebase updates or deletes `FxRate` rows. |

## 3. Architecture (implementation blueprint)

### 3.1 `lib/fx/` layout

```
lib/fx/
  types.ts        FxProviderAdapter, RateResult, RateQuery, RateMiss, ResolvedRate
  config.ts       SUPPORTED_QUOTES, MAX_STALE_DAYS = 7, FX_BASE = "USD"
  registry.ts     ordered adapter list; priority = failover order; test seam (inject fakes)
  providers/
    openexchangerates.ts   GET /api/historical/{date}.json?app_id&base=USD&symbols=…
    frankfurter.ts         GET /v1/{date}?base=USD&symbols=…  (ECB subset)
  archive.ts      writeBatch(insert-only), readRate(date,base,quote), readLatestOnOrBefore(...)
  service.ts      getRateForDate(from,to,date) → ResolvedRate | RateMiss; request-scope memo
  fetch.ts        fetchAndStoreDay(date) — registry walk, batch atomicity, source stamping
```

**Adapter interface (from roadmap §3.1, final):**

```ts
interface FxProviderAdapter {
  readonly source: string;             // "openexchangerates" | "frankfurter"
  readonly historicalDepth: string;    // earliest ISO date servable
  readonly supportedQuotes: (quotes: string[]) => string[]; // subset it can serve
  fetchDailyRates(dateISO: string, quotes: string[]): Promise<RateResult[]>; // base USD implied
}
```

Adapters are dumb fetchers: no storage, no failover, no selection logic. `fetch.ts` owns the registry walk; `archive.ts` owns the one DB touchpoint.

### 3.2 `FxRate` schema (Slice 1 migration — the only schema change in Phase 1)

```prisma
// MC1 Phase 1 — immutable dated FX rate archive. Rows for closed dates are
// never updated or deleted (append-only, enforced at the application layer:
// insert-only writes for dates ≤ yesterday UTC). This immutability is what
// makes read-time conversion (MC1 Phase 2) deterministic and history-stable.
model FxRate {
  id        String   @id @default(cuid())
  date      DateTime @db.Date // valuation date, daily close granularity (D4)
  base      String            // canonical base — always "USD" (lib/fx/config.ts)
  quote     String            // ISO 4217
  rate      Float             // 1 base = rate quote (Float confirmed — D3)
  source    String            // adapter that supplied the batch — provenance
  fetchedAt DateTime @default(now())

  @@unique([date, base, quote]) // determinism anchor: ONE canonical rate per (date, pair)
  @@index([quote, date])        // walk-back scans (base is constant USD)
}
```

Migration: single `CREATE TABLE` + the two constraints. Name: `mc1_phase1_fxrate_archive`.

### 3.3 Rate resolution (`service.ts` — pure over the archive)

1. `from === to` → rate 1, `exact`, no lookup (identity fast path).
2. Cross-rate via USD: `rate(from→to) = usdRate(to) / usdRate(from)`; `usdRate(USD) = 1` by definition (no self-row stored).
3. Per leg: exact-date row → else latest row with `date' < date` within `MAX_STALE_DAYS` (walk-back, one indexed query: `WHERE base='USD' AND quote=? AND date <= ? ORDER BY date DESC LIMIT 1`) → else `RateMiss { quote, requestedDate }`.
4. Result carries `{ rate, date, effectiveDates: {from, to}, staleness: "exact" | "walked-back" }` — Phase 2 maps walked-back/miss onto its `estimated` flag; Phase 1 just reports.
5. Request-scope memo (`Map` keyed `date|from|to`) — the archive is immutable, so memoization can never serve a stale answer.
6. **Never throws on resolution.** `RateMiss` is a value; throwing is reserved for programmer errors (unsupported quote not in `SUPPORTED_QUOTES`).

### 3.4 Fetch, cron, and backfill

- **`fetch.ts` — `fetchAndStoreDay(dateISO)`:** skip if all quotes already stored (idempotent re-run); walk registry; store one complete batch under one source; log failures per adapter; return `{date, source, stored, skippedExisting}`.
- **Cron route `app/api/jobs/fetch-fx-rates/route.ts`:** exact `sync-banks` shape — `withApiHandler`, `CRON_SECRET` bearer guard, `maxDuration = 60`; body = `fetchAndStoreDay(yesterdayUTC())`. `vercel.json`: `{ "path": "/api/jobs/fetch-fx-rates", "schedule": "30 6 * * *" }` (after the 06:00 sync-banks; OXR EOD data for yesterday is final by then). Job body also exported from `jobs/fetch-fx-rates.ts` for symmetry with the house layout and manual invocation.
- **Backfill script `scripts/backfill-fx-rates.ts`:** house pattern (dry-run default, `--apply`, `--from=`, `--to=`, `--throttle-ms=`); walks dates oldest→newest calling `fetchAndStoreDay`; dry-run reports the date range, per-date presence, and request count *without* network writes; re-runnable (skip-if-present). Default range per D7. Also `--verify`: sample N stored rows, re-fetch those dates, assert byte-equal rates (archive spot-check; read-only).

## 4. Validation plan

- **Unit tests (auto-discovered, no network):** `lib/fx/service.test.ts` — identity, cross-rate arithmetic, exact date, walk-back ≤7, miss >7, unsupported-quote throw, memo behavior; `lib/fx/fetch.test.ts` — registry order, partial-batch discard + failover, batch source atomicity, insert-only idempotence (fake adapters + in-memory archive seam); `lib/fx/providers/*.test.ts` — response parsing fixtures (recorded JSON, no live calls).
- **Determinism test:** resolve a fixture query twice (cold + memo) and across a simulated re-fetch (skipDuplicates) — identical results; a mutated-duplicate insert attempt must violate the unique constraint in the migration replay harness.
- **Archive spot-check (operator, post-Slice-3):** `--verify` sample vs. provider; eyeball 2–3 majors against published ECB/OXR values.
- **Migration validation:** `npx prisma migrate dev` + `generate`; full-chain replay on scratch Postgres (45/45); `tsc --noEmit` with zero consumer edits (Phase 1's neutrality proof); `npm run lint`; `npm test`.
- **No-consumer proof at closeout:** grep — nothing outside `lib/fx/`, the cron route, and the script imports from `lib/fx/` or touches `FxRate`.

## 5. Rollback

- **Schema:** drop `FxRate` — zero consumers by construction.
- **Provider failure at runtime:** failover chain → worst case the day stores nothing; the archive self-heals via the next backfill run (append-only, skip-if-present). No product surface degrades — nothing reads rates.
- **Safe disable:** remove the `vercel.json` cron entry (or unset `OXR_APP_ID` — the route then no-ops with a logged warning and Frankfurter-only coverage, or is skipped entirely if both adapters are unavailable). The archive keeps its rows; disabling fetch never invalidates stored history.
- **Per-slice:** each slice below is independently revertible (delete files / drop table); no slice modifies existing code except the two registration touch-points in Slice 4 (`vercel.json`, `.env.example`).

## 6. Implementation slices

| Slice | Scope | Files | Validation | Rollback |
|---|---|---|---|---|
| **1 — Archive schema** | `FxRate` model + migration `mc1_phase1_fxrate_archive`; nothing else | `prisma/schema.prisma`, new migration | migrate dev, generate, replay 45/45, `tsc` clean with zero consumer edits, lint, test | Drop table |
| **2 — Core library (no network)** | `types.ts`, `config.ts`, `registry.ts`, `archive.ts`, `service.ts` + unit tests with fake adapters/in-memory seam | `lib/fx/*` (new only) | `npm test` (suites self-discover), determinism tests green | Delete `lib/fx/` |
| **3 — Adapters + backfill** | `providers/openexchangerates.ts`, `providers/frankfurter.ts`, `fetch.ts`, `scripts/backfill-fx-rates.ts` (dry-run/`--apply`/`--verify`), `.env.example` `OXR_APP_ID=` | `lib/fx/providers/*`, `lib/fx/fetch.ts`, script, `.env.example` | Parser fixture tests; live dry-run; small live `--apply --from/--to` window + `--verify` spot-check | Delete files; archive rows harmless |
| **4 — Cron + closeout** | `jobs/fetch-fx-rates.ts` + `app/api/jobs/fetch-fx-rates/route.ts` (CRON_SECRET pattern), `vercel.json` cron entry (Hobby slot #2), operator backfill run, STATUS.md ledger + closeout note | route, `jobs/`, `vercel.json`, docs | Route 401 without bearer; manual authorized invocation stores yesterday; no-consumer grep; full suite | Remove cron entry/route; archive persists |

Ordering rule (house): schema → pure core → network edge → wiring/closeout; every boundary shippable and healthy.

## 7. Open items for approval alongside this plan

1. **Confirm Open Exchange Rates as the primary vendor** and create the free-tier `OXR_APP_ID` (operator step — required before Slice 3 live validation; Slices 1–2 need no key).
2. Confirm the curated `SUPPORTED_QUOTES` list (D6) — additions are cheap now, free later.
3. Confirm Vercel Hobby cron slot #2 is acceptable for `fetch-fx-rates` (D1/finding 1).

---

## 8. Recommended first-slice prompt

> Implement MC1 Phase 1 Slice 1 per `docs/initiatives/mc1/MC1_PHASE1_FX_PROVIDER_LAYER_PLAN.md` §3.2 / §6 exactly. Add the `FxRate` model to `prisma/schema.prisma` with the plan's comment block (append-only doctrine, determinism anchor on `@@unique([date, base, quote])`, `@@index([quote, date])`, `Float` rate per decision D3). Create one migration named `mc1_phase1_fxrate_archive` containing only the CREATE TABLE + constraints. Touch nothing else — no lib/fx code, no adapters, no cron, no env changes (those are Slices 2–4). Validate: `npx prisma migrate dev`, `npx prisma generate`, `npx tsc --noEmit` (must pass with zero consumer edits), `npm run lint`, `npm test`, and a full migration-chain replay. Stop after validation and report before Slice 2.

---

*End of plan. Investigation and checklist only — no implementation, schema, migration, or code change is made or authorized by this document. Phase 1 work begins only upon approval, one slice at a time.*
