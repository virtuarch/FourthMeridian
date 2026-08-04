"use client";

/**
 * components/space/widgets/investments/HistoricalPointPanel.tsx
 *
 * V26-S3-DETAIL — what one historical chart point is made of.
 *
 * ── What this component is NOT allowed to do ─────────────────────────────────
 * Compute anything financial. Every number, every count, every tier, every
 * reason and the reconciliation verdict itself arrive already decided from
 * `/investments/point-detail`, which is a thin pass-through over the canonical
 * historical authority. This file formats and lays out; it does not multiply a
 * quantity by a price, sum a column, or judge completeness. That is the whole
 * point: a view that does its own arithmetic is a second engine.
 *
 * ── The refusal ──────────────────────────────────────────────────────────────
 * When the authority reports `reconciled: false`, NO breakdown is rendered. A
 * partial list that does not sum to the point above it is worse than nothing —
 * it teaches the reader to distrust both. The user sees one honest sentence; the
 * diagnostic delta stays in the server log where it is useful.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Panel } from "@/components/atlas/panels/Panel";
import { PanelHeader, PanelContent } from "@/components/atlas/panels/PanelParts";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";

interface PointComponent {
  kind: "investment" | "crypto";
  accountName: string;
  symbol: string | null;
  name: string | null;
  isCash: boolean;
  quantity: number | null;
  quantityTier: string;
  ownership: "KNOWN" | "POSSIBLE" | null;
  unitPrice: number | null;
  priceSource: string | null;
  value: number | null;
  reason: string;
}
interface PointExcluded {
  accountName: string; symbol: string | null; reasonCode: string; explanation: string;
}
interface HistoricalScope {
  heldValued: number; heldUnavailable: number; notYetOwned: number;
  alreadyClosed: number; ownershipUncertain: number; excludedArtifact: number;
  detail: { category: string; symbol: string | null; accountName: string; explanation: string }[];
}
interface PointDetail {
  dateISO: string;
  reportingCurrency: string;
  chartValue: number;
  componentTotal: number;
  state: "EXACT" | "PARTIALLY_ATTRIBUTED" | "CONTRADICTORY" | "UNAVAILABLE";
  reconciled: boolean;
  unattributed: number | null;
  explainedFraction: number;
  observedTotal: boolean;
  refusal: string | null;
  components: PointComponent[];
  excluded: PointExcluded[];
  valuedCount: number;
  heldCount: number;
  scope: HistoricalScope;
}

/** Scope lines, worded once. Categories with a zero count are simply absent. */
function scopeLines(s: HistoricalScope): string[] {
  const out: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (s.notYetOwned)        out.push(`${plural(s.notYetOwned, "position was", "positions were")} acquired after this date`);
  if (s.alreadyClosed)      out.push(`${plural(s.alreadyClosed, "position had", "positions had")} already been sold`);
  if (s.ownershipUncertain) out.push(`${plural(s.ownershipUncertain, "position has", "positions have")} uncertain ownership`);
  if (s.heldUnavailable)    out.push(`${plural(s.heldUnavailable, "held position", "held positions")} could not be valued`);
  if (s.excludedArtifact)   out.push(`${plural(s.excludedArtifact, "provider transfer record was", "provider transfer records were")} excluded`);
  return out;
}

const money = (n: number, ccy: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: ccy, maximumFractionDigits: 2 }).format(n);

/** Quantities are shown at the precision the engine resolved, never rounded into a lie. */
const qty = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(8))));

/** The provenance line under a holding — the engine's grade, worded once. */
function provenance(c: PointComponent): string {
  const parts: string[] = [];
  if (c.isCash) parts.push("Reconstructed from cash effects");
  else if (c.quantityTier === "observed") parts.push("Observed quantity");
  else if (c.quantityTier === "derived") parts.push("Reconstructed quantity");
  else parts.push("Estimated quantity");
  if (c.ownership === "POSSIBLE") parts.push("inferred ownership");
  if (c.priceSource) parts.push(`${c.priceSource} close`);
  return parts.join(" · ");
}

