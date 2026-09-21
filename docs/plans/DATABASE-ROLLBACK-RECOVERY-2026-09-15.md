# Database rollback / recovery investigation — 2026-09-15

Investigation only. Nothing in this document has been executed beyond one safety
backup of the current database. No restore, migration, reset, reconnect, mass
refresh or data mutation was performed. Not committed.

## 1. Current database safety backup (taken)

| | |
|---|---|
| Mechanism | `npm run db:backup` (host `pg_dump` 18.4 against the `fintracker-db` container, `--no-owner --no-privileges`, plain SQL) |
| File | `backups/post-rollback-2026-09-15-fintracker.sql` (byte-identical copy of `backups/fintracker-2026-09-15T17-25-45-979Z.sql`) |
| Taken | 2026-09-15 17:25:45 UTC |
| Size | 7,628,335 bytes, 65 `COPY` blocks, ends with `PostgreSQL database dump complete` |
| SHA-256 | `b4cd912477b45b7db401472e2bf56097af3f5abc2b69f43a526408f913fdc5a3` |

Caveat: this is NOT the pristine post-restore state. Between 17:19 and 17:21 UTC
a peer ran the `sync-crypto` job locally (5 `RefreshExecution`, 1 `JobRun`,
1,636 `PositionObservation`, 261 `PriceObservation`, 1 `SpaceSnapshot`, 3
`SyncIssue`, 1 `AuditLog`), and at 17:25–17:27 UTC a peer's dogfood scripts wrote
15 `AiInvocation` rows. The backup contains the sweep but not the invocations.
The repository does not compute checksums for backups; the hash above was taken
manually.

## 2. Proven rollback window and sequence (PROVEN)

Source: the recorded tool calls and results of local Claude Code session
`e11cd218-4729-4700-9986-708ce04263ac` (the Platform Ops session), corroborated
by Postgres forensics. All times UTC.

| Time | Event | Evidence |
|---|---|---|
| ≤ 16:54 | Database intact. This session's own BTC sync wrote `lastUpdated 16:54:16`; ETH wallet present; SyncIssue rows from 16:33–16:37 present. | this session's psql output |
| 16:56:25 | `npx prisma migrate dev --name … --skip-generate` run from a non-TTY shell after editing `prisma/schema.prisma`. Prisma printed "environment is non-interactive, which is not supported" AND listed drift (`ProviderCapabilityObservation` index rename). **The database was reset before the interactivity refusal surfaced.** WAL segment `…AB` last written 16:56:32. | session log; `pg_wal` mtimes |
| 16:56:58 | `prisma migrate deploy` → `P3005 The database schema is not empty` (schema present, `_prisma_migrations` gone). | session log |
| 16:58:45 | Session's probe: only `PlatformSetting` (5 rows) had live tuples; `backups/` newest file = 2026-08-26. Its own earlier probe had counted **RefreshExecution 92, AiInvocation 1,474** before the reset, **0 / 0** after. | session log, SendFeedback text |
| 16:59:45 | `psql … -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'` (cascade to 125 objects) then `psql -v ON_ERROR_STOP=0 -f backups/fintracker-2026-08-26T23-26-40-599Z.sql`. WAL segment `…AC` written 16:59:46. | session log |
| 17:00:01–17:00:03 | `prisma migrate deploy` applied the 6 migrations dated after the backup (xmin 264589…264609, all `finished_at 17:00:02`). Counts after: `_prisma_migrations 106, AiInvocation 0, DailyBrief 0, JobRun 0, wallets BTC 3 / SOL 1`. | session log; `_prisma_migrations` |
| 17:00:08 | The session filed a SendFeedback bug describing exactly this ("~3 weeks of dev data lost"). | session log |

Postgres forensics agree: `public` schema oid 440512 and every user table oid
441223+ are new; `n_tup_ins == n_live_tup` and `n_tup_del = 0` on every core
table; the 100 pre-backup `_prisma_migrations` rows share one xmin (264249, the
restore COPY) and keep their original timestamps; newest restored row anywhere
is 2026-08-26 19:27 UTC; `_prisma_migrations` file mtime 17:04 and data-table
mtimes 17:02–17:04 are checkpoint flushes.

## 3. Restore mechanism and 4. classification

