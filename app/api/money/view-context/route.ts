/**
 * GET /api/money/view-context?target=EUR
 *
 * MC1 Phase 4 Slice 8 (plan D-10) — serialized conversion context for the
 * EPHEMERAL "view as" override. Returns the same SerializedConversionContext
 * shape the server pages embed as props, but for an arbitrary approved
 * target currency, covering the active Space's account balances (latest
 * close) and transaction rows (per-row dates).
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
import { serializeSpaceConversionContext } from "@/lib/money/server-context";
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
    db.transaction.groupBy({ by: ["date"], where: txWhere }),
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
  const moneyCtx = await serializeSpaceConversionContext(
    { reportingCurrency: parsed.value },
    {
      currencies: [
        ctx.space.reportingCurrency, // snapshot totals' stamp currency (the "from" for chart points)
        ...accounts.map((a) => a.currency ?? null),
        ...currencyRows.map((r) => r.currency ?? null),
      ],
      dates: [
        yesterdayUTCISO(),
        ...dateRows.map((r) => r.date.toISOString().split("T")[0]),
        ...snapshots.map((s) => s.date),
      ],
    },
  );

  return NextResponse.json({ target: parsed.value, moneyCtx });
}
