"use client";

/**
 * components/space/widgets/wealth/WealthChangeCards.tsx
 *
 * Cards 1, 4, and 5 of the Wealth story grid — all comparison-driven, all
 * deterministic and template-based (no LLM, no fabricated attribution):
 *
 *   WealthChangeCard  — "How wealthy am I?"           (net worth + change + top drivers)
 *   WealthDriversCard — "What caused the biggest impact?" (real component deltas)
 *   WealthStoryCard   — "What's the story behind the change?" (full-width sentence)
 *
 * Every amount comes from real snapshot component deltas. Finer attribution
 * (contributions vs. market growth, income/spending) is not available from
 * snapshots and is stated as such — never estimated from the visuals.
 */

import { formatCurrency } from "@/lib/format";
import type { WealthResult, WealthDriver } from "@/lib/wealth/wealth-time-machine";
import { WealthCard, WealthUnavailable, DeltaBadge, formatSigned } from "./wealth-ui";

const NO_COMPARE = "Add a Compare To date above to see what changed.";
const ATTRIBUTION_NOTE = "Detailed attribution (contributions vs. market growth) isn't available for this period yet.";

/** A driver is "good" when assets rise or liabilities fall. */
function driverGood(d: WealthDriver): boolean {
  return d.id === "liabilities" ? d.delta < 0 : d.delta > 0;
}

function DriverRow({ d, currency }: { d: WealthDriver; currency: string }) {
  const color = driverGood(d) ? "var(--accent-positive)" : "var(--accent-negative)";
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-[var(--text-secondary)] truncate">{d.label}</span>
      <span className="text-xs font-semibold tabular-nums shrink-0" style={{ color }}>
        {formatSigned(d.delta, currency)}
      </span>
    </div>
  );
}

// ─── Card 1 — "How wealthy am I?" ─────────────────────────────────────────────

export function WealthChangeCard({
  result,
  currency,
  compareLabel,
}: {
  result:        WealthResult;
  currency:      string;
  compareLabel?: string;
}) {
  const { asOfState, deltas, drivers } = result;

  if (!asOfState.found) {
    return (
      <WealthCard title="How wealthy am I?">
        <WealthUnavailable message="No net-worth snapshot on or before this date." />
      </WealthCard>
    );
  }

  return (
    <WealthCard title="How wealthy am I?">
      <div className="space-y-1">
        <p className="text-3xl font-semibold tabular-nums text-[var(--text-primary)] leading-none">
          {formatCurrency(asOfState.netWorth, currency)}
        </p>
        <p className="text-[11px] text-[var(--text-faint)]">net worth</p>
      </div>

      {deltas ? (
        <div className="mt-3">
          <DeltaBadge abs={deltas.netWorth.abs} pct={deltas.netWorth.pct} currency={currency} goodDirection="up" compareLabel={compareLabel} />
          {drivers && drivers.length > 0 ? (
            <div className="mt-2 divide-y" style={{ borderColor: "var(--border-hairline)" }}>
              {drivers.slice(0, 3).map((d) => <DriverRow key={d.id} d={d} currency={currency} />)}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-[var(--text-faint)]">{ATTRIBUTION_NOTE}</p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-[var(--text-faint)]">{NO_COMPARE}</p>
      )}
    </WealthCard>
  );
}

// ─── Card 4 — "What caused the biggest impact?" ───────────────────────────────

export function WealthDriversCard({
  result,
  currency,
}: {
  result:   WealthResult;
  currency: string;
}) {
  const { deltas, drivers } = result;

  return (
    <WealthCard title="What caused the biggest impact?">
      {!deltas ? (
        <WealthUnavailable message={NO_COMPARE} />
      ) : drivers && drivers.length > 0 ? (
        <>
          <div className="divide-y" style={{ borderColor: "var(--border-hairline)" }}>
            {drivers.map((d) => <DriverRow key={d.id} d={d} currency={currency} />)}
          </div>
          <p className="mt-3 text-[11px] text-[var(--text-faint)] leading-relaxed">{ATTRIBUTION_NOTE}</p>
        </>
      ) : (
        <WealthUnavailable message="Net worth was essentially flat between these dates." />
      )}
    </WealthCard>
  );
}

// ─── Card 5 — "What's the story behind the change?" ───────────────────────────

export function WealthStoryCard({
  result,
}: {
  result: WealthResult;
}) {
  return (
    <WealthCard
      title="What's the story behind the change?"
      right={result.evidence ? (
        <span className="text-[11px] text-[var(--text-faint)] whitespace-nowrap">{result.evidence.label}</span>
      ) : undefined}
    >
      {result.story ? (
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{result.story}</p>
      ) : (
        <p className="text-sm text-[var(--text-faint)] leading-relaxed">
          {result.compareTo ? "No change to report between these dates." : NO_COMPARE}
        </p>
      )}
      {result.story && (
        <p className="mt-2 text-[11px] text-[var(--text-faint)] leading-relaxed">{ATTRIBUTION_NOTE}</p>
      )}
    </WealthCard>
  );
}
