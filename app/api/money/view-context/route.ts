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
import { requireUser } from "@/lib/session";
import { getSpaceContext } from "@/lib/space";
import { getAccounts } from "@/lib/data/accounts";
import { getTransactions } from "@/lib/data/transactions";
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
  const [accounts, transactions] = await Promise.all([
    getAccounts({ spaceId: ctx.spaceId }),
    getTransactions({ spaceId: ctx.spaceId }),
  ]);

  // Same input coverage as the dashboard page's persisted-context prop —
  // balances at the latest close, transaction rows at their own dates —
  // but targeted at the requested view currency instead of the Space's.
  const moneyCtx = await serializeSpaceConversionContext(
    { reportingCurrency: parsed.value },
    {
      currencies: [
        ...accounts.map((a) => a.currency ?? null),
        ...transactions.map((t) => t.currency ?? null),
      ],
      dates: [yesterdayUTCISO(), ...transactions.map((t) => t.date)],
    },
  );

  return NextResponse.json({ target: parsed.value, moneyCtx });
}
