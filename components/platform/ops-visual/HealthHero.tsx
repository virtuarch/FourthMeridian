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
 *   < lg   it2 — the CompactHeroCard RHYTHM (same panel treatment `COMPACT_HERO`
 *          and the same first three row classes `COMPACT_HERO_ROWS`) without its
 *          finance-only rows: title + checked time · the verdict · ONE caption
 *          line — no empty change/range/talk rows (the shared card reserves them
 *          at fixed heights, which left ~70 px of nothing here). The KPIs follow
 *          directly as two 2-up `CompactKpiStrip`s (2×2). CompactHeroCard itself
 *          is unchanged.
 *
 * Presentation only: every word and figure arrives from ops-visual-model.ts.
 *
 * Shared by the Providers ("Integration health") and AI & Costs ("AI spend")
 * heroes: `title`, `dot`, `provenance` and `kpiLabels` are optional and default
 * to the Operations hero exactly as accepted (no Operations markup changes).
 */

import { ChevronRight } from "lucide-react";
import { COMPACT_HERO_ROWS } from "@/components/space/compact/CompactHeroCard";
import { COMPACT_HERO } from "@/components/space/compact/compact-hero";
import { CompactKpiStrip } from "@/components/space/compact/CompactKpiStrip";
import { Figure, Surface } from "@/components/atlas/Surface";
import { TONE_COLOR, type StatusTone } from "../platform-surface";
import { ProvenanceChip, type ProvenanceKind } from "../ui/ProvenanceChip";
import type { Kpi } from "./ops-visual-model";

export interface HeroModel {
  verdict: { word: string; tone: StatusTone };
  /** "Checked 05:31 UTC", or null when the overview did not answer. */
  checked: string | null;
  /** ONE line under the verdict. */
  caption: string;
  kpis: readonly Kpi[];
  /** The hero's label (default "Platform health"). */
  title?: string;
  /** Whether the verdict carries a status dot (default true; a money figure has none). */
  dot?: boolean;
  /** What KIND of figure the hero is (a chip beside the label), when it is not a verdict. */
  provenance?: ProvenanceKind;
  /** The two compact KPI strips' and the desktop tiles' accessible names. */
  kpiLabels?: { first: string; second: string; all: string };
  /**
   * Platform Spaces 2.0 (owner) — the KPIs that OPEN something real (a drawer
   * of records, a view, or the chart that breaks the figure down), keyed by KPI
   * key. A KPI without an entry stays a static figure: no hover, no chevron, no
   * button — never fake clickability.
   */
  actions?: Readonly<Record<string, KpiAction>>;
}

export interface KpiAction {
  /** What opens, in words ("Open the attention list") — the tile's accessible name suffix. */
  label: string;
  onSelect: () => void;
  /** True when it opens a dialog / drawer (aria-haspopup). */
  dialog?: boolean;
}

const TILE_BUTTON =
  "group block w-full min-w-0 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] rounded-[inherit]";

function Dot({ tone, size = 10 }: { tone: StatusTone; size?: number }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: TONE_COLOR[tone] }} />;
}