- **Destroying event:** Prisma Migrate's reset path inside `prisma migrate dev`
  (schema drift + pending hand-written migration, non-interactive shell, Prisma
  CLI 5.22.0). This is the documented footgun `scripts/db-guard.ts` warns about,
  but `db-guard` is wired only into `db:reset`; `db:migrate` (`prisma migrate dev`)
  and a raw `npx prisma migrate dev` are unguarded.
- **Restoring event:** manual `DROP SCHEMA public CASCADE` + plain-SQL restore of
  the newest backup on disk (19 days old) + `migrate deploy`. No pre-restore backup
  was possible (the database was already empty).
- **Type:** C — schema drop/recreate with an SQL restore into the same database,
  same container, same volume. Not A (restore over live data), not B (database
  drop), not D/E (container `fintracker-db` created 2026-08-16, started
  2026-08-30, 0 restarts, single volume `fintracker_postgres_data` created
  2026-06-08; Docker events in the window are healthchecks only), not F.
- **Confidence: PROVEN** (first-party command/result records plus independent
  database forensics).
- **What cannot be recovered from this mechanism:** the reset unlinked the old
  relation files. `pg_wal` holds only 3 segments (16:56, 16:59, current);
  `wal_level` default, no archiving; no filesystem snapshot of the Docker VM
  disk exists. Carving deleted ext4 blocks out of `Docker.raw` is the only
  theoretical path and is not recommended.

## 5. Database / container / volume history

| Item | Fact |
|---|---|
| Container | `fintracker-db` (postgres:16-alpine, compose project `fourthmeridian`), created 2026-08-16, postmaster start 2026-08-30 17:39 UTC, up 2 weeks, 0 restarts |
| Volume | `fintracker_postgres_data` (created 2026-06-08), 103.7 MB, 585 files modified in the last 20 days (live) |
| Dangling volumes | 5 anonymous volumes from 2026-07-25 (PG16, 4 databases, newest file 2026-07-25) and `fourthmeridian_postgres_data` (2026-07-05, empty). None newer than the backup. |
| Homebrew Postgres | stopped ~2026-08-30 (history); no data directory present on disk |
| Time Machine | no destination configured; only OS-update APFS snapshots (no user-data date listed) |
| Prior migration of data | 2026-08-30: `fintracker-old-db` → pg_dump → loaded into `fintracker-db` (history lines 814–822); that container was removed |

## 6. Newer backup / copy candidates

Searched: `backups/`, project tree incl. ignored dirs, `~/dev`, Desktop,
Documents, Downloads, `/tmp`, `/private/tmp`, `/private/var/tmp`, all Docker
volumes (read-only mounts), stopped containers, Homebrew data dirs, Time
Machine, APFS snapshots, git worktrees, `.env.preview` (empty URLs, no remote DB).

**Result: none.** Newest pre-incident copy is
`backups/fintracker-2026-08-26T23-26-40-599Z.sql` (7,567,203 bytes, taken by
`db:migrate:safe` on 2026-08-26 23:26 UTC). Post-incident copies: the two
identical files from §1.

## 7. Loss inventory (2026-08-26 23:26 UTC → 2026-09-15 16:56 UTC)

Legend: PROVIDER = recoverable from provider, CHAIN = reconstructable from
blockchain, REGEN = regeneratable deterministically, LOCAL = recoverable from
other local evidence, LOST = irreplaceable without backup, UNKNOWN.

**Connections**
- ETH wallet `cmtbintp0004q1292xyboi5xc` (Connection, AccountConnection,
  ProviderAccountIdentity, FinancialAccount, created 2026-08-27): rows LOST;
  identity LOCAL (§15); history CHAIN.
- BTC zpub wallet: identity SURVIVED (Connection credential + discovery cursor,
  1 identity row); `lastUpdated` reverted to 2026-08-26; PositionCoverage
  licence LOST (table post-dates backup) → REGEN on next successful sync.
- SOL wallet: identity SURVIVED; already re-synced by the peer sweep at 17:20
  (coverage COMPLETE 2022-03-26..2026-09-15, 1,636 rows) → effectively recovered.
- Plaid: 13 `PlaidItem` rows SURVIVED with encrypted tokens and 2026-08-26
  cursors; `environment` column now NULL on all 13 (column post-dates backup).
  Schwab stayed NEEDS_REAUTH throughout the window (no reauth lost). Sync
  state since 08-26: PROVIDER.
- `AuditLog` after 08-26 (2,018 rows on 09-14 vs 333 now, incl. 7
  PLAID_ITEM_STATUS_CHANGED, policy CHANGED/RESET, AI_CONTEXT_ASSEMBLED): LOST.

