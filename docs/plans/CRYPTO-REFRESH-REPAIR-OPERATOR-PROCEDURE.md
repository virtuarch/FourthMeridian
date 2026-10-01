# CRYPTO REFRESH REPAIR — OPERATOR PROCEDURE

> ## ✅ BOTH ACTIONS EXECUTED — 2026-10-01 19:22–19:3x UTC, under operator authorization
>
> | | Result |
> |---|---|
> | **Action 1** — schema migration | **APPLIED** to `localhost:5432/fintracker` via `npm run db:migrate:safe` (guard + backup + `migrate deploy`). `20261001120000_connection_facet_freshness` recorded, `applied_steps_count=1`, not rolled back. Both columns present and nullable; all 11 `Connection` rows NULL in both — **no backfill, no fabricated timestamps**. |
> | **Action 2** — RAW_CLOSE gap repair | **COMPLETE.** 27/27 asset-days acquired (BTC/ETH/SOL × 2026-09-21..09-29), provider outcome `OK=1` per asset, **0 gaps remaining**. |
>
> **Path taken for Action 1 — a deliberate deviation from the draft below, in the safer
> direction.** The draft prescribed `db execute` + `migrate resolve`. The repo's own
> sanctioned additive path `npm run db:migrate:safe` was used instead because it is
> strictly stronger: it runs the house DB guard's target-identity check, takes a backup
> automatically, and `migrate deploy` applies **and records atomically** — removing the
> one real hazard of the manual route, which is `migrate resolve` marking a migration
> applied when the SQL only partly ran. `prisma migrate dev` was never invoked.
> Exactly one migration was pending (proven: 107 on disk, 106 applied), so deploy could
> not apply anything unintended.
>
> Pre-migration backup: `backups/fintracker-2026-10-01T19-22-24-926Z.sql` (8.7 MB).
>
> **Proof nothing else was touched** — content digests taken before and after:
> ```
> connection_digest  4c21a5f8eec866665cd13387b5c234c6   UNCHANGED
> tx_digest          4abd8ac3e5e468dd5a138ee49b445de4   UNCHANGED
> position_digest    c6a0d6fce3fa4af8bd8b8e51130e3084   UNCHANGED
> wallet quantities  BTC:0.02, BTC:0.038, BTC:0.24060252, SOL:0, ETH:0   UNCHANGED
> PriceObservation   10426 → 10453  (+27, exactly the authorized RAW_CLOSE inserts)
> INTRADAY rows      BTC 2 / ETH 1 / SOL 2   UNCHANGED — never promoted
> ```
> Post-repair, all three held assets resolve a usable close as of 2026-10-01
> (floor 2026-09-24, usable close 2026-09-30), so no wallet is latched.
>
> No wallet sync was triggered. No commit was required for either action — the
> migration file was already committed and both outcomes live in the database.
>
> *The remainder of this document is the original procedure, kept as the record of what
> was authorized and why.*

---

**Two live actions were required to finish the 2026-10-01 repair. Neither was
performed during implementation, because the repair authorization restricted live
DB access to READ ONLY. Both needed explicit go-ahead — given and executed above.**

Authority: `docs/plans/CRYPTO-REFRESH-INCIDENT-2026-10-01.md`
Code: the `CRYPTO-LATCH-*` / `CRYPTO-FRESHNESS-1` / `CRYPTO-COPY-1` /
`CRYPTO-PARALLEL-1` commits on `v2.6`.

Live DB fingerprint, taken before and after implementation — **identical**, proving
nothing was mutated during the work or its acceptance:

```
wallets=5 positions=6622 prices=10426 tx=4929 execs=115 stages=418 syncissues=45
btc_newest_rawclose=2026-09-30
```

---

## ACTION 1 — Apply the schema migration (REQUIRED before the app runs)

`20261001120000_connection_facet_freshness` adds two **nullable** columns to
`Connection`: `transactionsSyncedAt` and `historyRebuiltAt`.

It is additive, has no backfill, and no data is read or rewritten. **There is
deliberately no backfill**: inventing a success date for a facet whose history we
do not have is the exact dishonesty the repair removes, so every existing row reads
NULL and the UI renders that as silence.

### ⚠️ Do NOT use `prisma migrate dev`

