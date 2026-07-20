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

import { useState, type ReactNode } from "react";
import { formatCurrency } from "@/lib/format";
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { WEALTH_CLASS_COLOR, DEFAULT_CHART_COLOR } from "@/lib/charts/chart-palette";
import { Dropdown } from "@/components/atlas/Dropdown";
import type { ConversionContext } from "@/lib/money/types";
import {
  renderInstitutionAllocation,
  renderWealthByAccount,
  renderWealthConcentration,
  type WealthAdapterAccount,
} from "@/components/space/widgets/wealth-adapters";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate, wealthCompositionItems } from "@/lib/wealth/wealth-time-machine";
import { Surface, Block } from "@/components/atlas/Surface";
import { WealthUnavailable, formatSigned } from "./wealth-ui";

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

  // The mode switcher — a compact dropdown (four modes shouldn't eat a rail of
  // width, and it keeps this card's header aligned with its neighbour).
  const switcher = <Dropdown options={MODES} value={mode} onChange={setMode} ariaLabel="Composition grouping" />;

  const c = asOfState.composition;
  // Colours pinned to the CLASS, not its position. wealthCompositionItems drops
  // zero-value classes, so index-assigned colour meant a portfolio without (say)
  // crypto drew "Real World Assets" in crypto's amber — and disagreed with the
  // treemap/strip modes, which have always pinned these values.
  const items: BreakdownItem[] = asOfState.found
    ? wealthCompositionItems(c).map((i) => ({
        ...i,
        color: WEALTH_CLASS_COLOR[i.id] ?? DEFAULT_CHART_COLOR,
      }))
    : [];

  // Resolve the header hint + the mode's body ONCE, so the whole card is a single
  // Block whose content fades on a mode change (the "switch slices" animation).
  let hint: ReactNode;
  let content: ReactNode;

  if (mode !== "class") {
    // ── Live-account modes — "Current classification", never historical. ──────────
    hint = <span className="text-[11px] text-[var(--text-muted)]">Current classification</span>;
    content = (
      <Surface className="px-4 py-4">
        <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">
          Current classification — reflects today&apos;s connected accounts, not the selected As Of date.
        </p>
        {mode === "institution"
          ? renderInstitutionAllocation(accounts, ctx)
          : mode === "account"
            ? renderWealthByAccount(accounts, ctx)
            : renderWealthConcentration(accounts, ctx)}
      </Surface>
    );
  } else if (!asOfState.found) {
    // ── By class, before coverage — honest unavailable. ──────────────────────────
    content = (
      <Surface className="px-4 py-4">
        <WealthUnavailable
          message={
            result.coverageFrom
              ? `Historical composition unavailable — no history before ${formatWealthDate(result.coverageFrom)}.`
              : "Historical composition unavailable for this date."
          }
        />
      </Surface>
    );
  } else {
    // ── By class — historical composition of the selected As Of snapshot. ─────────
    hint = asOfState.date
      ? <span className="text-[11px] text-[var(--text-muted)]">As of {formatWealthDate(asOfState.date)}</span>
      : undefined;
    content = (
      <Surface className="px-4 py-4">
        {asOfState.isEstimated && (
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
            className="mt-3 flex items-center justify-between rounded-[var(--radius-lg)] px-3 py-2 border"
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
      </Surface>
    );
  }

  return (
    <Block label="Where it sits" hint={hint} action={switcher}>
      {/* Keyed on mode ⇒ the slices fade/re-focus on a switch (the same in-place
          "re-aim" the Lens selector uses), rather than snapping. */}
      <div key={mode} className="motion-safe:animate-[wcomp-fade_220ms_var(--ease-standard)_both]">
        {content}
      </div>
      <style>{`@keyframes wcomp-fade { from { opacity: 0 } to { opacity: 1 } }`}</style>
    </Block>
  );
}
