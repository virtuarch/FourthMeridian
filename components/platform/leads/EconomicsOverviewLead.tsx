"use client";

/**
 * components/platform/leads/EconomicsOverviewLead.tsx  (Platform Economics — Overview)
 *
 * "What does running the platform cost, per customer — and what can we NOT see?"
 * One read (GET /api/platform/platform-ops/economics, PLATFORM_OPS READ), every
 * figure with its status chip (Measured · Estimated · Partial · Unavailable),
 * its window and its reason. Every figure with records OPENS them: the drawer
 * reads the figure's own drill href (the same inputs, the same window end), so
 * the list total and the tile agree.
 *
 *   ≥ lg (12-col)
 *     A  Operating cost · this cycle (12)   lower bound + split KPIs (AI · Providers ·
 *                                           Infrastructure · Cost per engaged customer)
 *     B  Revenue · Margin · Engaged customers (3 tiles; revenue + margin UNAVAILABLE)
 *     C  AI cost trend (8)                  7 / 30 / 90 d, gaps never drawn as $0
 *        Cost split (4)                     AI / Providers / Infrastructure shares
 *   < lg  the same stack, one column (tiles 2-up).
 *
 * The open drill lives in the URL (?econ=<figure>.<window>&econuntil=<ms>, REPLACE,
 * workspace-scoped) so it survives a refresh and is linkable.
 * Presentation only — words come from economics-model.ts (pure).
 */

import { useCallback, useEffect, useState } from "react";
import { Block, Surface } from "@/components/atlas/Surface";
import { TrendChart } from "@/components/space/widgets/charts/TrendChart";
import { useSpaceUrl } from "@/components/space/shell/useSpaceUrl";
import { DetailDrawer } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import type { PlatformViewLeadProps } from "./lead-contract";
import type { Fetched } from "../ops-visual/ops-visual-model";
import { Caption, ChartMessage, Segmented } from "./visual-kit";
import type {
  EconomicsDrillResponse, EconomicsFigure, EconomicsSnapshot, EconomicsStatus, TrendWindow,
} from "@/lib/platform/economics/snapshot-core";
import {
  STATUS_WORD, checkedText, drillStateOf, drillTotalText, economicsDrillApiPath, economicsDrillUrlUpdate,
  figureSubText, figureValueText, readEconomicsDrillUrl, rowValueText, splitFigures, splitShares,
  trendDays, trendSeries, windowText, type EconomicsDrillUrlState,
} from "./economics-model";

export const ECONOMICS_URL = "/api/platform/platform-ops/economics";

const STATUS_COLOR: Readonly<Record<EconomicsStatus, string>> = {
  MEASURED: "var(--meridian-400)",
  ESTIMATED: "var(--brass-300)",
  PARTIAL: "var(--brass-300)",
  UNAVAILABLE: "var(--text-faint)",
};

/** The status chip: the word, never a colour alone. */
export function EconomicsStatusChip({ status, title }: { status: EconomicsStatus; title?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]" data-econ-status={status} title={title}>
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[status] }} />
      {STATUS_WORD[status]}
    </span>
  );
}

const TILE = "flex min-w-0 flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--border-hairline)] p-3 text-left";
const TILE_BUTTON = `${TILE} transition-colors hover:bg-[var(--glass-ultrathin)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]`;

/** One figure as a tile. With records it is a button that opens them; without, plain text. */
export function FigureTile({ figure, onOpen }: { figure: EconomicsFigure; onOpen?: (f: EconomicsFigure) => void }) {
  const body = (
    <>
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-[11px] text-[var(--text-secondary)]">{figure.label}</span>
        <EconomicsStatusChip status={figure.status} title={figure.basis} />
      </span>
      <span className="truncate text-lg font-semibold tabular-nums text-[var(--text-primary)]" data-econ-value={figure.key}>{figureValueText(figure)}</span>
      <span className="line-clamp-2 break-words text-[11px] text-[var(--text-muted)]">{figureSubText(figure)}</span>
    </>
  );
  return figure.drill && onOpen ? (
    <button type="button" className={TILE_BUTTON} onClick={() => onOpen(figure)} aria-haspopup="dialog" aria-label={`${figure.label}: ${figureValueText(figure)} — open its records`} data-econ-tile={figure.key} data-econ-drill={figure.drill.href}>
      {body}
    </button>
  ) : (
    <div className={TILE} data-econ-tile={figure.key}>{body}</div>
  );
}

