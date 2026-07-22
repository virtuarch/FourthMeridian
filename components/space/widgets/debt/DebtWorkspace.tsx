"use client";

/**
 * components/space/widgets/debt/DebtWorkspace.tsx
 *
 * The Debt WORKSPACE — rebuilt in the Net Worth / prototype EDITORIAL idiom (the
 * Investments redesign, c944694), presentation only. It reuses the SD-6A
 * DebtSpaceData contract + useDebtSpaceData hook + every figure authority VERBATIM
 * (no data / contract / engine / trust change) and re-composes them as a stacked,
 * generously-spaced read surface rather than a 12-col KPI card grid:
 *
 *   ① Summary        DebtHero        — total owed + balance-history window delta + trust
 *   ② Balance history DebtBalanceChart — liability balance over time (Net Worth chart idiom)
 *   ③ Liabilities    LiabilitiesLedger — grouped weight-bar ledger → Left/Right panels
 *   ④ Cost & risk    utilization + interest cost
 *   ⑤ Payoff strategy the interactive planner + preset scenarios
 *   ⑥ Credit health  FICO + deterministic signals + the missing-info editor
 *
 * DUAL-AUTHORITY (load-bearing, unchanged — plan §1.4): every VISIBLE FIGURE is
 * PRESENTATION-DERIVED from the visibility-filtered `accounts` array (computeDebtKpis /
 * computePayoffAggregate / the ledger / signals) — NEVER the lens. The lens drives only
 * the prose verdict in the hero; the two can legitimately disagree.
 *
 * TEMPORAL HONESTY (Debt is temporalCapability: PARTIAL): the lede's window delta, the
 * Balance-history chart, the verdict, and the trust chip honour asOf/compareTo; the
 * headline total, ledger, utilization, and payoff are PRESENT-DAY. The hero SAYS this in
 * a historical view rather than letting a present-day figure pass as as-of.
 *
 * Owns NO time state — asOf / compareTo / today are shell props threaded into the hook.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { Check, AlertTriangle, Loader2 } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { useSpaceSectionsPublisher, type SpaceChromeSection } from "@/lib/space/space-chrome-context";
import { convertDebtHistory } from "@/lib/debt/display-conversion";
import { Surface, Block } from "@/components/atlas/Surface";
import {
  renderDebtCost,
  CreditUtilizationWidget,
  renderCreditScore,
  renderDebtCompleteInfo,
  type DebtPerspectiveAccount,
} from "@/components/space/widgets/debt-perspective-adapters";
import { renderDebtPayoffCalculator } from "@/components/space/widgets/debt-adapters";
import { computeDebtKpis, computePayoffAggregate } from "./debt-kpis";
import { buildDebtSignals } from "./debt-signals";
import { useDebtSpaceData } from "./useDebtSpaceData";
import { DebtHero, type DebtWindowChange } from "./DebtHero";
import { DebtBalanceHistory } from "./DebtBalanceHistory";
import { LiabilitiesLedger } from "./LiabilitiesLedger";
import { PayoffScenarioStrip } from "./PayoffScenarioStrip";

/** The Debt workspace's section anchors — what the sidebar shows as "what's inside". */
const DEBT_SECTIONS: SpaceChromeSection[] = [
  { label: "Summary",         anchor: "debt-summary" },
  { label: "Balance history", anchor: "debt-history" },
  { label: "Liabilities",     anchor: "debt-liabilities" },
  { label: "Cost & risk",     anchor: "debt-costrisk" },
  { label: "Payoff",          anchor: "debt-payoff" },
  { label: "Credit health",   anchor: "debt-credit" },
];

