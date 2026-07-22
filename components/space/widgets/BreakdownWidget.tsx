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
 * palette customisation is needed (e.g. debt red-gradient). Falls back to the
 * shared CHART_PALETTE, keyed on item ID, when item.color is omitted.
 *
 * ── Selection (UX-CLOSE-1) ────────────────────────────────────────────────────
 * A chart segment and a ledger row are the same concept: a named portion of a
 * total that has constituents. So this widget exposes the SAME seam a ledger row
 * has — an optional `onSelect` — and nothing more. There is no selection event
 * bus, no shared selection type, no context. The CALLER decides what opens
 * (typically the existing Preview → Browser → Detail panels), exactly as the
 * ledgers already do.
 *
 * Selection is OPT-IN and additive: with no `onSelect` this renders precisely as
 * before, except that segments no longer claim to be clickable (see below).
 *
 * Currently powers:
 *   debt_breakdown_chart   — debt accounts by balance (adapter in SpaceDashboard)
 *
 * Will eventually power:
 *   investment_allocation  — holdings by asset class
 *   spending_categories    — expenses by category
 *   account_distribution   — accounts by type or institution
 *   portfolio_concentration — top positions by weight
 *
 * ── Design contract ──────────────────────────────────────────────────────────
 * Pure presenter. All data extraction, sorting, and colour assignment happen
 * in the SectionRegistry adapters inside SpaceDashboard.tsx.
 */

import { useState } from "react";
import { formatCurrency } from "@/lib/format";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { assignStableColors, DEFAULT_CHART_COLOR } from "@/lib/charts/chart-palette";

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
  /**
   * Makes segments/rows interrogable. When omitted the widget is inert — and
   * importantly does NOT render a pointer cursor, which it previously did on
   * every donut segment while doing nothing on click.
   *
   * The caller receives the whole item (its `id` is the slice key it already
   * chose) and opens whatever surface it owns.
   */
  onSelect?: (item: BreakdownItem) => void;
  /** Currently-selected item id, so the chart can reflect an open detail panel. */
  selectedId?: string | null;
  /**
   * Accessible-name builder for an interactive segment. Defaults to the label.
   * Pass one when the label alone is ambiguous out of context ("Other").
   */
  selectLabel?: (item: BreakdownItem) => string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Internal type with colour guaranteed to be present
type ColoredItem = BreakdownItem & { color: string };

/**
 * Fill in colours for items that omit one.
 *
 * Derived colour comes from `lib/charts/chart-palette`, keyed on each item's
 * stable ID — NOT its array position. Position-keyed colour named a rank rather
 * than a thing: these lists sort value-descending and drop empty entries, so a
 * balance change or a missing category silently recoloured the chart (and made
 * the donut disagree with the treemap/strip modes, which pin class colours).
 *
 * An explicit `item.color` always wins — that is the identity regime, for
 * categories that carry product meaning (asset class, liquidity horizon, debt).
 */
function assignColors(items: BreakdownItem[]): ColoredItem[] {
  const derived = assignStableColors(items.map((i) => i.id));
  return items.map((item, i) => ({ ...item, color: item.color ?? derived[i] }));
}

const defaultFmt = (v: number) =>
  formatCurrency(v, DEFAULT_DISPLAY_CURRENCY);

/**
 * Pluralise the donut's centre noun. A bare `+ "s"` rendered "3 asset classs"
 * on the Wealth card, and would have produced "categorys" the moment a caller
 * passed `itemNoun="category"`. Sibilants take -es, consonant+y takes -ies.
 */
function pluralize(noun: string): string {
  if (/(s|x|z|ch|sh)$/i.test(noun))  return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun))      return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

// ─── Selection plumbing ───────────────────────────────────────────────────────

/** The optional selection seam, passed down to whichever view is rendering. */
interface SelectApi {
  onSelect?:    (item: BreakdownItem) => void;
  selectedId?:  string | null;
  selectLabel?: (item: BreakdownItem) => string;
}

/**
 * A breakdown row that becomes a real `<button>` when — and only when — the
 * caller supplied `onSelect`. Inert callers keep the previous non-interactive
 * markup, so nothing gains a focus stop or a screen-reader control it did not
 * have before.
 *
 * The selected treatment mirrors the ledger idiom already used across the
 * product (`SourcesLedger`, `HoldingsLedger`): a left accent rail on hover and
 * focus, filled in while that row's detail is open.
 */