// ── The surface (prop-driven, fetch-free — every state renders in a test) ────

export interface EconomicsOverviewSurfaceProps {
  snapshot: Fetched<EconomicsSnapshot>;
  onOpenDrill: (f: EconomicsFigure) => void;
  /** Open the AI & Costs view (the detail of the AI figure). */
  onOpenAiCosts?: () => void;
}

function TrendCard({ s, onOpenDrill }: { s: EconomicsSnapshot; onOpenDrill: (f: EconomicsFigure) => void }) {
  const [win, setWin] = useState<TrendWindow>("30d");
  const fig = s.trend.windows[win];
  const series = trendSeries(trendDays(s, win));
  return (
    <Block id="econ-trend" label="AI cost trend" className="min-w-0 lg:col-span-8"
      hint={<EconomicsStatusChip status={fig.status} />}
      action={<Segmented label="Trend window" value={win} onChange={setWin} options={[{ id: "7d", label: "7 d" }, { id: "30d", label: "30 d" }, { id: "90d", label: "90 d" }]} />}>
      <Surface className="flex-1 p-4 sm:p-5">
        {series.points.length === 0 ? (
          <ChartMessage>{fig.reason ? `No AI cost to draw — ${fig.reason}` : "No priced AI usage in this window."}</ChartMessage>
        ) : (
          <TrendChart points={series.points} currency="USD" ariaLabel={`Estimated AI cost per UTC day, last ${win.replace("d", "")} days`} emptyMessage="No priced AI usage in this window." />
        )}
        <Caption>
          {fig.drill ? (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => onOpenDrill(fig)} aria-haspopup="dialog" data-econ-tile={`${fig.key}.${fig.window}`}>
              {`${figureValueText(fig)} · ${windowText(fig)}`}
            </button>
          ) : `${figureValueText(fig)} · ${windowText(fig)}`}
          {series.gaps > 0 ? ` · ${series.gaps} day${series.gaps === 1 ? "" : "s"} without priced data (gaps, not $0)` : ""}
        </Caption>
        <p className="mt-1 line-clamp-2 text-[11px] text-[var(--text-faint)]">{s.trend.note}</p>
      </Surface>
    </Block>
  );
}

function SplitCard({ s, onOpenDrill }: { s: EconomicsSnapshot; onOpenDrill: (f: EconomicsFigure) => void }) {
  const figs = splitFigures(s);
  const shares = splitShares(figs);
  return (
    <Block id="econ-split" label="Cost split · this cycle" className="min-w-0 lg:col-span-4">
      <Surface className="flex-1 px-4 py-2 sm:px-5">
        <ul aria-label="Operating cost split" className="flex flex-col">
          {figs.map((f, i) => (
            <li key={f.key} className="flex min-h-11 flex-col justify-center gap-1 border-t border-[var(--border-hairline)] py-2 first:border-t-0">
              <span className="flex min-w-0 items-center justify-between gap-2 text-[11px]">
                {f.drill ? (
                  <button type="button" className="min-w-0 truncate text-left text-[var(--text-secondary)] underline-offset-2 hover:underline" onClick={() => onOpenDrill(f)} aria-haspopup="dialog">{f.label}</button>
                ) : <span className="min-w-0 truncate text-[var(--text-secondary)]">{f.label}</span>}
                <span className="shrink-0 tabular-nums text-[var(--text-primary)]">{figureValueText(f)}</span>
              </span>
              {shares[i] === null
                ? <span className="block h-2 w-full rounded-full border border-dashed border-[var(--border-hairline-strong)]" role="img" aria-label={`${f.label}: no figure`} />
                : <span className="block h-2 w-full overflow-hidden rounded-full bg-[var(--border-hairline)]" role="img" aria-label={`${f.label}: ${shares[i]}% of the priced cost`}>
                    <span className="block h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, shares[i]!))}%`, background: STATUS_COLOR[f.status] }} />
                  </span>}
              <span className="truncate text-[10px] text-[var(--text-muted)]">{figureSubText(f)}</span>
            </li>
          ))}
        </ul>
      </Surface>
    </Block>
  );
}

