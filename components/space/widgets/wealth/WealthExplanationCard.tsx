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
 */

import { FileSearch } from "lucide-react";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
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

  return (
    <Block label="Explanation">
      <Surface tone="sunken" className="px-4 py-4">
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
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
