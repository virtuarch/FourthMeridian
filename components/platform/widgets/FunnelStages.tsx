"use client";

/**
 * components/platform/widgets/FunnelStages.tsx  (GROWTH-1 · growth_funnel)
 *
 * One canonical funnel, rendered as selectable stages. Presentation only: every
 * count and rate arrives already decided by `growth-funnel-view.ts`, which in
 * turn reads them from `GrowthFunnel`. This file computes nothing.
 *
 * DELIBERATELY GROWTH-SHAPED, NOT A PLATFORM PRIMITIVE. It is shared between the
 * beta and activation funnels because those are the same shape from the same
 * authority — and no further. Promoting it to a cross-domain operational
 * component would need a second domain that actually has ordered stages, and
 * none does today.
 *
 * ── WHAT IS NOT HERE, ON PURPOSE ──────────────────────────────────────────────
 *   • No colour. A count is not a verdict: nothing here is green, amber or red,
 *     because no stage is "healthy" or "failing" — those would be claims the
 *     projection does not make.
 *   • No hover-only information. Every fact is on the surface, so the funnel
 *     reads identically to a mouse and to a finger.
 *   • No percentage for a stage the authority does not measure. See the
 *     three-state `rate` contract in growth-funnel-view.ts.
 */

import { barFraction, formatRate, type FunnelStageView, type FunnelView } from "./growth-funnel-view";

export function FunnelStages({
  view,
  selectedId,
  onSelect,
}: {
  view: FunnelView;
  selectedId: string | null;
  onSelect: (stage: FunnelStageView) => void;
}) {
  // The first stage is the proportionality denominator (null/0 ⇒ no bars at all).
  const denominator = view.stages[0]?.count ?? null;

  return (
    <section aria-label={view.label} className="flex min-w-0 flex-col">
      <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
        {view.label}
      </h3>

      <ul className="flex flex-col">
        {view.stages.map((stage, i) => {
          const rate = formatRate(stage.rate);
          const fraction = barFraction(stage.count, denominator);
          const selected = stage.id === selectedId;

          return (
            <li key={stage.id} className="border-b last:border-b-0" style={{ borderColor: "var(--border-hairline)" }}>
              <button
                type="button"
                onClick={() => onSelect(stage)}
                aria-pressed={selected}
                className="flex w-full flex-col gap-1.5 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
                style={{ background: selected ? "var(--surface-hover)" : undefined }}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="w-3 shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">{i + 1}</span>
                    <span className="truncate text-xs text-[var(--text-primary)]">{stage.label}</span>
                  </span>
                  <span className="flex shrink-0 items-baseline gap-3">
                    <span className="text-xs tabular-nums text-[var(--text-primary)]">
                      {stage.count.toLocaleString()}
                    </span>
                    {/* The rate cell keeps its width whether or not there is a
                        rate, so the column stays aligned down the funnel. An
                        unmeasured stage renders an empty cell — not a dash,
                        which would claim the authority tried and failed. */}
                    <span className="w-10 text-right text-[11px] tabular-nums text-[var(--text-muted)]">
                      {rate ?? ""}
                    </span>
                  </span>
                </span>

                {fraction != null && (
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="w-3 shrink-0" />
                    <span
                      aria-hidden
                      className="h-1.5 min-w-0 flex-1 overflow-hidden"
                      style={{ borderRadius: 2, background: "var(--glass-ultrathin)" }}
                    >
                      <span
                        className="block h-full"
                        style={{
                          width: `${fraction * 100}%`,
                          borderRadius: 2,
                          background: "rgba(125,168,255,.45)",
                        }}
                      />
                    </span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
