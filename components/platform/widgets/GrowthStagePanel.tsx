"use client";

/**
 * components/platform/widgets/GrowthStagePanel.tsx  (GROWTH-1 · growth_funnel)
 *
 * The stage INSPECTION surface — an Atlas `RightPanel` over one funnel stage.
 * Follows the shipped Ledger → Detail precedent (SourcesLedger →
 * SourceAccountDetail, HoldingsLedger → HoldingDetail): the list owns the
 * selection, the panel renders the selected subject, and the workspace behind it
 * is preserved.
 *
 * ── IT SHOWS ONLY WHAT THE PAYLOAD OWNS ───────────────────────────────────────
 * Funnel identity, stage identity, the count, the conversion rate when the
 * authority provides one, and the adjacent canonical stages — because adjacency
 * is where the difference in counts went, and it comes from the same payload.
 *
 * ── WHAT IT REFUSES TO SHOW, AND SAYS SO ──────────────────────────────────────
 * `GrowthFunnel` is an aggregate projection: it returns counts and ratios and no
 * member-level or request-level rows at all. So there is no evidence list here,
 * and rather than leaving a suspicious gap the panel states the limit plainly.
 * There is no interpretation, no cause, no recommendation, and no action — a
 * panel that offered any of those would be asserting something no authority
 * computed. That is also why there is no `PanelFooter`: dismissal is the header's
 * close control, and inventing a button to fill a footer is how a read surface
 * quietly becomes a control surface.
 */

import { type ReactNode } from "react";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import {
  RATE_UNAVAILABLE,
  adjacentStages,
  formatRate,
  type FunnelStageView,
  type FunnelView,
} from "./growth-funnel-view";

/** Label left, value right. Local presentation, not a shared abstraction. */
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-xs text-[var(--text-secondary)]">{label}</span>
      <span className="min-w-0 text-right text-xs tabular-nums text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{title}</h3>
      {children}
    </section>
  );
}

export function GrowthStagePanel({
  views,
  stage,
  onClose,
}: {
  views: FunnelView[];
  /** The selected stage, or null when the panel is closed. */
  stage: FunnelStageView | null;
  onClose: () => void;
}) {
  const { previous, next } = stage ? adjacentStages(views, stage.id) : { previous: null, next: null };
  const rate = stage ? formatRate(stage.rate) : null;

  return (
    /**
     * ALWAYS MOUNTED, `open` toggles — the shipped ledger pattern
     * (SourcesLedger, HoldingsLedger, LiabilitiesLedger all do exactly this).
     * Unmounting on close would skip <Panel>'s presence-driven exit animation
     * entirely, and `ariaLabel` covers the moment the header has unmounted
     * mid-exit. Selecting another stage re-renders THIS panel with a new subject:
     * the panel never closes and reopens, so the workspace behind it is untouched
     * and its scroll position is preserved.
     */
    <RightPanel open={stage != null} onClose={onClose} size="md" ariaLabel="Funnel stage detail">
      {stage && (
        <>
          <PanelHeader eyebrow={stage.funnelLabel} title={stage.label} />

          <PanelContent>
            <div className="flex flex-col gap-5">
          <Group title="Stage">
            <Fact label="Count" value={stage.count.toLocaleString()} />
            <Fact
              label="Conversion from previous stage"
              value={
                rate == null ? (
                  <span className="text-[var(--text-muted)]">not measured by this projection</span>
                ) : rate === RATE_UNAVAILABLE ? (
                  <span className="text-[var(--text-muted)]">{RATE_UNAVAILABLE} no denominator</span>
                ) : (
                  rate
                )
              }
            />
            <Fact label="Authority field" value={<span className="font-mono text-[11px]">{stage.field}</span>} />
            {stage.rateField && (
              <Fact label="Rate field" value={<span className="font-mono text-[11px]">{stage.rateField}</span>} />
            )}
          </Group>

          <Group title="Adjacent stages">
            <Fact
              label="Previous"
              value={
                previous ? (
                  `${previous.label} · ${previous.count.toLocaleString()}`
                ) : (
                  <span className="text-[var(--text-muted)]">none — first stage</span>
                )
              }
            />
            <Fact
              label="Next"
              value={
                next ? (
                  `${next.label} · ${next.count.toLocaleString()}`
                ) : (
                  <span className="text-[var(--text-muted)]">none — last stage</span>
                )
              }
            />
          </Group>

          {stage.siblings && stage.siblings.length > 0 && (
            <Group title="Other outcomes at this step">
              {stage.siblings.map((s) => (
                <Fact key={s.field} label={s.label} value={s.count.toLocaleString()} />
              ))}
              <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
                Canonical fields on the same payload — where the requests that were not approved went.
              </p>
            </Group>
          )}

          <Group title="Evidence">
            <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
              Stage-level evidence is not available from the current projection.{" "}
              <span className="font-mono text-[10px]">GrowthFunnel</span> returns aggregate counts and ratios only — no
              member-level or request-level rows — so there is nothing here to list without inventing it.
            </p>
              </Group>
            </div>
          </PanelContent>
        </>
      )}
    </RightPanel>
  );
}
