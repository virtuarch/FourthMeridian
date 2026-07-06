import { getAccounts, getHoldings } from "@/lib/data/accounts";
import { getSpaceContext } from "@/lib/space";
import { buildSpaceConversionContext } from "@/lib/money/server-context";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { EstimatedChip } from "@/components/ui/EstimatedChip";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import { TrendingUp, TrendingDown } from "lucide-react";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

// MC1 P4 Slice 5 — aggregate totals format in the Space's reporting currency
// (server component: currency passed explicitly); itemized position rows keep
// their native values.
const fmt = (n: number, cur: string = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n);

export default async function HoldingsPage() {
  const ctx = await getSpaceContext();
  const [allAccounts, allHoldings] = await Promise.all([
    getAccounts({ spaceId: ctx.spaceId }),
    getHoldings({ spaceId: ctx.spaceId }),
  ]);

  const investmentAccountIds = allAccounts
    .filter((a) => a.type === "investment" || a.type === "crypto")
    .map((a) => a.id);

  const holdings = allHoldings.filter((h) => investmentAccountIds.includes(h.accountId));

  // MC1 P4 Slice 5 (F-5) — the headline total converts into the Space's
  // reporting currency at the latest close; per-position rows below stay
  // native. All-USD Spaces: identity, numerically unchanged.
  const moneyCtx = await buildSpaceConversionContext(ctx.space, {
    currencies: holdings.map((h) => h.currency ?? null),
    dates:      [yesterdayUTCISO()],
  });
  const conv = holdings.map((h) =>
    convertMoney({ amount: h.value, currency: h.currency ?? null }, yesterdayUTCISO(), moneyCtx),
  );
  const total = conv.reduce((sum, c) => sum + c.amount, 0);
  const totalEstimated = conv.some((c) => c.estimated);
  const displayCurrency = ctx.space.reportingCurrency;

  return (
    <div className="space-y-4 pb-4">
      <h1 className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>Holdings</h1>

      <DataCard>
        <DataCardTitle>Total Holdings Value</DataCardTitle>
        <p className="text-3xl font-bold mt-1" style={{ color: "var(--text-primary)" }}>{totalEstimated ? "\u2248 " : ""}{fmt(total, displayCurrency)}{totalEstimated && <EstimatedChip />}</p>
      </DataCard>

      <DataCard>
        <DataCardTitle>Positions</DataCardTitle>
        <div className="mt-2 divide-y divide-[var(--border-hairline)]">
          {holdings.map((h) => {
            const positive = h.change24h >= 0;
            return (
              <div key={h.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "var(--surface-inset)" }}>
                    <span className="text-xs font-bold" style={{ color: "var(--text-primary)" }}>{h.symbol.slice(0, 2)}</span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{h.symbol}</p>
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>{h.name}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fmt(h.value, h.currency ?? "USD")}</p>
                  <div className="flex items-center justify-end gap-0.5 text-xs font-medium" style={{ color: positive ? "var(--accent-positive)" : "var(--accent-negative)" }}>
                    {positive ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                    {positive ? "+" : ""}{h.change24h}% 24h
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </DataCard>
    </div>
  );
}
