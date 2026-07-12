"use client";

/**
 * components/space/widgets/debt/DebtPerspective.tsx
 *
 * The Debt Perspective workspace — a multi-panel composition of the SAME seven
 * mounted Debt widgets, relocated from the generic single-column SectionCard
 * stack into a 2D grid. Mirrors the landed Liquidity/Cash Flow mechanics
 * (grid-cols-1 lg:grid-cols-12, a local non-exported Panel helper reproducing
 * the SectionCard solid-lede treatment, adapter renderers reused, items-stretch).
 * NOT a new layout abstraction — no registry, no schema, no grid engine, no new
 * card primitive (plan §1.7, §3.1).
 *
 * LIABILITIES ONLY — "What do I owe?": shape, cost, and risk of debt. No assets,
 * net worth, allocation, spending, or goals.
 *
 * CURRENT-STATE ONLY (decided, not open for reinterpretation): this workspace
 * consumes NO as-of / compare-to / historical ACCOUNT read. Every panel is
 * point-in-time EXCEPT Balance Over Time, which reads the SAME host `snapshots`
 * array it reads today — a snapshot read, not an account as-of read (plan §1.5).
 * The shell's As Of / Compare To have zero effect here; the as-of engine stays
 * kill-switched and unconsumed (stop condition 1, locked by the source-scan test).
 *
 * This component owns NO state — everything is pass-through from the host.
 *
 * Layout (plan §3.3) — desktop is a 12-column grid; mobile/tablet stacks in
 * source order Lede → KPI → Balance Over Time → Credit Utilization → Interest
 * Cost → Debt by Account → Payoff Planner → Credit Health → Complete Details:
 *   xl (≥1280): ⓪ 12 · ① 12 · ② 8 / ③ 4 · ④ 7 / ⑤ 5 · ⑥ 4 / ⑦ 8
 *   lg (1024):  ⓪ 12 · ① 12 · ② 7 / ③ 5 · ④ 6 / ⑤ 6 · ⑥ 5 / ⑦ 7
 */

import type { ReactNode } from "react";
import { Check, AlertTriangle } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import {
  renderDebtByAccount,
  renderDebtCost,
  CreditUtilizationWidget,
  renderCreditScore,
  renderDebtCompleteInfo,
  type DebtPerspectiveAccount,
} from "@/components/space/widgets/debt-perspective-adapters";
import { renderDebtPayoffCalculator } from "@/components/space/widgets/debt-adapters";
import { DebtKpiStrip } from "./DebtKpiStrip";
import { DebtHistoryPanel } from "./DebtHistoryPanel";
import { PayoffScenarioStrip } from "./PayoffScenarioStrip";
import { computePayoffAggregate } from "./debt-kpis";
import { buildDebtSignals } from "./debt-signals";

// The card language is exactly the SectionCard solid-lede treatment reproduced
// by the Liquidity/Cash Flow Panel helpers. NOT a new card system.
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

