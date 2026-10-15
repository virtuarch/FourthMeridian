"use client";

/**
 * components/space/widgets/wealth/AssetValuationHistory.tsx   (RWA-2A)
 *
 * One manual asset's value over time, opened from its Real assets card.
 *
 * Every point arrives already classified by THE valuation policy
 * (lib/assets/valuation-series.core.ts, served by
 * GET /api/accounts/manual/[id]/valuations); this component only draws it:
 *   recorded  — a value the user entered for that date (solid dot)
 *   modeled   — a straight line between two recorded values (dashed) — an
 *               illustration, never an observed market price
 *   carried   — the latest estimate carried forward (long dash), never projected
 * The list below the chart is the ledger itself: each recorded value with its
 * date, plus how many same-day entries a later correction replaced.
 *
 * Read-only. The route serves only the owner or a FULL-link viewer.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { TrendChart, type TrendPoint } from "@/components/space/widgets/charts/TrendChart";
import { formatCurrency } from "@/lib/currency";
import { formatDate } from "@/lib/format";
import type { ValuationBasis } from "@/lib/assets/valuation-series.core";

interface HistoryResponse {
  currency:    string;
  acquisition: { acquisitionDate: string | null; purchasePrice: number | null; purchasePriceIsStartingValue: boolean } | null;
  startDate:   string | null;
  anchors:     { date: string; value: number; kind: "USER_VALUATION" | "PURCHASE_PRICE" | "LEGACY_BALANCE"; recordedAt: string | null }[];
  superseded:  { date: string; value: number; recordedAt: string }[];
  excluded:    { reason: string; detail: string }[];
  series:      { date: string; value: number; basis: ValuationBasis }[];
  modeled:     { meaning: string } | null;
}

const ANCHOR_LABEL: Record<HistoryResponse["anchors"][number]["kind"], string> = {
  USER_VALUATION: "Your estimate",
  PURCHASE_PRICE: "Purchase price (used as your starting estimate)",
  LEGACY_BALANCE: "Your estimate",
};

/** Map the policy's bases onto the chart's (exported for the test). */
export function toTrendPoints(series: HistoryResponse["series"]): TrendPoint[] {
  return series.map((p) => ({ date: p.date, value: p.value, estimated: false, basis: p.basis }));
}

export function AssetValuationHistory({ accountId }: { accountId: string }) {
  const [data,  setData]  = useState<HistoryResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/accounts/manual/${encodeURIComponent(accountId)}/valuations`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: HistoryResponse) => { if (!cancelled) { setData(d); setState("ready"); } })
      .catch(() => { if (!cancelled) setState("failed"); });
    return () => { cancelled = true; };
  }, [accountId]);

  if (state === "loading") {
    return <p className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><Loader2 size={12} className="animate-spin" /> Loading history…</p>;
  }
  if (state === "failed" || !data) {
    return <p className="text-xs text-[var(--text-muted)]">Couldn&rsquo;t load this asset&rsquo;s history.</p>;
  }

  const points = toTrendPoints(data.series);
  const correctionsByDate = new Map<string, number>();
  for (const s of data.superseded) correctionsByDate.set(s.date, (correctionsByDate.get(s.date) ?? 0) + 1);

  return (
    <div className="space-y-3">
      {points.length >= 2 ? (
        <TrendChart points={points} currency={data.currency} />
      ) : (
        <p className="text-xs text-[var(--text-muted)]">
          One recorded value so far. Record another (or add a purchase price as a starting estimate) to see a trend.
        </p>
      )}
      {data.modeled && <p className="text-[11px] text-[var(--text-muted)]">{data.modeled.meaning}</p>}

      <ul className="space-y-1 text-xs" aria-label="Recorded values">
        {[...data.anchors].reverse().map((a) => (
          <li key={`${a.date}-${a.kind}`} className="flex items-baseline justify-between gap-3">
            <span className="text-[var(--text-secondary)]">
              {formatDate(a.date)} · {ANCHOR_LABEL[a.kind]}
              {correctionsByDate.get(a.date) ? (
                <span className="text-[var(--text-muted)]"> · corrected ({correctionsByDate.get(a.date)} earlier entr{correctionsByDate.get(a.date) === 1 ? "y" : "ies"} kept)</span>
              ) : null}
            </span>
            <span className="tabular-nums text-[var(--text-primary)]">{formatCurrency(a.value, data.currency)}</span>
          </li>
        ))}
      </ul>

      {data.acquisition && (data.acquisition.acquisitionDate || data.acquisition.purchasePrice !== null) && (
        <p className="text-[11px] text-[var(--text-muted)]">
          {data.acquisition.acquisitionDate ? `Acquired ${formatDate(data.acquisition.acquisitionDate)}` : "Acquisition date not given"}
          {data.acquisition.purchasePrice !== null
            ? ` · paid ${formatCurrency(data.acquisition.purchasePrice, data.currency)}${data.acquisition.purchasePriceIsStartingValue ? "" : " (not used as a value estimate)"}`
            : ""}
        </p>
      )}
      {data.excluded.length > 0 && (
        <p className="text-[11px] text-[var(--text-muted)]">
          {data.excluded.length} entr{data.excluded.length === 1 ? "y" : "ies"} could not be used (e.g. a different currency) and {data.excluded.length === 1 ? "is" : "are"} not drawn.
        </p>
      )}
    </div>
  );
}
