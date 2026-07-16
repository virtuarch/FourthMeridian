"use client";

/**
 * components/space/widgets/wealth/WealthWorkspace.tsx  (SD-5)
 *
 * The Wealth Perspective WORKSPACE — the render + composition boundary for the
 * historical Wealth lens. It replaces the old props-in WealthPerspective, which was
 * a dumb view fed a host-computed WealthResult. Following the Investments/Debt
 * Workspace pattern, the composition now lives HERE, not in SpaceDashboard:
 *
 *   host-fetched, SHARED snapshots (Overview/Debt read the same series)
 *        + shell time (asOf / compareTo)  + display ConversionContext
 *     → convertWealthSnapshots(...)   ← per-date display-currency FX (this workspace)
 *     → computeWealthTimeMachine(...) ← THE canonical Wealth read model (unchanged)
 *     → WealthResult
 *     → the five surfaces + the shell trust envelope (emitted up via onEnvelopeChange)
 *
 * Ownership boundary (what moved out of the host):
 *  - `computeWealthTimeMachine` + effective-display-currency resolution,
 *  - the per-date FX conversion of the snapshot series (display-currency ACTIVATION;
 *    the host formerly showed snapshot-currency figures and ignored the selected
 *    display currency),
 *  - the trust envelope resolution (resolvePerspectiveEnvelope), pushed to the shell
 *    Completeness/Evidence chip via onEnvelopeChange (the Investments bridge), and
 *  - the Evidence drawer (formerly host-owned).
 *
 * The workspace owns NO time state (asOf/compareTo are shell props) and does NOT
 * fetch snapshots — snapshots are a Space-level shared resource passed in, so there
 * is no second snapshot authority and no WealthSpaceData wrapper (WealthResult IS the
 * canonical durable Wealth boundary).
 *
 * Layout (unchanged) — desktop is a 12-column grid, mobile/tablet stacks ①→⑤:
 *   ① WealthHero (4)        ② WealthTrendChart (8)
 *   ③ WealthChangeLedger (6) ④ WealthCompositionCard (6)
 *   ⑤ WealthExplanationCard (12)
 */