export function DebtPerspective({
  accounts,
  ctx,
  snapshots,
  ficoScore,
  ficoUpdatedAt,
  lensResult,
}: {
  accounts: DebtPerspectiveAccount[];
  ctx?: ConversionContext;
  /** SpaceSnapshot history for Balance Over Time (host fetches on debtWorkspaceActive). */
  snapshots?: Snapshot[] | null;
  /** Manual FICO score (Personal host only; shared Spaces render the add-score state). */
  ficoScore?: number | null;
  ficoUpdatedAt?: string;
  /** The already-fetched current-state LensResult (lensResults["debt"]). Absent /
   *  empty / error ⇒ the lede strip is omitted entirely. NO new fetch, NO
   *  point-in-time read — the same result the shell envelope already consumes. */
  lensResult?: LensResult | null;
}) {
  // The blended aggregate the planner derives — computed ONCE and handed to the
  // scenario strip so the two can never disagree inside one panel (plan risk §5).
  const payoffAgg = computePayoffAggregate(accounts, ctx);
  const signals = buildDebtSignals({ accounts, ctx, lensResult });

  // ⓪ Lens lede — the verdict SENTENCE only, never a competing figure of record
  // (plan §1.4, §3.5: the client widgets and the DebtProfile-merged lens can
  // legitimately disagree, so the lede is prose-only). Rendered only on
  // status === "ok"; absent/empty/error ⇒ null.
  function renderLede(): ReactNode {
    if (!lensResult || lensResult.status !== "ok" || !lensResult.verdict) return null;
    const freshnessLabel = lensResult.provenance.dataAsOf ? formatDate(lensResult.provenance.dataAsOf) : null;
    const redactions = lensResult.provenance.redactions?.length ?? 0;
    return (
      <div className="min-w-0 lg:col-span-12">
        <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
          <p className="text-sm text-[var(--text-primary)] leading-snug">
            {lensResult.estimated ? "≈ " : ""}{lensResult.verdict}
          </p>
          {(freshnessLabel || redactions > 0) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
              {freshnessLabel && <span className="text-[11px] text-[var(--text-faint)]">as of {freshnessLabel}</span>}
              {redactions > 0 && (
                <span className="text-[11px] text-[var(--text-faint)]">{redactions} account detail{redactions === 1 ? "" : "s"} withheld</span>
              )}
            </div>
          )}
        </GlassPanel>
      </div>
    );
  }

  // ⑥ Debt Signals — deterministic reason rows from landed classifications only
  // (plan §2, §3.2). Nothing derivable ⇒ nothing rendered (no filler).
  function renderSignals(): ReactNode {
    if (signals.length === 0) return null;
    return (
      <ul className="mt-3 pt-3 border-t border-[var(--border-hairline)] space-y-1.5">
        {signals.map((s) => (
          <li key={s.id} className="flex items-start gap-2">
            {s.tone === "ok"
              ? <Check size={13} className="text-[var(--accent-positive)] shrink-0 mt-0.5" />
              : <AlertTriangle size={13} className="text-[#f59e0b] shrink-0 mt-0.5" />}
            <span className="text-[12px] text-[var(--text-secondary)] leading-snug">{s.text}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch min-w-0">
      {/* ⓪ Lens lede — slim strip, present only on an ok LensResult. */}
      {renderLede()}

      {/* ① KPI strip — Total Debt · Est. Interest · Utilization · Min. Payments. */}
      <div className="min-w-0 lg:col-span-12">
        <DebtKpiStrip accounts={accounts} ctx={ctx} />
      </div>

      {/* ② Debt Balance Over Time — the visually dominant panel (snapshot read). */}
      <div className="min-w-0 lg:col-span-7 xl:col-span-8">
        <Panel title="Debt Balance Over Time">
          <DebtHistoryPanel snapshots={snapshots} ctx={ctx} />
        </Panel>
      </div>

      {/* ③ Cost & risk column: Credit Utilization over Interest Cost. */}
      <div className="min-w-0 lg:col-span-5 xl:col-span-4 flex flex-col gap-4">
        <Panel title="Credit Utilization">
          <CreditUtilizationWidget accounts={accounts} ctx={ctx} />
        </Panel>
        <Panel title="Interest Cost">
          {renderDebtCost(accounts, ctx)}
        </Panel>
      </div>

      {/* ④ Debt by Account — ranked liability bars. */}
      <div className="min-w-0 lg:col-span-6 xl:col-span-7">
        <Panel title="Debt by Account">
          {renderDebtByAccount(accounts, ctx)}
        </Panel>
      </div>

      {/* ⑤ Payoff Planner — embedded (no new fullscreen trigger, plan §3.6) +
           the S4 preset scenario strip beneath it in the same panel. */}
      <div className="min-w-0 lg:col-span-6 xl:col-span-5">
        <Panel title="Payoff Planner">
          {renderDebtPayoffCalculator(accounts, false, undefined, ctx)}
          <PayoffScenarioStrip input={payoffAgg} ctx={ctx} />
        </Panel>
      </div>

      {/* ⑥ Credit Health — the REAL manual FICO + S4 deterministic signal rows. */}
      <div className="min-w-0 lg:col-span-5 xl:col-span-4">
        <Panel title="Credit Health">
          {renderCreditScore(ficoScore, ficoUpdatedAt)}
          {renderSignals()}
        </Panel>
      </div>

      {/* ⑦ Complete Debt Details — quiet data-quality affordance (plan §3.3). */}
      <div className="min-w-0 lg:col-span-7 xl:col-span-8">
        <Panel title="Complete Debt Details" subdued>
          {renderDebtCompleteInfo(accounts)}
        </Panel>
      </div>
    </div>
  );
}