export function EconomicsOverviewSurface({ snapshot, onOpenDrill, onOpenAiCosts }: EconomicsOverviewSurfaceProps) {
  const s = snapshot.data;
  if (!s) {
    return (
      <Surface className="p-4 sm:p-5">
        <ChartMessage>{snapshot.loading ? "Reading economics…" : `Economics unavailable${snapshot.error ? ` — ${snapshot.error}` : ""}`}</ChartMessage>
      </Surface>
    );
  }
  const op = s.figures.operating_cost;
  const f = s.figures;
  return (
    <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-economics-overview>
      {/* A — Operating cost this cycle + the split KPIs. */}
      <Block id="econ-operating" label="Operating cost · this cycle" hint={<EconomicsStatusChip status={op.status} title={op.basis} />}
        action={<span className="truncate text-[11px] text-[var(--text-faint)]">{checkedText(s.checkedAt)}</span>}>
        <Surface className="p-4 sm:p-5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            {op.drill ? (
              <button type="button" onClick={() => onOpenDrill(op)} aria-haspopup="dialog" data-econ-tile={op.key} data-econ-drill={op.drill.href}
                className="text-3xl font-semibold tabular-nums text-[var(--text-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
                {figureValueText(op)}
              </button>
            ) : <span className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]" data-econ-tile={op.key}>{figureValueText(op)}</span>}
            <span className="min-w-0 text-[11px] text-[var(--text-muted)]">{`${windowText(op)} · ${figureSubText(op)}`}</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <FigureTile figure={f.ai_cost} onOpen={onOpenDrill} />
            <FigureTile figure={f.provider_cost} onOpen={onOpenDrill} />
            <FigureTile figure={f.infra_cost} onOpen={onOpenDrill} />
            <FigureTile figure={f.cost_per_active_customer} onOpen={onOpenDrill} />
          </div>
          {onOpenAiCosts && (
            <p className="mt-3 text-[11px] text-[var(--text-muted)]">
              <button type="button" className="underline-offset-2 hover:underline" onClick={onOpenAiCosts}>AI &amp; Costs detail</button>
            </p>
          )}
        </Surface>
      </Block>

      {/* B — what there is no source for, beside who the cost is spread over. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-econ-revenue-row>
        <FigureTile figure={f.revenue} />
        <FigureTile figure={f.margin} />
        <FigureTile figure={f.active_customers} onOpen={onOpenDrill} />
        {/* PR C — AI invoked for operators (Comms authoring), split out of overhead. */}
        <FigureTile figure={f.platform_ai_cost} onOpen={onOpenDrill} />
      </div>

      {/* C — AI cost trend (8) · split (4). */}
      <div className="grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8">
        <TrendCard s={s} onOpenDrill={onOpenDrill} />
        <SplitCard s={s} onOpenDrill={onOpenDrill} />
      </div>

      <p className="text-[10px] leading-relaxed text-[var(--text-faint)]" data-econ-note>{s.estimateNote}</p>
    </div>
  );
}

// ── The drill drawer ────────────────────────────────────────────────────────────

