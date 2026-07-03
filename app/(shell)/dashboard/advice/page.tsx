import { getLatestAdvice } from "@/lib/data/advice";
import { AdviceBanner } from "@/components/dashboard/AdviceBanner";
import { DataCard } from "@/components/atlas/DataCard";
import { Clock } from "lucide-react";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default async function AdvicePage() {
  const advice = await getLatestAdvice();
  const adviceHistory = advice ? [advice] : [];

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>AI Advice</h1>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
          <Clock size={12} />
          Runs 2× daily
        </div>
      </div>

      <DataCard>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          The advice engine reviews your cash position, debt load, portfolio allocation, crypto exposure, recent snapshots, and current market conditions twice daily on trading days and once daily on weekends. It produces conservative, non-automated suggestions.
        </p>
      </DataCard>

      {adviceHistory.map((advice) => (
        <div key={advice.id} className="space-y-1">
          <AdviceBanner advice={advice} />
        </div>
      ))}

      <DataCard className="opacity-50">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--text-faint)" }} />
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Next advice run: Today at 4:00 PM</p>
        </div>
      </DataCard>
    </div>
  );
}
