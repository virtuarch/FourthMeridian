/**
 * GET /api/money/view-context?target=EUR
 *
 * MC1 Phase 4 Slice 8 (plan D-10) — serialized conversion context for the
 * EPHEMERAL "view as" override. Returns the same SerializedConversionContext
 * shape the server pages embed as props, but for an arbitrary approved
 * target currency, covering the active Space's account balances (latest
 * close) and transaction rows (per-row dates).
 *
 * ── v2.6-CHRON-1: this endpoint serves BOTH bases ───────────────────────────
 *
 * It is the worked example in docs/architecture/TIME_MODEL.md §8.4. The context
 * it returns is used to convert two populations that carry different dates:
 *
 *   transaction rows  → converted by the flow folds at the DTO's `date`,
 *                       which since L8-B is the ECONOMIC date
 *   snapshot points   → converted at the snapshot's own date, POSTING basis
 *
 * It used to enumerate `groupBy(["date"])` over the flow population: posting
 * keys for rows that would be asked for at economic dates. Measured on the live
 * corpus, 31 economic dates had NO prefetched rate and 163 rows landed on them —
 * they would have converted as unavailable while neighbouring rows converted
 * cleanly. `FxRate` is empty today so nothing was visibly wrong; the defect was
 * latent and would have surfaced as an unexplainable scatter of missing
 * conversions the first time a non-USD reporting currency was used.
 *
 * Rule B3: a surface serving both bases enumerates BOTH. It does not pick one.
 *
 * READ-ONLY BY DOCTRINE: this endpoint writes nothing and the override is
 * never persisted anywhere — not on the Space, not on the User, not in a
 * cookie. Writers (snapshot regenerate/backfill, assemblers) never consult
 * it; they read Space.reportingCurrency and only that. A page reload
 * discards the override because it lives in client component state only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { getSpaceContext } from "@/lib/space";
import { getAccounts } from "@/lib/data/accounts";
import { bankingTransactionWhere } from "@/lib/data/transactions";
import { getRecentSnapshots } from "@/lib/data/snapshots";
import { resolveEffectiveSpaceConversionSerialized } from "@/lib/money/server-context";
import { parseReportingCurrencyInput } from "@/lib/spaces/reporting-currency";
import { yesterdayUTCISO } from "@/lib/fx/config";

export async function GET(req: NextRequest) {
  const [, err] = await requireUser();
  if (err) return err;

  const parsed = parseReportingCurrencyInput(req.nextUrl.searchParams.get("target"));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const ctx = await getSpaceContext();
  // TX-2C — this endpoint only needs the DISTINCT currencies + dates present in
  // the Space's transactions to build FX coverage, NOT the rows themselves.
  // Enumerate them with cheap DB aggregates (groupBy) over the SAME banking
  // population as getTransactions — one row per distinct currency / calendar day,
  // bounded by days not transaction count — instead of loading the full history.
  const txWhere = bankingTransactionWhere(ctx.spaceId);
  const [accounts, currencyRows, dateRows, snapshots] = await Promise.all([
    getAccounts({ spaceId: ctx.spaceId }),
    db.transaction.groupBy({ by: ["currency"], where: txWhere }),
    // v2.6-CHRON-1 — ECONOMIC dates. This population is flow-shaped
    // (bankingTransactionWhere), and the folds that will consume this context
    // convert at the DTO's `date`, which IS the economic date. Enumerating
    // posting dates here prefetched rates for days the client never asks about
    // while missing the days it does. `nulls` cannot occur — economicDate is
    // NOT NULL for every live row (audit:economic-date) — but the filter is
    // spelled out so a future backfill gap degrades to "fewer dates", never to
    // a crash on a null key.
    db.transaction.groupBy({ by: ["economicDate"], where: txWhere }),
    // Snapshot dates + the Space's stamp currency are enumerated so the chart's
    // per-point conversion resolves under the override instead of rate-missing
    // (each historical net-worth point converts at its own date). Same 365-day
    // window the Overview chart reads.
    getRecentSnapshots(365, { spaceId: ctx.spaceId }),
  ]);

  // Same input coverage as before — balances at the latest close, the distinct
  // transaction currencies + dates, plus the snapshot series — all targeted at
  // the requested view currency. Aggregate-derived coverage is equivalent to the
  // old row scan (same distinct currency/date sets).
  //
  // V25-CLOSE-3A — resolve the EFFECTIVE currency here (the shared decision
  // point): if `parsed.value` cannot be satisfied (every needed pair misses), the
  // display reverts to USD and `reverted: true` is reported. `target` stays the
  // effective currency for existing readers; `requested`/`reverted` are additive.
  // Nothing is persisted.
  const resolved = await resolveEffectiveSpaceConversionSerialized(
    { reportingCurrency: parsed.value },
    {
      currencies: [
        ctx.space.reportingCurrency, // snapshot totals' stamp currency (the "from" for chart points)
        ...accounts.map((a) => a.currency ?? null),
        ...currencyRows.map((r) => r.currency ?? null),
      ],
      dates: [
        yesterdayUTCISO(),
        // v2.6-CHRON-1 — the flow population's ECONOMIC dates (the days the
        // client will actually ask about). Snapshot dates below cover the
        // balance basis; together they satisfy rule B3.
        ...dateRows.flatMap((r) => (r.economicDate ? [r.economicDate.toISOString().split("T")[0]] : [])),
        ...snapshots.map((s) => s.date),
      ],
    },
  );

  return NextResponse.json({
    target:    resolved.effective, // back-compat: existing readers use `target`
    requested: resolved.requested,
    effective: resolved.effective,
    reverted:  resolved.reverted,
    moneyCtx:  resolved.moneyCtx,
  });
}
