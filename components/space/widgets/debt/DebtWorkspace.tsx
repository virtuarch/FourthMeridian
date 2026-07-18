"use client";

/**
 * components/space/widgets/debt/DebtWorkspace.tsx
 *
 * The Debt WORKSPACE — SD-6A. Supersedes the CURRENT-STATE-ONLY DebtPerspective by
 * activating the canonical DebtSpaceData time-composition contract
 * (lib/debt-space-data.ts) end-to-end, closing the asOf/compareTo clipping gap:
 *
 *   SpaceShell ──(asOf / compareTo / today)──▶ DebtWorkspace
 *                                                │  owns useDebtSpaceData
 *                                                ▼
 *                                          DebtSpaceData
 *                                   { lens@asOf, completeness, history[clipped], fico }
 *
 * The workspace OWNS its data consumption (the useDebtSpaceData hook lives here,
 * mirroring InvestmentsWorkspace). It consumes the contract for the TEMPORAL
 * concerns only:
 *   • lede         ← data.lens        (the verdict SENTENCE at asOf — prose only)
 *   • Balance Over Time ← data.history (the window-clipped slice, [compareTo, asOf])
 *   • completeness ← data.completeness (the as-of trust envelope, PRESENTED)
 *   • FICO         ← data.fico         (passthrough)
 *
 * DUAL-AUTHORITY (load-bearing, plan §1.4 / §3.5): every VISIBLE FIGURE stays
 * PRESENTATION-DERIVED from the visibility-filtered `accounts` array (computeDebtKpis
 * / computePayoffAggregate / renderDebtByAccount / buildDebtSignals) — the lens is
 * NEVER the numeric authority. The lens (which may see DebtProfile terms the client
 * array lacks) drives only the prose lede; the two can legitimately disagree, and the
 * design keeps every number off the lens. LIABILITIES ONLY — "What do I owe?".
 *
 * This component owns NO time state — asOf / compareTo / today are shell props. The
 * only local state is the hook's as-of lens fetch (loading/error for the retry
 * affordance). Present day is byte-identical to the old render: no fetch, the host's
 * present-day lens, and a full-history clip.
 *
 * Layout is unchanged from DebtPerspective — the same 12-col grid, span pairs, and
 * source order (mobile stacking) the source-scan test locks.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { Check, AlertTriangle, RefreshCw } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import { convertDebtHistory } from "@/lib/debt/display-conversion";
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
import { useDebtSpaceData } from "./useDebtSpaceData";

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
  /** Resolved closing date (YYYY-MM-DD) from the shell. */
  asOf: string;
  /** Resolved opening date, or null; clips the Balance-Over-Time window's lower bound. */
  compareTo: string | null;
  /** The shell's "today"; asOf >= today ⇒ present-day (no fetch, full history). */
  today: string;
  /** Gate — only fetch the as-of lens while the Debt workspace is open. */
  active: boolean;
  accounts: DebtPerspectiveAccount[];
  ctx?: ConversionContext;
  /** SpaceSnapshot history (host state) — the Balance-Over-Time source; the contract clips it. */
  snapshots?: Snapshot[] | null;
  /** The currency the snapshot totals are stamped in (the history basis). */
  snapshotCurrency: string;
  /** Manual FICO score (Personal host only; shared Spaces render the add-score state). */
  ficoScore?: number | null;
  ficoUpdatedAt?: string;
  /** The host's already-fetched present-day debt lens (lensResults["debt"]). Used
   *  as-is on the present-day branch; the as-of branch fetches its own. */
  presentLens?: LensResult | null;
  /** MC1 "view as" override — forwarded to the as-of lens fetch. */
  targetCurrency?: string;
  /** SD-6 gate — the workspace emits its OWN trust envelope (the on-screen lens,
   *  present-day OR as-of) so the shell chip is honest for the SELECTED date; the
   *  host merely relays it (mirrors Wealth/Investments/Liquidity). */
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
}) {
  // Activate the canonical contract: fetch lens@asOf when historical, compose the
  // rest (clipped history, FICO, completeness pointer) purely from host inputs.
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

  // Display-currency pass (FX correctness — the Debt analogue of SD-5/SD-6B): the
  // Balance-Over-Time slice is stamped in the SNAPSHOT currency; convert it per-date
  // into the display currency BEFORE the panel formats it with the display symbol.
  // Identity when display == reporting (the common case) — byte-unchanged. This
  // forecloses the symbol-only relabel: the chart now reads CONVERTED magnitudes,
  // consistent with the KPI strip beside it (which already converts via `ctx`).
  const history = useMemo(() => convertDebtHistory(data.history, ctx), [data.history, ctx]);

  // The trust envelope from the on-screen lens (as-of when historical, else the host
  // present-day lens — exactly what `data.lens` composes) through the ONE canonical
  // resolver, so the shell chip is honest for the SELECTED date instead of stuck on
  // present state. Computed ONCE and shared by the shell (onEnvelopeChange) and the
  // workspace's own local TrustIndicator, so the two can never disagree.
  const envelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: lens }),
    [lens],
  );
  useEffect(() => { onEnvelopeChange(envelope); }, [envelope, onEnvelopeChange]);

  // The blended aggregate the planner derives — computed ONCE and handed to the
  // scenario strip so the two can never disagree inside one panel (plan risk §5).
  // FIGURES OF RECORD: from the client accounts array, never the lens.
  const payoffAgg = computePayoffAggregate(accounts, ctx);
  const signals = buildDebtSignals({ accounts, ctx, lensResult: lens });

  // ⓪ Lens lede — the verdict SENTENCE only, never a competing figure of record
  // (plan §1.4, §3.5: the client widgets and the DebtProfile-merged lens can
  // legitimately disagree, so the lede is prose-only). Rendered only on
  // status === "ok"; absent/empty/error ⇒ null. When historical, the as-of trust
  // envelope (data.completeness — a POINTER to lens.completeness, not recomputed)
  // is PRESENTED beneath the sentence.
  function renderLede(): ReactNode {
    if (!lens || lens.status !== "ok" || !lens.verdict) return null;
    const freshnessLabel = lens.provenance.dataAsOf ? formatDate(lens.provenance.dataAsOf) : null;
    const redactions = lens.provenance.redactions?.length ?? 0;
    return (
      <div className="min-w-0 lg:col-span-12">
        <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
          <p className="text-sm text-[var(--text-primary)] leading-snug">{lens.verdict}</p>
          {(freshnessLabel || redactions > 0) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
              {freshnessLabel && <span className="text-[11px] text-[var(--text-faint)]">as of {freshnessLabel}</span>}
              {redactions > 0 && (
                <span className="text-[11px] text-[var(--text-faint)]">{redactions} account detail{redactions === 1 ? "" : "s"} withheld</span>
              )}
            </div>
          )}
          {/* Trust caveat — the SHARED indicator over the SAME envelope the shell chip
              reads. Renders only when noteworthy (reconstructed/estimated tier, or an
              orthogonal FX caveat); the "≈"/reason marker is no longer hand-derived. */}
          <TrustIndicator variant="inline" envelope={envelope} className="mt-1" />
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

      {/* ① KPI strip — Total Debt · Est. Interest · Utilization · Min. Payments.
           FIGURES OF RECORD: sourced from the accounts array, NOT the lens. */}
      <div className="min-w-0 lg:col-span-12">
        <DebtKpiStrip accounts={accounts} ctx={ctx} />
      </div>

      {/* ② Debt Balance Over Time — the visually dominant panel. Renders the
           canonical DebtSpaceData.history slice, clipped to [compareTo, asOf]. */}
      <div className="min-w-0 lg:col-span-7 xl:col-span-8">
        <Panel title="Debt Balance Over Time">
          <DebtHistoryPanel history={history} loading={loading} ctx={ctx} />
          {error && (
            <button
              type="button"
              onClick={reload}
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <RefreshCw size={11} /> Couldn’t load as-of history — retry
            </button>
          )}
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

      {/* ⑥ Credit Health — the REAL manual FICO (contract passthrough) + S4
           deterministic signal rows. */}
      <div className="min-w-0 lg:col-span-5 xl:col-span-4">
        <Panel title="Credit Health">
          {renderCreditScore(data.fico.score, data.fico.updatedAt ?? undefined)}
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
