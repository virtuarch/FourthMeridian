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
 *       Suggested route: GET /api/brief/activity?range=1d|1w|1m|1y|ytd
 */

import { useState } from "react";
import { BriefModal } from "./BriefModal";
import { InlineFilter } from "@/components/atlas/InlineFilter";
import {
  TONE_VALUE,
  TONE_ICON,
  CATEGORY_ICON,
  CATEGORY_CHIP_BG,
  categoryFromItemId,
} from "@/components/atlas/tones";
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
  { id: "current", label: "Since Visit", hasData: true  },
  { id: "1d",      label: "Day",         hasData: false },
  { id: "1w",      label: "Week",        hasData: false },
  { id: "1m",      label: "Month",       hasData: false },
  { id: "1y",      label: "Year",        hasData: false },
  { id: "ytd",     label: "YTD",         hasData: false },
] as const;

type RangeId = typeof RANGES[number]["id"];

// ── Icon chip ─────────────────────────────────────────────────────────────────

function ItemIcon({ id, tone }: { id: string; tone?: BriefTone }) {
  const category = categoryFromItemId(id);
  const colorCls = category === "netWorth" ? TONE_ICON[tone ?? "neutral"] : CATEGORY_ICON[category];
  const cls = `w-4 h-4 ${colorCls}`;
  if (id.startsWith("nw_up"))   return <TrendingUp className={cls} />;
  if (id.startsWith("nw_down")) return <TrendingDown className={cls} />;
  if (id.startsWith("nw"))      return <TrendingUp className={cls} />;
  if (category === "cash")      return <Landmark className={cls} />;
  if (category === "pending")   return <Bell className={cls} />;
  if (category === "goal")      return <Target className={cls} />;
  return <Activity className={cls} />;
}

// Semantic icon chip — circular glass-tinted background keyed to the same
// category color used everywhere else on the brief (cash = meridian,
// goal = violet, etc.), so users learn the association once and it holds.
function ItemIconChip({ id, tone }: { id: string; tone?: BriefTone }) {
  const category = categoryFromItemId(id);
  return (
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border ${CATEGORY_CHIP_BG[category]}`}
    >
      <ItemIcon id={id} tone={tone} />
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────────────

function ComingSoonState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
      <div className="w-10 h-10 rounded-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] flex items-center justify-center">
        <Clock className="w-5 h-5 text-[var(--text-muted)]" />
      </div>
      <p className="text-sm font-medium text-[var(--text-secondary)]">
        {label} data coming soon
      </p>
      <p className="text-xs text-[var(--text-muted)] max-w-xs">
        Extended range activity windows will be available in an upcoming update.
        {/* TODO: remove when GET /api/brief/activity?range=... is implemented */}
      </p>
    </div>
  );
}

// Row lives directly on the modal's own glass surface — no card, no
// divider. Vertical rhythm alone (py-3.5 per row) carries the grouping.
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
    <div className="flex items-start gap-3 py-3.5">
      <ItemIconChip id={id} tone={tone} />
      <div className="flex-1 min-w-0 pt-0.5">
        <p className="text-sm text-[var(--text-secondary)] leading-snug">{label}</p>
        {detail && (
          <p className="text-xs text-[var(--text-muted)] mt-0.5">{detail}</p>
        )}
      </div>
      {value && (
        <span className={`text-sm tabular-nums shrink-0 pt-0.5 ${valueCls}`}>{value}</span>
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
    <BriefModal
      open={open}
      onClose={onClose}
      title="Since Your Last Visit"
      wide
      headerRight={
        <InlineFilter
          aria-label="Time range"
          options={RANGES.map(r => ({ id: r.id, label: r.label }))}
          value={activeRange}
          onChange={setActiveRange}
        />
      }
    >
      {/* Content — rows sit directly on the modal's glass, no nested card */}
      {!activeRangeMeta.hasData ? (
        <ComingSoonState label={activeRangeMeta.label} />
      ) : (
        <>
          {items.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-[var(--text-muted)]">No activity recorded since your last visit.</p>
            </div>
          ) : (
            <div className="flex flex-col">
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
          <p className="text-xs text-[var(--text-muted)] mt-8 text-center">
            Showing changes since your last Daily Brief visit.
          </p>
        </>
      )}
    </BriefModal>
  );
}
