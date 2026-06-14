"use client";
import { useState } from "react";

interface Props {
  cash:         number;
  investments:  number;
  crypto:       number;
  debt:         number;
  /** Manually-entered real assets: property, vehicles, equipment, etc. (AccountType.other) */
  realAssets?:  number;
}

// ── Segment definitions ───────────────────────────────────────────────────────
const SEGMENTS = [
  { key: "cash",        label: "Cash",         color: "#3b82f6" },
  { key: "investments", label: "Investments",  color: "#8b5cf6" },
  { key: "crypto",      label: "Crypto",       color: "#f59e0b" },
  { key: "realAssets",  label: "Real Assets",  color: "#14b8a6" },
  { key: "debt",        label: "Debt",         color: "#ef4444" },
] as const;

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtCompact(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  return `$${n.toFixed(0)}`;
}

function fmtFull(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(n);
}

// ── SVG donut geometry (matches DebtBreakdownCard) ────────────────────────────
const SIZE   = 180;
const CX     = SIZE / 2;
const CY     = SIZE / 2;
const MID_R  = 62;
const STROKE = 22;
const CIRC   = 2 * Math.PI * MID_R;

export function AllocationChart({ cash, investments, crypto, debt, realAssets = 0 }: Props) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Order must match SEGMENTS: cash, investments, crypto, realAssets, debt
  const values = [cash, investments, crypto, realAssets, Math.abs(debt)];
  const total  = values.reduce((s, v) => s + v, 0);

  // Build SVG segments (skip zero values)
  const nonZeroCount = values.filter((v) => v > 0).length;
  const gapDash      = nonZeroCount > 1 ? (1.5 / 360) * CIRC : 0;

  const segments = SEGMENTS.reduce(
    (acc, seg, i) => {
      const val   = values[i];
      const pct   = total > 0 ? val / total : 0;
      const dash  = Math.max(0, pct * CIRC - gapDash);
      const gap   = CIRC - dash;
      const angle = -90 + 360 * acc.cumulative;
      return {
        cumulative: acc.cumulative + pct,
        items: [...acc.items, { ...seg, val, pct, dash, gap, angle, i }],
      };
    },
    { cumulative: 0, items: [] as Array<typeof SEGMENTS[number] & { val: number; pct: number; dash: number; gap: number; angle: number; i: number }> },
  ).items.filter((s) => s.val > 0);

  const hovered  = hoveredIdx !== null ? (segments.find((s) => s.i === hoveredIdx) ?? null) : null;
  const netWorth = (cash + investments + crypto + realAssets) - Math.abs(debt);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-gray-600">
        No accounts connected
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Donut ── */}
      <div className="flex justify-center">
        <div className="relative" style={{ width: SIZE, height: SIZE }}>
          <svg
            width={SIZE}
            height={SIZE}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            {/* Background track */}
            <circle
              cx={CX} cy={CY} r={MID_R}
              fill="none"
              stroke="#1f2937"
              strokeWidth={STROKE}
            />
            {/* Segments */}
            {segments.map((seg) => {
              const isHov    = hoveredIdx === seg.i;
              const isDimmed = hoveredIdx !== null && !isHov;
              return (
                <circle
                  key={seg.key}
                  cx={CX} cy={CY} r={MID_R}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={isHov ? STROKE + 5 : STROKE}
                  strokeDasharray={`${seg.dash} ${seg.gap}`}
                  transform={`rotate(${seg.angle}, ${CX}, ${CY})`}
                  strokeLinecap="butt"
                  opacity={isDimmed ? 0.25 : 1}
                  style={{ cursor: "pointer", transition: "opacity 0.15s, stroke-width 0.15s" }}
                  onMouseEnter={() => setHoveredIdx(seg.i)}
                />
              );
            })}
          </svg>

          {/* Center label */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-4 text-center">
            {hovered ? (
              <>
                <p className="text-[11px] text-gray-400 leading-tight truncate w-full text-center">
                  {hovered.label}
                </p>
                <p className="text-base font-bold leading-tight mt-0.5" style={{ color: hovered.color }}>
                  {hovered.key === "debt" ? `−${fmtCompact(hovered.val)}` : fmtCompact(hovered.val)}
                </p>
                <p className="text-[10px] text-gray-500 leading-tight mt-0.5">
                  {(hovered.pct * 100).toFixed(1)}%
                </p>
              </>
            ) : (
              <>
                <p className="text-[10px] text-gray-500 leading-tight">Net Worth</p>
                <p className="text-base font-bold leading-tight mt-0.5 text-white">
                  {fmtCompact(netWorth)}
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Legend rows ── */}
      <div className="space-y-0.5">
        {segments.map((seg) => {
          const isActive = hoveredIdx === null || hoveredIdx === seg.i;
          return (
            <div
              key={seg.key}
              className="flex items-center gap-3 rounded-xl px-2 py-1.5 transition-opacity"
              style={{ opacity: isActive ? 1 : 0.3, cursor: "default" }}
              onMouseEnter={() => setHoveredIdx(seg.i)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
              <p className="text-sm text-white flex-1">{seg.label}</p>
              <p className="text-[11px] text-gray-500 tabular-nums">
                {(seg.pct * 100).toFixed(1)}%
              </p>
              <p
                className="text-sm font-medium tabular-nums w-16 text-right"
                style={{ color: seg.key === "debt" ? "#f87171" : seg.color }}
              >
                {seg.key === "debt" ? `−${fmtFull(seg.val)}` : fmtFull(seg.val)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
