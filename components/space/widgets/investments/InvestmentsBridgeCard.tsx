"use client";

/**
 * components/space/widgets/investments/InvestmentsBridgeCard.tsx
 *
 * Thin renderer over `buildBridgeRows` (the pure model). Draws the opening →
 * money in → money out → portfolio change → closing waterfall as CSS bars (no
 * chart library), with the residual framed honestly as "what's inside this
 * number" — the residual amount and its plain-English reason (plus any endpoint /
 * conflict caveat) live one tap deep, never asserted as market gains. The two
 * cumulative levels (opening, closing) render as bold reference lines; the three
 * deltas render as signed bars. Holds no state beyond the disclosure toggle.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { InvestmentsReconciliation } from "@/lib/investments/investments-time-machine-core";
import type { PeriodFlows } from "@/lib/investments/investment-flows-core";
import { buildBridgeRows } from "./investments-bridge";
import { formatCurrencyExact } from "@/lib/format";

export function InvestmentsBridgeCard({
  reconciliation,
  flows,
}: {
  reconciliation: InvestmentsReconciliation | null;
  flows:          PeriodFlows | null;
}) {
  const [open, setOpen] = useState(false);
  const model = buildBridgeRows(reconciliation, flows);

  if (model.state !== "reconciled" || model.reportingCurrency == null) {
    return <p className="text-sm py-4" style={{ color: "var(--text-muted)" }}>
      Pick a comparison date to see how your portfolio changed.
    </p>;
  }

  const cur = model.reportingCurrency;
  const fmt = (v: number) => formatCurrencyExact(v, cur);
  const signed = (v: number) => `${v >= 0 ? "+" : "−"}${fmt(Math.abs(v))}`;
  // Bar scale: widest magnitude across every row so bars stay comparable.
  const maxMag = Math.max(1, ...model.rows.map((r) => Math.abs(r.amount)));

  return (
    <div className="flex flex-col gap-2">
      {model.rows.map((r) => {
        const pct = (Math.abs(r.amount) / maxMag) * 100;
        const positive = r.amount >= 0;
        const barColor = r.isLevel
          ? "var(--text-faint)"
          : positive
            ? "var(--accent-positive, #34d399)"
            : "var(--accent-warning, #f59e0b)";
        return (
          <div key={r.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <span
                className={`text-sm ${r.isLevel ? "font-semibold" : ""} truncate`}
                style={{ color: r.isLevel ? "var(--text-primary)" : "var(--text-secondary)" }}
              >
                {r.label}
              </span>
              <span
                className={`text-sm tabular-nums shrink-0 ${r.isLevel ? "font-semibold" : ""}`}
                style={{ color: "var(--text-primary)" }}
              >
                {r.isLevel ? fmt(r.amount) : signed(r.amount)}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-inset)" }}>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: barColor }} />
            </div>
          </div>
        );
      })}

      {/* Residual framing — what's inside the "portfolio change" number. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-1 flex items-start gap-1.5 text-left text-xs"
        style={{ color: "var(--text-muted)" }}
      >
        {open ? <ChevronDown size={13} className="shrink-0 mt-0.5" /> : <ChevronRight size={13} className="shrink-0 mt-0.5" />}
        <span>Your portfolio changed {signed(model.residual)} beyond what you moved in or out.</span>
      </button>
      {open && (
        <div className="ml-5 flex flex-col gap-1.5">
          {model.residualReason && <p className="text-xs" style={{ color: "var(--text-muted)" }}>{model.residualReason}</p>}
          {model.caveat && <p className="text-xs" style={{ color: "var(--accent-warning, #f59e0b)" }}>{model.caveat}</p>}
        </div>
      )}
    </div>
  );
}
