"use client";

/**
 * SinceLastVisitModal
 *
 * Detailed activity window shown when the user clicks the
 * "Since Your Last Visit" panel.
 *
 * v1 scope:
 *   - Time range tab strip (UI present; only "Since Last Visit" has real data)
 *   - Honest "coming soon" state for extended ranges — no fabricated numbers
 *   - Summary cards from existing BriefSection items
 *
 * TODO: wire extended range tabs to a dedicated API endpoint that accepts
 *       a `range` query param and returns net-worth delta, transaction count,
 *       goal updates, and account changes for that window.
 *       Suggested route: GET /api/brief/activity?range=1d|1w|1m|3m|6m|1y
 */

import { useState } from "react";
import { BriefModal } from "./BriefModal";
import type { BriefSection, BriefTone } from "@/lib/brief-types";
import {
  TrendingUp,
  TrendingDown,
  Landmark,
  Target,
  Bell,
  Activity,
  Clock,
} from "lucide-react";

// ── Time range strip ──────────────────────────────────────────────────────────

const RANGES = [
  { id: "current", label: "Since Last Visit", hasData: true  },
  { id: "1h",      label: "Last Hour",        hasData: false },
  { id: "6h",      label: "6 Hours",          hasData: false },
  { id: "1d",      label: "1 Day",            hasData: false },
  { id: "1w",      label: "1 Week",           hasData: false },
  { id: "1m",      label: "1 Month",          hasData: false },
  { id: "3m",      label: "3 Months",         hasData: false },
  { id: "6m",      label: "6 Months",         hasData: false },
  { id: "1y",      label: "1 Year",           hasData: false },
] as const;

type RangeId = typeof RANGES[number]["id"];

// ── Tone helpers ──────────────────────────────────────────────────────────────

const TONE_VALUE: Record<BriefTone, string> = {
  positive: "text-emerald-400",
  warning:  "text-amber-400",
  danger:   "text-red-400",
  info:     "text-blue-400",
  neutral:  "text-white",
};

function ItemIcon({ id }: { id: string }) {
  const cls = "w-4 h-4 text-gray-500 shrink-0";
  if (id.startsWith("nw_up"))       return <TrendingUp  className={cls} />;
  if (id.startsWith("nw_down"))     return <TrendingDown className={cls} />;
  if (id.startsWith("nw"))          return <TrendingUp  className={cls} />;
  if (id.startsWith("account"))     return <Landmark    className={cls} />;
  if (id.startsWith("pending"))     return <Bell        className={cls} />;
  if (id.startsWith("goal"))        return <Target      className={cls} />;
  return <Activity className={cls} />;
}

// ── Components ────────────────────────────────────────────────────────────────

function ComingSoonState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
      <div className="w-10 h-10 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center">
        <Clock className="w-5 h-5 text-gray-600" />
      </div>
      <p className="text-sm font-medium text-gray-400">
        {label} data coming soon
      </p>
      <p className="text-xs text-gray-600 max-w-xs">
        Extended range activity windows will be available in an upcoming update.
        {/* TODO: remove when GET /api/brief/activity?range=... is implemented */}
      </p>
    </div>
  );
}

function SummaryItem({
  id,
  label,
  value,
  detail,
  tone,
}: {
  id: string;
  label: string;
  value?: string;
  detail?: string;
  tone?: BriefTone;
}) {
  const valueCls = TONE_VALUE[tone ?? "neutral"];
  return (
    <div className="flex items-start gap-3 py-3.5 border-b border-white/[0.05] last:border-0">
      <ItemIcon id={id} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-300 leading-snug">{label}</p>
        {detail && (
          <p className="text-xs text-gray-500 mt-0.5">{detail}</p>
        )}
      </div>
      {value && (
        <span className={`text-sm tabular-nums shrink-0 ${valueCls}`}>{value}</span>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface SinceLastVisitModalProps {
  open: boolean;
  onClose: () => void;
  section: BriefSection;
}

export function SinceLastVisitModal({ open, onClose, section }: SinceLastVisitModalProps) {
  const [activeRange, setActiveRange] = useState<RangeId>("current");
  const activeRangeMeta = RANGES.find(r => r.id === activeRange)!;
  const items = section.items ?? [];

  return (
    <BriefModal open={open} onClose={onClose} title="Since Your Last Visit" wide>
      {/* Time range strip */}
      <div className="flex gap-1.5 flex-wrap mb-6">
        {RANGES.map(range => (
          <button
            key={range.id}
            onClick={() => setActiveRange(range.id)}
            className={[
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150",
              activeRange === range.id
                ? "bg-blue-600/80 text-white border border-blue-500/60"
                : "bg-white/[0.05] text-gray-400 border border-white/[0.07] hover:bg-white/[0.09] hover:text-gray-200",
            ].join(" ")}
          >
            {range.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {!activeRangeMeta.hasData ? (
        <ComingSoonState label={activeRangeMeta.label} />
      ) : (
        <>
          {/* Summary section */}
          <div className="mb-2">
            <p className="text-[10px] font-bold tracking-[0.16em] uppercase text-gray-500 mb-1">
              Summary
            </p>
          </div>

          {items.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-gray-500">No activity recorded since your last visit.</p>
            </div>
          ) : (
            <div className="rounded-xl border border-white/[0.06] divide-y-0 overflow-hidden"
              style={{ background: "rgba(255,255,255,0.02)" }}
            >
              {items.map(item => (
                <SummaryItem
                  key={item.id}
                  id={item.id}
                  label={item.label}
                  value={item.value}
                  detail={item.detail}
                  tone={item.tone}
                />
              ))}
            </div>
          )}

          {/* Footer note */}
          <p className="text-xs text-gray-600 mt-5 text-center">
            Showing changes since your last Daily Brief visit.
          </p>
        </>
      )}
    </BriefModal>
  );
}
