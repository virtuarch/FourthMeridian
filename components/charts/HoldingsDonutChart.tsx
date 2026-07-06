"use client";
import { useRef, useState } from "react";
import { X, Eye, EyeOff, LayoutGrid, Activity } from "lucide-react";
import { Holding, Account } from "@/types";
import { exchangeSymbol } from "@/lib/exchangeSymbol";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

interface Props {
  holdings:       Holding[];
  cryptoAccounts: Account[];
  accountTotal:   number;
}

// ── Colors ────────────────────────────────────────────────────────────────────
const COLORS = [
  "#8b5cf6","#3b82f6","#10b981","#f97316","#ec4899",
  "#14b8a6","#6366f1","#84cc16","#f59e0b","#06b6d4",
  "#a855f7","#22c55e",
];

function colorFor(symbol: string, index: number) {
  if (symbol === "CASH")  return "#3b82f6";
  if (symbol === "Other") return "#4b5563";
  return COLORS[index % COLORS.length];
}

// ── Treemap layout (slice-and-dice) ──────────────────────────────────────────
interface Rect { x: number; y: number; w: number; h: number; }

function buildTreemap(items: Seg[], x: number, y: number, w: number, h: number): (Seg & Rect)[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ ...items[0], x, y, w, h }];
  const total = items.reduce((s, i) => s + i.value, 0);
  let acc = 0;
  let splitIdx = 0;
  const half = total / 2;
  for (let i = 0; i < items.length - 1; i++) {
    acc += items[i].value;
    splitIdx = i;
    if (acc >= half) break;
  }
  const g1    = items.slice(0, splitIdx + 1);
  const g2    = items.slice(splitIdx + 1);
  const ratio = g1.reduce((s, i) => s + i.value, 0) / total;
  if (w >= h) {
    const w1 = w * ratio;
    return [...buildTreemap(g1, x, y, w1, h), ...buildTreemap(g2, x + w1, y, w - w1, h)];
  } else {
    const h1 = h * ratio;
    return [...buildTreemap(g1, x, y, w, h1), ...buildTreemap(g2, x, y + h1, w, h - h1)];
  }
}

// ── Heat map colors (Yahoo Finance style) ─────────────────────────────────────
function heatBg(change: number): string {
  if (change >=  5)  return "#166534";
  if (change >=  3)  return "#15803d";
  if (change >=  1.5)return "#16a34a";
  if (change >=  0.5)return "#22c55e";
  if (change >   0)  return "#4ade80";
  if (change === 0)  return "#374151";
  if (change >  -0.5)return "#f87171";
  if (change >  -1.5)return "#ef4444";
  if (change >  -3)  return "#dc2626";
  if (change >  -5)  return "#b91c1c";
  return                    "#991b1b";
}
function heatFg(change: number): string {
  // Light-colored tiles need dark text
  if (change > 0 && change < 0.5) return "#14532d";
  if (change < 0 && change > -0.5) return "#7f1d1d";
  return "#ffffff";
}

// ── Formatters ────────────────────────────────────────────────────────────────
// MC1 P4 Slice 5 — aggregate labels (totals/center) take the display
// currency via the wrapper below; NOTE: segment values are native holding
// values, so mixed-currency allocation proportions remain approximate until
// per-position conversion is designed (recorded at the Phase 4 closeout).
const fmtFull = (n: number, cur: string = DEFAULT_DISPLAY_CURRENCY) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n);
const fmtCompact = (n: number, cur: string = DEFAULT_DISPLAY_CURRENCY) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, notation: "compact", maximumFractionDigits: 1 }).format(n);
function fmtQty(q: number) {
  if (q === 0) return "—";
  return q % 1 === 0 ? q.toFixed(0) : q < 0.01 ? q.toFixed(6) : q.toFixed(4);
}

// ── Segment type ──────────────────────────────────────────────────────────────
interface Seg { symbol: string; name: string; value: number; quantity: number; change24h: number; }

type PopupTab = "grid" | "heatmap";

