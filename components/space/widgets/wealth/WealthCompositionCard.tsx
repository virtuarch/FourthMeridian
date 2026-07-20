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

import { useMemo, useState, type ReactNode } from "react";
import { formatCurrency } from "@/lib/format";
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { WEALTH_CLASS_COLOR, DEFAULT_CHART_COLOR } from "@/lib/charts/chart-palette";
import { Dropdown } from "@/components/atlas/Dropdown";
import type { ConversionContext } from "@/lib/money/types";
import {
  renderInstitutionAllocation,
  renderWealthByAccount,
  renderWealthConcentration,
  wealthInstitutionGroups,
  wealthAccountRows,
  type WealthAdapterAccount,
} from "@/components/space/widgets/wealth-adapters";
import { renderDebtByAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { renderLiquidityLadder } from "@/components/space/widgets/liquidity-adapters";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import {
  InstitutionCompositionDetail,
  AccountCompositionDetail,
} from "./WealthCompositionDetail";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate, wealthCompositionItems } from "@/lib/wealth/wealth-time-machine";
import { Surface, Block } from "@/components/atlas/Surface";
import { WealthUnavailable, formatSigned } from "./wealth-ui";
import type { WealthMetricKey } from "./WealthTrendChart";
import {
  METRIC_COMPOSITION_REGIME,
  METRIC_DRIVER_COMPONENTS,
  showsLiabilityContribution,
} from "./wealth-metric-facets";

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
  metric = "netWorth",
}: {
  result:    WealthResult;
  currency:  string;
  /** Live accounts for the institution/account/concentration modes. */
  accounts?: WealthAdapterAccount[];
  ctx?:      ConversionContext;
  /** Selected wealth metric — drives which composition REGIME renders. */
  metric?:   WealthMetricKey;
}) {
  const [mode, setMode] = useState<CompositionMode>("class");
  // UX-CLOSE-2 — one selection, scoped to this card. No provider, no event bus:
  // the same local-useState idiom the five ledgers already use.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { asOfState, drivers } = result;

  // V25-CLOSE-4A — the composition REGIME follows the selected metric. Assets and
  // Net Worth share the asset donut (Net Worth additionally shows a liabilities
  // row); Liabilities and Liquid render present-day debt / liquidity composition
  // from the EXISTING adapters — never an assets donut.
  const regime = METRIC_COMPOSITION_REGIME[metric];

  // Changing metric changes what the card is ABOUT, so any open asset-drill panel
  // and the (asset-only) grouping mode no longer apply — clear both. Adjust-state-
  // during-render (no effect, no flash), the same idiom the slice drawers use.
  const [prevMetric, setPrevMetric] = useState(metric);
  if (metric !== prevMetric) {
    setPrevMetric(metric);
    setSelectedId(null);
    setMode("class");
  }

  // Both drills read the SAME authority the charts render from, so a segment and
  // its panel cannot disagree about membership or converted value.
  const institutionGroups = useMemo(
    () => wealthInstitutionGroups(accounts, ctx),
    [accounts, ctx],
  );
  const accountRows = useMemo(() => wealthAccountRows(accounts, ctx), [accounts, ctx]);
  const totalAssets = useMemo(
    () => accountRows.reduce((s, a) => s + a.value, 0),
    [accountRows],
  );

  const selectedGroup   = mode === "institution" ? institutionGroups.find((g) => g.id === selectedId) ?? null : null;
  const selectedAccount = mode === "account"     ? accountRows.find((a) => a.id === selectedId) ?? null : null;
  const detailOpen = selectedGroup != null || selectedAccount != null;

  // Switching grouping changes what an id MEANS ("Chase" vs an account id), so a
  // carried-over selection would resolve to nothing. Clear it with the mode.
  const changeMode = (next: CompositionMode) => {
    setSelectedId(null);
    setMode(next);
  };

  // The mode switcher — a compact dropdown. Its four modes (class / institution /
  // account / concentration) are ASSET concepts, so it is shown only in the asset
  // regime; Liabilities and Liquid render a single present-day composition.
  const switcher = regime === "assets"
    ? <Dropdown options={MODES} value={mode} onChange={changeMode} ariaLabel="Composition grouping" />
    : undefined;

  // The metric's driver components — filters the per-class change chips so Assets
  // mode never shows a liabilities chip.
  const metricComponents = new Set<string>(METRIC_DRIVER_COMPONENTS[metric]);

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

  // Resolve the header hint + the body ONCE, so the whole card is a single Block
  // whose content fades on a metric/mode change (the "switch slices" animation).
  let hint: ReactNode;
  let content: ReactNode;

  if (regime === "liabilities") {
    // ── Liabilities — present-day debt composition, NEVER an assets donut. ────────
    // Reuses the existing debt adapter (per-creditor / per-account bars). Snapshots
    // store only a debt scalar, so there is no historical per-creditor breakdown;
    // this is honestly badged current-only.
    hint = <span className="text-[11px] text-[var(--text-muted)]">Current classification</span>;
    content = (
      <Surface className="px-4 py-4">
        <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">
          Current classification — your debts today, by creditor. Per-account debt
          history isn&apos;t tracked, so this reflects now, not the selected As Of date.
        </p>
        {renderDebtByAccount(accounts, ctx)}
      </Surface>
    );
  } else if (regime === "liquid") {
    // ── Liquid — present-day reachability ladder from the liquidity adapter. ──────
    hint = <span className="text-[11px] text-[var(--text-muted)]">Current classification</span>;
    content = (
      <Surface className="px-4 py-4">
        <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">
          Current classification — where your money sits by how quickly you can
          reach it. Reflects today&apos;s accounts, not the selected As Of date.
        </p>
        {renderLiquidityLadder(accounts, ctx)}
      </Surface>
    );
  } else if (mode !== "class") {
    // ── Live-account modes — "Current classification", never historical. ──────────
    hint = <span className="text-[11px] text-[var(--text-muted)]">Current classification</span>;
    content = (
      <Surface className="px-4 py-4">
        <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">
          Current classification — reflects today&apos;s connected accounts, not the selected As Of date.
        </p>
        {mode === "institution"
          ? renderInstitutionAllocation(accounts, ctx, { onSelect: setSelectedId, selectedId })
          : mode === "account"
            ? renderWealthByAccount(accounts, ctx, { onSelect: setSelectedId, selectedId })
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

        {/* Liabilities contribution — shown ONLY in Net Worth mode. In Assets mode
            the card is assets-only, so the liabilities row is removed. */}
        {showsLiabilityContribution(metric) && c.liabilities > 0 && (
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

        {/* Per-class change chips — real component deltas, only when comparing,
            filtered to the selected metric's components (Assets omits the
            liabilities chip; Net Worth shows all). */}
        {drivers && drivers.some((d) => metricComponents.has(d.id)) && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {drivers.filter((d) => metricComponents.has(d.id)).map((d) => (
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
      {/* Keyed on metric+mode ⇒ the body fades/re-focuses on either switch (the
          same in-place "re-aim" the Lens selector uses), rather than snapping. */}
      <div key={`${metric}:${mode}`} className="motion-safe:animate-[wcomp-fade_220ms_var(--ease-standard)_both]">
        {content}
      </div>
      <style>{`@keyframes wcomp-fade { from { opacity: 0 } to { opacity: 1 } }`}</style>

      {/* INSPECT — "what is inside the thing I selected". Right edge, matching
          the ledgers. The browse counterpart (pick from the full set) would be a
          LeftPanel; this card's chart already is that set, so none is needed. */}
      <RightPanel open={detailOpen} onClose={() => setSelectedId(null)} ariaLabel="Composition detail">
        {selectedGroup && (
          <>
            <PanelHeader eyebrow="Institution" title={selectedGroup.label} />
            <PanelContent>
              <InstitutionCompositionDetail
                group={selectedGroup}
                totalAssets={totalAssets}
                currency={ctx?.target ?? currency}
              />
            </PanelContent>
          </>
        )}
        {selectedAccount && (
          <>
            <PanelHeader eyebrow={selectedAccount.institution} title={selectedAccount.name} />
            <PanelContent>
              <AccountCompositionDetail
                account={selectedAccount}
                totalAssets={totalAssets}
                currency={ctx?.target ?? currency}
              />
            </PanelContent>
          </>
        )}
      </RightPanel>
    </Block>
  );
}