**Financial data**
- Bank transactions/balances/holdings 08-26→09-15: PROVIDER (cursor sync from
  the restored cursor returns added/modified/removed since 08-26; upsert on
  `plaidTransactionId` with fingerprint fallback; investments via events).
  Provider-side truth (posted dates, amounts) is preserved; our ingestion
  timestamps (`createdAt`) will be new.
- ETH movements/observations (16 movements, 3,238+ DERIVED rows, 31 closes):
  CHAIN + PROVIDER (Alchemy state reads; `ALCHEMY_API_KEY` present).
- BTC movements: ledger SURVIVED (28 active tx, reconciles to balance);
  observations 08-27→09-15 CHAIN via re-sync + `refreshWalletHistory`.
- `PriceObservation` 08-27→09-15: PROVIDER (CoinGecko/Tiingo backfill already
  re-fetched 261 rows at 17:20).
- `SpaceSnapshot` / `PositionReconstruction` / wealth history: REGEN
  (`regenerateWealthHistoryForAccounts`, `regenerateSnapshotsForAccounts`).
- Interim ETH history from 08-27 to 09-15 as it was OBSERVED day by day: LOST
  as an observation record, CHAIN as a reconstruction.

**User-entered data**
- `DebtProfile`: 0 rows both before (per L1 investigation on 09-15) and now →
  nothing lost. APR/minimum overrides: evidence says none were created in the
  window on the dogfood Space; other Spaces UNKNOWN.
- Spaces, account metadata edits, planned events: no evidence of creation or
  edits in the window (scenario/planned events are not persisted by design).
  Anything unrecorded is UNKNOWN.

**AI / memory** — `SpaceMemory` table post-dates the backup → **all rows LOST**.
Evidence of what existed (contents not to be reconstructed): 5 rows on
2026-09-08 (incl. contradictory ACTIVE INTENTIONs `net-worth-target-2030` and
`net-worth-target-2029`, a CHECKPOINT for horizon 2026-12-31), 8 rows on
2026-09-13 (+ CHECKPOINT `liquid-2026-10-19`, CHECKPOINT `liquid-2026-12-31`),
plus a two-member `net-worth-target` pair from the slice-6 verification.
Intentions are user-stated → LOST (may be re-stated by the user); checkpoints
are derived from projections → REGEN only in the sense that new ones will be
written; the historical ones are LOST. AI transcript cache lives in browser
localStorage, not the database → unaffected.

**Daily Brief** — table post-dates the backup → all rows LOST (§14).

**Platform Ops** — `RefreshExecution` 92 rows (all Plaid manual runs) and their
`RefreshEndpointResult`/`ProviderCall`/coverage rows after 08-26: LOST
(operational evidence). `JobRun`: was 0 locally → nothing lost. Refresh-policy
rows: none existed at the time of the reset (§13) → nothing lost; the
CHANGED/RESET audit rows are LOST. `PlatformGrant` (4) SURVIVED. Platform section
row created by `ensurePlatformSections` on 09-14: LOST, REGEN by re-running the
seed. `PlatformSetting`: 5 security rows SURVIVED.

**AI economics** — `AiInvocation` table post-dates the backup → **1,474 rows
LOST** (§12).

**Other** — `UserSession` rows after 08-16: LOST (users re-login). `RateLimit`,
`Notification` deliveries after 08-26: LOST, immaterial. `SyncIssue`
open-incident state after 08-26 (8 UPSERT_ERROR, 7 REMOVED_TOMBSTONE, 2
BALANCE_TX_MISMATCH, WALLET_SYNC_FAILED): LOST as history; incidents recur on
the next sync if still true.

## 8. Provider reconstruction plan (not executed)

| Source | Window | Identity stable | Idempotent | Observations | Historical balances | Holdings history | Provider timestamps | Derived rows |
|---|---|---|---|---|---|---|---|---|
| Plaid transactions | from restored cursor (08-26) forward; a null cursor would pull full available history | `plaidTransactionId` (+ fingerprint fallback, tombstone-wins) | yes (upsert; `removed[]` applied) | balances current-only | via `regenerateWealthHistory` from ledger | via InvestmentEvent sync | posted/authorized dates preserved | deterministic regen |
| Plaid investments | `/investments/transactions` date range; holdings current | event ids | yes | current | REGEN from events | partial | preserved | deterministic |
| CoinGecko/Tiingo prices | registry backfill (`COINGECKO_HISTORY_DAYS`) | (instrument, date, basis) unique | yes | n/a | n/a | n/a | dated closes | n/a |
| SOL | already re-synced 17:20 | signature | yes | reconstructed | reconstructed | n/a | block time | done |
| BTC | zpub survived; `mempool.space` currently unreachable (tx import non-fatal; balance via blockchain.info) | txid | yes (unique index) | on next success | reconstruction | n/a | block time | REGEN |
| ETH | requires reconnect (§15); full reconstruction ~158 s / 551 requests, then incremental | txhash + state reads | yes | reconstructed | reconstructed | n/a | block time | REGEN |

