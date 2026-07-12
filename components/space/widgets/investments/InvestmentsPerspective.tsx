"use client";

/**
 * components/space/widgets/investments/InvestmentsPerspective.tsx
 *
 * The Investments Perspective workspace — the first real UI over the A10
 * Investments Time Machine. Wealth owns "how much am I worth"; Investments
 * answers "what do I own, and what happened to it", in that order — so there is
 * NO second hero number here, only a compact Portfolio Header strip.
 *
 * This component owns NO time state: the Perspective Shell owns preset / asOf /
 * compareTo and the host threads in the already-fetched `result` (plus loading /
 * error / onRetry). Props in, render out — the same contract WealthPerspective /
 * CashFlowPerspective follow.
 *
 * Layout (plan §3.3) — a 12-col grid, mobile/tablet stacks in source order
 * Header → Holdings → Activity → Bridge → Connections. It uses `items-start`
 * (Wealth's choice, not Cash Flow's stretched rows): Holdings is much taller than
 * the side panels, so stretching the side column would leave lonely tall cards.
 *
 * The local `Panel` helper reproduces the SectionCard solid-lede card language
 * verbatim (third local copy — extraction stays a non-goal until a fourth
 * consumer complains; NOT a shared abstraction).
 */

import type { ReactNode } from "react";
import { Loader2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { formatCurrency } from "@/lib/format";
import type { InvestmentsTimeMachineResult } from "@/lib/investments/investments-time-machine-core";
import { InvestmentsHoldings } from "./InvestmentsHoldings";
import { InvestmentsActivityCard } from "./InvestmentsActivityCard";
import { InvestmentsBridgeCard } from "./InvestmentsBridgeCard";
import { InvestmentConnectionsCard } from "./InvestmentConnectionsCard";

// The card language is exactly the SectionCard solid-lede treatment: GlassPanel
// depth="thin" elevation="e2" radius="lg" p-4 with a text-sm font-semibold header.
// No `h-full` — items-start leaves panel heights content-defined. min-w-0 keeps
// long instrument names from forcing horizontal overflow.
function Panel({ title, subdued, children }: { title: string; subdued?: boolean; children: ReactNode }) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
      <p className={`text-sm font-semibold px-1 mb-2 ${subdued ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
        {title}
      </p>
      {children}
    </GlassPanel>
  );
}

/** The compact Portfolio Header strip — NOT a hero (Wealth owns the big number). */
function PortfolioHeader({
  result,
  compareTo,
  loading,
}: {
  result:    InvestmentsTimeMachineResult;
  compareTo: string | null;
  loading:   boolean;
}) {
  const { portfolio, asOf } = result;
  const total = portfolio.valuedCount + portfolio.unvaluedCount;
  const partial = portfolio.unvaluedCount > 0;
  // The pixel rule: NEVER present the subtotal as "portfolio value" when some
  // holdings could not be valued — it is a partial ("Valued holdings").
  const figureLabel = partial ? "Valued holdings" : "Portfolio value";
  // Only claim a comparison window when the host actually resolved one (< asOf).
  const comparing = compareTo != null && compareTo < asOf;

  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>{figureLabel}</p>
        <p className="text-2xl font-bold tabular-nums" style={{ color: "var(--text-primary)" }}>
          {formatCurrency(portfolio.valuedSubtotal, portfolio.reportingCurrency)}
        </p>
        <p className="text-xs mt-0.5 flex items-center gap-1.5" style={{ color: "var(--text-faint)" }}>
          <span>as of {asOf}{comparing ? ` · vs ${compareTo}` : ""}</span>
          {loading && <Loader2 size={11} className="animate-spin" aria-label="Refreshing" />}
        </p>
      </div>
      <span
        className="text-xs font-medium px-2.5 py-1 rounded-full shrink-0"
        title={portfolio.completeness.reason}
        style={{
          background: "var(--surface-inset)",
          color: partial ? "var(--accent-warning, #f59e0b)" : "var(--text-muted)",
        }}
      >
        {portfolio.valuedCount} of {total} positions valued
      </span>
    </div>
  );
}

export function InvestmentsPerspective({
  result,
  loading,
  error,
  onRetry,
  accounts,
  spaceId,
  compareTo,
}: {
  result:    InvestmentsTimeMachineResult | null;
  loading:   boolean;
  error:     boolean;
  onRetry:   () => void;
  accounts:  { id: string; name: string }[];
  spaceId:   string;
  compareTo: string | null;
}) {
  // Loading (no result yet) — a centered spinner in place of the grid. A refetch
  // over an existing result never blanks it (the hook keeps the last result).
  if (!result) {
    if (error) {
      return (
        <div className="rounded-2xl border p-8" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>Couldn’t load your investments.</p>
            <button onClick={onRetry} className="text-xs font-semibold text-[var(--meridian-400)] hover:underline">Retry</button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={18} className="animate-spin text-[var(--text-faint)]" />
      </div>
    );
  }

  // Empty — no holdings and nothing unvalued: the connect-CTA (mirrors the legacy
  // widget). The Connections card still mounts for any account needing attention.
  const isEmpty = result.holdings.length === 0 && result.portfolio.unvaluedCount === 0;
  if (isEmpty) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0">
        <div className="min-w-0 lg:col-span-8">
          <Panel title="Holdings">
            <div className="py-6 text-center">
              <TrendingUp size={22} className="mx-auto text-[var(--text-faint)]" />
              <p className="mt-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>No holdings for this date</p>
              <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                Connect a brokerage or exchange, or pick a later date, to see your holdings here.
              </p>
              <Link href="/dashboard/connections" className="mt-3 inline-block text-sm font-semibold text-[var(--meridian-400)] hover:underline">
                Connect an investment account →
              </Link>
            </div>
          </Panel>
        </div>
        <div className="min-w-0 lg:col-span-4">
          <InvestmentConnectionsCard spaceId={spaceId} />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0">
      {/* ① Portfolio Header — compact strip, NOT a hero. */}
      <div className="min-w-0 lg:col-span-12">
        <Panel title="Portfolio">
          <PortfolioHeader result={result} compareTo={compareTo} loading={loading} />
        </Panel>
      </div>

      {/* ② Holdings — the dominant panel. */}
      <div className="min-w-0 lg:col-span-7 xl:col-span-8">
        <Panel title="Holdings">
          <InvestmentsHoldings
            holdings={result.holdings}
            reportingCurrency={result.reportingCurrency}
            accounts={accounts}
          />
        </Panel>
      </div>

      {/* ③ Side column — Period Activity → The Bridge → Connections (conditional).
           A flex stack (not a grid row-span) so panel heights stay content-defined. */}
      <div className="min-w-0 lg:col-span-5 xl:col-span-4 flex flex-col gap-4">
        <Panel title="Period Activity">
          <InvestmentsActivityCard flows={result.flows} />
        </Panel>
        <Panel title="Change Bridge">
          <InvestmentsBridgeCard reconciliation={result.reconciliation} flows={result.flows} />
        </Panel>
        {/* Renders its own titled panel only when an account needs attention; null otherwise. */}
        <InvestmentConnectionsCard spaceId={spaceId} />
      </div>
    </div>
  );
}
