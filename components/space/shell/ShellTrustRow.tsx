"use client";

/**
 * components/space/shell/ShellTrustRow.tsx
 *
 * The shell's ORTHOGONAL CAVEATS — the warning chips (FX today, syncing) that
 * qualify the money on screen. Renders nothing when there are none.
 *
 * It used to lead with two always-on chips, "Completeness  Observed" and
 * "Evidence  2 accounts". On the normal path those said "nothing is wrong" and
 * "you have accounts" in the most valuable strip of the page, above the figures
 * they described. They are removed from this surface — PRESENTATION ONLY:
 *
 *   • `PerspectiveEnvelope.completeness` / `.evidence` are still resolved for
 *     every perspective (lib/perspectives/envelope.ts) and still feed the
 *     deterministic contracts, AI, the Daily Brief and diagnostics;
 *   • a completeness tier that CHANGES how a figure should be read still
 *     surfaces beside that figure, via the hero's TrustIndicator;
 *   • CompletenessPopover / EvidenceDrawer remain, used by TrustIndicator and
 *     the Wealth workspace's per-point evidence.
 *
 * A caveat is different in kind: "FX rate unavailable" means a displayed total
 * is partial. That is not status chrome, so it stays.
 *
 * Presentation only — reads the active perspective's envelope, owns no state.
 */

import { AlertTriangle } from "lucide-react";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";

interface Props {
  /** The active perspective's trust envelope. Only `warnings` is rendered here. */
  envelope: PerspectiveEnvelope;
  className?: string;
}

export function ShellTrustRow({ envelope, className = "" }: Props) {
  const warnings = envelope.warnings ?? [];
  if (warnings.length === 0) return null;

  return (
    <div className={["flex flex-wrap items-center gap-2", className].join(" ")}>
      {warnings.map((w, i) => (
        <div
          key={`${w.kind}-${i}`}
          title={w.detail ?? w.label}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 bg-[var(--surface-inset)] border border-[var(--border-hairline)]"
        >
          <span className="text-[var(--accent-warning)]" aria-hidden><AlertTriangle size={13} /></span>
          <span className="text-[11px] font-semibold text-[var(--accent-warning)]">{w.label}</span>
        </div>
      ))}
    </div>
  );
}