import { useEffect, useMemo, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import {
  computeWealthTimeMachine,
  type WealthResult,
} from "@/lib/wealth/wealth-time-machine";
import { convertWealthSnapshots } from "@/lib/wealth/display-conversion";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";
import type { WealthAdapterAccount } from "@/components/space/widgets/wealth-adapters";
import { EvidenceDrawer } from "@/components/space/shell/EvidenceDrawer";
import { WealthHero } from "./WealthHero";
import { WealthTrendChart, type WealthMetricKey } from "./WealthTrendChart";
import { WealthChangeLedger } from "./WealthChangeLedger";
import { WealthCompositionCard } from "./WealthCompositionCard";
import { WealthExplanationCard } from "./WealthExplanationCard";
import { WealthUnavailable } from "./wealth-ui";

export function WealthWorkspace({
  snapshots,
  snapshotCurrency,
  asOf,
  compareTo,
  accounts,
  ctx,
  metric,
  onMetricChange,
  onSelectAsOf,
  onSwitchLens,
  onEnvelopeChange,
  backfillInProgress,
}: {
  snapshots:        Snapshot[] | null | undefined;
  /** The currency the snapshot totals are stamped in (the FX from-currency). */
  snapshotCurrency: string | null;
  asOf:             string;
  compareTo:        string | null;
  accounts?:        WealthAdapterAccount[];
  /** Display ConversionContext — `ctx.target` is the member's selected display currency. */
  ctx?:             ConversionContext;
  metric?:          WealthMetricKey;
  onMetricChange?:  (m: WealthMetricKey) => void;
  onSelectAsOf?:    (date: string) => void;
  onSwitchLens?:    (lensId: string) => void;
  /** Bridge the workspace's trust envelope up to the shell Completeness/Evidence chip. */
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
  /** Part-6 — a snapshot backfill is actively running for this Space. */
  backfillInProgress?: boolean;
}) {
  // ── Effective display currency + per-date FX (display-currency ACTIVATION) ──────
  // Convert only when we know the from-currency AND have a display context. Identity
  // (from === target) short-circuits inside convertWealthSnapshots, so the common
  // all-same-currency path is byte-identical to the pre-activation behavior. When we
  // cannot convert (no snapshotCurrency), figures are labeled as before
  // (snapshotCurrency ?? display target) with no conversion — never a masqueraded
  // relabel. The Time Machine then derives everything (including its formatted
  // explanation sentence) already in the resolved currency.
  const canConvert = !!(ctx && snapshotCurrency);
  const displayCurrency = canConvert ? ctx!.target : (snapshotCurrency ?? ctx?.target ?? "USD");
  const convertedSnapshots = useMemo(
    () => (canConvert ? convertWealthSnapshots(snapshots ?? [], snapshotCurrency!, ctx!) : (snapshots ?? [])),
    [snapshots, snapshotCurrency, ctx, canConvert],
  );
  const result: WealthResult = useMemo(
    () => computeWealthTimeMachine({
      snapshots: convertedSnapshots,
      asOf,
      compareTo,
      currency: displayCurrency,
    }),
    [convertedSnapshots, asOf, compareTo, displayCurrency],
  );

  // Trust envelope — resolved from THIS workspace's own result (currency-consistent),
  // emitted up to the shell chip (the Investments onEnvelopeChange bridge). Memoized so
  // the effect only fires when the envelope actually changes (no re-render loop).
  const envelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult: result, currency: displayCurrency }),
    [result, displayCurrency],
  );
  useEffect(() => { onEnvelopeChange(envelope); }, [envelope, onEnvelopeChange]);

  // Evidence drawer — now workspace-owned (was host-owned). Opened from the
  // Explanation card's "View evidence" affordance; rows come from the same envelope.
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  // Part-6 — while a backfill is running, the snapshot series is still being written,
  // so a partial (or empty) WealthResult must NOT render as if final. Honest loading
  // state; clears once the backfill completes and the host re-fetches.
  if (backfillInProgress) {
    return (
      <div
        className="rounded-2xl border p-8 flex flex-col items-center justify-center text-center gap-3 min-h-[220px]"
        style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
      >
        <Loader2 className="animate-spin" size={26} style={{ color: "var(--meridian-400)" }} />
        <div className="max-w-sm">
          <p className="text-sm font-semibold text-[var(--text-primary)]">Creating your 30-day snapshot history…</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            We&rsquo;re reconstructing balance history from the accounts you just connected.
            This can take a few minutes — the chart appears here the moment it&rsquo;s ready.
          </p>
        </div>
      </div>
    );
  }

  if (!result.hasHistory) {
    return (
      <div
        className="rounded-2xl border p-8"
        style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
      >
        <WealthUnavailable message="No wealth history yet. Once this Space accrues daily snapshots (or you connect accounts), the historical Wealth perspective builds itself — nothing is fabricated in the meantime." />
      </div>
    );
  }

  const canViewEvidence = !!envelope.evidence?.rows?.length;

  return (
    <>
      {/* HIST-2E — today/history valuation-basis disclosure (from the read model;
          transparency only, no number changes). Renders only when the view mixes an
          observed today point with reconstructed history. */}
      {result.basis && (
        <div
          className="mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
          style={{ background: "var(--surface-inset)", color: "var(--text-muted)" }}
          role="note"
        >
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-[var(--text-secondary)]">{result.basis.title}.</span>{" "}
            {result.basis.note}
          </span>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0">
        {/* ① Hero + ② Trend chart. */}
        <div className="min-w-0 lg:col-span-4">
          <WealthHero result={result} currency={displayCurrency} onSwitchLens={onSwitchLens} />
        </div>
        <div className="min-w-0 lg:col-span-8">
          <WealthTrendChart
            result={result}
            currency={displayCurrency}
            onSelectAsOf={onSelectAsOf}
            metric={metric}
            onMetricChange={onMetricChange}
          />
        </div>

        {/* ③ Change ledger + ④ Composition. */}
        <div className="min-w-0 lg:col-span-6">
          <WealthChangeLedger result={result} currency={displayCurrency} />
        </div>
        <div className="min-w-0 lg:col-span-6">
          <WealthCompositionCard result={result} currency={displayCurrency} accounts={accounts} ctx={ctx} />
        </div>

        {/* ⑤ Explanation. */}
        <div className="min-w-0 lg:col-span-12">
          <WealthExplanationCard
            result={result}
            currency={displayCurrency}
            onViewEvidence={canViewEvidence ? () => setEvidenceOpen(true) : undefined}
          />
        </div>
      </div>
      {envelope.evidence && (
        <EvidenceDrawer
          open={evidenceOpen}
          onClose={() => setEvidenceOpen(false)}
          evidence={envelope.evidence}
        />
      )}
    </>
  );
}