/** A drill's body: the figure in its own words, then the rows it is the sum of. */
export function EconomicsDrillBody({ data }: { data: EconomicsDrillResponse }) {
  const f = data.figure;
  const isCustomers = f.key === "active_customers";
  return (
    <div className="flex min-w-0 flex-col gap-3" data-econ-drill-body={f.key}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]" data-econ-drill-value>{figureValueText(f)}</span>
        <EconomicsStatusChip status={f.status} />
        <span className="text-[11px] text-[var(--text-muted)]">{windowText(f)}</span>
      </div>
      <p className="break-words text-[11px] text-[var(--text-muted)]">{f.basis}</p>
      {f.coverage.missing.length > 0 && (
        <ul aria-label="Not included" className="flex flex-col gap-0.5 text-[11px] text-[var(--text-muted)]" data-econ-missing>
          {f.coverage.missing.map((m) => <li key={m} className="break-words">{`Not included: ${m}`}</li>)}
        </ul>
      )}
      <p className="text-[11px] tabular-nums text-[var(--text-secondary)]" data-econ-drill-total>{drillTotalText(f, data.total, data.rows.length)}</p>
      {data.rows.length === 0 ? (
        <ChartMessage>{f.reason ?? "No records in this window."}</ChartMessage>
      ) : isCustomers ? (
        <ul aria-label="Engaged customers" className="flex flex-wrap gap-1.5" data-econ-rows>
          {data.rows.map((r) => <li key={r.id} className="rounded-full border border-[var(--border-hairline)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">{r.label}</li>)}
        </ul>
      ) : (
        <ul aria-label={`${f.label} records`} className="flex flex-col divide-y divide-[var(--border-hairline)]" data-econ-rows>
          {data.rows.map((r) => (
            <li key={r.id} className="flex min-h-11 min-w-0 flex-col gap-0.5 py-2" data-econ-row-status={r.status}>
              <span className="flex min-w-0 items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-[var(--text-secondary)]">{r.label}</span>
                <span className={`shrink-0 tabular-nums ${r.value === null ? "text-[var(--text-faint)]" : "text-[var(--text-primary)]"}`}>{rowValueText(r.value, f.unit)}</span>
              </span>
              <span className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 break-words text-[10px] text-[var(--text-muted)]">{r.detail}</span>
                <EconomicsStatusChip status={r.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">{`${checkedText(data.checkedAt)} · estimates, never a bill`}</p>
    </div>
  );
}

/** Fetching wrapper (keyed, so a stale drill never lands over a newer one). */
export function EconomicsDrill({ state }: { state: EconomicsDrillUrlState }) {
  const path = economicsDrillApiPath(state);
  const [res, setRes] = useState<{ key: string | null; data: EconomicsDrillResponse | null; error: string | null }>({ key: null, data: null, error: null });
  useEffect(() => {
    let alive = true;
    fetch(path, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
        return (await r.json()) as EconomicsDrillResponse;
      })
      .then((data) => { if (alive) setRes({ key: path, data, error: null }); })
      .catch((e: unknown) => { if (alive) setRes({ key: path, data: null, error: e instanceof Error ? e.message : "Failed to load" }); });
    return () => { alive = false; };
  }, [path]);
  const fresh = res.key === path;
  if (fresh && res.error) return <ChartMessage>{`Records unavailable — ${res.error}`}</ChartMessage>;
  if (!fresh || !res.data) return <ChartMessage>Reading records…</ChartMessage>;
  return <EconomicsDrillBody data={res.data} />;
}

/**
 * THE drill state every Economics lead shares: the open figure lives in the URL
 * (?econ / ?econuntil, REPLACE), read after mount (SSR-safe) and on Back/Forward.
 */
export function useEconomicsDrill(): { drill: EconomicsDrillUrlState | null; open: (f: EconomicsFigure) => void; close: () => void } {
  const spaceUrl = useSpaceUrl();
  const [drill, setDrill] = useState<EconomicsDrillUrlState | null>(null);
  useEffect(() => {
    const sync = () => setDrill(readEconomicsDrillUrl(spaceUrl.getSearch(), Date.now()));
    sync();
    return spaceUrl.subscribe(sync);
  }, [spaceUrl]);
  /** THE one setter: state + the URL mirror (REPLACE — a refinement of this entry, never a history step). */
  const apply = useCallback((next: EconomicsDrillUrlState | null) => {
    setDrill(next);
    spaceUrl.commit(economicsDrillUrlUpdate(next), { history: "replace" });
  }, [spaceUrl]);
  return { drill, open: useCallback((f: EconomicsFigure) => apply(drillStateOf(f)), [apply]), close: useCallback(() => apply(null), [apply]) };
}

/** The records drawer for the open drill (shared by every Economics lead). */
export function EconomicsDrillDrawer({ drill, title, onClose }: { drill: EconomicsDrillUrlState | null; title: string; onClose: () => void }) {
  return (
    <DetailDrawer open={drill !== null} onClose={onClose} eyebrow="Economics · records" title={title} size="xl">
      {drill ? <EconomicsDrill state={drill} /> : null}
    </DetailDrawer>
  );
}

export function EconomicsOverviewLead({ onOpenWorkspace }: PlatformViewLeadProps) {
  const snapshot = useSharedWidgetFetch<EconomicsSnapshot>(ECONOMICS_URL);
  const { drill, open, close } = useEconomicsDrill();
  const figures = snapshot.data?.figures as Readonly<Record<string, EconomicsFigure>> | undefined;
  const title = drill && snapshot.data
    ? (drill.window === "cycle" ? figures?.[drill.figure]?.label
      : (drill.figure === "platform_ai_cost" ? snapshot.data.trend.platformAi : snapshot.data.trend.windows)[drill.window as TrendWindow]?.label) ?? "Records"
    : "Records";

  return (
    <>
      <EconomicsOverviewSurface snapshot={snapshot} onOpenDrill={open} onOpenAiCosts={() => onOpenWorkspace("platform-economics:ai")} />
      <EconomicsDrillDrawer drill={drill} title={title} onClose={close} />
    </>
  );
}
