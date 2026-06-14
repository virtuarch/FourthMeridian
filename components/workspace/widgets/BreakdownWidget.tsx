"use client";

/**
 * BreakdownWidget
 *
 * Generic widget for visualising a set of named values as portions of a whole.
 * Supports three view modes selectable via section.config.viewMode:
 *
 *   "donut"  — SVG ring chart with hover/tap interaction + segment list
 *   "bar"    — horizontal bar chart (simple, functional)
 *   "list"   — plain ranked list with colour indicators
 *
 * Data contract: BreakdownItem[] — caller sorts, caller assigns colours when
 * palette customisation is needed (e.g. debt red-gradient). Falls back to a
 * generic multi-colour DEFAULT_PALETTE when item.color is omitted.
 *
 * Currently powers:
 *   debt_breakdown_chart   — debt accounts by balance (adapter in WorkspaceDashboard)
 *
 * Will eventually power:
 *   investment_allocation  — holdings by asset class
 *   spending_categories    — expenses by category
 *   account_distribution   — accounts by type or institution
 *   portfolio_concentration — top positions by weight
 *
 * ── Design contract ──────────────────────────────────────────────────────────
 * Pure presenter. All data extraction, sorting, and colour assignment happen
 * in the SectionRegistry adapters inside WorkspaceDashboard.tsx.
 */

import { useState } from "react";
import { formatCurrency } from "@/lib/format";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

// ─── Types ────────────────────────────────────────────────────────────────────

/** One slice / row of the breakdown. Caller controls sort order. */
export interface BreakdownItem {
  id:    string;
  label: string;
  value: number;
  /**
   * Pre-assigned hex or rgb colour string.
   * If omitted the widget assigns from DEFAULT_PALETTE.
   */
  color?: string;
  /** Subtitle in segment rows (e.g. institution name). */
  meta?:  string;
  /** Secondary subtitle (e.g. "19.99% APR · $50/mo min"). */
  meta2?: string;
}

export type BreakdownViewMode = "donut" | "bar" | "list";

