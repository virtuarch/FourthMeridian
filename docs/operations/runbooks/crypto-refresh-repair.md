# Runbook — repair missing crypto `RAW_CLOSE` days

**Trigger:** any of
- a held native crypto asset (BTC, ETH, SOL, …) shows days with no historical close inside a window the vendor should serve, e.g. after a provider outage or a failed price run;
- a chart or a Connections card reports held days "not valued" for a native asset where prices are expected;
- an incident review finds a hole in the `RAW_CLOSE` series older than the valuation walk-back.

**Why an operator tool exists:** current crypto valuation reads dated `RAW_CLOSE` closes with a **7-day walk-back**, and the close authority and the scheduled crypto sweep keep that window maintained automatically (see [crypto-networks.md → Wallet refresh](../../systems/crypto-networks.md#wallet-refresh-price-archive-maintenance-and-per-facet-freshness)). That maintenance deliberately does not reach further back: widening it would make every refresh pay for unbounded acquisition. Closing an **older** hole is this tool's job.

**Verified against:** `scripts/repair-crypto-close-gaps.ts`, `scripts/audit-registry.ts` (entry `repair-crypto-close-gaps`, tier OPERATIONAL) — 2026-11-02.

**Origin:** the 2026-10-01 crypto refresh incident (evidence: see `docs/archive/evidence/incidents/`).

## What the tool does

| | |
|---|---|
| Scope | Native assets of every non-deleted wallet's chain (held assets only — an asset is included because it is held, not because of what it is). |
| Default | **Dry run.** Without `--apply` every statement is a read; it reports the missing days per asset and exits. |
| Writes (only with `--apply`) | `PriceObservation` rows, basis `RAW_CLOSE`, **insert-only**, closed dates only. |
| Never | interpolates, carries a neighbouring close, fabricates, overwrites an existing row, touches `INTRADAY` quotes, positions, transactions or accounts. |
| Acquisition | Delegates to the one acquisition path (`backfillPricesForInstruments`), so planning is missing-only: a covered day costs no vendor call, and a second run is a no-op. |
| Honest result | Re-reads after acquiring and reports any day the vendor **still** does not serve. |
| Window | `--from` / `--to` (YYYY-MM-DD). Defaults: `--to` = yesterday (UTC), `--from` = 30 days before `--to`. A `--to` after yesterday is clamped (the archive stores closed dates only). |
| Exit codes | `0` no gaps remain (or all repaired) · `1` gaps remain · `2` failure or usage error. |
| Needs | database access for the target environment and `COINGECKO_API_KEY`. The vendor tier bounds how far back closes exist (the Demo tier serves about 365 days); days outside it stay missing. |

## 1. Confirm the gap (read-only)

Run against the intended environment's env file (never print its values):

```bash
npx dotenv -e .env.local -- npx tsx scripts/repair-crypto-close-gaps.ts \
  --from <YYYY-MM-DD> --to <YYYY-MM-DD>
```

The report lists, per asset, `N missing of M` and the missing ranges, then the number of day-gaps remaining. Nothing is written.

## 2. Repair (writes — requires explicit authorization)

`--apply` writes to the database. On Preview or Production it needs the environment owner's authorization, like any data repair. Keep the window as tight as the report shows.

```bash
npx dotenv -e .env.local -- npx tsx scripts/repair-crypto-close-gaps.ts \
  --from <YYYY-MM-DD> --to <YYYY-MM-DD> --apply
```

To prove nothing else changed, take counts before and after (for example `PriceObservation` total and the `INTRADAY` row count per asset): the only expected difference is the number of `RAW_CLOSE` rows inserted.

## 3. Read the result

- **Exit 0** — no gaps remain in the window.
- **Exit 1** — some days are still missing. That is the honest outcome, not a script failure: the vendor does not serve them, and the system keeps reporting those days unpriced rather than inventing a close. Do not retry in a loop; check the vendor tier's history depth.
- **Exit 2** — usage error or failure; read the message. Nothing partial is hidden: re-run the dry run to see the current state.

After a successful repair, held assets resolve a usable close again. Snapshot rows for the affected days are revalued by the normal regeneration path; this tool does not trigger a wallet sync or a regeneration itself.

## Related rules

- **Schema changes are not part of this runbook.** If a repair depends on a pending migration, apply it with the guarded procedure (`npm run db:migrate:safe`: target-identity guard → backup → `prisma migrate deploy`) per [database-safety.md](../database-safety.md). Never use `prisma migrate dev` against a database whose data matters.
- **No operator action is needed for the 7-day window** — it is maintained automatically before any wallet is touched; see [crypto-networks.md](../../systems/crypto-networks.md#wallet-refresh-price-archive-maintenance-and-per-facet-freshness).
