import { CSSProperties } from "react";
import { DataCard } from "@/components/atlas/DataCard";

/** Semantic state tone, resolved to Atlas accent / ink tokens below.
 *  Replaces the old raw `valueClassName`/`messageClassName` strings so no raw
 *  Tailwind palette enters this family (Step B1). */
export type StatTone = "none" | "positive" | "negative" | "neutral";

const TONE_COLOR: Record<StatTone, string> = {
  none:     "var(--text-primary)",
  positive: "var(--accent-positive)",
  negative: "var(--accent-negative)",
  neutral:  "var(--text-secondary)",
};

export interface SummaryStatRow {
  id:         string;
  label:      string;
  value:      string;    // pre-formatted currency string
  valueTone?: StatTone;  // semantic state tone (was raw valueClassName)
  subLabel?:  string;    // e.g. "4.99% APR · $320/mo min"
}

interface Props {
  title:        string;
  value:        string;   // pre-formatted headline (compact currency)
  valueTone?:   StatTone;
  message:      string;
  messageTone?: StatTone;
  rows:         SummaryStatRow[];
  lastUpdated?: string;
}

/**
 * Shared layout for the Cash on Hand and Debt summary cards:
 *   TITLE → PRIMARY VALUE → SHORT MESSAGE → account rows → Updated date.
 *
 * Keeping this structure in one place guarantees the two cards stay in
 * lockstep (same spacing, same row layout, same message/date placement)
 * instead of drifting via independent JSX in each card.
 *
 * Atlas Glass: renders through DataCard (Step B1). Colour is expressed as a
 * semantic tone resolved to Atlas accent / ink tokens — no raw Tailwind
 * palette. Geometry, spacing, and typography are unchanged from the legacy
 * Card layout.
 */
export function SummaryStatCard({
  title, value, valueTone = "none",
  message, messageTone = "neutral",
  rows, lastUpdated,
}: Props) {
  const color = (t: StatTone): CSSProperties => ({ color: TONE_COLOR[t] });

  return (
    <DataCard title={title}>
      <p className="text-2xl font-bold mt-1" style={color(valueTone)}>{value}</p>

      <p className="text-xs font-medium mt-1.5" style={color(messageTone)}>{message}</p>

      {rows.length > 0 && (
        <div className="flex flex-col gap-2 mt-3">
          {rows.map((r) => (
            <div key={r.id}>
              <div className="flex items-center justify-between">
                <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>{r.label}</p>
                <p className="text-xs font-semibold tabular-nums shrink-0 ml-2" style={color(r.valueTone ?? "none")}>
                  {r.value}
                </p>
              </div>
              {r.subLabel && (
                <p className="text-[10px] mt-0.5" style={{ color: "var(--text-faint)" }}>{r.subLabel}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {lastUpdated && <p className="text-xs mt-3" style={{ color: "var(--text-faint)" }}>Updated {lastUpdated}</p>}
    </DataCard>
  );
}
