"use client";

/**
 * components/space/widgets/liquidity/LiquidityWorkspace.tsx
 *
 * The Liquidity WORKSPACE — SD-6B. Supersedes the CURRENT-STATE-ONLY
 * LiquidityPerspective by activating the canonical LiquiditySpaceData contract
 * (lib/liquidity/space-data.ts) end-to-end, closing the Perspective doctrine gap:
 * Liquidity now supports current, asOf, compareTo, and delta.
 *
 *   SpaceShell ──(asOf / compareTo / today)──▶ LiquidityWorkspace
 *                                                │  owns useLiquiditySpaceData
 *                                                ▼
 *                                       LiquiditySpaceData
 *                        { current, atAsOf, atCompareTo, delta, trust }
 *
 * ── The live anchor + the time machine (plan §5) ────────────────────────────────
 * The four account-array widgets (Accessible Cash, Emergency Fund Readiness,
 * Reachability, Concentration) and the What-Changed window are the LIVE CURRENT
 * ANCHOR — per-account readings of money you can get at RIGHT NOW, sourced from the
 * visibility-filtered `accounts` array exactly as before (they cannot be
 * reconstructed per-account historically, and are never faked into the past). The
 * TEMPORAL layer rides ONE panel — the Liquidity Ladder — plus the lede:
 *   • present day  → the current lens verdict (lede) + the per-account Ladder tiles.
 *   • historical   → the atAsOf lens verdict (lede) + a reconstructed Ladder from the
 *                    canonical atAsOf tier metrics (cashNow / marketable / illiquid),
 *                    with per-tier delta chips (compareTo → asOf) and the honest
 *                    as-of trust envelope (data.trust — held-flat / estimated
 *                    surfaced, never hidden).
 *
 * The SAME canonical ladder applies at every date — the tiers are computeLiquidity's
 * (cashNow → Available now, marketable → Available in days, illiquid → Illiquid); the
 * workspace RE-SURFACES those metrics, it never re-partitions accounts into tiers or
 * recomputes a liquidity sum. Crypto is counted exactly once by the engine (the
 * splice REPLACES a wallet's held-flat estimate with its A8 value — no parallel
 * digital-asset bucket); this workspace inherits that guarantee and adds nothing.
 *
 * This component owns NO time state — asOf / compareTo / today are shell props. It
 * owns its data consumption (useLiquiditySpaceData) and emits its trust envelope
 * outward (onEnvelopeChange), so the host is no longer the Liquidity domain-data
 * owner for the shell chip. Present day is byte-identical to the old render: no
 * fetch, the host's present-day lens, the same account-array widgets.
 *
 * FX posture (plan §11 — no new authority): the current-anchor widgets convert live
 * balances through the existing ConversionContext seam. The historical endpoints
 * (atAsOf / atCompareTo / delta) are valued by the engine in the Space REPORTING
 * currency; before render they pass through the pure `convertLiquiditySpaceData`
 * (lib/liquidity/display-conversion.ts) — the ONE canonical money authority — which
 * NUMERICALLY converts each endpoint into the selected display currency at that
 * endpoint's OWN date (per-date; identity when display == reporting). A reporting-
 * currency number is therefore NEVER shown under a different symbol without
 * conversion; a missing rate degrades to an honest `estimated` (≈) flag, never a
 * silent relabel. The lede prose (`verdict`) stays the engine's self-consistent
 * reporting-currency sentence (regenerating template prose is out of scope).
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { classifyAccounts } from "@/lib/account-classifier";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { convertLiquiditySpaceData } from "@/lib/liquidity/display-conversion";
import { periodLabel, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { LiquidityLadderTiers } from "./LiquidityLadderTiers";
import { LiquidityWhatChangedCard } from "./LiquidityWhatChangedCard";
import { useLiquiditySpaceData } from "./useLiquiditySpaceData";
import {
  renderAccessibleCash,
  renderEmergencyFundReadiness,
  renderLiquidityConcentration,
  type LiquidityAdapterAccount,
} from "@/components/space/widgets/liquidity-adapters";

// The card language is exactly the SectionCard solid-lede treatment reproduced by
// the sibling Panel helpers. NOT a new card system.
function Panel({ title, subdued, children }: { title: string; subdued?: boolean; children: ReactNode }) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 h-full min-w-0">
      <p className={`text-sm font-semibold px-1 mb-2 ${subdued ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
        {title}
      </p>
      {children}
    </GlassPanel>
  );
}

function fmtMoney(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}

function fmtSigned(v: number, ctx?: ConversionContext): string {
  const abs = fmtMoney(Math.abs(v), ctx);
  return `${v >= 0 ? "+" : "−"}${abs}`;
}

/** Read one liquidity tier value out of a LensResult by metric id. A missing metric
 *  is a true zero for that tier (computeLiquidity omits availableCredit when no known
 *  limit exists); a non-ok endpoint contributes nothing. NEVER recomputes a sum. */
