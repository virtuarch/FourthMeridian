# D2.x Slice 4B — July 2 Anomaly: Live-Row Provenance — Investigation

**Status:** Investigation only. No implementation.
**Space:** `cmr456dtb0004117fjb6qavmm`.

**Access limitation (stated plainly, not worked around):** the dev DB is on `localhost` and this environment has no DB route / `psql` / `pg` / working `tsx`. I cannot read the rows, and I will not fabricate them. Q2 and Q5 are answerable from code and are answered below with certainty. Q1/Q3/Q4/Q6 require the row data — exact queries are provided. Q7 is a decision tree, not a guessed ranking, because ranking "supported by database evidence" is impossible without the rows.

---

## Q2 — Every LIVE snapshot writer (code-proven). Why there are exactly 3 live rows.

There is exactly **one** live-row writer function: `regenerateSpaceSnapshot(spaceId, date=todayUTC())` (`lib/snapshots/regenerate.ts:74`), which **upserts** the `[spaceId, date]` row (`@@unique([spaceId, date])`) with `isEstimated` defaulting to **false** (LIVE). Every code path below funnels into it (directly, or via `regenerateSnapshotsForAccounts` → `regenerateSpaceSnapshot`):

| Caller | Trigger |
|---|---|
| `lib/plaid/exchangeToken.ts:521` | Plaid **connect** (initial import, step 9b) |
| `lib/plaid/refresh.ts:321` | manual **Refresh** button **and** the daily `sync-banks` cron (same pipeline) |
| `lib/events/handlers/snapshot.ts:30` | domain-event handler (account-share events) |
| `app/api/accounts/manual/route.ts:173` | add manual asset |
| `app/api/accounts/manual/[id]/restore/route.ts:112` | restore manual asset |
| `app/api/accounts/wallet/route.ts` (×3) | add / archive / restore wallet |
| `app/api/accounts/[id]/route.ts:187` | account **delete** |
| `app/api/accounts/[id]/restore/route.ts:173` | account **restore** |
| `prisma/seed.ts` | demo seed only (not a real space) |

The only other `SpaceSnapshot` writer is the **estimated** backfill (`backfill.ts:258`, `isEstimated=true`).

**Because the write is an UPSERT keyed on `[spaceId, date]`, there is at most one row per calendar day, and repeated calls on the same day overwrite that day's row.** Therefore **3 live rows = 3 distinct calendar days on which at least one of the above operations ran** (e.g. connect on day A, a refresh/cron on day B, another op on day C). The live count is a function of *how many distinct days you triggered a balance-changing op*, nothing more.

**Critical corollary (matters for Q3/Q6):** `SpaceSnapshot` has **`createdAt` only — no `updatedAt`** (schema: `createdAt DateTime @default(now())`, no update field). So:
- `createdAt` = timestamp of the **first** write on that day.
- The stored **values** reflect the **last** write on that day (the final upsert).
- **The time of that last write is not recorded anywhere on the row.** You cannot prove from the row alone whether its values are the 10:00 AM pre-payroll state or a later state — you must cross-reference other timestamps (Q3).

## Q5 — Assets formula (code-proven for the writers; partial audit from stored columns).

Both writers compute identically:
- `regenerate.ts`: `totalAssets = (stocks+crypto) + cash + savings + realAssets`; `netWorth = totalAssets − debt`; `netLiquid = cash + savings − debt`.
- `computeSnapshotFields` (backfill): the same arithmetic (unit-tested).

So **there is no arithmetic bug in either writer.** BUT note a schema fact that limits what you can verify from stored columns: **`realAssets` is NOT a stored column.** `SpaceSnapshot` stores `stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, cashOnHand, netLiquid`. Manual/real assets are folded into `totalAssets` but not stored separately. Consequences for the audit:
- **Verifiable from stored columns:** `netWorth == totalAssets − debt`, `total == stocks + crypto`, `netLiquid == cash + savings − debt`, `cashOnHand == max(cash,0)`.
- **NOT directly verifiable:** `totalAssets == stocks+crypto+cash+savings+realAssets`, because `realAssets` isn't stored. Instead, **derive** `realAssets = totalAssets − stocks − crypto − cash − savings`; it should be ≥ 0 and roughly constant across days (manual assets don't move). If it jumps between an estimated day and a live day, that is the flat-vs-live non-cash discontinuity showing up in `totalAssets`.

---

## Queries to run (they produce the Q1/Q3/Q4/Q6 evidence)

**Q1 — rows with provenance:**
```sql
SELECT date, "createdAt", "isEstimated",
       cash, savings, debt, stocks, crypto, "totalAssets", "netWorth", "netLiquid",
       ("totalAssets" - stocks - crypto - cash - savings) AS derived_real_assets
FROM "WorkspaceSnapshot"
WHERE "workspaceId" = 'cmr456dtb0004117fjb6qavmm'
  AND date BETWEEN '2026-06-28' AND '2026-07-05'
ORDER BY date;
```

