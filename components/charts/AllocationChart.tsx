"use client";
import { useRef, useState } from "react";
import { PieChart, Pie, Cell, Legend, ResponsiveContainer } from "recharts";

interface Props {
  cash: number;
  investments: number;
  crypto: number;
  debt: number;
}

const COLORS = ["#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444"];

// 0–999 → "$X",  1k–999,999 → "$Xk",  1M+ → "$X.XM"
function fmtCenter(n: number): string {
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

export function AllocationChart({ cash, investments, crypto, debt }: Props) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [lockedIndex,  setLockedIndex]  = useState<number | null>(null);

  // Prevents the outer "deselect" handler from firing immediately after a slice click
  const sliceClickedRef = useRef(false);

  const activeIndex = lockedIndex ?? hoveredIndex;

  const data = [
    { name: "Cash",        value: cash },
    { name: "Investments", value: investments },
    { name: "Crypto",      value: crypto },
    { name: "Debt",        value: Math.abs(debt) },
  ];

  const total = data.reduce((s, d) => s + d.value, 0);
  const active = activeIndex !== null ? data[activeIndex] : null;
  const isDebt = active?.name === "Debt";
  const activePct = active && total > 0 ? (active.value / total) * 100 : 0;

  return (
    <div
      style={{ position: "relative", height: 220 }}
      onClick={() => {
        if (sliceClickedRef.current) {
          sliceClickedRef.current = false;
          return;
        }
        setLockedIndex(null);
      }}
    >
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data}
            cx="50%" cy="42%"
            innerRadius={50} outerRadius={75}
            paddingAngle={3}
            dataKey="value"
            onMouseEnter={(_, i) => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
            onClick={(_, i) => {
              sliceClickedRef.current = true;
              setLockedIndex((prev) => (prev === i ? null : i));
            }}
            style={{ cursor: "pointer", outline: "none" }}
          >
            {data.map((_, i) => (
              <Cell
                key={i}
                fill={COLORS[i]}
                opacity={activeIndex === null || activeIndex === i ? 1 : 0.35}
                style={{ transition: "opacity 0.15s" }}
              />
            ))}
          </Pie>
          <Legend
            formatter={(value) => <span style={{ color: "#9ca3af", fontSize: 11 }}>{value}</span>}
            iconSize={8}
            iconType="circle"
          />
        </PieChart>
      </ResponsiveContainer>

      {/* Center label — name, %, and amount in the donut hole */}
      {active && (
        <div style={{
          position: "absolute",
          top: "42%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          pointerEvents: "none",
          textAlign: "center",
          lineHeight: 1.35,
        }}>
          <div style={{ color: "#9ca3af", fontSize: 10 }}>{active.name}</div>
          <div style={{ color: isDebt ? "#f87171" : "#ffffff", fontSize: 16, fontWeight: 700 }}>
            {isDebt ? `−${fmtCenter(active.value)}` : fmtCenter(active.value)}
          </div>
          <div style={{ color: "#6b7280", fontSize: 10, fontWeight: 600 }}>
            {activePct.toFixed(1)}%
          </div>
        </div>
      )}
    </div>
  );
}