export function HistoricalPointPanel({
  spaceId, dateISO, open, onClose,
}: {
  spaceId: string;
  dateISO: string | null;
  open: boolean;
  onClose: () => void;
}) {
  // ONE state cell, stamped with the date it answers for. `loading` is then
  // DERIVED rather than tracked: a spinner that is a separate boolean can
  // disagree with the data beside it, and this panel exists to not do that.
  const [answer, setAnswer] = useState<{ dateISO: string; detail: PointDetail | null } | null>(null);

  // The repo's established async-in-component shape (InvestmentConnectionsCard):
  // a useCallback loader invoked from the effect, so state is only ever set from
  // the resolved promise. `open` guards it so a closed panel fetches nothing.
  const load = useCallback(() => {
    if (!open || !dateISO) return;
    const requested = dateISO;
    fetch(`/api/spaces/${spaceId}/investments/point-detail?date=${requested}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PointDetail | null) => setAnswer({ dateISO: requested, detail: d }))
      .catch(() => setAnswer({ dateISO: requested, detail: null }));
  }, [spaceId, dateISO, open]);

  useEffect(() => { load(); }, [load]);

  // An answer for a DIFFERENT date is not this date's answer — it is still
  // loading. This is what makes a stale breakdown impossible to render.
  const current = answer && answer.dateISO === dateISO ? answer.detail : undefined;
  const loading = dateISO !== null && current === undefined;
  const detail = current ?? null;

  const ccy = detail?.reportingCurrency ?? "USD";

  return (
    <Panel open={open} onClose={onClose}>
      <PanelHeader eyebrow={dateISO ? formatWealthDate(dateISO) : undefined} title="Historical holdings" />
      <PanelContent>
      {loading && (
        <div className="flex items-center gap-2 py-8 text-xs text-[var(--text-faint)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Resolving this date&rsquo;s holdings…
        </div>
      )}

      {!loading && detail && detail.state === "CONTRADICTORY" && (
        <p className="py-8 text-xs leading-relaxed text-[var(--text-muted)]">
          Historical composition is unavailable because the stored observations conflict.
        </p>
      )}

      {!loading && detail && detail.state === "UNAVAILABLE" && (
        <p className="py-8 text-xs leading-relaxed text-[var(--text-muted)]">
          Historical composition unavailable for this date.
        </p>
      )}

      {!loading && detail && detail.reconciled && (
        <div className="space-y-5">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
              {detail.observedTotal ? "Observed portfolio" : "Portfolio value"}
            </p>
            <p className="mt-0.5 text-2xl font-medium tabular-nums">{money(detail.chartValue, ccy)}</p>
            <p className="mt-1 text-[11px] text-[var(--text-faint)]">
              <span className="tabular-nums">{detail.heldCount}</span>{" "}
              {detail.heldCount === 1 ? "holding existed" : "holdings existed"} ·{" "}
              <span className="tabular-nums">{detail.valuedCount}</span> valued
            </p>
          </div>

          {/* The residual on a partially attributed OBSERVED total. Stated as
              arithmetic and nothing else — never cash, gain, or a holding. */}
          {detail.state === "PARTIALLY_ATTRIBUTED" && detail.unattributed != null && (
            <div className="rounded-md border border-[var(--border-hairline)] px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] text-[var(--text-secondary)]">Unattributed observed amount</span>
                <span className="text-sm tabular-nums">{money(detail.unattributed, ccy)}</span>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-faint)]">
                Fourth Meridian recorded the total directly on this date, but the available
                component evidence does not allocate {money(detail.unattributed, ccy)} to a
                specific holding. {(detail.explainedFraction * 100).toFixed(1)}% explained.
              </p>
            </div>
          )}

          <ul className="space-y-3">
            {detail.components.map((c, i) => (
              <li key={`${c.symbol ?? "?"}-${c.accountName}-${i}`}
                  className="border-t border-[var(--border-hairline)] pt-3 first:border-0 first:pt-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">{c.symbol ?? c.name ?? "—"}</span>
                  <span className="text-sm tabular-nums">
                    {c.value == null ? "—" : money(c.value, ccy)}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] tabular-nums text-[var(--text-muted)]">
                  {c.quantity != null && !c.isCash && c.unitPrice != null
                    ? `${qty(c.quantity)} × ${money(c.unitPrice, ccy)}`
                    : c.isCash && c.quantity != null
                      ? money(c.quantity, ccy)
                      : c.reason}
                </p>
                <p className="mt-0.5 text-[10px] text-[var(--text-faint)]">
                  {c.accountName} · {provenance(c)}
                </p>
              </li>
            ))}
          </ul>

          {scopeLines(detail.scope).length > 0 && (
            <details className="border-t border-[var(--border-hairline)] pt-3">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
                Historical scope
              </summary>
              <ul className="mt-2 space-y-1">
                {scopeLines(detail.scope).map((line) => (
                  <li key={line} className="text-[11px] text-[var(--text-muted)]">{line}</li>
                ))}
              </ul>
              {detail.scope.detail.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-[var(--border-hairline)] pt-2">
                  {detail.scope.detail.map((d, i) => (
                    <li key={`${d.category}-${d.symbol ?? "?"}-${i}`} className="text-[10px] text-[var(--text-faint)]">
                      <span className="font-medium">{d.symbol ?? "—"}</span> · {d.accountName} — {d.explanation}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>
      )}

      {!loading && !detail && (
        <p className="py-8 text-xs text-[var(--text-muted)]">
          Historical composition unavailable for this date.
        </p>
      )}
      </PanelContent>
    </Panel>
  );
}
