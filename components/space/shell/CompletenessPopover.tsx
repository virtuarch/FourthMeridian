"use client";

/**
 * components/space/shell/CompletenessPopover.tsx
 *
 * Opens from the shell's Completeness chip (S4). Shows the fixed-vocabulary tier
 * label + the envelope's one-sentence reason — Observed / Reconstructed /
 * Estimated / Incomplete / No history before … / Held at current value /
 * Held at current classification. NEVER a percentage. Reuses OverlaySurface
 * (portaled, focus-trapped, Escape-closes, focus restored).
 */

import { OverlaySurface } from "@/components/atlas/OverlaySurface";
import type { EnvelopeCompleteness } from "@/lib/perspectives/envelope";

export function CompletenessPopover({
  open,
  onClose,
  completeness,
}: {
  open: boolean;
  onClose: () => void;
  completeness: EnvelopeCompleteness;
}) {
  return (
    <OverlaySurface open={open} onClose={onClose} title="Completeness" subtitle={completeness.label}>
      <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
        {completeness.detail ?? completeness.label}
      </p>
      <p className="mt-3 text-[11px] text-[var(--text-faint)] leading-relaxed">
        Trust is stated in fixed terms — Observed, Reconstructed, Estimated, Incomplete —
        never a percentage.
      </p>
    </OverlaySurface>
  );
}