export interface BreakdownWidgetProps {
  /** Items to display. Caller controls sort order (typically value descending). */
  items: BreakdownItem[];
  /** View mode read from section.config.viewMode. Default: "donut". */
  viewMode?: BreakdownViewMode;
  /**
   * Value formatter used throughout the widget.
   * Default: USD currency with no cents.
   */
  formatValue?: (value: number) => string;
  /**
   * Singular noun describing each item, shown in the donut centre label.
   * E.g. "account", "position", "category". Default: "item".
   */
  itemNoun?: string;
  /**
   * Optional content rendered below the main chart / list.
   * Use for aggregate summaries (e.g. "Total minimum payments: $X/mo").
   */
  footer?: React.ReactNode;
  /** Empty state copy */
  emptyHeadline?: string;
  emptySubline?:  string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Internal type with colour guaranteed to be present
type ColoredItem = BreakdownItem & { color: string };

/**
 * Visually distinct palette used when items omit an explicit colour.
 * Values are Tailwind 500 hex equivalents — safe for SVG + inline styles.
 */
const DEFAULT_PALETTE: string[] = [
  "#3b82f6", // blue-500
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
  "#06b6d4", // cyan-500
  "#f97316", // orange-500
  "#84cc16", // lime-500
];

function assignColors(items: BreakdownItem[]): ColoredItem[] {
  return items.map((item, i) => ({
    ...item,
    color: item.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
  }));
}

const defaultFmt = (v: number) =>
  formatCurrency(v, DEFAULT_DISPLAY_CURRENCY);

// ─── ListView (standalone, no hover) ─────────────────────────────────────────

function ListView({
  items,
  formatValue,
  total,
}: {
  items:       ColoredItem[];
  formatValue: (v: number) => string;
  total:       number;
}) {
  return (
    <div className="space-y-2">
      {items.map((item) => {
        const pct = total > 0 ? ((item.value / total) * 100).toFixed(1) : "0.0";
        return (
          <div key={item.id} className="flex items-center gap-3 px-1 py-0.5">
            <div className="w-2 h-2 rounded-full shrink-0 mt-0.5" style={{ backgroundColor: item.color }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white truncate">{item.label}</p>
              {item.meta  && <p className="text-[10px] text-gray-500">{item.meta}</p>}
              {item.meta2 && <p className="text-[10px] text-gray-600">{item.meta2}</p>}
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-medium text-white">{formatValue(item.value)}</p>
              <p className="text-[10px] text-gray-600">{pct}%</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── BarView ──────────────────────────────────────────────────────────────────

function BarView({
  items,
  formatValue,
  total,
}: {
  items:       ColoredItem[];
  formatValue: (v: number) => string;
  total:       number;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-3">
      {items.map((item) => {
        const pct    = total > 0 ? ((item.value / total) * 100).toFixed(1) : "0.0";
        const barPct = ((item.value / max) * 100).toFixed(1);
        return (
          <div key={item.id} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <span className="text-gray-300 truncate block">{item.label}</span>
                {item.meta && <span className="text-gray-600">{item.meta}</span>}
              </div>
              <span className="shrink-0 text-gray-400">
                {formatValue(item.value)}{" "}
                <span className="text-gray-700">({pct}%)</span>
              </span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${barPct}%`, backgroundColor: item.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── DonutView ────────────────────────────────────────────────────────────────

const DONUT_SIZE   = 180;
const DONUT_CX     = DONUT_SIZE / 2;
const DONUT_CY     = DONUT_SIZE / 2;
const DONUT_RADIUS = 62;
const DONUT_STROKE = 22;
const DONUT_CIRC   = 2 * Math.PI * DONUT_RADIUS;

function DonutView({
  items,
  formatValue,
  itemNoun,
  total,
}: {
  items:       ColoredItem[];
  formatValue: (v: number) => string;
  itemNoun:    string;
  total:       number;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Gap between segments; no gap for a single item
  const gapDash = items.length > 1 ? (1.5 / 360) * DONUT_CIRC : 0;

  // Build segments with cumulative start angles
  const segments = items.reduce(
    (acc, item, i) => {
      const pct   = total > 0 ? item.value / total : 1 / items.length;
      const dash  = Math.max(0, pct * DONUT_CIRC - gapDash);
      const gap   = DONUT_CIRC - dash;
      const angle = -90 + 360 * acc.cumulative;
      return {
        cumulative: acc.cumulative + pct,
        segs: [
          ...acc.segs,
          { ...item, pct, dash, gap, angle, i },
        ],
      };
    },
    {
      cumulative: 0,
      segs: [] as Array<ColoredItem & { pct: number; dash: number; gap: number; angle: number; i: number }>,
    },
  ).segs;

  const hovered       = hoveredIdx !== null ? segments[hoveredIdx] : null;
  // Centre label uses first item colour when showing totals (matches original red-gradient behaviour)
  const totalColor    = items[0]?.color ?? DEFAULT_PALETTE[0];
  const pluralNoun    = items.length === 1 ? itemNoun : `${itemNoun}s`;

  return (
    <div className="space-y-4">
      {/* ── Ring chart ─────────────────────────────────────────────────── */}
      <div className="flex justify-center">
        <div className="relative" style={{ width: DONUT_SIZE, height: DONUT_SIZE }}>
          <svg
            width={DONUT_SIZE}
            height={DONUT_SIZE}
            viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            {/* Background track */}
            <circle
              cx={DONUT_CX} cy={DONUT_CY} r={DONUT_RADIUS}
              fill="none"
              stroke="#1f2937"
              strokeWidth={DONUT_STROKE}
            />
            {/* Segments */}
            {segments.map((seg) => {
              const isHov    = hoveredIdx === seg.i;
              const isDimmed = hoveredIdx !== null && !isHov;
              return (
                <circle
                  key={seg.id}
                  cx={DONUT_CX} cy={DONUT_CY} r={DONUT_RADIUS}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={isHov ? DONUT_STROKE + 5 : DONUT_STROKE}
                  strokeDasharray={`${seg.dash} ${seg.gap}`}
                  transform={`rotate(${seg.angle}, ${DONUT_CX}, ${DONUT_CY})`}
                  strokeLinecap="butt"
                  opacity={isDimmed ? 0.3 : 1}
                  style={{ cursor: "pointer", transition: "opacity 0.15s, stroke-width 0.15s" }}
                  onMouseEnter={() => setHoveredIdx(seg.i)}
                />
              );
            })}
          </svg>

          {/* Centre label */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-4 text-center">
            {hovered ? (
              <>
                <p className="text-xs text-gray-400 leading-tight truncate w-full text-center">
                  {hovered.label}
                </p>
                <p className="text-base font-bold leading-tight mt-0.5" style={{ color: hovered.color }}>
                  {formatValue(hovered.value)}
                </p>
                <p className="text-[10px] text-gray-500 leading-tight mt-0.5">
                  {(hovered.pct * 100).toFixed(1)}% of total
                </p>
              </>
            ) : (
              <>
                <p className="text-lg font-bold leading-tight" style={{ color: totalColor }}>
                  {formatValue(total)}
                </p>
                <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">
                  {items.length} {pluralNoun}
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Hover-synced segment list ───────────────────────────────────── */}
      <div className="space-y-2">
        {segments.map((seg) => {
          const isHov = hoveredIdx === seg.i;
          const isDim = hoveredIdx !== null && !isHov;
          const pct   = (seg.pct * 100).toFixed(1);
          return (
            <div
              key={seg.id}
              className="flex items-center gap-3 rounded-lg px-1 py-0.5 transition-opacity"
              style={{ opacity: isDim ? 0.4 : 1, cursor: "default" }}
              onMouseEnter={() => setHoveredIdx(seg.i)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{seg.label}</p>
                <div className="flex gap-2 items-center flex-wrap">
                  {seg.meta  && <span className="text-[10px] text-gray-500">{seg.meta}</span>}
                  {seg.meta2 && <span className="text-[10px] text-gray-600">{seg.meta2}</span>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-medium" style={{ color: seg.color }}>
                  {formatValue(seg.value)}
                </p>
                <p className="text-[10px] text-gray-600">{pct}%</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function BreakdownWidget({
  items,
  viewMode     = "donut",
  formatValue  = defaultFmt,
  itemNoun     = "item",
  footer,
  emptyHeadline,
  emptySubline,
}: BreakdownWidgetProps) {
  if (items.length === 0) {
    return (
      <div className="text-center py-5 space-y-1">
        <p className="text-sm text-gray-400">
          {emptyHeadline ?? "No data to display."}
        </p>
        {emptySubline && (
          <p className="text-xs text-gray-600 leading-relaxed max-w-xs mx-auto">
            {emptySubline}
          </p>
        )}
      </div>
    );
  }

  const colored = assignColors(items);
  const total   = colored.reduce((s, i) => s + i.value, 0);

  return (
    <div className="space-y-4">
      {viewMode === "bar"  && <BarView  items={colored} formatValue={formatValue} total={total} />}
      {viewMode === "list" && <ListView items={colored} formatValue={formatValue} total={total} />}
      {viewMode === "donut" && (
        <DonutView items={colored} formatValue={formatValue} itemNoun={itemNoun} total={total} />
      )}
      {footer && <div>{footer}</div>}
    </div>
  );
}
