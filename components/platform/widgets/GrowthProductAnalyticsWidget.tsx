"use client";

/**
 * components/platform/widgets/GrowthProductAnalyticsWidget.tsx  (BETA V3 · Workstream W4)
 *
 * ONE SectionSurface "Product analytics" for Growth & Revenue, over
 * GET /api/platform/growth-revenue/product-analytics (requirePlatformAccess
 * GROWTH_REVENUE READ; contract lib/platform/growth/product-analytics-types.ts).
 * Fleet grain, identity-minimised: no username, no Space name, no id ever
 * reaches this markup — per-user detail lives in Customer Success, and the
 * footnote says so (there is no `platform-*` workspace id for another area, so
 * no doorway is drawn).
 *
 * Six movements, in the design's order (BETA-PRODUCT-ANALYTICS-DESIGN.md §8):
 *   1. Registrations          three BigStats + registrations per UTC day
 *   2. Presence · engagement  3 windows × 3 strata as StatusTiles — the words
 *                             "present", "engaged", "sign-ins" are ALWAYS all
 *                             visible; there is no single "active" figure
 *   3. Retention              returning-ever + weekly cohorts × D1 / D7 window /
 *                             D7 strict; a too-young cohort says so
 *   4. Onboarding funnel      the FunnelStages grammar (numbered rows, count,
 *                             three-state rate cell, proportional bar) plus
 *                             the abandonment count per stage
 *   5. Feature adoption       feature · adopters · adoption · frequency, with
 *                             each figure's basis under "Technical details"
 *   6. Cost per engaged user  ESTIMATED, "estimate, not a bill"; null ⇒
 *                             Unavailable with the reader's reason
 *
 * Presentation only: every figure is read from the payload through the pure
 * product-analytics-view.ts, which authors no metric. `ProductAnalyticsSurface`
 * is prop-driven so every state is renderable in a test; the widget fetches.
 */

