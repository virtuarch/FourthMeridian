"use client";

/**
 * components/platform/ops-visual/HealthHero.tsx  (Platform Ops visual spec §4 row A)
 *
 * The Operations health hero, composed exactly like a Personal Space hero:
 *
 *   ≥ lg   the bare hero (WealthHero's desktop form): one small uppercase label +
 *          the checked time, ONE large figure (the verdict word, Atlas `Figure`
 *          size "hero"), one caption line, then the four KPI figures on Atlas
 *          `Surface` tiles.
 *   < lg   the shared `CompactHeroCard` (the Net Worth / Cash Flow phone card,
 *          unchanged) followed by the KPIs as two 2-up `CompactKpiStrip`s (2×2).
 *
 * Presentation only: every word and figure arrives from ops-visual-model.ts.
 */

import { CompactHeroCard } from "@/components/space/compact/CompactHeroCard";
import { CompactKpiStrip } from "@/components/space/compact/CompactKpiStrip";
import { Figure, Surface } from "@/components/atlas/Surface";
import { TONE_COLOR, type StatusTone } from "../platform-surface";
import type { Kpi } from "./ops-visual-model";

export interface HeroModel {
  verdict: { word: string; tone: StatusTone };
  /** "Checked 05:31 UTC", or null when the overview did not answer. */
  checked: string | null;
  /** ONE line under the verdict. */
  caption: string;
  /** The compact card's fourth row (one line). */
  basisLine: string;
  kpis: readonly Kpi[];
}

function Dot({ tone, size = 10 }: { tone: StatusTone; size?: number }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: TONE_COLOR[tone] }} />;
}

export function HealthHero({ model }: { model: HeroModel }) {
  const { verdict, checked, caption, basisLine, kpis } = model;
  const pair = (from: number) => kpis.slice(from, from + 2).map((k) => ({
    key: k.key,
    label: k.label,
    value: k.value,
    change: <span style={{ color: k.tone && k.tone !== "muted" ? TONE_COLOR[k.tone] : "var(--text-muted)" }}>{k.sub}</span>,
  }));
  return (
    <div id="ops-health" className="scroll-mt-20" data-health-hero>
      {/* COMPACT (< lg) — the Personal phone hero card + a 2×2 KPI grid. */}
      <CompactHeroCard
        title="Platform health"
        freshness={checked}
        trust={<Dot tone={verdict.tone} size={8} />}
        value={verdict.word}
        valueTone={verdict.tone === "bad" ? "negative" : "neutral"}
        change={null}
        noChangeLabel={caption}
        range={basisLine}
        currency="USD"
      />
      <div className="mt-3 flex flex-col gap-2 lg:hidden">
        <CompactKpiStrip ariaLabel="Platform health figures" items={pair(0)} />
        <CompactKpiStrip ariaLabel="Platform activity figures" items={pair(2)} />
      </div>

      {/* DESKTOP (≥ lg) — the bare hero, then four figure tiles. */}
      <section className="max-lg:hidden" aria-label="Platform health">
        <div className="flex items-baseline gap-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Platform health</p>
          {checked && <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{checked}</span>}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <Dot tone={verdict.tone} size={12} />
          <Figure value={verdict.word} size="hero" className="leading-none sm:text-5xl" tone={verdict.tone === "bad" ? "down" : "neutral"} />
        </div>
        <p className="mt-2.5 truncate text-sm text-[var(--text-secondary)]">{caption}</p>
        <dl className="mt-6 grid grid-cols-4 gap-4" aria-label="Platform health figures">
          {kpis.map((k) => (
            <Surface key={k.key} className="min-w-0 px-4 py-3.5">
              <dt className="truncate text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{k.label}</dt>
              <dd className="mt-1.5"><Figure value={k.value} size="figure" tone={k.tone === "muted" ? "muted" : "neutral"} /></dd>
              <dd className="mt-0.5 truncate text-[11px]" style={{ color: k.tone && k.tone !== "muted" ? TONE_COLOR[k.tone] : "var(--text-muted)" }}>{k.sub}</dd>
            </Surface>
          ))}
        </dl>
      </section>
    </div>
  );
}
