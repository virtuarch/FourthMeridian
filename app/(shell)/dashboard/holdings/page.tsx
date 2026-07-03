import { getAccounts, getHoldings } from "@/lib/data/accounts";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import { TrendingUp, TrendingDown } from "lucide-react";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);

export default async function HoldingsPage() {
  const [allAccounts, allHoldings] = await Promise.all([
    getAccounts(),
    getHoldings(),
  ]);

  const investmentAccountIds = allAccounts
    .filter((a) => a.type === "investment" || a.type === "crypto")
    .map((a) => a.id);

  const holdings = allHoldings.filter((h) => investmentAccountIds.includes(h.accountId));
  const total = holdings.reduce((sum, h) => sum + h.value, 0);

  return (
    <div className="space-y-4 pb-4">
      <h1 className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>Holdings</h1>

      <DataCard>
        <DataCardTitle>Total Holdings Value</DataCardTitle>
        <p className="text-3xl font-bold mt-1" style={{ color: "var(--text-primary)" }}>{fmt(total)}</p>
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
                  <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fmt(h.value)}</p>
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
