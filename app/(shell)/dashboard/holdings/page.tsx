import { getAccounts, getHoldings } from "@/lib/data/accounts";
import { Card, CardTitle } from "@/components/ui/Card";
import { TrendingUp, TrendingDown } from "lucide-react";

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);

export default async function HoldingsPage() {
  const [allAccounts, allHoldings] = await Promise.all([getAccounts(), getHoldings()]);

  const investmentAccountIds = allAccounts
    .filter((a) => a.type === "investment" || a.type === "crypto")
    .map((a) => a.id);

  const holdings = allHoldings.filter((h) => investmentAccountIds.includes(h.accountId));
  const total = holdings.reduce((sum, h) => sum + h.value, 0);

  return (
    <div className="space-y-4 pb-4">
      <h1 className="text-xl font-bold text-white">Holdings</h1>

      <Card>
        <CardTitle>Total Holdings Value</CardTitle>
        <p className="text-3xl font-bold text-white mt-1">{fmt(total)}</p>
      </Card>

      <Card>
        <CardTitle>Positions</CardTitle>
        <div className="mt-2 divide-y divide-gray-800">
          {holdings.map((h) => {
            const positive = h.change24h >= 0;
            return (
              <div key={h.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-gray-800 flex items-center justify-center">
                    <span className="text-xs font-bold text-white">{h.symbol.slice(0, 2)}</span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">{h.symbol}</p>
                    <p className="text-xs text-gray-500">{h.name}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-white">{fmt(h.value)}</p>
                  <div className={`flex items-center justify-end gap-0.5 text-xs font-medium ${positive ? "text-emerald-400" : "text-red-400"}`}>
                    {positive ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                    {positive ? "+" : ""}{h.change24h}% 24h
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
