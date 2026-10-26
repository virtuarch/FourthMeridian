"use client";

/**
 * components/space/widgets/wealth/WealthHero.tsx
 *
 * Surface ① of the Wealth Perspective — the ONE place the page's subject is
 * stated as a number (single-instance doctrine): the headline, its change vs
 * Compare To, an inline confidence chip (Observed / Reconstructed / No history —
 * tone straight from the read model's completeness), then a quiet secondary
 * stat line (NOT cards, NO sparklines):
 *
 *   Total  (netWorth)  → Assets · Liabilities · Liquid NW
 *   Assets (All)       → Cash · Investments   (Cash / Investments slices: none)
 *
 * OVERVIEW-CONSOLIDATION — Liquid Net Worth is no longer a page; it survives
 * here as the derived stat it always was (netLiquid, read off the same
 * snapshot). Cash and Investments are the two disjoint dimensions of Total
 * Assets (cash + invested ≤ totalAssets; the remainder is real-world assets).
 * Honest states: an As Of before coverage shows "No history for this date"
 * (never zeros-as-facts); a missing comparison shows values without deltas.
 * Presentation only — every number comes from the WealthResult.
 */

import type { ReactNode } from "react";
import { CompactHeroCard } from "@/components/space/compact/CompactHeroCard";
import { formatCurrency } from "@/lib/currency";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { Figure } from "@/components/atlas/Surface";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import type { WealthMetricKey } from "@/lib/wealth/wealth-mode";
import { WealthUnavailable, DeltaBadge } from "./wealth-ui";
import { investedClassLabel } from "@/lib/wealth/invested-label";
import type { TalkSection } from "@/components/ai/talk-about-this";

/** v2.7 R6 — which topic the compact AI entry names for the headline metric. */
const TALK_SECTION: Record<WealthMetricKey, TalkSection> = {
  netWorth:         "net-worth",
  liquidNetWorth:   "net-worth",
  totalAssets:      "assets",
  totalLiabilities: "debt",
  cash:             "cash",
  invested:         "investments",
};

/** Hero eyebrow label per metric — mirrors the chart's metric switcher so the
 *  headline reads as whatever series the user selected in Balance history. */
const METRIC_LABEL: Record<WealthMetricKey, string> = {
  netWorth:         "Net worth",
  totalAssets:      "Total assets",
  totalLiabilities: "Total liabilities",
  liquidNetWorth:   "Liquid net worth",
  cash:             "Cash",
  invested:         "Investments & crypto",
};

/** The secondary stat line per headline — each row is a real WealthMetrics key. */
const SECONDARY: Record<WealthMetricKey, { key: WealthMetricKey; label: string; goodDirection: "up" | "down" }[]> = {
  netWorth: [
    { key: "totalAssets",      label: "Assets",      goodDirection: "up" },
    { key: "totalLiabilities", label: "Liabilities", goodDirection: "down" },
    { key: "liquidNetWorth",   label: "Liquid NW",   goodDirection: "up" },
  ],
  // `invested` rows: the label below is a placeholder — it is replaced at render
  // by investedClassLabel(asOfState.composition) ("Investments", "Crypto" or
  // "Investments & crypto", or the row is omitted). The invested series is stocks + crypto (the two
  // disjoint snapshot buckets the Investments lens always plotted), while the
  // composition card below names "Investments" and "Crypto" as separate classes.
  // The stat says which it is so the two never read as one figure disagreeing.
  totalAssets: [
    { key: "cash",     label: "Cash",                 goodDirection: "up" },
    { key: "invested", label: "Investments & crypto", goodDirection: "up" },
  ],
  // v2.7 visual-first — the Cash and Investments slices state no cross-slice
  // stats (owner: Total assets / the other slice live on All, one tap away).
  cash: [],
  invested: [],
  totalLiabilities: [],
  liquidNetWorth: [],
};

