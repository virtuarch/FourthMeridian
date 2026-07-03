import { getRecentSnapshots } from "@/lib/data/snapshots";
import { formatDate } from "@/lib/format";
import { NetWorthChart } from "@/components/charts/NetWorthChart";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

export default async function HistoryPage() {
  const snapshots = await getRecentSnapshots(30);

  if (snapshots.length === 0) {
    return (
      <div className="space-y-4 pb-4">
        <h1 className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>History</h1>
        <DataCard>
          <DataCardTitle>Net Worth — 30 Days</DataCardTitle>
          <p className="text-sm mt-2" style={{ color: "var(--text-muted)" }}>
            No history yet. Click Refresh to generate today&apos;s snapshot.
          </p>
        </DataCard>
      </div>
    );
  }

  const latest = snapshots[snapshots.length - 1];
  const oldest = snapshots[0];
  const change = latest.netWorth - oldest.netWorth;
  const pct = ((change / oldest.netWorth) * 100).toFixed(1);

  return (
    <div className="space-y-4 pb-4">
      <h1 className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>History</h1>

      <DataCard>
        <DataCardTitle>Net Worth — 30 Days</DataCardTitle>
        <div className="flex items-baseline gap-2 mt-1 mb-3">
          <p className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>{fmt(latest.netWorth)}</p>
          <span className="text-sm font-semibold" style={{ color: change >= 0 ? "var(--accent-positive)" : "var(--accent-negative)" }}>
            {change >= 0 ? "+" : ""}{fmt(change)} ({pct}%)
          </span>
        </div>
        <NetWorthChart snapshots={snapshots} interval="1M" onIntervalChange={() => {}} />
      </DataCard>

      <DataCard>
        <DataCardTitle>Snapshot History</DataCardTitle>
        <div className="mt-2 divide-y divide-[var(--border-hairline)]">
          {[...snapshots].reverse().slice(0, 10).map((s) => (
            <div key={s.date} className="flex items-center justify-between py-2.5">
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{formatDate(s.date)}</p>
              <div className="text-right">
                <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fmt(s.netWorth)}</p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>Cash: {fmt(s.totalCash)}</p>
              </div>
            </div>
          ))}
        </div>
      </DataCard>

      <DataCard>
        <DataCardTitle>Debt Tracker</DataCardTitle>
        <div className="mt-2">
          <div className="flex justify-between text-sm mb-2">
            <span style={{ color: "var(--text-secondary)" }}>Current Debt</span>
            <span className="font-semibold" style={{ color: "var(--accent-negative)" }}>-{fmt(latest.totalDebt)}</span>
          </div>
          <div className="w-full rounded-full h-3" style={{ background: "var(--surface-inset)" }}>
            <div
              className="h-3 rounded-full bg-gradient-to-r from-red-500 to-orange-400"
              style={{ width: `${Math.min((latest.totalDebt / 30000) * 100, 100)}%` }}
            />
          </div>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Target: $0 · Remaining: {fmt(latest.totalDebt)}</p>
        </div>
      </DataCard>
    </div>
  );
}