function BreakdownRow({
  item,
  sel,
  className = "",
  onHoverStart,
  onHoverEnd,
  style,
  children,
}: {
  item:          BreakdownItem;
  sel:           SelectApi;
  className?:    string;
  onHoverStart?: () => void;
  onHoverEnd?:   () => void;
  style?:        React.CSSProperties;
  children:      React.ReactNode;
}) {
  const shared = { onMouseEnter: onHoverStart, onMouseLeave: onHoverEnd, style };

  if (!sel.onSelect) {
    return <div className={className} {...shared}>{children}</div>;
  }

  const selected = sel.selectedId != null && sel.selectedId === item.id;
  return (
    <button
      type="button"
      onClick={() => sel.onSelect?.(item)}
      aria-label={sel.selectLabel ? sel.selectLabel(item) : item.label}
      // Only a meaningful state when the caller actually tracks selection;
      // otherwise this is a plain action button and must not claim a state.
      aria-pressed={sel.selectedId !== undefined ? selected : undefined}
      className={`group relative w-full text-left cursor-pointer transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none ${className}`}
      {...shared}
    >
      <span
        aria-hidden
        className={`absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] transition-opacity ${
          selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }`}
      />
      {children}
    </button>
  );
}

// ─── ListView (standalone, no hover) ─────────────────────────────────────────