**Q3 — timeline (because the row has no updatedAt, cross-reference the actual events):**
```sql
-- when refreshes/syncs/connects happened (live-writer triggers), with times
SELECT "createdAt", action, metadata
FROM "AuditLog"
WHERE "userId" = (SELECT "ownerUserId" FROM "FinancialAccount"
                  JOIN "SpaceAccountLink" sal ON sal."financialAccountId" = "FinancialAccount".id
                  WHERE sal."workspaceId"='cmr456dtb0004117fjb6qavmm' LIMIT 1)
  AND action IN ('PLAID_REFRESH','PLAID_SYNC','ACCOUNT_ADD')
  AND "createdAt" BETWEEN '2026-06-28' AND '2026-07-05'
ORDER BY "createdAt";

-- Plaid item sync markers
SELECT "institutionName", "lastSyncedAt", "lastManualRefreshAt", cursor IS NOT NULL AS has_cursor
FROM "PlaidItem"
WHERE "userId" = '<CHRISTIAN_USER_ID>';

-- the payroll transaction's date + whether pending
SELECT fa.name, t.date, t.merchant, t.amount, t.pending
FROM "Transaction" t JOIN "FinancialAccount" fa ON fa.id=t."financialAccountId"
WHERE fa.type='checking' AND t.amount > 0 AND t.date BETWEEN '2026-07-01' AND '2026-07-03'
ORDER BY t.amount DESC;
```

**Q4 — boundary check (do NOT assume it):** from Q1, for each adjacent pair mark whether `isEstimated` flips. Then find where `netWorth`/`totalAssets` makes its biggest jump. The discontinuity hypothesis is **confirmed only if** the biggest jump coincides with an `isEstimated` flip **and** `derived_real_assets` (or `stocks`/`crypto`) changes across that flip. If the biggest jump is *within* estimated rows (no flip) and `derived_real_assets` is constant, the discontinuity hypothesis is **falsified** — it's a cash reconstruction / transaction effect instead.

**Q5 verification:** confirm `netWorth == totalAssets − debt` and `total == stocks+crypto` on every row; confirm `derived_real_assets` is constant. Any violation = writer/data bug (unexpected — the writers are correct).

**Q6 — legitimate vs accidental live row:** cross-reference each live row's `createdAt` (Q1) and the audit/sync times (Q3) against the payroll `date`/post time. A live row is **legitimate history** if its values match the true state at its last-write time; it is an **accidental intermediate** only if it was written mid-operation (e.g. a snapshot regenerated *between* balance update and transaction sync). The event/handler ordering to check: `exchangeToken` writes the snapshot at **step 9b, AFTER** balances (step 7) and holdings (step 8) and — in Slice 1 — the initial tx sync is deferred, so a connect-day snapshot is taken **before** the background history/backfill. That is a real sequencing question worth confirming with the audit timeline.

---

## Q7 — Root-cause ranking = decision tree (final ranking is set by the query output, not by me)

I will not assign probabilities without the rows. Map the Q1/Q3/Q4 output to a cause:

1. **Legitimate pre-payroll history** — LIKELY-CONFIRMED if: the dip days are `isEstimated=true` (or a live day whose last-write time per Q3 precedes payroll), Q5 arithmetic is clean, `derived_real_assets` constant, and Q4 shows no boundary coincidence. Then the dip is *correct* and nothing should be rewritten.
2. **Live/estimated boundary artifact** — CONFIRMED only if Q4 shows the largest jump exactly at an `isEstimated` flip **and** `derived_real_assets`/`stocks`/`crypto` change across it. Falsified otherwise.
3. **Intraday snapshot timing** — CONFIRMED if a **live** dip row's `createdAt` (Q1) + audit time (Q3) precede the payroll post time (Q3), i.e. the row froze a pre-payroll intraday state.
4. **Transaction-date bucketing** — CONFIRMED if the payroll `t.date` (Q3) is July 1 or July 3 rather than July 2 (UTC bucketing moved it), shifting the step off payday.
5. **Flat investment limitation** — CONFIRMED if `derived_real_assets` or `stocks`/`crypto` differ between estimated and live segments (same evidence as #2, non-cash side).
6. **Snapshot writer sequencing** — CONFIRMED if Q3 shows a live row written between a balance update and the tx sync/backfill (mid-operation), per the exchangeToken step-9b ordering noted in Q6.
7. **Arithmetic bug** — essentially EXCLUDED by code (Q5 writers correct); only revived if Q5's stored-column check fails on a row.

**What the code already tells us (priors, to be confirmed by data):** the writers are arithmetically correct (#7 out); the "3 live rows" are simply 3 distinct op-days (Q2); and `SpaceSnapshot` has no `updatedAt`, so intraday timing (#3) can only be judged via the audit/sync timeline (Q3), not the row. The two hypotheses the data must adjudicate are **#1 (legitimate history)** vs **#2/#5 (boundary/flat-non-cash) and #3 (intraday live row)** — and Q4 + `derived_real_assets` + Q3 timeline decide it cleanly.

## Historical integrity (your explicit concern)

Do not rewrite any live row until Q6/Q3 prove it is an **accidental intermediate** (written mid-operation) rather than a **legitimate** capture of the world at its last-write time. If it is legitimate (even if pre-payroll and low), rewriting it would falsify history — leave it. The `createdAt`-only schema means "legitimate vs accidental" must be judged from the audit/sync timeline, not the row alone.

**Stop — investigation only. Run Q1 + Q3 (+ the Q5 checks) and the decision tree resolves the ranking with evidence.**

---

*Offer: if you want the evidence without hand-running SQL, I can provide a strictly read-only `tsx` diagnostic (SELECT-only, no writes) that prints Q1/Q3/Q4/Q5 in one go — say the word and I'll add it; it changes no application behavior.*
