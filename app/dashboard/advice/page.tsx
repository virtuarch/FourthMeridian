import { getLatestAdvice } from "@/lib/data/advice";
import { AdviceBanner } from "@/components/dashboard/AdviceBanner";
import { Card, CardTitle } from "@/components/ui/Card";
import { Clock } from "lucide-react";

export default async function AdvicePage() {
  const advice = await getLatestAdvice();
  const adviceHistory = advice ? [advice] : [];

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">AI Advice</h1>
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <Clock size={12} />
          Runs 2× daily
        </div>
      </div>

      <Card>
        <p className="text-sm text-gray-400">
          The advice engine reviews your cash position, debt load, portfolio allocation, crypto exposure, recent snapshots, and current market conditions twice daily on trading days and once daily on weekends. It produces conservative, non-automated suggestions.
        </p>
      </Card>

      {adviceHistory.map((advice) => (
        <div key={advice.id} className="space-y-1">
          <AdviceBanner advice={advice} />
        </div>
      ))}

      <Card className="opacity-50">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-gray-600 animate-pulse" />
          <p className="text-sm text-gray-400">Next advice run: Today at 4:00 PM</p>
        </div>
      </Card>
    </div>
  );
}
