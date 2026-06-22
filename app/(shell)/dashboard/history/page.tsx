import { getRecentSnapshots } from "@/lib/data/snapshots";
import { formatDate } from "@/lib/format";
import { NetWorthChart } from "@/components/charts/NetWorthChart";
import { Card, CardTitle } from "@/components/ui/Card";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

export default async function HistoryPage() {
  const snapshots = await getRecentSnapshots(30);

  if (snapshots.length === 0) {
    return (
      <div className="space-y-4 pb-4">
        <h1 className="text-xl font-bold text-white">History</h1>
        <Card>
          <CardTitle>Net Worth — 30 Days</CardTitle>
          <p className="text-sm text-gray-500 mt-2">
            No history yet. Click Refresh to generate today&apos;s snapshot.
          </p>
        </Card>
      </div>
    );
  }

  const latest = snapshots[snapshots.length - 1];
  const oldest = snapshots[0];
  const change = latest.netWorth - oldest.netWorth;
  const pct = ((change / oldest.netWorth) * 100).toFixed(1);

  return (
    <div className="space-y-4 pb-4">
      <h1 className="text-xl font-bold text-white">History</h1>

      <Card>
        <CardTitle>Net Worth — 30 Days</CardTitle>
        <div className="flex items-baseline gap-2 mt-1 mb-3">
          <p className="text-2xl font-bold text-white">{fmt(latest.netWorth)}</p>
          <span className={`text-sm font-semibold ${change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {change >= 0 ? "+" : ""}{fmt(change)} ({pct}%)
          </span>
        </div>
        <NetWorthChart snapshots={snapshots} interval="1M" onIntervalChange={() => {}} />
      </Card>

      <Card>
        <CardTitle>Snapshot History</CardTitle>
        <div className="mt-2 divide-y divide-gray-800">
          {[...snapshots].reverse().slice(0, 10).map((s) => (
            <div key={s.date} className="flex items-center justify-between py-2.5">
              <p className="text-sm text-gray-400">{formatDate(s.date)}</p>
              <div className="text-right">
                <p className="text-sm font-semibold text-white">{fmt(s.netWorth)}</p>
                <p className="text-xs text-gray-500">Cash: {fmt(s.totalCash)}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardTitle>Debt Tracker</CardTitle>
        <div className="mt-2">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-gray-400">Current Debt</span>
            <span className="text-red-400 font-semibold">-{fmt(latest.totalDebt)}</span>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-3">
            <div
              className="h-3 rounded-full bg-gradient-to-r from-red-500 to-orange-400"
              style={{ width: `${Math.min((latest.totalDebt / 30000) * 100, 100)}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-1">Target: $0 · Remaining: {fmt(latest.totalDebt)}</p>
        </div>
      </Card>
    </div>
  );
}
