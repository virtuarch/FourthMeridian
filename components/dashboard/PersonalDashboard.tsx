"use client";

/**
 * components/dashboard/PersonalDashboard.tsx
 *
 * SP-2A-4c — the Personal shell flip's client controller.
 *
 * `page.tsx` (a Server Component) cannot pass a function prop to the
 * "use client" SpaceDashboard, and `renderHero` is a render-prop. This thin
 * client boundary is the smallest thing that closes that gap: it owns the
 * Personal Overview interaction state (chartInterval, the ephemeral "view as"
 * override), derives the hero's Net Worth / Allocation numbers from the
 * server-fetched Personal data closed over here (no duplicate fetching), and
 * injects the untouched PersonalHero into SpaceDashboard's `renderHero` seam.
 *
 * Currency universality: this host wraps the shared shell in
 * DisplayCurrencyProvider(effective…), so the "view as" override re-scopes
 * EVERY widget in this Space (card A, Perspectives, the hero), not just the
 * hero. No override ⇒ effective === reporting, so shared Spaces (which never
 * mount this host) are byte-identical.
 *
 * The "view as" control itself renders at the very top of the Overview via the
 * shell's `overviewTopSlot` seam — above the Net Worth card.
 */

import { useMemo, useState } from "react";
import { SpaceDashboard } from "@/components/dashboard/SpaceDashboard";
import { PersonalHero } from "@/components/dashboard/PersonalHero";
import { Interval } from "@/components/charts/NetWorthChart";
import { classifyAccounts } from "@/lib/account-classifier";
import { rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { DisplayCurrencyProvider, useDisplayCurrency } from "@/lib/currency-context";
import { ViewCurrencyOverride, type ViewOverride } from "@/components/dashboard/widgets/ViewCurrencyOverride";
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
  /** Still fetched by page.tsx; reserved for future Overview surfaces. */
  transactions:  Transaction[];
  /** Still fetched by page.tsx; Credit moves to the Debt perspective later. */
  ficoScore:     number | null;
  /** Serialized Space conversion context; absent ⇒ context-less math (kill switch). */
  moneyCtx?:     SerializedConversionContext;
}

export function PersonalDashboard({
  spaceId, spaceName, spaceType, category, myRole, currentUserId, initialTab,
  accounts, snapshots, moneyCtx,
}: Props) {
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

  // Read outside the effective provider below, so this is the Space's persisted
  // reporting currency — the "off" position for the override control.
  const displayCurrency = useDisplayCurrency();
  const effectiveDisplayCurrency = viewOverride?.currency ?? displayCurrency;

  // Chart interval — the hero owns the control; kept here so it survives hero
  // remounts.
  const [chartInterval, setChartInterval] = useState<Interval>("1M");

  // Full-portfolio classification — feeds card A (net worth / assets / debt)
  // and the allocation donut. Converts into the effective currency when a
  // context is present (identical math for all-USD Spaces).
  const classification = useMemo(() => classifyAccounts(accounts, effectiveCtx), [accounts, effectiveCtx]);

  const allocation = {
    cash:        classification.totalLiquid,
    investments: classification.totalInvestments,
    crypto:      classification.totalDigitalAssets,
    debt:        classification.totalLiabilities,
    realAssets:  classification.totalRealAssets,
  };

  return (
    <DisplayCurrencyProvider currency={effectiveDisplayCurrency}>
      <SpaceDashboard
        key={spaceId}
        spaceId={spaceId}
        spaceName={spaceName}
        spaceType={spaceType}
        category={category}
        myRole={myRole}
        currentUserId={currentUserId}
        initialTab={initialTab}
        overviewTopSlot={
          <div className="flex justify-end">
            <ViewCurrencyOverride
              spaceCurrency={displayCurrency}
              override={viewOverride}
              onChange={setViewOverride}
            />
          </div>
        }
        renderHero={() => (
          <PersonalHero
            accountCount={accounts.length}
            snapshots={snapshots}
            estimated={classification.estimated}
            netWorth={classification.netWorth}
            totalAssets={classification.totalAssets}
            totalLiabilities={classification.totalLiabilities}
            allocation={allocation}
            chartInterval={chartInterval}
            onChartIntervalChange={setChartInterval}
          />
        )}
      />
    </DisplayCurrencyProvider>
  );
}