export function HealthHero({ model }: { model: HeroModel }) {
  const { verdict, checked, caption, kpis } = model;
  const title = model.title ?? "Platform health";
  const dot = model.dot ?? true;
  const labels = model.kpiLabels ?? { first: "Platform health figures", second: "Platform activity figures", all: "Platform health figures" };
  const actions = model.actions ?? {};
  const actionable = kpis.some((k) => actions[k.key]);
  const pair = (from: number) => kpis.slice(from, from + 2).map((k) => ({
    key: k.key,
    label: k.label,
    value: k.value,
    change: <span style={{ color: k.tone && k.tone !== "muted" ? TONE_COLOR[k.tone] : "var(--text-muted)" }}>{k.sub}</span>,
  }));
  return (
    <div id="ops-health" className="scroll-mt-20" data-health-hero>
      {/* COMPACT (< lg) — the Personal phone hero card + a 2×2 KPI grid. */}
      <section data-compact-hero aria-label={title} className={`lg:hidden grid gap-1 ${COMPACT_HERO}`}>
        <div className={COMPACT_HERO_ROWS[0]}>
          <p className="shrink-0 whitespace-nowrap text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{title}</p>
          {model.provenance && <ProvenanceChip kind={model.provenance} />}
          <span className="ml-auto min-w-0 truncate text-[11px] tabular-nums text-[var(--text-muted)]">{checked ?? ""}</span>
        </div>
        <div className={`${COMPACT_HERO_ROWS[1]} gap-2.5`}>
          {dot && <Dot tone={verdict.tone} size={10} />}
          <p
            className="min-w-0 overflow-hidden whitespace-nowrap text-[clamp(28px,9vw,40px)] font-semibold leading-tight tracking-tight"
            style={{ color: verdict.tone === "bad" ? "var(--accent-negative)" : "var(--text-primary)" }}
          >
            {verdict.word}
          </p>
        </div>
        <div className={COMPACT_HERO_ROWS[2]}>
          <p className="min-w-0 truncate text-[12px] leading-6 text-[var(--text-muted)]" title={caption}>{caption}</p>
        </div>
      </section>
      <div className="mt-3 flex flex-col gap-2 lg:hidden">
        {!actionable ? (
          <>
            <CompactKpiStrip ariaLabel={labels.first} items={pair(0)} />
            <CompactKpiStrip ariaLabel={labels.second} items={pair(2)} />
          </>
        ) : (
          /* The Personal strip's exact tile treatment (CompactKpiStrip has no
             action slot and is not changed): an actionable tile is a button with
             a chevron; a static one stays a plain figure. */
          <div className="grid grid-cols-2 gap-2" aria-label={labels.all} role="group" data-compact-kpi-strip>
            {kpis.map((k) => {
              const a = actions[k.key];
              const body = (
                <>
                  <span className="flex items-center justify-between gap-1">
                    <span className="truncate text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{k.label}</span>
                    {a && <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-faint)] group-hover:text-[var(--text-secondary)]" />}
                  </span>
                  <span className="mt-1 block text-[13px] font-semibold leading-tight tabular-nums text-[var(--text-primary)] [overflow-wrap:anywhere]">{k.value}</span>
                  <span className="mt-0.5 block text-[11px] leading-tight tabular-nums [overflow-wrap:anywhere]" style={{ color: k.tone && k.tone !== "muted" ? TONE_COLOR[k.tone] : "var(--text-muted)" }}>{k.sub}</span>
                </>
              );
              const tile = "min-w-0 rounded-[var(--radius-lg)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-3 py-2.5";
              return a ? (
                <button key={k.key} type="button" onClick={a.onSelect} aria-haspopup={a.dialog ? "dialog" : undefined}
                  aria-label={`${k.label}: ${k.value} — ${a.label}`} className={`${TILE_BUTTON} ${tile} min-h-11 transition-colors hover:border-[var(--border-hairline-strong)]`} data-compact-kpi={k.key} data-kpi-action>
                  {body}
                </button>
              ) : (
                <div key={k.key} className={tile} data-compact-kpi={k.key}>{body}</div>
              );
            })}
          </div>
        )}
      </div>

      {/* DESKTOP (≥ lg) — the bare hero, then four figure tiles. */}
      <section className="max-lg:hidden" aria-label={title}>
        <div className="flex items-baseline gap-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{title}</p>
          {checked && <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{checked}</span>}
          {model.provenance && <ProvenanceChip kind={model.provenance} />}
        </div>
        <div className="mt-2 flex items-center gap-3">
          {dot && <Dot tone={verdict.tone} size={12} />}
          <Figure value={verdict.word} size="hero" className="leading-none sm:text-5xl" tone={verdict.tone === "bad" ? "down" : "neutral"} />
        </div>
        <p className="mt-2.5 truncate text-sm text-[var(--text-secondary)]">{caption}</p>
        <div className="mt-6 grid grid-cols-4 gap-4" role="group" aria-label={labels.all}>
          {kpis.map((k) => {
            const a = actions[k.key];
            const inner = (
              <>
                <span className="flex items-center justify-between gap-1">
                  <span className="truncate text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{k.label}</span>
                  {a && <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-faint)] group-hover:text-[var(--text-secondary)]" />}
                </span>
                <span className="mt-1.5 block"><Figure value={k.value} size="figure" tone={k.tone === "muted" ? "muted" : "neutral"} /></span>
                <span className="mt-0.5 block truncate text-[11px]" style={{ color: k.tone && k.tone !== "muted" ? TONE_COLOR[k.tone] : "var(--text-muted)" }}>{k.sub}</span>
              </>
            );
            return (
              <Surface key={k.key} className={`min-w-0 ${a ? "transition-colors hover:border-[var(--border-hairline-strong)]" : ""}`}>
                {a ? (
                  <button type="button" onClick={a.onSelect} aria-haspopup={a.dialog ? "dialog" : undefined} aria-label={`${k.label}: ${k.value} — ${a.label}`}
                    className={`${TILE_BUTTON} px-4 py-3.5`} data-kpi-action={k.key}>
                    {inner}
                  </button>
                ) : (
                  <div className="px-4 py-3.5">{inner}</div>
                )}
              </Surface>
            );
          })}
        </div>
      </section>
    </div>
  );
}
