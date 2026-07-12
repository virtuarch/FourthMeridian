"use client";

/**
 * components/space/widgets/wealth/WealthCompositionCard.tsx
 *
 * Surface ④ — "What is my wealth composed of?" Two honesty regimes behind one
 * header switcher (Amendments 8–9):
 *
 *   • By class (default) — the HISTORICAL composition of the selected As Of date,
 *     taken from that date's snapshot (never today's classification), with a
 *     Reconstructed badge on estimated dates, liabilities kept separate, and
 *     per-class change chips when a comparison is set. Copy is the earned
 *     taxonomy via WEALTH_CATEGORY_LABELS ("Real World Assets", never "Real
 *     Assets"/"Real Estate"). No zero-value slices; no "Other" bucket.
 *
 *   • By institution / By account / Concentration — these read LIVE accounts, so
 *     they carry a permanent "Current classification" label and are NEVER
 *     presented as belonging to the historical As Of date. They reuse the
 *     existing registered wealth adapters verbatim (no new chart system).
 *
 * A date before coverage shows an honest unavailable state in class mode.
 */

import { useState } from "react";
import { formatCurrency } from "@/lib/format";
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import type { ConversionContext } from "@/lib/money/types";
import {
  renderInstitutionAllocation,
  renderWealthByAccount,
  renderWealthConcentration,
  type WealthAdapterAccount,
} from "@/components/space/widgets/wealth-adapters";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate, wealthCompositionItems } from "@/lib/wealth/wealth-time-machine";
import { WealthCard, WealthUnavailable, formatSigned } from "./wealth-ui";

type CompositionMode = "class" | "institution" | "account" | "concentration";

const MODES: { id: CompositionMode; label: string }[] = [
  { id: "class",         label: "By class" },
  { id: "institution",   label: "By institution" },
  { id: "account",       label: "By account" },
  { id: "concentration", label: "Concentration" },
];

function driverGood(id: string, delta: number): boolean {
  return id === "liabilities" ? delta < 0 : delta > 0;
}

export function WealthCompositionCard({
  result,
  currency,
  accounts = [],
  ctx,
}: {
  result:    WealthResult;
  currency:  string;
  /** Live accounts for the institution/account/concentration modes. */
  accounts?: WealthAdapterAccount[];
  ctx?:      ConversionContext;
}) {
  const [mode, setMode] = useState<CompositionMode>("class");
  const { asOfState, drivers } = result;

  const switcher = (
    <SegmentedControl<CompositionMode>
      options={MODES}
      value={mode}
      onChange={setMode}
      aria-label="Composition grouping"
      className="max-w-full"
    />
  );

  // ── Live-account modes — "Current classification", never historical. ──────────
  if (mode !== "class") {
    return (
      <WealthCard title="What is my wealth composed of?" subtitle="Current classification" right={switcher}>
        <p className="text-[11px] text-[var(--text-faint)] mb-3 leading-relaxed">
          Current classification — reflects today&apos;s connected accounts, not the selected As Of date.
        </p>
        {mode === "institution"
          ? renderInstitutionAllocation(accounts, ctx)
          : mode === "account"
            ? renderWealthByAccount(accounts, ctx)
            : renderWealthConcentration(accounts, ctx)}
      </WealthCard>
    );
  }

  // ── By class — historical composition of the selected As Of snapshot. ─────────
  const subtitle = asOfState.date ? `As of ${formatWealthDate(asOfState.date)}` : undefined;

  if (!asOfState.found) {
    return (
      <WealthCard title="What is my wealth composed of?" right={switcher}>
        <WealthUnavailable
          message={
            result.coverageFrom
              ? `Historical composition unavailable — no history before ${formatWealthDate(result.coverageFrom)}.`
              : "Historical composition unavailable for this date."
          }
        />
      </WealthCard>
    );
  }

  const c = asOfState.composition;
  const items: BreakdownItem[] = wealthCompositionItems(c);
  const reconstructed = asOfState.isEstimated;

  return (
    <WealthCard title="What is my wealth composed of?" subtitle={subtitle} right={switcher}>
      {reconstructed && (
        <span
          className="inline-block mb-3 text-[10px] font-medium px-2 py-0.5 rounded-full"
          style={{ color: "var(--accent-warning)", background: "color-mix(in srgb, var(--accent-warning) 14%, transparent)" }}
          title="Reconstructed from history — some values held at recent prices"
        >
          Reconstructed
        </span>
      )}

      {items.length > 0 ? (
        <BreakdownWidget
          items={items}
          viewMode="donut"
          itemNoun="asset class"
          emptyHeadline="No assets on this date"
          emptySubline="This snapshot recorded no asset balances."
          formatValue={(v: number) => formatCurrency(v, currency)}
        />
      ) : (
        <WealthUnavailable message="This snapshot recorded no asset balances." />
      )}

      {c.liabilities > 0 && (
        <div
          className="mt-3 flex items-center justify-between rounded-xl px-3 py-2 border"
          style={{ background: "var(--surface-hover)", borderColor: "var(--border-hairline)" }}
        >
          <span className="text-xs text-[var(--text-muted)]">Liabilities (shown separately)</span>
          <span className="text-xs font-semibold tabular-nums text-[var(--accent-negative)]">
            −{formatCurrency(c.liabilities, currency)}
          </span>
        </div>
      )}

      {/* Per-class change chips — real component deltas, only when comparing. */}
      {drivers && drivers.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {drivers.map((d) => (
            <span
              key={d.id}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] tabular-nums border"
              style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}
            >
              <span className="text-[var(--text-muted)]">{d.label}</span>
              <span style={{ color: driverGood(d.id, d.delta) ? "var(--accent-positive)" : "var(--accent-negative)" }}>
                {formatSigned(d.delta, currency)}
              </span>
            </span>
          ))}
        </div>
      )}
    </WealthCard>
  );
}
