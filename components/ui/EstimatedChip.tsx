/**
 * components/ui/EstimatedChip.tsx
 *
 * MC1 Phase 4 Slice 3 (plan D-5) — the quiet estimation marker for AGGREGATE
 * values whose conversion was estimated (walked-back/missing rate, or
 * null-residue provenance). Styling copied verbatim from PerspectivesWidget's
 * existing LensMetric "est." marker so there is exactly one visual language.
 * Render ONLY when the surface's `estimated` flag is true — silent otherwise;
 * itemized rows never carry it.
 */
export function EstimatedChip() {
  return (
    <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] align-middle">
      est.
    </span>
  );
}