Cursor implication: restored 08-26 cursors do not skip data — Plaid returns every
change since that cursor. Risk is the opposite: a long replay. A forced full
pull (null cursor) is NOT needed and would re-import 24 months.

## 9. Crypto reconstruction

| | BTC | SOL | ETH |
|---|---|---|---|
| Connection identity | survived (zpub credential, cursor `rDone/cDone`) | survived (address) | LOST — must be recreated via `POST /api/accounts/wallet` with name, address, chain |
| Address config | survived | survived | evidence in §15 |
| Chain history | 28 tx survived; new since 08-26 via explorer once reachable | done | full via Alchemy state reads |
| Movement identity | `txid` / `txid:fee`, active-row unique index | signature | txhash |
| Observation reconstruction | `refreshWalletHistory` after a successful sync | done | `reconstructEthHistory` then incremental |
| Price history | archive has closes through today (backfilled 17:20) | same | same (rolling ceiling) |
| Derived rows | REGEN | done | REGEN |
| Not reconstructable | the day-by-day OBSERVED rows 08-27→09-15 (a DERIVED replay replaces them); the coverage licence's original `computedAt` | same | same, plus the original connect timestamp |

## 10. Plaid / bank reconstruction

Items, tokens and cursors survived (13 items, 13 tokens, 4 real items with
cursors: Chase, Amex, Schwab, Robinhood). Schwab needs reauth (unchanged since
08-17). `environment` is NULL on all items after the restore because the column
was added on 09-08; verify what the Plaid client derives when NULL before any
refresh. Safe path: the existing manual refresh per item (`runFullRefresh`,
`FULL_REFRESH`), which resumes from the stored cursor and is idempotent by
construction. No forced/null-cursor pull.

## 11. AI / memory loss — see §7. Inventoried: ≥ 8 `SpaceMemory` rows
(intentions + checkpoints, subjects known, payloads not). Financial truth must
not be rebuilt from these; intentions may only be re-stated by the user.

## 12. AiInvocation / economics loss

1,474 rows (2026-09-08 → 09-15 16:56) LOST. Exact per-invocation accounting
is gone. Estimated evidence survives locally: the 09-14 census in
`docs/plans/PLATFORM-OPS-CONTROL-PLANE-INVESTIGATION.md` (1,134 rows, ≈$5.11
over five days, 8.6M prompt tokens), the dogfood gate report (28 rows, $0.1974),
and per-run logs under gitignored `tmp/` (141 files newer than 08-27, e.g.
`tmp/floor/out/pc-cost*.log`). Classification: EXACT lost, ESTIMATED available.
No provider usage export is configured.

## 13. Refresh-policy evidence

Code defaults: BANK 24h, WALLET 6h (`DEFAULT_REFRESH_CADENCE`), grace
max(2h,25%). Operator mutation 6h→12h happened on 2026-09-13 (measurement), and
the Slice-2 acceptance on 09-14 did CHANGED then RESET; the 09-14 census states
"no rows exist" for `refresh_cadence_*`. Conclusion: at reset time the policies
were **DEFAULT (no rows)** — nothing to recreate. The audit trail of the
mutations is LOST.

## 14. Daily Brief loss

All `DailyBrief` rows (2026-09-13 → 09-15) LOST. Content is REGENERATABLE
(`ensureDailyBrief` recomputes from the watermark/digest; ~$0.004 per
generation), but each row was also operational evidence: `generatedAt`,
`sourceWatermark`, `materialDigest`, `promptVersion`, `correlationId`,
failure timestamps and the day-over-day `standingFacts` comparison. Those exact
historical rows cannot be reproduced; only new briefs for new days can.

## 15. ETH connection recovery evidence

- Account id `cmtbintp0004q1292xyboi5xc`, chain ETH, created 2026-08-27
  (ETH-H2 acceptance), plain EOA, 16 movements, first inbound 2021-04-27.