export function WealthHero({
  result,
  currency,
  envelope,
  metric = "netWorth",
  cryptoPriceNote,
  freshnessLabel = null,
  timePreset,
}: {
  result:   WealthResult;
  currency: string;
  /** The workspace's canonical trust envelope — drives the confidence chip. */
  envelope: PerspectiveEnvelope;
  /** The page's resolved series — the hero reflects the SAME metric the chart
   *  plots, so Total / Assets / a slice change the headline too. */
  metric?:  WealthMetricKey;
  /**
   * v2.7 P0 — the Space's canonical freshness claim ("Last checked 2 hr ago",
   * from resolveSpaceFreshness — the chrome subtitle's source). A snapshot can
   * be dated today while its balances were observed days ago, so the compact
   * line never labels the snapshot date as freshness; without a claim it says
   * "As of <snapshot date>", the desktop wording.
   */
  freshnessLabel?: string | null;
  /**
   * 2026-09-21 — the price basis of the crypto inside TODAY's figure
   * (summarizeCryptoPricing over the same wallet values the snapshot was
   * written from). Absent for a past date or a Space with no priced wallet.
   */
  cryptoPriceNote?: string | null;
  /** v2.7 R6 — the shell slice id for the compact "Talk with Fourth Meridian
   *  about this" link (kept there only when allowlisted). */
  timePreset?: string;
}) {
  const { asOfState, deltas, compareState } = result;
  // The `invested` figure is named for the classes actually held (canonical
  // composition) — never "& crypto" for a user with no crypto. Null ⇒ neither.
  const investedLabel = investedClassLabel(asOfState.composition);
  const metricLabel = metric === "invested" ? (investedLabel ?? "Investments") : METRIC_LABEL[metric];
  const secondaryRows = wealthSecondaryRows(result, metric);
  const compareLabel =
    compareState?.found && compareState.date ? formatWealthDate(compareState.date) : undefined;
  const asOfLabel = asOfState.date ? `As of ${formatWealthDate(asOfState.date)}` : undefined;

  // Rising liabilities are BAD; every other metric is good when it rises.
  const goodDirection: "up" | "down" = metric === "totalLiabilities" ? "down" : "up";

  // The confidence chip is now the shared trust primitive, reading the SAME
  // envelope the shell Completeness chip does — they can never disagree.
  const confidenceChip = <TrustIndicator variant="compact" envelope={envelope} />;

  // Eyebrow + confidence — the quiet label above the figure (prototype hero).
  const eyebrow = (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{metricLabel}</p>
      {confidenceChip}
    </div>
  );

  if (!asOfState.found) {
    return (
      <section>
        {eyebrow}
        <WealthUnavailable message="No history for this date. Pick a later As Of, or connect accounts to build history." />
      </section>
    );
  }

  // v2.7 visual-first — the COMPACT (<lg) hero is the shared five-row card
  // (CompactHeroCard): title · freshness · trust / figure / change / range / AI
  // entry. The freshness claim is the canonical "Last checked N ago"
  // (freshnessLabel) — never the snapshot date labelled as fresh data; the
  // as-of date is stated on the range row. The crypto price basis is an
  // exceptional note BELOW the card, never a sixth row.
  const compactRange = compareState?.found && compareState.date && asOfState.date
    ? `${formatWealthDate(compareState.date)} → ${formatWealthDate(asOfState.date)}`
    : (asOfLabel ?? "");

  return (
    <div>
      <CompactHeroCard
        title={metricLabel}
        freshness={freshnessLabel}
        trust={<TrustIndicator variant="compact" envelope={envelope} />}
        value={formatCurrency(asOfState[metric], currency)}
        change={deltas ? { abs: deltas[metric].abs, pct: deltas[metric].pct, goodDirection } : null}
        range={compactRange}
        currency={currency}
        talkSection={TALK_SECTION[metric]}
        talkPeriod={timePreset}
        notes={cryptoPriceNote ? [cryptoPriceNote] : []}
      />

      {/* DESKTOP (≥lg) — the bare hero, no card, no border. The most important
          figure doesn't need a container to be found. */}
      <section className="max-lg:hidden">
        {eyebrow}

        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <Figure value={formatCurrency(asOfState[metric], currency)} size="hero" className="sm:text-5xl leading-none" />
          {deltas ? (
            <DeltaBadge
              abs={deltas[metric].abs}
              pct={deltas[metric].pct}
              currency={currency}
              goodDirection={goodDirection}
              compareLabel={compareLabel}
              className="!text-xs"
            />
          ) : (
            <span className="text-[11px] text-[var(--text-muted)]">Add a Compare To date above to see the change.</span>
          )}
        </div>
        {asOfLabel && <p className="mt-2.5 text-sm text-[var(--text-secondary)]">{asOfLabel}{cryptoPriceNote ? ` · ${cryptoPriceNote}` : ""}</p>}

        {/* Secondary stats — the subject's dimensions, each a real WealthMetrics
            key off the same as-of snapshot (label · value · signed change). */}
        {secondaryRows.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-[var(--text-muted)]">
            {secondaryRows.map((row) => (
              <Stat key={row.key} label={row.label}>
                {formatCurrency(asOfState[row.key], currency)}
                <SecondaryChange delta={deltas?.[row.key]} goodDirection={row.goodDirection} currency={currency} />
              </Stat>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The secondary stat rows for a headline — each a real WealthMetrics key off the
 * SAME as-of snapshot, the `invested` row named for the classes actually held (or
 * omitted). Exported (v2.7 R4) so the compact KPI strip states exactly these rows.
 */
export function wealthSecondaryRows(result: WealthResult, metric: WealthMetricKey): { key: WealthMetricKey; label: string; goodDirection: "up" | "down" }[] {
  const investedLabel = investedClassLabel(result.asOfState.composition);
  return SECONDARY[metric]
    .filter((row) => row.key !== "invested" || investedLabel !== null)
    .map((row) => (row.key === "invested" ? { ...row, label: investedLabel! } : row));
}

/**
 * A secondary stat's signed change (hidden under half a unit) — the hero's stat
 * line formatting, exported (v2.7 R4) for the compact KPI strip.
 */
export function SecondaryChange({
  delta,
  goodDirection,
  currency,
  className,
}: {
  delta: { abs: number } | null | undefined;
  goodDirection: "up" | "down";
  currency: string;
  className?: string;
}) {
  if (!delta || Math.abs(delta.abs) < 0.5) return null;
  const good = goodDirection === "up" ? delta.abs >= 0 : delta.abs <= 0;
  return (
    <span className={className ?? "ml-1.5"} style={{ color: good ? "var(--accent-positive)" : "var(--accent-negative)" }}>
      {delta.abs >= 0 ? "+" : "−"}{formatCurrency(Math.abs(delta.abs), currency)}
    </span>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{label}</span>
      <span className="text-[var(--text-secondary)]">{children}</span>
    </span>
  );
}