function metricValue(lens: LensResult | null, id: string): number {
  if (!lens || lens.status !== "ok") return 0;
  const m = lens.metrics.find((x) => x.id === id);
  return m && typeof m.value === "number" ? m.value : 0;
}

export function LiquidityWorkspace({
  spaceId,
  asOf,
  compareTo,
  today,
  active,
  accounts,
  ctx,
  presentLens,
  transactions,
  txCtx,
  period,
  onOpenCashFlow,
  onEnvelopeChange,
}: {
  spaceId: string;
  /** Resolved closing date (YYYY-MM-DD) from the shell. */
  asOf: string;
  /** Resolved opening date, or null; drives the comparison delta. */
  compareTo: string | null;
  /** The shell's "today"; asOf >= today (no comparison) ⇒ present-day (no fetch). */
  today: string;
  /** Gate — only fetch the historical contract while the Liquidity workspace is open. */
  active: boolean;
  accounts: LiquidityAdapterAccount[];
  ctx?: ConversionContext;
  /** The host's already-fetched present-day liquidity lens (lensResults["liquidity"]).
   *  Reused as `current` on the present-day branch (byte-identical, no round-trip). */
  presentLens?: LensResult | null;
  /** S4 — the shell-bridged transaction window for the What Changed panel (current
   *  anchor; transaction-window filtering relative to today, NOT a balance-as-of read). */
  transactions?: Transaction[] | null;
  txCtx?: ConversionContext;
  period?: CashFlowPeriod;
  onOpenCashFlow?: () => void;
  /** Emit the trust envelope up to the shell Completeness chip (the host owns no
   *  Liquidity data). Present-day ⇒ the current lens; historical ⇒ the atAsOf lens. */
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
}) {
  // Activate the canonical contract: fetch the whole historical envelope when a past
  // date / comparison is requested; synthesize the current-only contract from the
  // host lens present-day (no fetch).
  const { data: rawData, loading, error, reload } = useLiquiditySpaceData({
    spaceId,
    asOf,
    compareTo,
    today,
    active,
    presentLens: presentLens ?? null,
  });

  // Display-currency pass (SD-6B FX correctness): convert the reporting-currency
  // historical endpoints into the selected display currency at each endpoint's own
  // date. IDENTITY when display == reporting (the common case) — byte-unchanged.
  // This is what forecloses the symbol-only relabel bug: the tiles/delta below read
  // CONVERTED numbers, never a reporting magnitude under a display symbol.
  const data = useMemo(
    () => (rawData ? convertLiquiditySpaceData(rawData, ctx) : null),
    [rawData, ctx],
  );

  // Whether an FX conversion actually happened (display target ≠ reporting currency).
  // Drives an honest "shown in <target>" provenance note on the reconstructed ladder.
  const fxConverted = !!(ctx && rawData && rawData.reportingCurrency !== ctx.target);

  // The temporal endpoint drives the lede + Ladder when a historical reconstruction
  // is present and ok; otherwise the live current lens does.
  const atAsOf = data?.atAsOf ?? null;
  const showAsOf = atAsOf != null && atAsOf.status === "ok";
  const delta = data?.delta ?? null;
  const trust = data?.trust ?? null;
  // The lens the lede reads: the reconstructed as-of lens when historical, else the
  // live current lens (data.current === the host present lens present-day).
  const ledeLens: LensResult | null = showAsOf ? atAsOf : (data?.current ?? null);

  // Emit the trust envelope from whichever endpoint is on screen — the atAsOf lens
  // carries the as-of completeness (held-flat / estimated), so the shell chip is
  // honest for the SELECTED date, not stuck on current state. Reuses the ONE
  // canonical resolver; the host no longer owns Liquidity data for the chip.
  useEffect(() => {
    onEnvelopeChange(
      resolvePerspectiveEnvelope({ perspectiveId: "liquidity", lensResult: ledeLens }),
    );
  }, [ledeLens, onEnvelopeChange]);

  // ⓪ Lens lede — the verdict SENTENCE only, never a second cashNow KPI (the lens
  // headline is the same figure Accessible Cash / the Ladder leads with — the
  // duplicate-KPI rule). Historical adds an "as of {date}" tag and the honest as-of
  // trust reason beneath the sentence (data.trust — presented, never recomputed).
  function renderLede(): ReactNode {
    if (!ledeLens || ledeLens.status !== "ok" || !ledeLens.verdict) return null;
    const freshnessLabel = showAsOf ? formatDate(asOf) : (ledeLens.provenance.dataAsOf ? formatDate(ledeLens.provenance.dataAsOf) : null);
    const redactions = ledeLens.provenance.redactions?.length ?? 0;
    return (
      <div className="min-w-0 lg:col-span-12">
        <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
          <p className="text-sm text-[var(--text-primary)] leading-snug">
            {ledeLens.estimated ? "≈ " : ""}{ledeLens.verdict}
          </p>
          {(freshnessLabel || redactions > 0) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
              {freshnessLabel && <span className="text-[11px] text-[var(--text-faint)]">as of {freshnessLabel}</span>}
              {redactions > 0 && (
                <span className="text-[11px] text-[var(--text-faint)]">{redactions} account detail{redactions === 1 ? "" : "s"} withheld</span>
              )}
            </div>
          )}
          {/* As-of trust envelope — presented, never recomputed (data.trust re-surfaces
              the atAsOf completeness). Present only on the historical path. */}
          {showAsOf && trust && trust.tier !== "observed" && (
            <p className="text-[11px] text-[#f59e0b] mt-1 leading-snug">{trust.reason}</p>
          )}
        </GlassPanel>
      </div>
    );
  }

  // ③ Reachability by Type — a donut over the five classifyAccounts type totals.
  // CURRENT ANCHOR (per-account, live) — unchanged from the current-state render.
  function renderReachability(): ReactNode {
    const c = classifyAccounts(accounts, ctx);
    const items: BreakdownItem[] = [
      { id: "checking",    label: "Checking",    value: c.totalChecking,      color: "#22c55e" },
      { id: "savings",     label: "Savings",     value: c.totalSavings,       color: "#16a34a" },
      { id: "investments", label: "Investments", value: c.totalInvestments,   color: "#3b82f6" },
      { id: "crypto",      label: "Crypto",      value: c.totalDigitalAssets, color: "#60a5fa" },
      { id: "other",       label: "Other",       value: c.totalRealAssets,    color: "#6b7280" },
    ].filter((i) => i.value > 0);

    const total = items.reduce((s, i) => s + i.value, 0);
    const top = items.reduce<BreakdownItem | null>((best, i) => (best && best.value >= i.value ? best : i), null);
    const footer = top && total > 0
      ? <p className="text-[11px] text-[var(--text-faint)] text-center">Top type: {top.label} · {((top.value / total) * 100).toFixed(0)}%</p>
      : undefined;

    return (
      <BreakdownWidget
        items={items}
        viewMode="donut"
        itemNoun="type"
        formatValue={(v) => fmtMoney(v, ctx)}
        footer={footer}
        emptyHeadline="No assets yet"
        emptySubline="Connect asset accounts to see how reachable your money is by type."
      />
    );
  }

  // ② Liquidity Ladder — the ONE temporal panel. Present day: the per-account tier
  // tiles (LiquidityLadderTiers, current anchor). Historical: the reconstructed
  // as-of tiers from the canonical atAsOf metrics + per-tier delta chips.
  function renderLadder(): ReactNode {
    if (!showAsOf) {
      return <LiquidityLadderTiers accounts={accounts} ctx={ctx} />;
    }

    // Reconstructed ladder — re-surface the canonical atAsOf tier metrics (NEVER a
    // re-partition of accounts): cashNow → Available now, marketable → Available in
    // days, illiquid → Illiquid. Same tier vocabulary + colors as the live tiles.
    const tiers = [
      { id: "now",      label: "Available now",     color: "#22c55e", meta: "Checking · savings",              value: metricValue(atAsOf, "cashNow"),    d: delta?.cashNow },
      { id: "days",     label: "Available in days", color: "#3b82f6", meta: "Brokerage · crypto (settlement)", value: metricValue(atAsOf, "marketable"), d: delta?.marketable },
      { id: "illiquid", label: "Illiquid",          color: "#6b7280", meta: "Property · other long-term",      value: metricValue(atAsOf, "illiquid"),   d: delta?.illiquid },
    ].filter((t) => t.value !== 0 || (t.d != null && t.d !== 0));

    const credit = metricValue(atAsOf, "availableCredit");

    return (
      <div className="space-y-3">
        <p className="text-[11px] text-[var(--text-faint)]">
          Reconstructed as of {formatDate(asOf)}
          {delta && <> · change since {formatDate(delta.from)}</>}
          {/* Honest FX provenance — only when the display currency differs from the
              reporting currency (a "view as" override), so the reconstructed figures
              were numerically converted at each date's rate (≈ where a rate was
              unavailable). Absent on the identity path (display == reporting). */}
          {fxConverted && ctx && (
            <> · shown in {ctx.target}{atAsOf?.estimated ? " (some rates estimated)" : ""}</>
          )}
        </p>
        {tiers.map((tier) => (
          <div key={tier.id} className="rounded-xl border p-3" style={{ background: "var(--surface-inset)", borderColor: "var(--border-subtle, rgba(255,255,255,0.06))" }}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 min-w-0">
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: tier.color }} />
                <span className="text-sm font-medium text-[var(--text-primary)] truncate">{tier.label}</span>
              </span>
              <span className="flex items-baseline gap-2 shrink-0">
                {tier.d != null && tier.d !== 0 && (
                  <span className="text-[11px] tabular-nums" style={{ color: tier.d >= 0 ? "var(--accent-positive, #22c55e)" : "#ef4444" }}>
                    {fmtSigned(tier.d, ctx)}
                  </span>
                )}
                <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{fmtMoney(tier.value, ctx)}</span>
              </span>
            </div>
            <p className="text-[10px] text-[var(--text-faint)] mt-0.5">{tier.meta}</p>
          </div>
        ))}

        {/* Net accessible change — Δcash + Δmarketable + Δilliquid (credit EXCLUDED,
            liquidity.core doctrine). Present only on a comparison. */}
        {delta && (
          <div className="rounded-lg px-3 py-2 flex items-center justify-between gap-2" style={{ background: "var(--surface-inset)" }}>
            <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">Net accessible change</span>
            <span className="text-sm font-semibold tabular-nums" style={{ color: delta.net >= 0 ? "var(--accent-positive, #22c55e)" : "#ef4444" }}>
              {fmtSigned(delta.net, ctx)}
            </span>
          </div>
        )}

        {/* Unused credit — borrowing capacity, shown separately and NEVER counted as
            liquidity (doctrine). Only when a known limit produced a figure. */}
        {credit > 0 && (
          <p className="text-[10px] text-[var(--text-faint)]">
            Unused credit (borrowing capacity, not liquidity): {fmtMoney(credit, ctx)}
          </p>
        )}

        {error && (
          <button
            type="button"
            onClick={reload}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <RefreshCw size={11} /> Couldn’t load as-of liquidity — retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch min-w-0">
      {/* ⓪ Lens lede — slim strip, present only on an ok LensResult. */}
      {renderLede()}

      {/* ① KPI column — Accessible Cash over Emergency Fund Readiness. CURRENT
           ANCHOR (live per-account readings). */}
      <div className="min-w-0 lg:col-span-5 xl:col-span-4 flex flex-col gap-4">
        <Panel title="Accessible Cash">
          {renderAccessibleCash(accounts, ctx)}
        </Panel>
        <Panel title="Emergency Fund Readiness" subdued>
          {renderEmergencyFundReadiness(accounts, ctx)}
        </Panel>
      </div>

      {/* ② Liquidity Ladder — the temporal panel (current tiles / reconstructed
           as-of tiers + delta). The visually dominant column. */}
      <div className="min-w-0 lg:col-span-7 xl:col-span-8">
        <Panel title={showAsOf ? "Liquidity Ladder · as of" : "Liquidity Ladder"}>
          {loading && !showAsOf && (
            <p className="text-[11px] text-[var(--text-faint)] mb-2">Loading as-of liquidity…</p>
          )}
          {renderLadder()}
        </Panel>
      </div>

      {/* ③ Reachability by Type — donut over classifyAccounts type totals. CURRENT ANCHOR. */}
      <div className="min-w-0 lg:col-span-6 xl:col-span-5">
        <Panel title="Reachability by Type">
          {renderReachability()}
        </Panel>
      </div>

      {/* ④ Liquidity Concentration — ranked bars of reachable-now accounts. CURRENT ANCHOR. */}
      <div className="min-w-0 lg:col-span-6 xl:col-span-7">
        <Panel title="Liquidity Concentration">
          {renderLiquidityConcentration(accounts, ctx)}
        </Panel>
      </div>

      {/* ⑤ What Changed — top liquidity drivers for the shell-bridged window, with a
           doorway to the Cash Flow workspace. CURRENT ANCHOR (window relative to today). */}
      {period && (
        <div className="min-w-0 lg:col-span-12">
          <Panel title={`What Changed · ${periodLabel(period)}`}>
            <LiquidityWhatChangedCard
              transactions={transactions}
              accounts={accounts}
              period={period}
              ctx={txCtx}
              onOpenCashFlow={onOpenCashFlow}
            />
          </Panel>
        </div>
      )}
    </div>
  );
}
