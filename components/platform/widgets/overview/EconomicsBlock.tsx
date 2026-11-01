"use client";

/**
 * components/platform/widgets/overview/EconomicsBlock.tsx  (UX-P1 · Agent 5; BETA C6)
 *
 * "Economics" — ONE SectionSurface on the Overview: two BigStats — the Plaid
 * current-cycle ESTIMATE (Item-months this cycle, whether the two invoice
 * readings agree) and the AI 30-day CUSTOMER ESTIMATE (Conversations + Daily
 * Brief from the invocation ledger, with overhead and the unpriced count stated
 * beside it, and the counter-based figure as the cross-check) — then estimated
 * customer AI spend per UTC day as MiniBars when a rate was in force, and the
 * one sentence that governs the whole block: no actual-charge ledger exists.
 * AI COST CONTROLS adds ONE doorway sentence (no new fetch) pointing at the
 * budget utilization reading in Economics → AI Budget.
 *
 * All three reads are PLATFORM_OPS READ and shared through the workspace
 * session (the AI block reads the same trend and spend). Presentation derives
 * nothing — the readings are composed in ai-economics-view.ts. Doorway → Economics.
 */

import { useState } from "react";
import { Coins } from "lucide-react";
import { WidgetMessage } from "../../widget-kit";
import { useSharedWidgetFetch } from "../../workspace-session";
import { BigStat, MiniBars, SectionSurface, Unavailable } from "../../platform-surface";
import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";
import type { AiSpendResponse } from "@/app/api/platform/platform-ops/ai-spend/route";
import type { OverviewBlockProps } from "./block-contract";
import { BlockDoorway } from "./block-doorway";
import {
  AI_WINDOW_DAYS, BUDGET_DOORWAY_NOTE, CUSTOMER_SPEND_NOTE, ESTIMATE_CAPTION, NO_LEDGER_NOTE, aiSpendReading, counterCrossCheckText, customerSpendPerDay,
  customerSpendReading, fmtUsd, overheadText, plaidCycleReading, spendPerDay,
} from "./ai-economics-view";

export interface EconomicsSurfaceProps {
  plaid: { data: PlaidUsage | null; loading: boolean; error: string | null };
  trend: { data: AiUsageTrend | null; loading: boolean; error: string | null };
  /** BETA C6 — spend allocated by surface. Omitted by callers that only have the counter. */
  spend?: { data: AiSpendResponse | null; loading: boolean; error: string | null };
  nowMs: number;
  onOpenWorkspace?: (workspaceId: string) => void;
}

/** Prop-driven and fetch-free. Each authority keeps its own four fetch states. */
export function EconomicsSurface({ plaid, trend, spend, nowMs, onOpenWorkspace }: EconomicsSurfaceProps) {
  const p = plaid.error ? null : plaid.data;
  const t = trend.error ? null : trend.data;
  const s = spend && !spend.error ? spend.data?.spend ?? null : null;
  const plaidReading = p ? plaidCycleReading(p) : null;
  const counterReading = t ? aiSpendReading(t) : null;
  const customer = s ? customerSpendReading(s) : null;
  // Customer spend per day when the allocation is available; the counter's
  // all-surface series otherwise — each labelled as what it is.
  const spendPoints = s && s.pricingConfigured ? customerSpendPerDay(s, nowMs) : t && t.pricingConfigured ? spendPerDay(t, nowMs) : null;
  const spendLabel = s && s.pricingConfigured ? `Estimated customer AI spend per UTC day · last ${AI_WINDOW_DAYS}` : `Estimated AI spend per UTC day · last ${AI_WINDOW_DAYS}`;
  return (
    <SectionSurface
      icon={Coins}
      title="Economics"
      actions={<BlockDoorway label="AI & Costs" workspaceId="platform-ai" onOpenWorkspace={onOpenWorkspace} />}
      footnote={`${NO_LEDGER_NOTE} Plaid: Item-months × the invoice-derived rate, per billing cycle, both invoice readings shown; no daily allocation is invented. AI: the code-owned rate card over observed tokens, per UTC day. ${CUSTOMER_SPEND_NOTE}`}
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
          {spend && spend.loading && !t ? (
            <WidgetMessage loading error={null} />
          ) : s && customer && t ? (
            <BigStat
              label={`AI · ${AI_WINDOW_DAYS}-day customer estimate`}
              value={customer.kind === "figure" ? customer.value : <Unavailable reason={customer.reason} />}
              qualifier={customer.qualifier}
              derivation={`${overheadText(s)} · ${counterCrossCheckText(t)}`}
            />
          ) : trend.loading || !t ? (
            <WidgetMessage loading={trend.loading} error={trend.error} />
          ) : (
            <BigStat
              label={`AI · ${AI_WINDOW_DAYS}-day estimate`}
              value={counterReading?.kind === "figure" ? counterReading.value : <Unavailable reason={counterReading?.reason ?? "no reading"} />}
              qualifier={counterReading?.kind === "figure" ? counterReading.qualifier : ESTIMATE_CAPTION}
              derivation={spend ? (spend.loading ? "customer / overhead allocation loading…" : `customer / overhead allocation unavailable${spend.error ? ` — ${spend.error}` : ""}; counter figure covers every surface`) : undefined}
            />
          )}
        </div>
        {spendPoints && (
          <MiniBars
            label={spendLabel}
            points={spendPoints}
            format={fmtUsd}
            caption={`${ESTIMATE_CAPTION} · a day with no ${s ? "priced customer invocation" : "counter row or no rate in force"} is a gap, never $0`}
          />
        )}
        {/* AI COST CONTROLS — a doorway sentence, not a figure: the budget reading needs its own fetch, which the Overview does not add. */}
        <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{BUDGET_DOORWAY_NOTE}</p>
      </div>
    </SectionSurface>
  );
}

export function EconomicsBlock({ onOpenWorkspace }: OverviewBlockProps) {
  const plaid = useSharedWidgetFetch<PlaidUsage>("/api/platform/platform-ops/plaid-usage");
  const trend = useSharedWidgetFetch<AiUsageTrend>("/api/platform/platform-ops/ai-usage-trend");
  const spend = useSharedWidgetFetch<AiSpendResponse>("/api/platform/platform-ops/ai-spend");
  // ONE instant for the surface, captured at mount (a clock read during render
  // is impure — the same idiom OpsPlatformHealthWidget uses).
  const [nowMs] = useState(() => Date.now());
  return <EconomicsSurface plaid={plaid} trend={trend} spend={spend} nowMs={nowMs} onOpenWorkspace={onOpenWorkspace} />;
}
