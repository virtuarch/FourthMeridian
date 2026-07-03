import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import { ShieldCheck, PlusCircle } from "lucide-react";

interface Props {
  score:       number | null;
  lastUpdated: string;
  compact?:    boolean;
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

export function FicoCard({ score, lastUpdated, compact }: Props) {
  // ── Empty state ───────────────────────────────────────────────────────────
  if (score === null) {
    if (compact) {
      return (
        <DataCard>
          <div className="flex items-center justify-between">
            <DataCardTitle>FICO</DataCardTitle>
            <ShieldCheck size={12} style={{ color: "var(--text-faint)" }} />
          </div>
          <div className="mt-2 flex flex-col items-center text-center gap-1.5">
            <PlusCircle size={20} style={{ color: "var(--text-faint)" }} />
            <p className="text-xs leading-snug" style={{ color: "var(--text-muted)" }}>No score on file</p>
            <a
              href="/dashboard/credit"
              className="text-[11px] font-semibold transition-colors"
              style={{ color: "var(--accent-info)" }}
            >
              Add score
            </a>
          </div>
        </DataCard>
      );
    }

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
          <a
            href="/dashboard/credit"
            className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold transition-colors"
            style={{ color: "var(--accent-info)" }}
          >
            <PlusCircle size={13} />
            Add credit score
          </a>
        </div>
      </DataCard>
    );
  }

  // ── Score display ─────────────────────────────────────────────────────────
  const { tone, label } = getScoreBand(score);
  const pct = ((score - 300) / (850 - 300)) * 100;

  // ── Compact variant ───────────────────────────────────────────────────────
  if (compact) {
    return (
      <DataCard>
        <div className="flex items-center justify-between">
          <DataCardTitle>FICO</DataCardTitle>
          <ShieldCheck size={12} style={{ color: "var(--text-muted)" }} />
        </div>
        <div className="flex items-baseline gap-1.5 mt-1">
          <p className="text-2xl font-bold" style={{ color: TONE[tone] }}>{score}</p>
          <p className="text-[11px] font-semibold" style={{ color: TONE[tone] }}>{label}</p>
        </div>
        <div className="w-full rounded-full h-1.5 mt-2" style={{ background: "var(--surface-inset)" }}>
          <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: TONE[tone] }} />
        </div>
        <div className="flex justify-between mt-0.5">
          <p className="text-[10px]" style={{ color: "var(--text-faint)" }}>300</p>
          <p className="text-[10px]" style={{ color: "var(--text-faint)" }}>850</p>
        </div>
        <p className="text-[10px] mt-1.5" style={{ color: "var(--text-faint)" }}>Updated {lastUpdated}</p>
      </DataCard>
    );
  }

  // ── Full variant ──────────────────────────────────────────────────────────
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
