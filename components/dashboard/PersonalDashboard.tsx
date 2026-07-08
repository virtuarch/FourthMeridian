"use client";

/**
 * components/dashboard/PersonalDashboard.tsx
 *
 * SP-2A-4c — the Personal shell flip's client controller.
 *
 * `page.tsx` (a Server Component) cannot pass a function prop to the
 * "use client" SpaceDashboard, and `renderHero` is a render-prop. This thin
 * client boundary is the smallest thing that closes that gap: it owns the
 * two pieces of hero interaction state the extracted PersonalHero needs
 * (chartInterval, viewOverride), derives the hero's KPI/allocation/cash-flow
 * numbers from the server-fetched Personal data closed over here (no
 * duplicate fetching), and injects the untouched PersonalHero into
 * SpaceDashboard's `renderHero` seam (SP-2A-4a).
 *
 * The derived-data math is lifted verbatim from DashboardClient's overview
 * branch — this is the hero's data controller that naturally accompanies the
 * SP-2A-4b view extraction. Everything else (rail, tabs, sections, goals,
 * accounts, transactions drawer) is the shared SpaceDashboard shell,
 * unchanged. Server-only data the hero needs (FICO, hero moneyCtx) arrives as
 * serializable props from page.tsx.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SpaceDashboard } from "@/components/dashboard/SpaceDashboard";
import { PersonalHero } from "@/components/dashboard/PersonalHero";
import { Interval, cutoffForInterval } from "@/components/charts/NetWorthChart";
import { classifyAccounts } from "@/lib/account-classifier";
import { convertMoney, rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { useDisplayCurrency } from "@/lib/currency-context";
import { type ViewOverride } from "@/components/dashboard/widgets/ViewCurrencyOverride";
import type { Account, Snapshot, Transaction } from "@/types";

interface Props {
  // Identity props forwarded to the shared shell.
  spaceId:       string;
  spaceName:     string;
  spaceType:     string;
  category:      string;
  myRole:        string;
  currentUserId: string;
  /** Mapped from the legacy `?tab=` deep link by page.tsx (unknown ⇒ OVERVIEW). */
  initialTab:    string;

  // Server-fetched Personal data the hero derives from (closed over here).
  accounts:      Account[];
  snapshots:     Snapshot[];
  transactions:  Transaction[];
  ficoScore:     number | null;
  /** Serialized Space conversion context; absent ⇒ context-less math (kill switch). */
  moneyCtx?:     SerializedConversionContext;
}