import { BarChart3 } from "lucide-react";
import { WidgetMessage, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { BigStat, GroupLabel, MiniBars, SectionSurface, StatusTile, Unavailable } from "../platform-surface";
import type { ProductAnalyticsResponse } from "@/lib/platform/growth/product-analytics-types";
import {
  ADOPTION_BASIS,
  DAY_SERIES_CAPTION,
  ESTIMATE_CAPTION,
  FEATURE_HEADINGS,
  RETENTION_BASIS,
  RETENTION_HEADINGS,
  activeTiles,
  checkedAtText,
  costReading,
  daySeries,
  engagedPerDay,
  featureRows,
  fmtCount,
  footnoteText,
  funnelRows,
  presentPerDay,
  registrationStats,
  retentionRows,
  returningEverText,
  type FunnelRow,
  type RetentionCell,
} from "./product-analytics-view";

/** ONE grid definition per table, shared by its header row and every data row. */
const RETENTION_COLS = "minmax(0,1.6fr) 5rem minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)";
const FEATURE_COLS = "minmax(0,1.4fr) 5rem minmax(0,1fr) minmax(0,1.6fr)";

const HEADING_CLASS = "text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]";

/** A movement inside the surface: eyebrow, then content, separated by one hairline. */
function Movement({ label, hint, children, first = false }: { label: string; hint?: string; children: React.ReactNode; first?: boolean }) {
  return (
    <div className={first ? "" : "mt-8 border-t pt-6"} style={first ? undefined : { borderColor: "var(--border-hairline)" }}>
      <GroupLabel hint={hint}>{label}</GroupLabel>
      <div className="mt-4">{children}</div>
    </div>
  );
}

/** A table cell that carries its column word below `md`, where the header row is hidden. */
function Cell({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col text-xs text-[var(--text-primary)]">
      <span className={`${HEADING_CLASS} md:hidden`}>{heading}</span>
      {children}
    </span>
  );
}

function RateCell({ heading, cell }: { heading: string; cell: RetentionCell }) {
  return (
    <Cell heading={heading}>
      <span className="tabular-nums">{cell.text}</span>
      {cell.qualifier && <span className="text-[10px] text-[var(--text-faint)]">{cell.qualifier}</span>}
    </Cell>
  );
}

/**
 * The onboarding funnel in the FunnelStages grammar — a numbered row per stage,
 * the count, a fixed-width three-state rate cell and a proportional bar — plus
 * the one thing that grammar has no slot for: the abandonment count. Not a
 * button: there is no stage panel on this surface, so a row is not selectable.
 */
function OnboardingFunnel({ rows }: { rows: readonly FunnelRow[] }) {
  if (rows.length === 0) return <p className="text-xs text-[var(--text-secondary)]">The reader returned no funnel stages.</p>;
  return (
    <ul className="flex flex-col">
      {rows.map((stage, i) => (
        <li key={stage.key} className="flex flex-col gap-1.5 border-b py-2.5 last:border-b-0" style={{ borderColor: "var(--border-hairline)" }}>
          <span className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="w-3 shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">{i + 1}</span>
              <span className="text-xs text-[var(--text-primary)]">{stage.label}</span>
            </span>
            <span className="flex shrink-0 items-baseline gap-3">
              <span className="text-xs tabular-nums text-[var(--text-primary)]">{fmtCount(stage.count)}</span>
              <span className="w-10 text-right text-[11px] tabular-nums text-[var(--text-muted)]">{stage.rateText ?? ""}</span>
            </span>
          </span>
          {stage.fraction != null && (
            <span className="flex items-center gap-2">
              <span aria-hidden className="w-3 shrink-0" />
              <span aria-hidden className="h-1.5 min-w-0 flex-1 overflow-hidden" style={{ borderRadius: 2, background: "var(--glass-ultrathin)" }}>
                <span className="block h-full" style={{ width: `${stage.fraction * 100}%`, borderRadius: 2, background: "color-mix(in srgb, var(--meridian-400) 45%, transparent)" }} />
              </span>
            </span>
          )}
          {stage.abandonedText && (
            <span className="flex items-baseline gap-2">
              <span aria-hidden className="w-3 shrink-0" />
              <span className="text-[11px] text-[var(--text-muted)]">{stage.abandonedText}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The prop-driven surface. Every state is reachable by handing it data. */
export function ProductAnalyticsSurface({ title, data }: { title: string; data: ProductAnalyticsResponse }) {
  const regs = registrationStats(data.registrations);
  const windows = activeTiles(data.active);
  const cohorts = retentionRows(data.retention.cohorts);
  const funnel = funnelRows(data.funnel, data.retention.abandonmentHorizonDays);
  const features = featureRows(data.features);
  const cost = costReading(data.cost);

  return (
    <SectionSurface
      icon={BarChart3}
      title={title}
      actions={<span className="text-[11px] text-[var(--text-muted)]">{checkedAtText(data.checkedAt)} · window {data.windowDays} d</span>}
      footnote={footnoteText(data.exclusions)}
    >
      {/* 1 · REGISTRATION — an account exists. */}
      <Movement label="Registrations" hint="An account exists (User rows). Not presence, not engagement." first>
        <div className="grid gap-6 sm:grid-cols-3">
          {regs.map((s) => <BigStat key={s.label} label={s.label} value={fmtCount(s.value)} qualifier={s.qualifier} />)}
        </div>
        <div className="mt-6">
          <MiniBars
            label={`Registrations per UTC day · last ${data.windowDays}`}
            points={daySeries(data.checkedAt, data.windowDays, data.registrations.perDay.map((d) => ({ day: d.day, value: d.count })), "registered")}
            format={(v) => `${fmtCount(v)} registered`}
            caption={DAY_SERIES_CAPTION}
          />
        </div>
      </Movement>

      {/* 2 · PRESENCE vs ENGAGEMENT vs SIGN-INS — three words, every window. */}
      <Movement label="Presence · engagement · sign-ins" hint="Three strata kept apart: a live session, meaningful product activity, and a credential sign-in. There is no single 'active' figure.">
        <div className="flex flex-col gap-6">
          {windows.map((w) => (
            <div key={w.window} className="flex flex-col gap-3">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">{w.label}</span>
              <div className="grid gap-6 sm:grid-cols-3">
                {w.tiles.map((t) => (
                  <StatusTile key={t.key} label={w.label} word={t.word} tone="muted" figure={fmtCount(t.count)} qualifier={t.basis} />
                ))}
              </div>
            </div>
          ))}
          <div className="grid gap-6 md:grid-cols-2">
            <MiniBars label="Present per UTC day" points={presentPerDay(data.active, data.checkedAt, data.windowDays)} format={(v) => `${fmtCount(v)} present`} caption={DAY_SERIES_CAPTION} />
            <MiniBars label="Engaged per UTC day" points={engagedPerDay(data.active, data.checkedAt, data.windowDays)} format={(v) => `${fmtCount(v)} engaged`} caption={DAY_SERIES_CAPTION} />
          </div>
        </div>
      </Movement>

      {/* 3 · RETENTION — weekly cohorts; a cohort too young says so. */}
      <Movement label="Retention" hint={RETENTION_BASIS}>
        <BigStat label="Returning ever" value={fmtCount(data.retention.returningEver.count)} qualifier={returningEverText(data.retention.returningEver)} />
        <div className="mt-6 overflow-x-auto">
          <div className="mb-1 hidden items-center gap-4 border-b px-1 pb-2 md:grid" style={{ gridTemplateColumns: RETENTION_COLS, borderColor: "var(--border-hairline)" }}>
            {RETENTION_HEADINGS.map((h) => <span key={h} className={HEADING_CLASS}>{h}</span>)}
          </div>
          {cohorts.length === 0 ? (
            <p className="py-3 text-xs text-[var(--text-secondary)]">No first-visit cohort falls in the window.</p>
          ) : (
            <ul className="flex flex-col">
              {cohorts.map((c) => (
                <li key={c.key} className="flex flex-wrap gap-x-4 gap-y-2 border-b px-1 py-2.5 last:border-b-0 md:grid md:items-start" style={{ gridTemplateColumns: RETENTION_COLS, borderColor: "var(--border-hairline)" }}>
                  <Cell heading={RETENTION_HEADINGS[0]}><span>{c.week}</span></Cell>
                  <Cell heading={RETENTION_HEADINGS[1]}><span className="tabular-nums">{fmtCount(c.cohortSize)}</span></Cell>
                  <RateCell heading={RETENTION_HEADINGS[2]} cell={c.d1} />
                  <RateCell heading={RETENTION_HEADINGS[3]} cell={c.d7Window} />
                  <RateCell heading={RETENTION_HEADINGS[4]} cell={c.d7Strict} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Movement>

      {/* 4 · ONBOARDING FUNNEL — the Growth funnel grammar, plus abandonment. */}
      <Movement label="Onboarding funnel" hint={`Stage counts with a three-state conversion rate; abandonment = reached this stage but not the next within ${data.retention.abandonmentHorizonDays} days.`}>
        <OnboardingFunnel rows={funnel} />
      </Movement>

      {/* 5 · FEATURE ADOPTION — figures on the surface, bases in the disclosure. */}
      <Movement label="Feature adoption" hint={ADOPTION_BASIS}>
        <div className="overflow-x-auto">
          <div className="mb-1 hidden items-center gap-4 border-b px-1 pb-2 md:grid" style={{ gridTemplateColumns: FEATURE_COLS, borderColor: "var(--border-hairline)" }}>
            {FEATURE_HEADINGS.map((h) => <span key={h} className={HEADING_CLASS}>{h}</span>)}
          </div>
          {features.length === 0 ? (
            <p className="py-3 text-xs text-[var(--text-secondary)]">The reader returned no feature rows.</p>
          ) : (
            <ul className="flex flex-col">
              {features.map((f) => (
                <li key={f.key} className="flex flex-wrap gap-x-4 gap-y-2 border-b px-1 py-2.5 last:border-b-0 md:grid md:items-start" style={{ gridTemplateColumns: FEATURE_COLS, borderColor: "var(--border-hairline)" }}>
                  <Cell heading={FEATURE_HEADINGS[0]}><span>{f.label}</span></Cell>
                  <Cell heading={FEATURE_HEADINGS[1]}><span className="tabular-nums">{fmtCount(f.adopters)}</span></Cell>
                  <Cell heading={FEATURE_HEADINGS[2]}><span className="tabular-nums">{f.adoptionText}</span></Cell>
                  <Cell heading={FEATURE_HEADINGS[3]}><span className="tabular-nums">{f.frequencyText}</span></Cell>
                </li>
              ))}
            </ul>
          )}
        </div>
        <details className="mt-4">
          <summary className="cursor-pointer text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]">
            Technical details
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            {features.map((f) => <li key={f.key}><span className="text-[var(--text-secondary)]">{f.label}</span> — {f.basis}</li>)}
            <li>{ADOPTION_BASIS}</li>
          </ul>
        </details>
      </Movement>

      {/* 6 · COST PER ENGAGED USER — an estimate with its derivation, or the reason there is none. */}
      <Movement label="Cost per engaged user" hint="AI customer surfaces (chat + Brief) plus Plaid Item-months, divided by engaged users over the window. Rate-card estimate; no actual-charge ledger exists.">
        <BigStat
          label={`Estimated cost per engaged user · ${data.windowDays} d`}
          value={cost.kind === "figure" ? cost.value : <Unavailable reason={cost.reason} />}
          qualifier={cost.kind === "figure" ? cost.qualifier : ESTIMATE_CAPTION}
          derivation={cost.derivation}
        />
        {data.cost.notes.length > 0 && (
          <ul className="mt-3 flex flex-col gap-0.5 text-[10px] leading-relaxed text-[var(--text-faint)]">
            {data.cost.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      </Movement>
    </SectionSurface>
  );
}

export function GrowthProductAnalyticsWidget({ section }: { section: PlatformSection; onOpenWorkspace?: (id: string) => void }) {
  const { data, loading, error } = useWidgetFetch<ProductAnalyticsResponse>("/api/platform/growth-revenue/product-analytics");
  if (loading || error || !data) {
    return (
      <SectionSurface icon={BarChart3} title={section.label}>
        <WidgetMessage loading={loading} error={error} empty="The product-analytics reader returned nothing." />
      </SectionSurface>
    );
  }
  return <ProductAnalyticsSurface title={section.label} data={data} />;
}
