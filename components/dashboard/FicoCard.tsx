import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import { ShieldCheck, PlusCircle } from "lucide-react";

interface Props {
  score:       number | null;
  lastUpdated: string;
  /**
   * The empty state's "Add credit score" is a BUTTON that calls this: the
   * host (Net Worth → Debt's CreditScoreInput) edits the score in place.
   * RETIRE-CREDIT (2026-10-22): the legacy /dashboard/credit page this card
   * used to link to is deleted, so there is no link fallback any more.
   */
  onAdd?:      () => void;
}

// FICO bands collapse to a restrained 3-step tone (Step B accent decision):
// excellent → positive, poor → negative, good/fair → neutral ink. The number
// and the band label ("Good"/"Fair") carry the middle distinction; colour is
// reserved for the genuine top/bottom states.
type FicoTone = "positive" | "negative" | "neutral";

const TONE: Record<FicoTone, string> = {
  positive: "var(--accent-positive)",
  negative: "var(--accent-negative)",
  neutral:  "var(--text-secondary)",
};

function getScoreBand(score: number): { tone: FicoTone; label: string } {
  if (score >= 740) return { tone: "positive", label: "Excellent" };
  if (score >= 670) return { tone: "neutral",  label: "Good" };
  if (score >= 580) return { tone: "neutral",  label: "Fair" };
  return                { tone: "negative", label: "Poor" };
}

export function FicoCard({ score, lastUpdated, onAdd }: Props) {
  // ── Empty state ───────────────────────────────────────────────────────────
  if (score === null) {
    return (
      <DataCard>
        <div className="flex items-center justify-between">
          <DataCardTitle>FICO Score</DataCardTitle>
          <ShieldCheck size={14} style={{ color: "var(--text-faint)" }} />
        </div>
        <div className="mt-3 flex flex-col items-center text-center gap-2 py-2">
          <PlusCircle size={28} style={{ color: "var(--text-faint)" }} />
          <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>No credit score on file</p>
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-faint)" }}>
            Add your score to start tracking credit history and unlock personalized advice.
          </p>
          {onAdd && (
            <button
              type="button"
              onClick={onAdd}
              className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold transition-colors"
              style={{ color: "var(--accent-info)" }}
            >
              <PlusCircle size={13} />
              Add credit score
            </button>
          )}
        </div>
      </DataCard>
    );
  }

  // ── Score display ─────────────────────────────────────────────────────────
  const { tone, label } = getScoreBand(score);
  const pct = ((score - 300) / (850 - 300)) * 100;

  return (
    <DataCard>
      <div className="flex items-center justify-between">
        <DataCardTitle>FICO Score</DataCardTitle>
        <ShieldCheck size={14} style={{ color: "var(--text-muted)" }} />
      </div>
      <div className="flex items-end gap-2 mt-1">
        <p className="text-4xl font-bold" style={{ color: TONE[tone] }}>{score}</p>
        <p className="text-sm font-semibold mb-1" style={{ color: TONE[tone] }}>{label}</p>
      </div>
      <div className="w-full rounded-full h-2 mt-3" style={{ background: "var(--surface-inset)" }}>
        <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: TONE[tone] }} />
      </div>
      <div className="flex justify-between mt-1">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>300</p>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>850</p>
      </div>
      <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>Updated {lastUpdated}</p>
    </DataCard>
  );
}
