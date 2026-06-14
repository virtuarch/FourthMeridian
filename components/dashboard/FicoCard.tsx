import { Card, CardTitle } from "@/components/ui/Card";
import { ShieldCheck, PlusCircle } from "lucide-react";

interface Props {
  score:       number | null;
  lastUpdated: string;
  compact?:    boolean;
}

function getScoreColor(score: number) {
  if (score >= 740) return { text: "text-emerald-400", bar: "bg-emerald-400", label: "Excellent" };
  if (score >= 670) return { text: "text-blue-400",    bar: "bg-blue-400",    label: "Good" };
  if (score >= 580) return { text: "text-yellow-400",  bar: "bg-yellow-400",  label: "Fair" };
  return             { text: "text-red-400",            bar: "bg-red-400",     label: "Poor" };
}

export function FicoCard({ score, lastUpdated, compact }: Props) {
  // ── Empty state ───────────────────────────────────────────────────────────
  if (score === null) {
    if (compact) {
      return (
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>FICO</CardTitle>
            <ShieldCheck size={12} className="text-gray-600" />
          </div>
          <div className="mt-2 flex flex-col items-center text-center gap-1.5">
            <PlusCircle size={20} className="text-gray-600" />
            <p className="text-xs text-gray-500 leading-snug">No score on file</p>
            <a
              href="/dashboard/credit"
              className="text-[11px] font-semibold text-blue-400 hover:text-blue-300 transition-colors"
            >
              Add score
            </a>
          </div>
        </Card>
      );
    }

    return (
      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>FICO Score</CardTitle>
          <ShieldCheck size={14} className="text-gray-600" />
        </div>
        <div className="mt-3 flex flex-col items-center text-center gap-2 py-2">
          <PlusCircle size={28} className="text-gray-600" />
          <p className="text-sm text-gray-400 font-medium">No credit score on file</p>
          <p className="text-xs text-gray-600 leading-relaxed">
            Add your score to start tracking credit history and unlock personalized advice.
          </p>
          <a
            href="/dashboard/credit"
            className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors"
          >
            <PlusCircle size={13} />
            Add credit score
          </a>
        </div>
      </Card>
    );
  }

  // ── Score display ─────────────────────────────────────────────────────────
  const { text, bar, label } = getScoreColor(score);
  const pct = ((score - 300) / (850 - 300)) * 100;

  // ── Compact variant ───────────────────────────────────────────────────────
  if (compact) {
    return (
      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>FICO</CardTitle>
          <ShieldCheck size={12} className="text-gray-500" />
        </div>
        <div className="flex items-baseline gap-1.5 mt-1">
          <p className={`text-2xl font-bold ${text}`}>{score}</p>
          <p className={`text-[11px] font-semibold ${text}`}>{label}</p>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-1.5 mt-2">
          <div className={`h-1.5 rounded-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between mt-0.5">
          <p className="text-[10px] text-gray-600">300</p>
          <p className="text-[10px] text-gray-600">850</p>
        </div>
        <p className="text-[10px] text-gray-600 mt-1.5">Updated {lastUpdated}</p>
      </Card>
    );
  }

  // ── Full variant ──────────────────────────────────────────────────────────
  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>FICO Score</CardTitle>
        <ShieldCheck size={14} className="text-gray-500" />
      </div>
      <div className="flex items-end gap-2 mt-1">
        <p className={`text-4xl font-bold ${text}`}>{score}</p>
        <p className={`text-sm font-semibold mb-1 ${text}`}>{label}</p>
      </div>
      <div className="w-full bg-gray-700 rounded-full h-2 mt-3">
        <div className={`h-2 rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between mt-1">
        <p className="text-xs text-gray-500">300</p>
        <p className="text-xs text-gray-500">850</p>
      </div>
      <p className="text-xs text-gray-500 mt-2">Updated {lastUpdated}</p>
    </Card>
  );
}
