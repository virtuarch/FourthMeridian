"use client";

/**
 * components/platform/growth/BetaRiskBadge.tsx  (beta-request risk · queue cue)
 *
 * The advisory risk cue on Growth's Waiting queue: a dot + word badge per row
 * (`BetaRiskBadge`) and the level + plain-English signals in the single-request
 * panel (`BetaRiskDetail`), so a one-row Approve carries the same cue the bulk
 * review does. PRESENTATION ONLY — the decisions live in beta-risk-badge-model.ts;
 * the level never blocks approval. Colour is never alone: every badge is a word.
 */

import { ToneBadge } from "@/components/platform/platform-surface";
import type { BetaRequestRisk } from "@/lib/platform/growth/beta-risk-types";
import { reviewLine, riskBadge, riskSignalLines } from "./beta-risk-badge-model";

/** Row badge; renders nothing for level none or a missing risk block. */
export function BetaRiskBadge({ risk }: { risk: BetaRequestRisk | null | undefined }) {
  const b = riskBadge(risk);
  if (!b) return null;
  return (
    <span className="inline-flex max-w-full truncate" title={b.title} data-risk-badge={b.level}>
      <span className="sr-only">Risk: </span>
      <ToneBadge word={b.word} tone={b.tone} />
    </span>
  );
}

/** Panel block: the level, each signal in plain English, the latest verdict. Nothing for level none / absent. */
export function BetaRiskDetail({ risk }: { risk: BetaRequestRisk | null | undefined }) {
  const b = riskBadge(risk);
  if (!b) return null;
  const lines = riskSignalLines(risk);
  const verdict = reviewLine(risk);
  return (
    <section className="flex flex-col gap-1.5 border-t border-[var(--border-hairline)] pt-3" aria-label="Risk signals" data-risk-detail={b.level}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[var(--text-secondary)]">Risk</span>
        <ToneBadge word={b.word} tone={b.tone} />
      </div>
      {lines.length > 0 && (
        <ul className="flex flex-col gap-1 pl-0.5">
          {lines.map((l) => (
            <li key={l.code} className="leading-snug text-[var(--text-primary)]" title={l.code}>
              {l.text}{l.evidence && <span className="text-[var(--text-muted)]">{` — ${l.evidence}`}</span>}
            </li>
          ))}
        </ul>
      )}
      {verdict && <span className="text-[11px] text-[var(--text-muted)]">{verdict}</span>}
      <span className="text-[11px] leading-snug text-[var(--text-muted)]">Advisory only — it never blocks approval.</span>
    </section>
  );
}
