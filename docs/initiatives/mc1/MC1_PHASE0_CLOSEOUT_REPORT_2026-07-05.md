# MC1 Phase 0 — Currency Provenance — Closeout Report

**Date:** 2026-07-05
**Status:** ✅ **COMPLETE** (Slices 1–4), pending the three dev-DB exit checks in §5.
**Plan of record:** `MC1_PHASE0_CURRENCY_PROVENANCE_PLAN.md` (implemented exactly as approved — no scope change).
**Commits:** `298ef56` (Slice 1 — schema + migration), `1aa342b` (Slice 2 — writer stamping), `bf53507` (Slice 3 — backfill script), + the Slice 4 docs/closeout commit carrying this report.

---

## 1. What shipped

| Slice | Deliverable | Verified |
|---|---|---|
| 1 | `Transaction.currency String?`, `Holding.currency String?` (nullable, no default), `SpaceSnapshot.reportingCurrency String @default("USD")`; migration `20260705191500_mc1_phase0_currency_provenance` — exactly three ADD COLUMN statements | Schema comments present (3 `MC1 Phase 0` markers); full 44-migration chain replays clean on fresh Postgres; column definitions confirmed (`is_nullable`/`column_default` spot-queried) |
| 2 | Currency stamped at every production writer: Plaid transaction sync (shared `fields` object → all three write outcomes), Plaid holdings ×2 (refresh + initial import), import pipeline (CREATE + update-on-match, excluded from the update-trigger diff), snapshot regenerate + backfill (explicit `DEFAULT_DISPLAY_CURRENCY` stamp), dormant `computeCashResidual` | All 7 sites grep-confirmed; degradation contract preserved (currency stamp never blocks a write); no code path manufactures `"USD"` for row-level stamps |
| 3 | `scripts/backfill-currency.ts` — dry-run default, `--apply`, `--batch`/`--limit`, keyset pagination, per-row `IS NULL`-guarded raw UPDATE (preserves `updatedAt`), derivation `financialAccount.currency ?? account.currency ?? NULL`, examined/updated/skipped/unresolved report | Functional-equivalence harness on scratch Postgres: FA leg → EUR, legacy-Account leg → GBP, pre-stamped untouched, orphans stay NULL, **second pass = 0 updates**, `updatedAt` byte-identical |
| 4 | This report + ledger updates (STATUS.md, plan, charter, roadmap) | — |

## 2. Doctrine confirmations

- **Null means "denomination never recorded" — never "assumed USD."** Row-level stamps trace to a provider code or a stored account row, or stay NULL. The only `USD` literal lives where it always did: `lib/currency.ts` (`DEFAULT_DISPLAY_CURRENCY`), consumed by the two snapshot writers.
- **Snapshots self-describe.** `reportingCurrency NOT NULL DEFAULT 'USD'` is a true statement about how every historical row's totals were computed; live and estimated writers stamp it explicitly.
- **Behavior-neutral.** Zero readers of the three new fields exist anywhere in `lib/ app/ components/ jobs/` (verified by grep at closeout; the only match is a prose comment about cent rounding). `tsc --noEmit` passed at every slice with zero consumer edits.
- **Conversion doesn't exist.** No FX, no rates, no `convertMoney()`, no reporting-currency logic — those are Phases 1–3 of the approved roadmap (`MC1_MULTI_CURRENCY_ROADMAP.md` §0.1).

## 3. Validation summary (closeout re-run, sandbox)

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (4 pre-existing `<img>` warnings, untouched files).
- Test suite — 26/27 pass; `transactions.kd17.test.ts` prints "All KD-17 rollup/invariant/tripwire cases passed" then fails only on PrismaClient instantiation in the Linux sandbox (client generated for darwin-arm64). Pre-existing environment constraint, identical to the pre-Phase-0 baseline.
- Migration chain — 44/44 replay clean on fresh Postgres 17; backfill idempotence re-proven (second pass 0 updates).

## 4. Residual debt (named, non-blocking — FlowType-closeout convention)

1. **`prisma/seed.ts` writes no row-level currency** (dev-only). Seeded snapshot rows get `'USD'` via the column default; seeded transactions/holdings are cured by `npx tsx scripts/backfill-currency.ts --apply` after seeding — same shape as the FlowType seed debt and its cure.
2. **`scripts/test-visibility-two-user-space.impl.ts`** fixture rows unstamped (test-only; wiped after use).
3. **`FinancialAccount.currency` is captured at creation and never re-asserted on refresh** — deferred by plan §8 to Phase 1/2 entry (changes an existing column's behavior; out of the behavior-neutral phase by design).
4. **kd17 suite cannot instantiate PrismaClient on non-darwin sandboxes** — pre-existing platform constraint, not MC1 debt; noted for CI-environment awareness.

## 5. Exit evidence to confirm on the dev machine (operator checklist)

Run against the real dev DB (the sandbox cannot reach it):

```bash
npx tsx scripts/backfill-currency.ts            # review dry-run report
npx tsx scripts/backfill-currency.ts --apply    # stamp historical rows
npx tsx scripts/backfill-currency.ts --apply    # expect: 0 updated (idempotence)
```

- [ ] Backfill applied; unresolved = 0 (or each residue explained — orphaned rows staying NULL is doctrine, not failure).
- [ ] Second `--apply` pass reports 0 updates.
- [ ] After the next Plaid refresh: newest `Transaction` rows and re-synced `Holding` rows read `currency = 'USD'`; today's `SpaceSnapshot` row reads `reportingCurrency = 'USD'`.
- [ ] UI/AI/chart outputs unchanged (the §2 neutrality statement, observed in production).

Record the final counts in the STATUS.md MC1 entry when checked.

## 6. What Phase 0 unlocked

Every monetary fact written from Slice 2 onward knows its denomination; every derivable historical fact is stamped; snapshots declare their computation currency. MC1 Phases 1–3 are now pure column-activation (FX archive → conversion service → reporting-currency flip) with no data archaeology, and Merchant Intelligence backfills will rewrite rows that already carry provenance.

---

*Phase 0 closed. Next per the approved roadmap: MC1 Phase 1 (FX provider layer) begins with its own implementation checklist — not started by this closeout. Merchant Intelligence may proceed on its own track; its entry gates are unrelated to MC1.*
