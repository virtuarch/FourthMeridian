# CRYPTO REFRESH REPAIR — OPERATOR PROCEDURE

**Two live actions are required to finish the 2026-10-01 repair. Neither was
performed during implementation, because the repair authorization restricted live
DB access to READ ONLY. Both need your explicit go-ahead.**

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
