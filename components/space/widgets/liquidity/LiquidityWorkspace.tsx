"use client";

/**
 * components/space/widgets/liquidity/LiquidityWorkspace.tsx
 *
 * The Liquidity WORKSPACE — rebuilt in the editorial idiom (the Debt redesign), presentation
 * only. It reuses the SD-6B LiquiditySpaceData contract + useLiquiditySpaceData hook + every
 * figure authority VERBATIM (no data / contract / engine / trust change) and re-composes them
 * as a stacked, generously-spaced read surface rather than a 12-col KPI card grid:
 *
 *   ① Summary        LiquidityHero          — accessible cash + coverage + window delta + trust
 *   ② Balance history LiquidityBalanceHistory — the cashNow tier over time (shared TrendChart)
 *   ③ Sources        SourcesLedger / tiers   — grouped weight-bar ledger → Left/Right panels
 *   ④ Resilience     coverage · concentration · reachability mix
 *   ⑤ What changed   the shell-bridged driver window → Cash Flow doorway
 *
 * ── The live anchor + the time machine (unchanged) ──────────────────────────────────────
 * The account-array surfaces (the Hero headline, Sources ledger, Resilience) are the LIVE
 * CURRENT ANCHOR — per-account readings of money you can reach RIGHT NOW, sourced from the
 * visibility-filtered `accounts` array (they cannot be reconstructed per-account historically,
 * and are never faked into the past). The TEMPORAL layer rides ONE surface — the Sources block:
 *   • present day  → the current lens verdict (Hero) + the per-account SourcesLedger.
 *   • historical   → the atAsOf lens verdict (Hero) + a reconstructed ladder from the canonical
 *                    atAsOf tier metrics (cashNow / marketable / illiquid), with per-tier delta
 *                    chips (compareTo → asOf) and the honest as-of trust envelope.
 *
 * The Hero SAYS this in a historical view (the headline is present-day; only the trend, verdict,
 * and trust honour the selected date) rather than letting a present-day figure pass as as-of.
 *
 * The Ladder RE-SURFACES computeLiquidity's tier metrics — it never re-partitions accounts or
 * recomputes a liquidity sum. Crypto is counted exactly once by the engine (the splice REPLACES
 * a wallet's held-flat estimate with its A8 value); this workspace inherits that and adds nothing.
 *
 * FX posture (no new authority): the current-anchor surfaces convert live balances through the
 * existing ConversionContext seam. The historical endpoints pass through the pure
 * `convertLiquiditySpaceData` (the ONE canonical money authority) per-date; the cashNow chart
 * series passes through `convertCashHistory`. A missing rate degrades to an honest `estimated`
 * (≈) flag, never a silent relabel. The lede prose (`verdict`) stays the engine's self-consistent
 * reporting-currency sentence.
 *
 * Owns NO time state — asOf / compareTo / today are shell props threaded into the hook.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { classifyAccounts } from "@/lib/account-classifier";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot, Transaction } from "@/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { useSpaceSectionsPublisher, type SpaceChromeSection } from "@/lib/space/space-chrome-context";
import { convertLiquiditySpaceData } from "@/lib/liquidity/display-conversion";
import { clipCashHistory, convertCashHistory } from "@/lib/liquidity/cash-history";
import { periodLabel, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { Surface, Block } from "@/components/atlas/Surface";
import { LiquidityHero, type LiquidityWindowChange, type LiquidityCoverage } from "./LiquidityHero";
import { LiquidityBalanceHistory } from "./LiquidityBalanceHistory";
import { SourcesLedger } from "./SourcesLedger";
import { buildSourceRows } from "./liquidity-sources-util";
import { LiquidityWhatChangedCard } from "./LiquidityWhatChangedCard";
import { useLiquiditySpaceData } from "./useLiquiditySpaceData";
import type { LiquidityAdapterAccount } from "@/components/space/widgets/liquidity-adapters";

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
  snapshots,
  snapshotCurrency,
  monthlyExpenses,
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
  /** The host's already-read Balance-Over-Time snapshots (the SAME array Wealth/Debt read) —
   *  the cashNow series is clipped from it. No new fetch (L0 — Debt precedent). */
  snapshots?: Snapshot[] | null;
  /** The stamped currency of the snapshot series (the history basis). */
  snapshotCurrency: string;
  /** The Space's monthly-expense baseline (emergency_fund_progress config), or null.
   *  Drives the honest Coverage stat; absent ⇒ no coverage shown (never fabricated). */
  monthlyExpenses?: number | null;
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

  // Display-currency pass (SD-6B FX correctness): convert the reporting-currency historical
  // endpoints into the selected display currency at each endpoint's own date. IDENTITY when
  // display == reporting (the common case). This forecloses the symbol-only relabel bug.
  const data = useMemo(
    () => (rawData ? convertLiquiditySpaceData(rawData, ctx) : null),
    [rawData, ctx],
  );

  // Whether an FX conversion actually happened (display target ≠ reporting currency).
  const fxConverted = !!(ctx && rawData && rawData.reportingCurrency !== ctx.target);

  const atAsOf = data?.atAsOf ?? null;
  const showAsOf = atAsOf != null && atAsOf.status === "ok";
  const delta = data?.delta ?? null;
  // The lens the lede reads: the reconstructed as-of lens when historical, else the live
  // current lens (data.current === the host present lens present-day).
  const ledeLens: LensResult | null = showAsOf ? atAsOf : (data?.current ?? null);

  // The trust envelope from whichever endpoint is on screen — computed ONCE and shared by
  // the shell (onEnvelopeChange) and the Hero's TrustIndicator, so the two can never disagree.
  const envelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "liquidity", lensResult: ledeLens }),
    [ledeLens],
  );
  useEffect(() => { onEnvelopeChange(envelope); }, [envelope, onEnvelopeChange]);

  // FIGURES OF RECORD — present-day, from the accounts array (never the lens). The Hero
  // headline (cashNow tier) is the SAME figure the SourcesLedger sums, so they agree.
  const classification = useMemo(() => classifyAccounts(accounts, ctx), [accounts, ctx]);
  const cashNow = classification.totalLiquid;
  const reachableSoon = classification.totalInvestments + classification.totalDigitalAssets;
  const sharePctNow = classification.totalAssets > 0 ? (cashNow / classification.totalAssets) * 100 : null;
  const nowSourceCount = classification.liquid.filter((a) => a.balance > 0).length;

  const displayCurrency = ctx?.target ?? DEFAULT_DISPLAY_CURRENCY;
  const historical = asOf < today;

  // ② Balance history — the cashNow tier over time, clipped to the shell window from the
  // host snapshots (no new fetch) + per-date FX. The chart is the ONLY honestly-continuous
  // historical surface (per-account panels stay present-day).
  const cashHistory = useMemo(
    () => convertCashHistory(clipCashHistory(snapshots ?? [], asOf, compareTo, snapshotCurrency), ctx),
    [snapshots, asOf, compareTo, snapshotCurrency, ctx],
  );

  // Balance-history WINDOW delta for the Hero (cashNow snapshot basis — the figure the chart
  // states). Only real when ≥2 in-window points exist; never invented.
  const change = useMemo<LiquidityWindowChange | null>(() => {
    const pts = cashHistory?.points ?? [];
    if (pts.length < 2) return null;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const abs = last.cashNow - first.cashNow;
    const pct = first.cashNow !== 0 ? (abs / first.cashNow) * 100 : null;
    return { abs, pct, fromLabel: formatDate(first.date) };
  }, [cashHistory]);

  // Coverage months — honest ONLY when a monthly-expense baseline exists (never fabricated).
  const coverage = useMemo<LiquidityCoverage | null>(() => {
    if (monthlyExpenses == null || !(monthlyExpenses > 0) || cashNow <= 0) return null;
    return { months: cashNow / monthlyExpenses, monthlyExpenses };
  }, [monthlyExpenses, cashNow]);

  // Cash concentration signal (Resilience) — the top reachable-now source's share of cashNow,
  // via the SAME one-FX-pass the ledger uses (no bespoke FX here). Present-day anchor.
  const concentration = useMemo(() => {
    const nowRows = buildSourceRows(accounts, ctx).filter((r) => r.horizon === "now");
    const total = nowRows.reduce((s, r) => s + r.value, 0);
    if (total <= 0 || nowRows.length === 0) return null;
    const top = nowRows[0]; // buildSourceRows is sorted largest-first
    return { topName: top.account.name, topShare: top.value / total, count: nowRows.length };
  }, [accounts, ctx]);

  // The lens verdict SENTENCE (prose only — never a figure of record).
  const verdict = ledeLens && ledeLens.status === "ok" && ledeLens.verdict ? ledeLens.verdict : null;
  const verdictAsOf = verdict
    ? (showAsOf ? formatDate(asOf) : (ledeLens?.provenance.dataAsOf ? formatDate(ledeLens.provenance.dataAsOf) : null))
    : null;
  const redactions = verdict ? (ledeLens?.provenance.redactions?.length ?? 0) : 0;

  // Publish section anchors to the sidebar (cleared on unmount).
  const publishSections = useSpaceSectionsPublisher();
  useEffect(() => {
    const sections: SpaceChromeSection[] = [
      { label: "Summary",         anchor: "liquidity-summary" },
      { label: "Balance history", anchor: "liquidity-history" },
      { label: "Sources",         anchor: "liquidity-sources" },
      { label: "Resilience",      anchor: "liquidity-resilience" },
      ...(period ? [{ label: "Activity", anchor: "liquidity-activity" }] : []),
    ];
    publishSections(sections);
    return () => publishSections([]);
  }, [publishSections, period]);

  return (
    <div className="space-y-8 sm:space-y-10 min-w-0">
      {loading && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-[var(--text-faint)]">
          <RefreshCw size={12} className="animate-spin" aria-label="Refreshing" /> Updating…
        </div>
      )}

      {/* ① Summary — the editorial lede. */}
      <div id="liquidity-summary" className="scroll-mt-20">
        <LiquidityHero
          cashNow={cashNow}
          reachableSoon={reachableSoon}
          sharePctNow={sharePctNow}
          sourceCount={nowSourceCount}
          coverage={coverage}
          estimated={classification.estimated}
          currency={displayCurrency}
          asOf={asOf}
          today={today}
          historical={historical}
          change={change}
          envelope={envelope}
          verdict={verdict}
          verdictAsOf={verdictAsOf}
          redactions={redactions}
        />
      </div>

      {/* ② Balance history — accessible cash over time, the SHARED TrendChart. */}
      <div id="liquidity-history" className="scroll-mt-20">
        <LiquidityBalanceHistory history={cashHistory} currency={displayCurrency} asOf={asOf} compareTo={compareTo} />
        {error && (
          <button
            type="button"
            onClick={reload}
            className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <RefreshCw size={11} /> Couldn&rsquo;t load as-of history — retry
          </button>
        )}
      </div>

      {/* ③ Sources — present-day per-account ledger, or the reconstructed as-of tiers. */}
      <Block
        id="liquidity-sources"
        label="Sources"
        hint={!showAsOf && <span className="text-[11px] tabular-nums text-[var(--text-faint)]">{nowSourceCount}</span>}
        action={
          <span className="text-[11px] text-[var(--text-faint)]">
            {showAsOf ? `Reconstructed as of ${formatDate(asOf)}` : "Bar shows share of assets"}
          </span>
        }
      >
        {showAsOf ? renderHistoricalTiers() : <SourcesLedger accounts={accounts} ctx={ctx} currency={displayCurrency} />}
      </Block>

      {/* ④ Resilience & Risk — coverage, cash concentration, reachability mix (present-day anchor). */}
      <Block id="liquidity-resilience" label="Resilience & risk">
        <div className="grid gap-4 lg:grid-cols-3 items-start min-w-0">
          {/* Emergency coverage — conditional on a monthly-expense baseline. */}
          <Surface className="p-4 min-w-0">
            <SubHeading>Emergency coverage</SubHeading>
            {coverage ? (
              <>
                <p className="text-2xl font-semibold tabular-nums" style={{ color: coverage.months >= 6 ? "var(--accent-positive)" : coverage.months >= 3 ? "#f59e0b" : "var(--accent-negative)" }}>
                  {coverage.months.toFixed(1)} months
                </p>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  {fmtMoney(cashNow, ctx)} reachable · at {fmtMoney(coverage.monthlyExpenses, ctx)}/mo
                </p>
              </>
            ) : (
              <>
                <p className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]">{fmtMoney(cashNow, ctx)}</p>
                <p className="mt-1 text-[11px] text-[var(--text-faint)]">
                  in reachable cash · set a monthly expense target to see months of coverage
                </p>
              </>
            )}
          </Surface>

          {/* Cash concentration — is reachable cash spread out or in one account? */}
          <Surface className="p-4 min-w-0">
            <SubHeading>Cash concentration</SubHeading>
            {concentration ? (
              <>
                <p className="text-2xl font-semibold tabular-nums" style={{ color: concentration.topShare >= 0.7 ? "#f59e0b" : "var(--text-primary)" }}>
                  {(concentration.topShare * 100).toFixed(0)}%
                </p>
                <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
                  in <span className="text-[var(--text-secondary)]">{concentration.topName}</span>
                  {concentration.count > 1 ? ` · across ${concentration.count} accounts` : " · your only cash account"}
                </p>
              </>
            ) : (
              <p className="text-[11px] text-[var(--text-faint)]">No reachable cash yet.</p>
            )}
          </Surface>

          {/* Reachability mix — how much is reachable now vs within days. */}
          <Surface className="p-4 min-w-0">
            <SubHeading>Reachability</SubHeading>
            {cashNow + reachableSoon > 0 ? (
              <>
                <ReachBar now={cashNow} soon={reachableSoon} />
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-muted)]">
                  <span className="inline-flex items-center gap-1.5"><Dot color="#22c55e" />Now {fmtMoney(cashNow, ctx)}</span>
                  <span className="inline-flex items-center gap-1.5"><Dot color="#3b82f6" />Days {fmtMoney(reachableSoon, ctx)}</span>
                </p>
              </>
            ) : (
              <p className="text-[11px] text-[var(--text-faint)]">No reachable assets yet.</p>
            )}
          </Surface>
        </div>
      </Block>

      {/* ⑤ What changed — top liquidity drivers for the shell-bridged window, with a
           doorway to the Cash Flow workspace. CURRENT ANCHOR (window relative to today). */}
      {period && (
        <Block id="liquidity-activity" label={`What changed · ${periodLabel(period)}`}>
          <Surface className="p-4 min-w-0">
            <LiquidityWhatChangedCard
              transactions={transactions}
              accounts={accounts}
              period={period}
              ctx={txCtx}
              onOpenCashFlow={onOpenCashFlow}
            />
          </Surface>
        </Block>
      )}
    </div>
  );

  // ── Historical Sources — reconstructed as-of tiers ─────────────────────────────────────
  // Re-surface the canonical atAsOf tier metrics (NEVER a re-partition of accounts): cashNow →
  // Available now, marketable → Available in days, illiquid → Illiquid. Same tier vocabulary +
  // colors as the live ledger. Per-account historical rows are not carried by the contract, so
  // the ledger honestly degrades to tier totals + delta chips here (said in the block header).
  function renderHistoricalTiers(): ReactNode {
    const tiers = [
      { id: "now",      label: "Available now",     color: "#22c55e", meta: "Checking · savings",              value: metricValue(atAsOf, "cashNow"),    d: delta?.cashNow },
      { id: "days",     label: "Available in days", color: "#3b82f6", meta: "Brokerage · crypto (settlement)", value: metricValue(atAsOf, "marketable"), d: delta?.marketable },
      { id: "illiquid", label: "Illiquid",          color: "#6b7280", meta: "Property · other long-term",      value: metricValue(atAsOf, "illiquid"),   d: delta?.illiquid },
    ].filter((t) => t.value !== 0 || (t.d != null && t.d !== 0));

    const credit = metricValue(atAsOf, "availableCredit");

    return (
      <div className="space-y-3">
        <p className="text-[11px] text-[var(--text-faint)]">
          Tier totals reconstructed for {formatDate(asOf)}
          {delta && <> · change since {formatDate(delta.from)}</>}
          {fxConverted && ctx && (
            <> · shown in {ctx.target}{atAsOf?.estimated ? " (some rates estimated)" : ""}</>
          )}
          {" · "}per-account detail is current only.
        </p>
        {tiers.map((tier) => (
          <Surface key={tier.id} className="p-3">
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
          </Surface>
        ))}

        {/* Net accessible change — Δcash + Δmarketable + Δilliquid (credit EXCLUDED). */}
        {delta && (
          <Surface tone="sunken" className="px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">Net accessible change</span>
            <span className="text-sm font-semibold tabular-nums" style={{ color: delta.net >= 0 ? "var(--accent-positive, #22c55e)" : "#ef4444" }}>
              {fmtSigned(delta.net, ctx)}
            </span>
          </Surface>
        )}

        {/* Unused credit — borrowing capacity, NEVER counted as liquidity (doctrine). */}
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
            <RefreshCw size={11} /> Couldn&rsquo;t load as-of liquidity — retry
          </button>
        )}
      </div>
    );
  }
}

/** The quiet in-Surface heading (Block owns the section label; this labels a sub-panel). */
function SubHeading({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{children}</p>;
}

function Dot({ color }: { color: string }) {
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

/** A two-segment reachability bar — now (green) vs within days (blue). Pure presentation. */
function ReachBar({ now, soon }: { now: number; soon: number }) {
  const total = now + soon || 1;
  const nowPct = (now / total) * 100;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-inset)]">
      <div className="h-full" style={{ width: `${nowPct}%`, backgroundColor: "#22c55e" }} />
      <div className="h-full" style={{ width: `${100 - nowPct}%`, backgroundColor: "#3b82f6" }} />
    </div>
  );
}