A non-interactive `prisma migrate dev` **reset this dev database on 2026-09-15** and
cost ~3 weeks of data. Use `db execute` + `migrate resolve`, which is how this repo
has applied migrations since:

```bash
cd /Users/chrstn/dev/FourthMeridian
set -a && . ./.env.local && set +a
export DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"

# 1. Back up first. Non-negotiable.
pg_dump "$DATABASE_URL" -Fc -f "backups/pre-facet-freshness-$(date +%Y%m%d%H%M).dump"

# 2. Apply the SQL (two ALTER TABLE ... ADD COLUMN statements, nothing else)
npx prisma db execute \
  --file prisma/migrations/20261001120000_connection_facet_freshness/migration.sql \
  --schema prisma/schema.prisma

# 3. Mark it applied so future `migrate deploy` runs agree with reality
npx prisma migrate resolve --applied 20261001120000_connection_facet_freshness
```

Verify:

```bash
psql "$DATABASE_URL" -c '\d "Connection"' | grep -E 'transactionsSyncedAt|historyRebuiltAt'
```

> **Production note:** deploy does **not** run `migrate deploy` automatically in this
> repo. The same two steps are needed against production before the Connections page
> is served there, or the page will error on the missing columns.

### Unrelated drift noticed, deliberately NOT included

`prisma migrate diff` also reports an index rename:

```
ALTER INDEX "ProviderCapabilityObservation_provider_capabilityKey_observedAt"
  RENAME TO "ProviderCapabilityObservation_provider_capabilityKey_observ_idx";
```

That is **pre-existing drift from peer work**, not mine, and it is excluded from this
migration. It should be resolved on its own by whoever owns that table.

---

## ACTION 2 — Repair the historical RAW_CLOSE gap (OPTIONAL, bounded)

The incident left **2026-09-21 … 2026-09-29** absent from the BTC / ETH / SOL
`RAW_CLOSE` series — 9 days × 3 assets. The latch repair restores only the
valuation's own 7-day walk-back, deliberately: it is a valuation prerequisite, not
a history tool, and widening it would make every refresh pay for unbounded
acquisition. Closing an older hole is this script's job.

### First, confirm the gap (READ-ONLY — safe to run now, and already run)

```bash
npx dotenv -e .env.local -- npx tsx scripts/repair-crypto-close-gaps.ts \
  --from 2026-09-18 --to 2026-09-30
```

Output observed 2026-10-01, with the DB fingerprint unchanged afterwards:

```
crypto RAW_CLOSE gap REPORT (dry run — nothing will be written)
window 2026-09-18..2026-09-30

BTC   9 missing of 13: 2026-09-21..2026-09-29
ETH   9 missing of 13: 2026-09-21..2026-09-29
SOL   9 missing of 13: 2026-09-21..2026-09-29

dry run — nothing written; 27 day-gap(s) remaining (see above)
```

### Then, if you authorize it, repair

```bash
npx dotenv -e .env.local -- npx tsx scripts/repair-crypto-close-gaps.ts \
  --from 2026-09-21 --to 2026-09-29 --apply
```

What `--apply` does and does not do:

| | |
|---|---|
| Writes | `PriceObservation` rows, basis `RAW_CLOSE`, **insert-only** |
| Never | interpolates, carries, fabricates, or overwrites an existing row |
| Never | touches `INTRADAY`, a position, a transaction, or an account |
| Bounded | to the window you pass; missing-only planning, so a covered day costs no vendor call |
| Idempotent | a second run is a no-op |
| Honest | re-reads after acquiring and reports days the vendor **still** does not serve |

Exit codes: `0` no gaps remain · `1` gaps remain · `2` failure.

It requires `COINGECKO_API_KEY` (present in `.env.local`). CoinGecko's Demo tier
serves 365 days, so this window is within depth.

**If some days remain missing afterwards, that is the honest outcome, not a
failure of the script** — the vendor does not serve them, and the system will keep
reporting those days unpriced rather than inventing a close.

---

## What needs NO operator action

- **The latch is closed in code.** A BTC-only holder now recovers two ways, neither
  gated on a valuation having succeeded: the close authority repairs its own
  archive on a miss and re-reads, and the scheduled sweep maintains held assets
  before it touches any wallet.
- **Timeouts and retries are unchanged**, deliberately — see the closure report.
- **No live sync was triggered** during implementation or acceptance.