export function PersonalDashboard({
  spaceId, spaceName, spaceType, category, myRole, currentUserId, initialTab,
  accounts, snapshots, transactions, ficoScore, moneyCtx,
}: Props) {
  const router = useRouter();

  // MC1 P3 Slice 6 — rehydrate once; undefined preserves the context-less
  // fallback path. MC1 P4 Slice 8 (D-10) — the EPHEMERAL "view as" override:
  // pure in-memory state, never persisted; a reload resets to the Space's
  // saved currency by construction.
  const conversionCtx = useMemo(
    () => (moneyCtx ? rehydrateContext(moneyCtx) : undefined),
    [moneyCtx],
  );
  const [viewOverride, setViewOverride] = useState<ViewOverride | null>(null);
  const effectiveCtx = useMemo(
    () => (viewOverride ? rehydrateContext(viewOverride.moneyCtx) : conversionCtx),
    [viewOverride, conversionCtx],
  );

  const displayCurrency = useDisplayCurrency();
  const effectiveDisplayCurrency = viewOverride?.currency ?? displayCurrency;

  // Shared chart interval — the hero owns the control; kept here so its value
  // survives hero remounts and feeds the % change below.
  const [chartInterval, setChartInterval] = useState<Interval>("1M");

  // Full-portfolio classification (allocation donut + KPI totals). Converts
  // into the Space's reporting currency when a context is present (identical
  // math for all-USD Spaces).
  const classification = useMemo(() => classifyAccounts(accounts, effectiveCtx), [accounts, effectiveCtx]);

  const allocation = {
    cash:        classification.totalLiquid,
    investments: classification.totalInvestments,
    crypto:      classification.totalDigitalAssets,
    debt:        classification.totalLiabilities,
    realAssets:  classification.totalRealAssets,
  };

  const latest = snapshots[snapshots.length - 1];

  const changeForInterval = useMemo(() => {
    if (!latest) return 0;
    const cutoff = cutoffForInterval(chartInterval);
    const snap = snapshots.find((s) => s.date >= cutoff) ?? snapshots[0];
    return snap ? latest.netWorth - snap.netWorth : 0;
  }, [snapshots, latest, chartInterval]);

  // Net Worth % change — same formula NetWorthCard used (prevWorth = current −
  // Δ), against the full-portfolio classification. null with no history (no
  // fabricated "0.0%" on a brand-new Space).
  const netWorthChangePct = useMemo(() => {
    if (!latest) return null;
    const prevWorth = classification.netWorth - changeForInterval;
    return prevWorth !== 0 ? (changeForInterval / Math.abs(prevWorth)) * 100 : 0;
  }, [latest, classification.netWorth, changeForInterval]);

  // Cash Flow (MTD) — real signed sum of this calendar month's transactions
  // (income − spend), with a vs.-last-month % change when last month has any
  // transactions. MC1 QA Q2 — each row converts at its own date; identity for
  // all-USD, so numbers are unchanged there.
  const cashFlow = useMemo(() => {
    const now = new Date();
    const ym = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;
    const thisYm = ym(now.getFullYear(), now.getMonth());
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevYm = ym(prevDate.getFullYear(), prevDate.getMonth());

    const convFor = (label: string) =>
      transactions
        .filter((t) => t.date.slice(0, 7) === label)
        .map((t) =>
          effectiveCtx
            ? convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, effectiveCtx)
            : { amount: t.amount, estimated: false },
        );
    const mtdConv = convFor(thisYm);
    const mtd = mtdConv.reduce((s, c) => s + c.amount, 0);
    const hasPrevMonth = transactions.some((t) => t.date.slice(0, 7) === prevYm);
    const prevConv = hasPrevMonth ? convFor(prevYm) : null;
    const prev = prevConv ? prevConv.reduce((s, c) => s + c.amount, 0) : null;
    const changePct = prev !== null && prev !== 0 ? ((mtd - prev) / Math.abs(prev)) * 100 : null;

    return { mtd, changePct, estimated: [...mtdConv, ...(prevConv ?? [])].some((c) => c.estimated) };
  }, [transactions, effectiveCtx]);

  return (
    <SpaceDashboard
      key={spaceId}
      spaceId={spaceId}
      spaceName={spaceName}
      spaceType={spaceType}
      category={category}
      myRole={myRole}
      currentUserId={currentUserId}
      initialTab={initialTab}
      renderHero={() => (
        <PersonalHero
          accountCount={accounts.length}
          snapshots={snapshots}
          transactions={transactions}
          estimated={classification.estimated}
          netWorth={classification.netWorth}
          netWorthChangePct={netWorthChangePct}
          totalAssets={classification.totalAssets}
          totalLiabilities={classification.totalLiabilities}
          cashFlowMTD={cashFlow.mtd}
          cashFlowEstimated={cashFlow.estimated}
          cashFlowChangePct={cashFlow.changePct}
          ficoScore={ficoScore}
          allocation={allocation}
          chartInterval={chartInterval}
          onChartIntervalChange={setChartInterval}
          spaceCurrency={displayCurrency}
          effectiveDisplayCurrency={effectiveDisplayCurrency}
          viewOverride={viewOverride}
          onViewOverrideChange={setViewOverride}
          onCreditClick={() => router.push("/dashboard/credit")}
        />
      )}
    />
  );
}