// ── Popup panel ───────────────────────────────────────────────────────────────
function HoldingsPopup({ sorted, total, onClose }: { sorted: Seg[]; total: number; onClose: () => void; }) {
  const [tab,       setTab]       = useState<PopupTab>("grid");
  const [showSmall, setShowSmall] = useState(false);

  const small = sorted.filter((d) => d.value < 50);
  const list  = showSmall ? sorted : sorted.filter((d) => d.value >= 50);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-gray-900 border-t border-gray-700 w-full flex flex-col flex-1 mt-16 rounded-t-3xl shadow-2xl overflow-hidden">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-gray-800 shrink-0">
          <div>
            <p className="text-sm font-bold text-white">Holdings</p>
            <p className="text-xs text-gray-500 mt-0.5">{sorted.length} positions · {fmtCompact(total)}</p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors touch-manipulation"
          >
            <X size={14} />
          </button>
        </div>

        {/* ── Tab + filter row ── */}
        <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5 shrink-0">
          {/* Tab switcher */}
          <div className="flex gap-1 bg-gray-800/60 rounded-xl p-1">
            <button
              onClick={() => setTab("grid")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors touch-manipulation ${
                tab === "grid" ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              <LayoutGrid size={11} /> Grid
            </button>
            <button
              onClick={() => setTab("heatmap")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors touch-manipulation ${
                tab === "heatmap" ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              <Activity size={11} /> Heat Map
            </button>
          </div>

          {/* Show all toggle */}
          {small.length > 0 && (
            <button
              onClick={() => setShowSmall((v) => !v)}
              className="flex items-center gap-1 py-1.5 px-2.5 rounded-lg bg-gray-800/60 border border-gray-700/40 hover:bg-gray-800 transition-colors touch-manipulation"
            >
              {showSmall
                ? <><EyeOff size={10} className="text-gray-500" /><span className="text-[10px] font-semibold text-gray-400">Hide &lt;$50</span></>
                : <><Eye    size={10} className="text-gray-500" /><span className="text-[10px] font-semibold text-gray-400">Show all</span></>
              }
            </button>
          )}
        </div>

        {/* ── Grid view ── */}
        {tab === "grid" && (
          <div className="overflow-y-auto flex-1 px-2 pb-4">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
              {list.map((d) => {
                const idx   = sorted.indexOf(d);
                const color = colorFor(d.symbol, idx);
                const pct   = total > 0 ? (d.value / total) * 100 : 0;
                return (
                  <div
                    key={d.symbol}
                    style={{ minWidth: 0, background: "#1f2937", border: "1px solid #374151", borderRadius: 14, padding: "10px 10px 8px 10px" }}
                  >
                    {/* dot + symbol */}
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#ffffff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.symbol}</span>
                    </div>
                    {/* value */}
                    <p style={{ fontSize: 14, fontWeight: 700, color: "#ffffff", fontVariantNumeric: "tabular-nums", lineHeight: 1.2 }}>{fmtCompact(d.value)}</p>
                    {/* qty + pct */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 5 }}>
                      <span style={{ fontSize: 9, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "55%" }}>{fmtQty(d.quantity)}</span>
                      <span style={{ fontSize: 9, color: "#6b7280", flexShrink: 0 }}>{pct.toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Heat map view ── */}
        {tab === "heatmap" && (
          <div className="flex-1 px-2 pb-3 pt-1 flex flex-col">
            {/* Legend strip */}
            <div className="flex items-center justify-center gap-1.5 mb-2 shrink-0">
              {[
                { label: "< −3%", bg: "#b91c1c" },
                { label: "−1%",   bg: "#ef4444" },
                { label: "flat",  bg: "#374151" },
                { label: "+1%",   bg: "#22c55e" },
                { label: "> +3%", bg: "#166534" },
              ].map(({ label, bg }) => (
                <div key={label} className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: bg }} />
                  <span className="text-[9px] text-gray-600">{label}</span>
                </div>
              ))}
            </div>

            {/* Treemap */}
            <div className="relative flex-1" style={{ minHeight: 0 }}>
              {(() => {
                const tiles = buildTreemap(list, 0, 0, 100, 100);
                return tiles.map((tile) => {
                  const bg   = heatBg(tile.change24h);
                  const fg   = heatFg(tile.change24h);
                  const sign = tile.change24h > 0 ? "+" : "";
                  const isSmall = tile.w < 18 || tile.h < 14;
                  return (
                    <div
                      key={tile.symbol}
                      style={{
                        position: "absolute",
                        left:   `${tile.x}%`,
                        top:    `${tile.y}%`,
                        width:  `${tile.w}%`,
                        height: `${tile.h}%`,
                        background: bg,
                        padding: "1px",
                        boxSizing: "border-box",
                      }}
                    >
                      <div
                        style={{
                          width: "100%", height: "100%",
                          display: "flex", flexDirection: "column",
                          justifyContent: "center", alignItems: "center",
                          overflow: "hidden", borderRadius: 6,
                          background: bg,
                        }}
                      >
                        {!isSmall && (
                          <>
                            <p style={{ color: fg, fontSize: tile.w > 25 ? 13 : 10, fontWeight: 700, lineHeight: 1.1, textAlign: "center" }}>
                              {tile.symbol}
                            </p>
                            <p style={{ color: fg, fontSize: tile.w > 25 ? 12 : 9, fontWeight: 600, lineHeight: 1.2, opacity: 0.9 }}>
                              {sign}{tile.change24h.toFixed(2)}%
                            </p>
                            {tile.w > 20 && tile.h > 20 && (
                              <p style={{ color: fg, fontSize: 8, opacity: 0.65, lineHeight: 1.2 }}>
                                {fmtCompact(tile.value)}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main chart component ──────────────────────────────────────────────────────
export function HoldingsDonutChart({ holdings, cryptoAccounts, accountTotal }: Props) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [lockedIndex,  setLockedIndex]  = useState<number | null>(null);
  const [popupOpen,    setPopupOpen]    = useState(false);
  const sliceClickedRef = useRef(false);

  const activeIndex = lockedIndex ?? hoveredIndex;

  // ── Build segments ──────────────────────────────────────────────────────────
  const combinedCash = holdings.filter((h) => h.isCash).reduce((s, h) => s + h.value, 0);

  const raw: Seg[] = [
    ...holdings.filter((h) => !h.isCash).map((h) => ({
      symbol: h.symbol, name: h.name, value: h.value, quantity: h.quantity, change24h: h.change24h,
    })),
    ...cryptoAccounts.map((a) => ({
      symbol:   a.walletChain ?? exchangeSymbol(a.institution),
      name:     a.name,
      value:    a.balance,
      quantity: a.nativeBalance ?? 0,
      change24h: 0,
    })),
    ...(combinedCash > 0
      ? [{ symbol: "CASH", name: "Uninvested Cash", value: combinedCash, quantity: combinedCash, change24h: 0 }]
      : []),
  ];

  const mergedMap = new Map<string, Seg>();
  for (const seg of raw) {
    if (mergedMap.has(seg.symbol)) {
      const e = mergedMap.get(seg.symbol)!;
      // Weighted average for change24h
      const totalVal = e.value + seg.value;
      e.change24h = totalVal > 0 ? (e.change24h * e.value + seg.change24h * seg.value) / totalVal : 0;
      e.value    += seg.value;
      e.quantity += seg.quantity;
    } else {
      mergedMap.set(seg.symbol, { ...seg });
    }
  }

  const sorted = Array.from(mergedMap.values()).sort((a, b) => b.value - a.value);

  // Donut: group <$50 into Other
  const main     = sorted.filter((d) => d.value >= 50);
  const small    = sorted.filter((d) => d.value <  50);
  const otherVal = small.reduce((s, d) => s + d.value, 0);
  const otherQty = small.reduce((s, d) => s + d.quantity, 0);

  const donutData: Seg[] = otherVal > 0
    ? [...main, { symbol: "Other", name: `${small.length} small positions`, value: otherVal, quantity: otherQty, change24h: 0 }]
    : main;

  const total     = accountTotal > 0 ? accountTotal : sorted.reduce((s, d) => s + d.value, 0);
  const active    = activeIndex !== null ? donutData[activeIndex] : null;
  const activePct = active && total > 0 ? (active.value / total) * 100 : 0;
  const getColor  = (i: number) => colorFor(donutData[i].symbol, i);
  const deselect  = () => setLockedIndex(null);

  const legendData = donutData.slice(0, 4);

  // ── SVG donut geometry (matches DebtBreakdownCard) ──────────────────────────
  const D_SIZE   = 180;
  const D_CX     = D_SIZE / 2;
  const D_CY     = D_SIZE / 2;
  const D_MID_R  = 62;
  const D_STROKE = 22;
  const D_CIRC   = 2 * Math.PI * D_MID_R;
  const gapDash  = donutData.length > 1 ? (1.5 / 360) * D_CIRC : 0;

  const svgSegments = donutData.reduce(
    (acc, d, i) => {
      const pct   = total > 0 ? d.value / total : 0;
      const dash  = Math.max(0, pct * D_CIRC - gapDash);
      const gap   = D_CIRC - dash;
      const angle = -90 + 360 * acc.cumulative;
      return {
        cumulative: acc.cumulative + pct,
        items: [...acc.items, { d, i, pct, dash, gap, angle, color: getColor(i) }],
      };
    },
    { cumulative: 0, items: [] as Array<{ d: Seg; i: number; pct: number; dash: number; gap: number; angle: number; color: string }> },
  ).items;

  return (
    <>
      <div onClick={deselect}>
        {/* ── Donut ── */}
        <div className="flex justify-center">
          <div className="relative" style={{ width: D_SIZE, height: D_SIZE }}>
            <svg
              width={D_SIZE}
              height={D_SIZE}
              viewBox={`0 0 ${D_SIZE} ${D_SIZE}`}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              {/* Background track */}
              <circle
                cx={D_CX} cy={D_CY} r={D_MID_R}
                fill="none"
                stroke="#1f2937"
                strokeWidth={D_STROKE}
              />
              {/* Segments */}
              {svgSegments.map(({ d: seg, i, dash, gap, angle, color }) => {
                const isHov    = activeIndex === i;
                const isDimmed = activeIndex !== null && !isHov;
                return (
                  <circle
                    key={`${seg.symbol}-${i}`}
                    cx={D_CX} cy={D_CY} r={D_MID_R}
                    fill="none"
                    stroke={color}
                    strokeWidth={isHov ? D_STROKE + 5 : D_STROKE}
                    strokeDasharray={`${dash} ${gap}`}
                    transform={`rotate(${angle}, ${D_CX}, ${D_CY})`}
                    strokeLinecap="butt"
                    opacity={isDimmed ? 0.25 : 1}
                    style={{ cursor: "pointer", transition: "opacity 0.15s, stroke-width 0.15s" }}
                    onMouseEnter={() => { setHoveredIndex(i); }}
                    onClick={() => { sliceClickedRef.current = true; setLockedIndex((p) => p === i ? null : i); }}
                  />
                );
              })}
            </svg>

            {/* Center label */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-4 text-center">
              {active ? (
                <>
                  <p className="text-[10px] text-gray-400 leading-tight truncate w-full text-center">
                    {active.symbol}
                  </p>
                  <p className="text-base font-bold leading-tight mt-0.5 text-white">
                    {fmtCompact(active.value)}
                  </p>
                  <p className="text-[10px] text-gray-500 leading-tight mt-0.5 font-semibold">
                    {activePct.toFixed(1)}%
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[10px] text-gray-500 leading-tight">Total</p>
                  <p className="text-base font-bold leading-tight mt-0.5 text-white">
                    {fmtCompact(total)}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Top 4 legend ── */}
        <div className="mt-1 space-y-0.5" onClick={(e) => e.stopPropagation()}>
          {legendData.map((d, i) => {
            const color    = getColor(i);
            const isActive = activeIndex === null || activeIndex === i;
            const pct      = total > 0 ? (d.value / total) * 100 : 0;
            return (
              <button
                key={`${d.symbol}-${i}`}
                onClick={(e) => { e.stopPropagation(); sliceClickedRef.current = true; setLockedIndex((p) => p === i ? null : i); }}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-xl transition-all touch-manipulation text-left hover:bg-gray-800/50"
                style={{ opacity: isActive ? 1 : 0.3 }}
              >
                <span className="w-1 h-5 rounded-full shrink-0" style={{ background: color }} />
                <span className="text-xs font-semibold text-white flex-1 truncate">{d.symbol}</span>
                <span className="text-[10px] text-gray-500 tabular-nums">{fmtQty(d.quantity)}</span>
                <span className="text-xs font-semibold text-white tabular-nums w-16 text-right">{fmtFull(d.value)}</span>
                <span className="text-[10px] text-gray-600 tabular-nums w-8 text-right">{pct.toFixed(1)}%</span>
              </button>
            );
          })}

          <button
            onClick={(e) => { e.stopPropagation(); setPopupOpen(true); }}
            className="w-full flex items-center justify-center gap-1.5 mt-1 py-2 rounded-xl border border-gray-800 text-[11px] font-semibold text-gray-500 hover:text-gray-300 hover:border-gray-600 hover:bg-gray-800/30 transition-colors touch-manipulation"
          >
            All {sorted.length} positions
          </button>
        </div>
      </div>

      {popupOpen && (
        <HoldingsPopup sorted={sorted} total={total} onClose={() => setPopupOpen(false)} />
      )}
    </>
  );
}