- The checksummed public address is recorded verbatim in the repository test
  `lib/crypto/wallet-card-truth.test.ts:44` (`CHECKSUMMED = "0x910Eb431…45bA2D"`,
  42 chars) and in this session's earlier database output. It is a public
  address, not a secret; it is not reproduced here in full.
- Reconnect is a normal `POST /api/accounts/wallet` (name, walletAddress,
  walletChain). Note the 08-27 duplicate-Connection bug was fixed
  (case-sensitive credential match); expect one Connection.

## 16. Plaid reconstruction capability — yes; see §8/§10.
## 17. Crypto reconstruction capability — yes for all three; see §9.
## 18. Refresh-policy recovery — nothing to restore; see §13.

## 19. Proposed recovery sequence (derived from repository facts)

1. Keep `backups/post-rollback-2026-09-15-fintracker.sql` untouched (done).
2. No newer authoritative copy exists → skip whole-DB restore. Keep the current
   database; do NOT restore the Aug-26 dump again.
3. Decide the peer-written post-rollback rows (sweep at 17:20, invocations at
   17:25) are acceptable operational rows; they are consistent with the schema.
4. Verify `PlaidItem.environment` NULL handling in the Plaid client before any
   bank refresh.
5. Re-ingest bank truth: manual `FULL_REFRESH` per real item (Chase, Amex,
   Robinhood; Schwab after reauth). Cursor resumes from 08-26.
6. Reconnect ETH via the wallet route using the address from §15; run its sync
   (full reconstruction once, then incremental).
7. BTC: run a manual sync once `mempool.space` answers (or accept balance-only
   syncs meanwhile); `refreshWalletHistory` re-issues the coverage licence.
8. Backfill prices via the registry job (`fetch-security-prices`) if any
   instrument lacks closes.
9. Regenerate snapshots and wealth history for all affected accounts
   (`regenerateSnapshotsForAccounts`, `regenerateWealthHistoryForAccounts`).
10. Re-run `ensurePlatformSections` (platform section row).
11. Policies: nothing to restore (defaults).
12. Resume scheduled refresh only after the above.
13. Validate Connections (all sources CURRENT under 24h/6h), Daily Brief
    (fresh generation), Platform Ops (executions, job health).
14. Ask the user whether to re-state lost intentions; never auto-recreate memory.
15. Resume L1.

## 20. Irreplaceable data

`SpaceMemory` (intentions/checkpoints), `DailyBrief` rows, `AiInvocation`
rows, `AuditLog` after 08-26, `RefreshExecution`/`ProviderCall` ledgers after
08-26, `SyncIssue` incident history after 08-26, `UserSession`s, the ETH
wallet's original connect timestamp and its day-by-day OBSERVED rows.

## 21. Prevention (not implemented)

1. Route `db:migrate` through `db-guard` and require a TTY plus
   `ALLOW_DESTRUCTIVE_DB=true` for any `migrate dev`; document
   `prisma db execute` + `migrate resolve --applied` as the non-interactive path
   for hand-written migrations.
2. A `db:restore` script that refuses when the dump is older than N days unless
   `--accept-age`, always takes a pre-restore backup, and prints a restore
   manifest (source file, hash, dump timestamp, row counts before/after).
3. Nightly (or on every `migrate:safe`) backup retention so the newest backup
   is never 19 days old; the last automatic backup was 08-26.
4. Startup rollback detector: compare `max(createdAt)` over key tables against
   a persisted watermark and log a loud warning on a large backward jump.
5. A restore audit row (`AuditLog` action `DATABASE_RESTORED`) written by the
   restore script.

## 22. Should the current database be used for development meanwhile?

Yes, with caveats: schema is current (106 migrations), identities for BTC/SOL/
Plaid survived, and peers are already writing to it. It must not be used for
any claim about post-08-26 history, Daily Brief evidence, AI economics, or L1
liability work that depends on recent ledger reach.

## 23. SAFE TO RECOVER / NEEDS MANUAL DECISION

**NEEDS MANUAL DECISION** on three points only: (a) accept the peer-written
rows from 17:19–17:27 as part of the baseline, (b) reconnect ETH (user action
on their own wallet), (c) whether to re-state lost intentions. Everything else
in §19 is safe and idempotent.

## 24. L1

**NOT SAFE TO RESUME L1** until steps 5–9 of §19 have run and Connections
report CURRENT.
