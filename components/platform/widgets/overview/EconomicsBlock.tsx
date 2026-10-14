"use client";

/**
 * components/platform/widgets/overview/EconomicsBlock.tsx  (UX-P1 · Agent 5)
 *
 * "Economics" — ONE SectionSurface on the Overview: two BigStats — the Plaid
 * current-cycle ESTIMATE (Item-months this cycle, whether the two invoice
 * readings agree) and the AI 30-day ESTIMATE (or Unavailable with the reason
 * when no pricing is configured) — then estimated AI spend per UTC day as
 * MiniBars when a rate was in force, and the one sentence that governs the
 * whole block: no actual-charge ledger exists.
 *
 * Both reads are PLATFORM_OPS READ and shared through the workspace session
 * (the AI block reads the same trend). Presentation derives nothing — the
 * readings are composed in ai-economics-view.ts. Doorway → Economics.
 */

import { useState } from "react";
import { Coins } from "lucide-react";
import { WidgetMessage } from "../../widget-kit";
import { useSharedWidgetFetch } from "../../workspace-session";
import { BigStat, MiniBars, SectionSurface, Unavailable } from "../../platform-surface";
import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";
import type { OverviewBlockProps } from "./block-contract";
import { BlockDoorway } from "./block-doorway";
import { AI_WINDOW_DAYS, ESTIMATE_CAPTION, NO_LEDGER_NOTE, aiSpendReading, fmtUsd, plaidCycleReading, spendPerDay } from "./ai-economics-view";

export interface EconomicsSurfaceProps {
  plaid: { data: PlaidUsage | null; loading: boolean; error: string | null };
  trend: { data: AiUsageTrend | null; loading: boolean; error: string | null };
  nowMs: number;
  onOpenWorkspace?: (workspaceId: string) => void;
}

/** Prop-driven and fetch-free. Each authority keeps its own four fetch states. */
export function EconomicsSurface({ plaid, trend, nowMs, onOpenWorkspace }: EconomicsSurfaceProps) {
  const p = plaid.error ? null : plaid.data;
  const t = trend.error ? null : trend.data;
  const plaidReading = p ? plaidCycleReading(p) : null;
  const aiReading = t ? aiSpendReading(t) : null;
  const spendPoints = t && t.pricingConfigured ? spendPerDay(t, nowMs) : null;
  return (
    <SectionSurface
      icon={Coins}
      title="Economics"
      actions={<BlockDoorway label="Economics" workspaceId="platform-costs" onOpenWorkspace={onOpenWorkspace} />}
      footnote={`${NO_LEDGER_NOTE} Plaid: Item-months × the invoice-derived rate, per billing cycle, both invoice readings shown; no daily allocation is invented. AI: the code-owned rate card over observed tokens, per UTC day.`}
    >
      <div className="flex flex-col gap-6">
        <div className="grid gap-6 md:grid-cols-2">
          {plaid.loading || !p ? (
            <WidgetMessage loading={plaid.loading} error={plaid.error} />
          ) : (
            <BigStat
              label="Plaid · current cycle estimate"
              value={plaidReading?.kind === "figure" ? plaidReading.value : <Unavailable reason={plaidReading?.reason ?? "no reading"} />}
              qualifier={plaidReading?.qualifier || ESTIMATE_CAPTION}
            />
          )}
          {trend.loading || !t ? (
            <WidgetMessage loading={trend.loading} error={trend.error} />
          ) : (
            <BigStat
              label={`AI · ${AI_WINDOW_DAYS}-day estimate`}
              value={aiReading?.kind === "figure" ? aiReading.value : <Unavailable reason={aiReading?.reason ?? "no reading"} />}
              qualifier={aiReading?.kind === "figure" ? aiReading.qualifier : ESTIMATE_CAPTION}
            />
          )}
        </div>
        {spendPoints && (
          <MiniBars
            label={`Estimated AI spend per UTC day · last ${AI_WINDOW_DAYS}`}
            points={spendPoints}
            format={fmtUsd}
            caption={`${ESTIMATE_CAPTION} · a day with no counter row or no rate in force is a gap, never $0`}
          />
        )}
      </div>
    </SectionSurface>
  );
}

export function EconomicsBlock({ onOpenWorkspace }: OverviewBlockProps) {
  const plaid = useSharedWidgetFetch<PlaidUsage>("/api/platform/platform-ops/plaid-usage");
  const trend = useSharedWidgetFetch<AiUsageTrend>("/api/platform/platform-ops/ai-usage-trend");
  // ONE instant for the surface, captured at mount (a clock read during render
  // is impure — the same idiom OpsPlatformHealthWidget uses).
  const [nowMs] = useState(() => Date.now());
  return <EconomicsSurface plaid={plaid} trend={trend} nowMs={nowMs} onOpenWorkspace={onOpenWorkspace} />;
}
