# MC1 Phase 1 — FX Provider Layer — Closeout Report

**Date:** 2026-07-05
**Status:** ✅ **COMPLETE** (Slices 1–4).
**Plan of record:** `MC1_PHASE1_FX_PROVIDER_LAYER_PLAN.md` — implemented as approved; both plan findings (Vercel-Cron job pattern; OXR-primary for SAR/AED coverage) held.
**Commits:** `8689e2d` (Slice 1 — FxRate archive schema), `fa7f196` (Slice 2 — core FX library), + the Slice 3 (providers/fetch/backfill) and Slice 4 (cron + closeout) commits carrying this report.

---

## 1. What shipped

| Slice | Deliverable | Verified |
|---|---|---|
| 1 | `FxRate` model + migration `20260705201500_mc1_phase1_fxrate_archive` — one table, `@@unique([date, base, quote])` determinism anchor, `@@index([quote, date])`, `Float` rate (D3), append-only doctrine comments | 45/45 chain replay; duplicate `(date,base,quote)` rejected (23505); zero consumer edits for `tsc` |
| 2 | `lib/fx/` core: types (adapter/registry/archive seams, `RateMiss` as value), config (approved 24 quotes, `MAX_STALE_DAYS=7`, closed-date guard), registry (ordered, frozen, DI), archive (insert-only `writeBatch`, walk-back read), service (identity fast path, USD cross-rate, walk-back, memo) | 38 pure unit checks (no network, no Prisma — fake seams) |
| 3 | Providers (`openExchangeRates` primary w/ `OXR_APP_ID`, `frankfurter` keyless ECB-subset failover with the no-forged-close rule), `fetchDay` orchestration (first-complete-batch-wins, batch atomicity, validation→failover), `scripts/backfill-fx-rates.ts` (offline dry-run, `--apply`, `--verify`, `--start/--end`), `.env.example` entry | 33 additional unit checks; **live validation on the dev environment (operator-run):** OXR authenticated, 4-day backfill, **96 rows inserted**, source attribution `openexchangerates`, `--verify` pass **0 mismatches**, no provider failures, no Frankfurter fallback needed, append-only re-run behavior confirmed |
| 4 | `jobs/fetch-fx-rates.ts` + Vercel Cron route `app/api/jobs/fetch-fx-rates/route.ts` (CRON_SECRET bearer, `maxDuration 60`, sync-banks pattern), `vercel.json` cron `30 6 * * *` (Hobby slot #2, after the 06:00 sync-banks), this closeout | route typechecks; vercel.json valid; sync-banks entry byte-untouched |

## 2. Production execution flow

Vercel Cron (06:30 UTC daily) → `GET /api/jobs/fetch-fx-rates` (401 without the exact `Bearer ${CRON_SECRET}` header) → `fetchFxRates()`: target = previous closed UTC day → query quotes already stored for that date → **fully covered ⇒ network-free no-op** → else `fetchDay(date, defaultFxRegistry(), missingQuotes)` walks `[openexchangerates → frankfurter]`, first validated complete batch wins → `fxArchive.writeBatch(source, rates)` (insert-only, skipDuplicates, closed-dates-only) → JSON summary logged and returned. No retries beyond failover: a fully-failed day self-heals via tomorrow's run or `scripts/backfill-fx-rates.ts` (append-only ⇒ always safe to re-run). Safe disable: remove the cron entry (archive keeps all rows) or unset `OXR_APP_ID` (Frankfurter-only ECB coverage).

## 3. Phase contract confirmations

- **Immutable, dated, source-stamped facts:** every row carries `date`/`base`/`quote`/`rate`/`source`; no code path updates or deletes `FxRate`; writes are insert-only for closed dates.
- **Determinism:** one canonical rate per (date, pair) enforced by the DB; resolution is a pure function over the archive with memoized request scope; proven byte-equal across instances in tests.
- **Nothing consumes rates.** Grep-verified: the only importers of `lib/fx` are the backfill script and the cron job/route. Zero product read-path references. `lib/ai`, UI, classifier, snapshots — all untouched. Phase 1 is behavior-neutral end to end.
- **No conversion logic exists.** `convertMoney()` and every consumer remain MC1 Phase 2 scope.

## 4. Validation summary (closeout re-run, sandbox)

`npx tsc --noEmit` clean · `npm run lint` 0 errors (4 pre-existing `<img>` warnings) · test suite **30/31** (4 fx suites, 71 fx checks, all green; `transactions.kd17.test.ts` = the standing darwin-engine-on-linux-sandbox constraint, its assertions pass) · `vercel.json` parses; existing bank cron untouched (4-line additive diff).

## 5. Residual debt (named, non-blocking)

1. **OXR free-tier quota vs. deep history** — initial backfill capped at 365 days (plan D7). Deepening later is a re-run with `--start`; append-only makes it trivial.
2. **Frankfurter-covered days lack SAR/AED** — only occurs if the primary fails on a given day; the backfill's missing-quote top-up heals it on the next OXR-healthy run.
3. **No `SyncIssue` integration** — FX fetch failures are console-logged only (plan finding 3; `FX_FETCH_FAILED` kind noted as a future option alongside the named observability-counters debt).
4. **`tsx` scripts don't auto-load `.env`** — the backfill needs `OXR_APP_ID` exported in the shell (Prisma loads `DATABASE_URL` itself). Operator note, not code debt.
5. **kd17 suite** cannot instantiate PrismaClient on non-darwin sandboxes — pre-existing platform constraint, not MC1 debt.

## 6. What Phase 1 unlocked

Rates now exist exactly as currency began existing in Phase 0: immutable, dated, source-stamped, consumed by nothing. MC1 Phase 2 (read-time conversion via `lib/money/` `convertMoney()` over the `FxArchiveReader` seam) is now pure library work with its inputs already flowing daily.

---

*Phase 1 closed. Next per the approved roadmap: MC1 Phase 2 (read-time conversion) begins with its own implementation checklist — not started by this closeout.*