function ListView({
  items,
  formatValue,
  total,
  sel,
}: {
  items:       ColoredItem[];
  formatValue: (v: number) => string;
  total:       number;
  sel:         SelectApi;
}) {
  return (
    <div className="space-y-2">
      {items.map((item) => {
        const pct = total > 0 ? ((item.value / total) * 100).toFixed(1) : "0.0";
        return (
          <BreakdownRow key={item.id} item={item} sel={sel} className="flex items-center gap-3 px-1 py-0.5 rounded-lg">
            <span className="w-2 h-2 rounded-full shrink-0 mt-0.5" style={{ backgroundColor: item.color }} />
            <span className="flex-1 min-w-0 block">
              <span className="text-sm truncate block" style={{ color: "var(--text-primary)" }}>{item.label}</span>
              {item.meta  && <span className="text-[10px] block" style={{ color: "var(--text-muted)" }}>{item.meta}</span>}
              {item.meta2 && <span className="text-[10px] block" style={{ color: "var(--text-faint)" }}>{item.meta2}</span>}
            </span>
            <span className="text-right shrink-0 block">
              <span className="text-sm font-medium block" style={{ color: "var(--text-primary)" }}>{formatValue(item.value)}</span>
              <span className="text-[10px] block" style={{ color: "var(--text-faint)" }}>{pct}%</span>
            </span>
          </BreakdownRow>
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
  sel,
}: {
  items:       ColoredItem[];
  formatValue: (v: number) => string;
  total:       number;
  sel:         SelectApi;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-3">
      {items.map((item) => {
        const pct    = total > 0 ? ((item.value / total) * 100).toFixed(1) : "0.0";
        const barPct = ((item.value / max) * 100).toFixed(1);
        return (
          <BreakdownRow key={item.id} item={item} sel={sel} className="block space-y-1 rounded-lg">
            <span className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 block">
                <span className="truncate block" style={{ color: "var(--text-secondary)" }}>{item.label}</span>
                {item.meta && <span style={{ color: "var(--text-faint)" }}>{item.meta}</span>}
              </span>
              <span className="shrink-0" style={{ color: "var(--text-secondary)" }}>
                {formatValue(item.value)}{" "}
                <span style={{ color: "var(--text-faint)" }}>({pct}%)</span>
              </span>
            </span>
            <span className="h-1.5 rounded-full overflow-hidden block" style={{ background: "var(--surface-inset)" }}>
              <span
                className="h-full rounded-full block"
                style={{ width: `${barPct}%`, backgroundColor: item.color }}
              />
            </span>
          </BreakdownRow>
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
  sel,
}: {
  items:       ColoredItem[];
  formatValue: (v: number) => string;
  itemNoun:    string;
  total:       number;
  sel:         SelectApi;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const interactive = sel.onSelect != null;

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
  const totalColor    = items[0]?.color ?? DEFAULT_CHART_COLOR;
  const pluralNoun    = items.length === 1 ? itemNoun : pluralize(itemNoun);

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
              // Was a hardcoded #1f2937 — invisible-to-wrong in a light theme.
              // BarView already uses this token for the same "empty track" role.
              stroke="var(--surface-inset)"
              strokeWidth={DONUT_STROKE}
            />
            {/* Segments. Pointer affordance only; the legend below carries the
                ACCESSIBLE controls (real buttons), so keyboard users reach every
                slice without SVG needing focus semantics of its own. */}
            {segments.map((seg) => {
              const isHov    = hoveredIdx === seg.i;
              const isSel    = sel.selectedId != null && sel.selectedId === seg.id;
              const emphasis = isHov || isSel;
              // Hover wins while it lasts; otherwise an open selection is what
              // the ring should be pointing at.
              const isDimmed = hoveredIdx !== null
                ? !isHov
                : sel.selectedId != null && !isSel;
              return (
                <circle
                  key={seg.id}
                  cx={DONUT_CX} cy={DONUT_CY} r={DONUT_RADIUS}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={emphasis ? DONUT_STROKE + 5 : DONUT_STROKE}
                  strokeDasharray={`${seg.dash} ${seg.gap}`}
                  transform={`rotate(${seg.angle}, ${DONUT_CX}, ${DONUT_CY})`}
                  strokeLinecap="butt"
                  opacity={isDimmed ? 0.3 : 1}
                  // The cursor previously claimed "clickable" on every donut in
                  // the product while nothing happened on click. It is now told
                  // the truth: pointer only where a handler exists.
                  style={{
                    cursor: interactive ? "pointer" : "default",
                    transition: "opacity 0.15s, stroke-width 0.15s",
                  }}
                  onMouseEnter={() => setHoveredIdx(seg.i)}
                  onClick={interactive ? () => sel.onSelect?.(seg) : undefined}
                />
              );
            })}
          </svg>

          {/* Centre label */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-4 text-center">
            {hovered ? (
              <>
                <p className="text-xs leading-tight truncate w-full text-center" style={{ color: "var(--text-secondary)" }}>
                  {hovered.label}
                </p>
                <p className="text-base font-bold leading-tight mt-0.5" style={{ color: hovered.color }}>
                  {formatValue(hovered.value)}
                </p>
                <p className="text-[10px] leading-tight mt-0.5" style={{ color: "var(--text-muted)" }}>
                  {(hovered.pct * 100).toFixed(1)}% of total
                </p>
              </>
            ) : (
              <>
                <p className="text-lg font-bold leading-tight" style={{ color: totalColor }}>
                  {formatValue(total)}
                </p>
                <p className="text-[10px] mt-0.5 leading-tight" style={{ color: "var(--text-muted)" }}>
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
            <BreakdownRow
              key={seg.id}
              item={seg}
              sel={sel}
              className="flex items-center gap-3 rounded-lg px-1 py-0.5 transition-opacity"
              style={{ opacity: isDim ? 0.4 : 1 }}
              onHoverStart={() => setHoveredIdx(seg.i)}
              onHoverEnd={() => setHoveredIdx(null)}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
              <span className="flex-1 min-w-0 block">
                <span className="text-sm truncate block" style={{ color: "var(--text-primary)" }}>{seg.label}</span>
                <span className="flex gap-2 items-center flex-wrap">
                  {seg.meta  && <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{seg.meta}</span>}
                  {seg.meta2 && <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>{seg.meta2}</span>}
                </span>
              </span>
              <span className="text-right shrink-0 block">
                <span className="text-sm font-medium block" style={{ color: seg.color }}>
                  {formatValue(seg.value)}
                </span>
                <span className="text-[10px] block" style={{ color: "var(--text-faint)" }}>{pct}%</span>
              </span>
            </BreakdownRow>
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
  onSelect,
  selectedId,
  selectLabel,
}: BreakdownWidgetProps) {
  const sel: SelectApi = { onSelect, selectedId, selectLabel };
  if (items.length === 0) {
    return (
      <div className="text-center py-5 space-y-1">
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {emptyHeadline ?? "No data to display."}
        </p>
        {emptySubline && (
          <p className="text-xs leading-relaxed max-w-xs mx-auto" style={{ color: "var(--text-faint)" }}>
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
      {viewMode === "bar"  && <BarView  items={colored} formatValue={formatValue} total={total} sel={sel} />}
      {viewMode === "list" && <ListView items={colored} formatValue={formatValue} total={total} sel={sel} />}
      {viewMode === "donut" && (
        <DonutView items={colored} formatValue={formatValue} itemNoun={itemNoun} total={total} sel={sel} />
      )}
      {footer && <div>{footer}</div>}
    </div>
  );
}