export function DebtWorkspace({
  spaceId,
  asOf,
  compareTo,
  today,
  active,
  accounts,
  ctx,
  snapshots,
  snapshotCurrency,
  ficoScore,
  ficoUpdatedAt,
  presentLens,
  targetCurrency,
  onEnvelopeChange,
}: {
  spaceId: string;
  asOf: string;
  compareTo: string | null;
  today: string;
  active: boolean;
  accounts: DebtPerspectiveAccount[];
  ctx?: ConversionContext;
  snapshots?: Snapshot[] | null;
  snapshotCurrency: string;
  ficoScore?: number | null;
  ficoUpdatedAt?: string;
  presentLens?: LensResult | null;
  targetCurrency?: string;
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
}) {
  const { data, loading, error, reload } = useDebtSpaceData({
    spaceId,
    asOf,
    compareTo,
    today,
    active,
    presentLens: presentLens ?? null,
    snapshots,
    snapshotCurrency,
    fico: { score: ficoScore ?? null, updatedAt: ficoUpdatedAt ?? null },
    targetCurrency,
  });

  const lens = data.lens;

  // Balance-Over-Time slice, per-date FX-converted into the display currency (the ONE
  // money authority — the workspace never clips/blends inline; the contract did that).
  const history = useMemo(() => convertDebtHistory(data.history, ctx), [data.history, ctx]);

  // Canonical trust envelope from the on-screen lens (present-day OR as-of) through the
  // ONE resolver — shared by the shell (onEnvelopeChange) and the hero's TrustIndicator,
  // so the two can never disagree.
  const envelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: lens }),
    [lens],
  );
  useEffect(() => { onEnvelopeChange(envelope); }, [envelope, onEnvelopeChange]);

  // FIGURES OF RECORD — present-day, from the accounts array (never the lens).
  const kpis = computeDebtKpis(accounts, ctx);
  const payoffAgg = computePayoffAggregate(accounts, ctx);
  const signals = buildDebtSignals({ accounts, ctx, lensResult: lens });

  const displayCurrency = ctx?.target ?? DEFAULT_DISPLAY_CURRENCY;
  const historical = asOf < today;
  const hasDebt = kpis.totalDebt > 0;
  // V25-SIDE-1 — the STRUCTURAL count, so this hint matches the number of rows
  // the Liabilities ledger actually renders (paid-off cards included). It used
  // to be ratedCount + unratedCount, which now scope to indebted accounts only.
  // The HERO instead takes kpis.owingCount: it reads "<total debt> across N
  // liabilities", so its N must be the count that contributes to that total.
  const liabilityCount = kpis.accountCount;

  // Structural summary for the Liabilities header — states WHAT the section
  // holds, in the same "counts, never names" register as the rest of the
  // workspace. Only the non-zero facets appear, so an all-owed Space reads
  // exactly as it did before this slice.
  const liabilitySummary = useMemo(() => {
    const parts: string[] = [];
    if (kpis.owingCount > 0)   parts.push(`${kpis.owingCount} with a balance owed`);
    if (kpis.settledCount > 0) parts.push(`${kpis.settledCount} paid off`);
    if (kpis.creditCount > 0)  parts.push(`${kpis.creditCount} in credit`);
    return parts.join(" · ");
  }, [kpis.owingCount, kpis.settledCount, kpis.creditCount]);

  // Balance-history WINDOW delta for the hero (snapshot basis — the same figure the
  // chart states). Only real when ≥2 in-window points exist; never invented.
  const change = useMemo<DebtWindowChange | null>(() => {
    const pts = history?.points ?? [];
    if (pts.length < 2) return null;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const abs = last.totalDebt - first.totalDebt;
    const pct = first.totalDebt !== 0 ? (abs / first.totalDebt) * 100 : null;
    return { abs, pct, fromLabel: formatDate(first.date) };
  }, [history]);

  // The lens verdict SENTENCE (prose only — never a figure of record). status !== "ok"
  // ⇒ no prose (absent/empty/error). Its freshness + redaction count ride along.
  const verdict = lens && lens.status === "ok" && lens.verdict ? lens.verdict : null;
  const verdictAsOf = verdict && lens?.provenance.dataAsOf ? formatDate(lens.provenance.dataAsOf) : null;
  const redactions = verdict ? (lens?.provenance.redactions?.length ?? 0) : 0;

  // Publish section anchors to the sidebar (cleared on unmount).
  const publishSections = useSpaceSectionsPublisher();
  useEffect(() => {
    publishSections(DEBT_SECTIONS);
    return () => publishSections([]);
  }, [publishSections]);

  return (
    <div className="space-y-8 sm:space-y-10 min-w-0">
      {loading && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-[var(--text-faint)]">
          <Loader2 size={12} className="animate-spin" aria-label="Refreshing" /> Updating…
        </div>
      )}

      {/* ① Summary — the editorial lede. */}
      <div id="debt-summary" className="scroll-mt-20">
        <DebtHero
          kpis={kpis}
          currency={displayCurrency}
          liabilityCount={kpis.owingCount}
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

      {/* ② Balance history — total debt over time, the SHARED Net Worth chart (bare,
           like Investments: the chart owns its own title + legend). */}
      <div id="debt-history" className="scroll-mt-20">
        <DebtBalanceHistory history={history} currency={displayCurrency} asOf={asOf} compareTo={compareTo} />
        {error && (
          <button
            type="button"
            onClick={reload}
            className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Couldn&rsquo;t load as-of history — retry
          </button>
        )}
      </div>

      {/* ③ Liabilities — the PERSISTENT account browser. V25-SIDE-1: this Block
          used to sit inside the `hasDebt` gate below, so paying every card off
          made the entire section — and with it every trace of those accounts —
          disappear from the Debt Perspective. Its population is STRUCTURAL
          ("what liability accounts do I have, and what state are they in"),
          which is a different question from the debt-magnitude widgets beneath
          it ("how much do I owe"). It therefore renders whenever the Space has
          a liability account at all, regardless of amount owed. */}
      {liabilityCount > 0 && (
        <Block
          id="debt-liabilities"
          label="Liabilities"
          hint={<span className="text-[11px] tabular-nums text-[var(--text-faint)]">{liabilityCount}</span>}
          action={
            <span className="text-[11px] text-[var(--text-faint)]">
              {liabilitySummary}{historical ? " · current" : ""}
            </span>
          }
        >
          <LiabilitiesLedger accounts={accounts} ctx={ctx} currency={displayCurrency} />
        </Block>
      )}

      {hasDebt && (
        <>
          {/* ④ Cost & risk — utilization + estimated interest (present-day). */}
          <Block id="debt-costrisk" label="Cost & risk">
            <div className="grid gap-4 lg:grid-cols-2 items-start min-w-0">
              <Surface className="p-4 min-w-0">
                <SubHeading>Credit utilization</SubHeading>
                <CreditUtilizationWidget accounts={accounts} ctx={ctx} />
              </Surface>
              <Surface className="p-4 min-w-0">
                <SubHeading>Interest cost</SubHeading>
                {renderDebtCost(accounts, ctx)}
              </Surface>
            </div>
          </Block>

          {/* ⑤ Payoff strategy — the interactive planner + preset scenarios. */}
          <Block id="debt-payoff" label="Payoff strategy">
            <Surface className="p-4 min-w-0">
              {renderDebtPayoffCalculator(accounts, false, undefined, ctx)}
              <PayoffScenarioStrip input={payoffAgg} ctx={ctx} />
            </Surface>
          </Block>
        </>
      )}

      {/* ⑥ Credit health — the REAL manual FICO + deterministic signals + gap editor. */}
      <Block id="debt-credit" label="Credit health">
        <div className="grid gap-4 lg:grid-cols-2 items-start min-w-0">
          <Surface className="p-4 min-w-0">
            {renderCreditScore(data.fico.score, data.fico.updatedAt ?? undefined)}
            {signals.length > 0 && (
              <ul className="mt-3 space-y-1.5 border-t border-[var(--border-hairline)] pt-3">
                {signals.map((s) => (
                  <li key={s.id} className="flex items-start gap-2">
                    {s.tone === "ok"
                      ? <Check size={13} className="mt-0.5 shrink-0 text-[var(--accent-positive)]" />
                      : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[#f59e0b]" />}
                    <span className="text-[12px] leading-snug text-[var(--text-secondary)]">{s.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Surface>
          <Surface className="p-4 min-w-0">
            <SubHeading>Complete debt details</SubHeading>
            {renderDebtCompleteInfo(accounts)}
          </Surface>
        </div>
      </Block>
    </div>
  );
}

/** The quiet in-Surface heading (Block owns the section label; this labels a sub-panel). */
function SubHeading({ children }: { children: ReactNode }) {
  return <p className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{children}</p>;
}
