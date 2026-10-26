"use client";

/**
 * components/space/widgets/wealth/WealthExplanationCard.tsx
 *
 * Surface ⑤ — "Explanation" (Amendment 10). The deterministic, template-based
 * plain-language read of the change: result.explanation (built in the frozen read
 * model — no LLM, no speculation, no advice, no causal attribution). This card
 * may append ONE more supported fact presentationally: when a single driver's |Δ|
 * exceeds half the net change, "driven mostly by ⟨label⟩ (⟨signed⟩)". The footer
 * "View explanation and evidence" opens the shell's Evidence drawer today (the
 * A12 conversation entry later — same slot). It carries NO attribution note: the
 * ledger owns the single note.
 *
 * v2.7 R4 (owner D-3) — COMPACT (<1024px) only: up to three number-first
 * one-liners re-stating figures already in this card's inputs (the net-worth,
 * assets and liabilities deltas, and the dominant driver this card already
 * names), then a "Details" disclosure holding the full paragraph verbatim. The
 * desktop paragraph is `max-lg:hidden`; every compact element is `lg:hidden`, so
 * at ≥1024px the card renders exactly as before.
 */

import { FileSearch } from "lucide-react";
import type { ReactNode } from "react";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { CompactInsights } from "@/components/space/compact/CompactInsights";
import { Surface, Block } from "@/components/atlas/Surface";
import { WealthUnavailable, formatSigned } from "./wealth-ui";

export function WealthExplanationCard({
  result,
  currency,
  onViewEvidence,
}: {
  result:         WealthResult;
  currency:       string;
  /** Opens the Evidence drawer (host-owned). Hidden when not provided. */
  onViewEvidence?: () => void;
}) {
  const { explanation, drivers, deltas } = result;

  if (!explanation) {
    return (
      <Block label="Explanation">
        <WealthUnavailable message="Add a Compare To date above to see a plain-language explanation of the change." />
      </Block>
    );
  }

  // Dominant-driver clause — supported fact only, computed presentationally from
  // the already-|Δ|-sorted drivers (the read model stays frozen). Appended when
  // one driver accounts for more than half the net change.
  let dominant = "";
  if (drivers && drivers.length > 0 && deltas) {
    const top = drivers[0];
    const net = Math.abs(deltas.netWorth.abs);
    if (net > 0 && Math.abs(top.delta) > net / 2) {
      dominant = ` This was driven mostly by ${top.label} (${formatSigned(top.delta, currency)}).`;
    }
  }

  // COMPACT one-liners — the SAME deltas and driver the paragraph states, number
  // first. Formatting only; no new figure is derived.
  const compactLines = explanationOneLiners(result, currency, dominant !== "");

  return (
    <Block label="Explanation">
      <Surface tone="sunken" className="px-4 py-4">
        <CompactInsights lines={compactLines} details={<>{explanation}{dominant}</>} />
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed max-lg:hidden">
          {explanation}{dominant}
        </p>
        {onViewEvidence && (
          <button
            type="button"
            onClick={onViewEvidence}
            className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-[var(--accent-info)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] rounded"
          >
            <FileSearch size={12} aria-hidden /> View explanation and evidence
          </button>
        )}
      </Surface>
    </Block>
  );
}

/**
 * v2.7 R4 — the compact one-liners: net-worth change since the compare date,
 * the assets / liabilities change, and (when the card names one) the dominant
 * driver. Each value is read straight off the WealthResult the paragraph is
 * built from; at most three lines.
 */
export function explanationOneLiners(result: WealthResult, currency: string, hasDominant: boolean): ReactNode[] {
  const { deltas, drivers, compareState } = result;
  if (!deltas) return [];
  const lines: ReactNode[] = [];
  const since = compareState?.found && compareState.date ? ` since ${formatWealthDate(compareState.date)}` : "";
  lines.push(<><span className="font-semibold tabular-nums text-[var(--text-primary)]">{formatSigned(deltas.netWorth.abs, currency)}</span> net worth{since}</>);
  if (deltas.totalAssets.abs !== 0 || deltas.totalLiabilities.abs !== 0) {
    lines.push(<><span className="font-semibold tabular-nums text-[var(--text-primary)]">{formatSigned(deltas.totalAssets.abs, currency)}</span> assets · <span className="font-semibold tabular-nums text-[var(--text-primary)]">{formatSigned(deltas.totalLiabilities.abs, currency)}</span> liabilities</>);
  }
  if (hasDominant && drivers && drivers.length > 0) {
    lines.push(<><span className="font-semibold tabular-nums text-[var(--text-primary)]">{formatSigned(drivers[0].delta, currency)}</span> {drivers[0].label} — the main driver</>);
  }
  return lines;
}
