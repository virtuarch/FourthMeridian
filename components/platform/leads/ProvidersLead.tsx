"use client";

/**
 * components/platform/leads/ProvidersLead.tsx  (Platform Ops visual spec §5 — Providers)
 *
 * THE PROVIDERS DEFAULT SCREEN — integration intelligence, in the accepted
 * Operations grammar (Personal Space language: one label, one figure, one chart
 * and at most one caption per card; detail in a drawer). It REPLACES the R2
 * master–detail list and the old stacked Provider Health card ("unacceptable").
 *
 *   ≥ lg (12-col)
 *     A  Integration health hero (12)   verdict · checked time · 4 KPI tiles
 *     B  Sync activity (7)              refresh executions per UTC day (DayBars)
 *        Health distribution (5)        BreakdownWidget donut (provider classes)
 *     C  Providers (12)                 2-column tiles, worst first, ≤ 4 + See all
 *     D  Provider detail nav            fleet diagnostics drawers (≤ 5)
 *   < lg
 *     compact hero → 2×2 KPIs → ONE chart card (sync activity) → 3 tiles (1 col)
 *     → See all → detail nav; the donut is desktop-only.
 *
 * DETAIL: a tile opens the provider drawer — usage (today / 7 d / 30 d), cap
 * (unknown), errors, cost with provenance, related connection health, and the
 * existing technical widgets HOSTED unchanged through `renderHosted` (provider
 * operations / health, resource freshness, usage ledger, email delivery for
 * Resend; connection diagnostics — with its history-recovery panel — and
 * provider cleanup for Plaid / wallet networks) as lazily-mounted disclosures.
 *
 * ONE MOUNT (the R2 review guarantee, kept): there is exactly ONE DetailDrawer
 * and its body renders only while it is open, so a hosted widget is never
 * mounted twice (no hidden desktop pane, no duplicate fetches / dialogs / ids).
 *
 * Presentation only. Words and figures come from providers-model.ts (pure).
 */

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Block, Surface } from "@/components/atlas/Surface";
import { BreakdownWidget } from "@/components/space/widgets/BreakdownWidget";
import { DetailDrawer, KpiTile, ProvenanceChip } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import { ToneBadge } from "../platform-surface";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { ApiUsageResponse } from "@/app/api/platform/platform-ops/api-usage/route";
import type { EmailHealthResponse } from "@/app/api/platform/platform-ops/email-health/route";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";
import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";
import type { ProviderOperationSummary, RefreshDailySeries } from "@/lib/platform/refresh/types";
import type { PlatformViewLeadProps, RenderHosted } from "./lead-contract";
import { LazyDisclosure } from "./lead-kit";
import { Caption, ChartMessage, Doorway } from "./visual-kit";
import { HealthHero, type HeroModel } from "../ops-visual/HealthHero";
import { DayBars, DayBarsLegend, DAY_BAR_COLORS } from "../ops-visual/DayBars";
import { StatusWord } from "../ops-visual/UnifiedJobs";
import { refreshDays, utcDay, type Fetched } from "../ops-visual/ops-visual-model";
import { currentCycle, moneyText, usd } from "./ai-costs-model";
import {
  CAP_UNKNOWN,
  CONNECTION_PROVIDERS,
  DIAGNOSTIC_TITLE,
  FLEET_DIAGNOSTICS,
  OPS_WINDOW_DAYS,
  failuresText,
  healthDistribution,
  integrationCaption,
  integrationVerdict,
  providerEntities,
  providerKpis,
  usageText,
  type ProviderEntity,
  type ProviderInputs,
} from "./providers-model";

/** Default-screen caps (spec §1: ≤ 5 per section; tiles in symmetric 2-column pairs). */
export const TILE_ROWS = 4;
export const TILE_ROWS_COMPACT = 3;
export const SYNC_DAYS = 14;

export type ProvidersDrawer = { kind: "provider"; key: string } | { kind: "fleet"; id: string } | { kind: "all" };

const n = (v: number) => v.toLocaleString("en-US");
const hhmm = (iso: string) => `Checked ${new Date(iso).toISOString().slice(11, 16)} UTC`;
const shortDay = (d: string) => new Date(`${d}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const BTN =
  "inline-flex min-h-11 items-center rounded-[var(--radius-sm)] border border-[var(--border-hairline-strong)] px-3 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]";

// ── Tiles ────────────────────────────────────────────────────────────────────

function SpendChip({ e }: { e: ProviderEntity }) {
  return e.spend.kind === "ESTIMATED" ? (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="text-xs font-medium tabular-nums text-[var(--text-primary)]">{usd(e.spend.usd)}</span>
      <ProvenanceChip kind="ESTIMATED" title={`${e.spend.basis} · this cycle`} />
    </span>
  ) : (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="text-xs text-[var(--text-muted)]">Cost</span>
      <ProvenanceChip kind="UNKNOWN" title={e.spend.reason} />
    </span>
  );
}

export function ProviderTile({ e, onSelect, className = "" }: { e: ProviderEntity; onSelect: () => void; className?: string }) {
  return (
    <Surface as="li" className={`min-w-0 ${className}`}>
      <button type="button" onClick={onSelect} aria-haspopup="dialog" data-provider-tile={e.key}
        className="group flex w-full min-w-0 flex-col gap-2 rounded-[var(--radius-lg)] p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
        <span className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">{e.label}</span>
          <StatusWord word={e.status.word} tone={e.status.tone} className="shrink-0" />
          <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-faint)] group-hover:text-[var(--text-secondary)]" />
        </span>
        <span className="block truncate text-[11px] tabular-nums text-[var(--text-secondary)]">{usageText(e)}</span>
        <span className="flex min-w-0 items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[11px] tabular-nums text-[var(--text-muted)]">{failuresText(e)}</span>
          <SpendChip e={e} />
        </span>
      </button>
    </Surface>
  );
}

// ── Provider detail (drawer) ─────────────────────────────────────────────────

export function ProviderDetail({ e, hasHosted, renderHosted, onOpenWorkspace, onOpenFleet, nowMs }: {
  e: ProviderEntity;
  hasHosted: (key: string) => boolean;
  renderHosted: RenderHosted;
  onOpenWorkspace: (id: string) => void;
  onOpenFleet: (id: string) => void;
  nowMs: number;
}) {
  const h = e.health;
  const resend = e.key === "RESEND" ? e.email : null;
  const diagnostics = e.diagnostics.filter(hasHosted);
  const cycle = currentCycle(nowMs);
  return (
    <div className="flex min-w-0 flex-col gap-5" data-provider-detail={e.key}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ToneBadge word={e.status.word} tone={e.status.tone} />
        <span className="text-[11px] text-[var(--text-muted)]">{e.statusBasis}</span>
        {e.asOf && <span className="ml-auto"><ProvenanceChip kind="MEASURED" asOf={e.asOf} /></span>}
      </div>

      <section aria-label="Usage" className="grid grid-cols-2 gap-2 sm:gap-3">
        {resend ? (
          <KpiTile label={`Deliveries · ${resend.windowDays} d`} value={n(resend.counts.total)} provenance={<ProvenanceChip kind="MEASURED" />}
            note={`${n(resend.counts.sent)} sent · ${n(resend.counts.captured)} captured · ${n(resend.counts.skipped)} skipped`} />
        ) : (
          <KpiTile label="Calls today" value={e.usage ? n(e.usage.today) : null} unavailableReason="not metered"
            note={e.usage ? `7 d ${n(e.usage.d7)} · 30 d ${n(e.usage.d30)}` : undefined}
            provenance={e.usage ? <ProvenanceChip kind="MEASURED" /> : <ProvenanceChip kind="UNKNOWN" />} />
        )}
        <KpiTile label="Cap" value={null} unavailableReason={CAP_UNKNOWN} note="no cap is exposed to Platform Operations" provenance={<ProvenanceChip kind="UNKNOWN" />} />
        <KpiTile label={`Failures · ${OPS_WINDOW_DAYS} d`} value={e.failures7d.count === null ? null : n(e.failures7d.count)} unavailableReason="not recorded"
          note={e.failures7d.calls !== null ? `of ${n(e.failures7d.calls)} attempts · ${n(e.failures7d.rateLimited ?? 0)} rate-limited` : undefined}
          provenance={e.failures7d.count === null ? <ProvenanceChip kind="UNKNOWN" /> : <ProvenanceChip kind="MEASURED" />} />
        {e.spend.kind === "ESTIMATED" ? (
          <KpiTile label="Spend · this cycle" value={usd(e.spend.usd)} note={`${e.spend.basis}${e.spend.partial ? " · partial" : ""} · ${shortDay(cycle.start)} – ${shortDay(cycle.end)}`} provenance={<ProvenanceChip kind="ESTIMATED" />} />
        ) : (
          <KpiTile label="Spend · this cycle" value={null} unavailableReason={e.spend.reason} provenance={<ProvenanceChip kind="UNKNOWN" />} />
        )}
      </section>

      {(h || e.failedRuns !== null) && (
        <section aria-label="Related health" className="flex flex-col gap-2">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Related health</h3>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
            {h && <div className="flex flex-col gap-0.5"><dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Freshness</dt><dd className="text-[var(--text-primary)]">{h.freshness.detail}</dd></div>}
            {h && <div className="flex flex-col gap-0.5"><dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Last success</dt><dd className="tabular-nums text-[var(--text-primary)]">{h.lastSuccessAt ? `${h.lastSuccessAt.slice(0, 16).replace("T", " ")} UTC` : "none in the window"}</dd></div>}
            {e.failedRuns !== null && <div className="flex flex-col gap-0.5"><dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Failed runs</dt><dd className="tabular-nums text-[var(--text-primary)]">{n(e.failedRuns)} in provider-health&apos;s run window</dd></div>}
            {h?.notes.slice(0, 2).map((note) => (
              <div key={note} className="flex flex-col gap-0.5 sm:col-span-2"><dt className="sr-only">Note</dt><dd className="text-[var(--text-secondary)]">{note}</dd></div>
            ))}
          </dl>
        </section>
      )}

      {resend && resend.recentErrors.length > 0 && (
        <ul aria-label="Recent delivery errors" className="flex flex-col divide-y divide-[var(--border-hairline)] text-xs">
          {resend.recentErrors.slice(0, 3).map((x) => (
            <li key={x.id} className="flex flex-col gap-0.5 py-1.5"><span className="truncate text-[var(--text-primary)]">{x.error}</span><span className="text-[11px] text-[var(--text-muted)]">{x.at.slice(0, 16).replace("T", " ")} UTC</span></li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {CONNECTION_PROVIDERS.has(e.key) && hasHosted("ops_connection_diagnostics") && (
          <button type="button" className={BTN} onClick={() => onOpenFleet("diag:connections")}>All connections</button>
        )}
        {(e.key === "OPENAI" || e.key === "PLAID") && <button type="button" className={BTN} onClick={() => onOpenWorkspace("platform-ai")}>Open AI &amp; Costs</button>}
      </div>

      {diagnostics.length > 0 && (
        <section aria-label="Technical diagnostics" className="flex flex-col">
          <h3 className="pb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Technical diagnostics</h3>
          {diagnostics.map((key) => (
            <LazyDisclosure key={key} title={DIAGNOSTIC_TITLE[key] ?? key}>{renderHosted(key, onOpenWorkspace)}</LazyDisclosure>
          ))}
        </section>
      )}
    </div>
  );
}

function FleetDetail({ id, renderHosted, onOpenWorkspace }: { id: string; renderHosted: RenderHosted; onOpenWorkspace: (id: string) => void }) {
  const d = FLEET_DIAGNOSTICS.find((x) => x.id === id);
  if (!d) return null;
  return <div className="flex min-w-0 flex-col gap-6">{d.keys.map((k) => <div key={k} className="min-w-0">{renderHosted(k, onOpenWorkspace)}</div>)}</div>;
}

function AllProviders({ entities, onSelect }: { entities: readonly ProviderEntity[]; onSelect: (key: string) => void }) {
  return (
    <ul aria-label="All providers" className="flex flex-col">
      {entities.map((e) => (
        <li key={e.key} className="border-t border-[var(--border-hairline)] first:border-t-0">
          <button type="button" onClick={() => onSelect(e.key)} className="group flex min-h-11 w-full items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{e.label}</span>
              <span className="block truncate text-[11px] tabular-nums text-[var(--text-muted)]">{usageText(e)} · {failuresText(e)} · {e.spend.kind === "ESTIMATED" ? `${moneyText(e.spend)} est.` : "cost unknown"}</span>
            </span>
            <StatusWord word={e.status.word} tone={e.status.tone} className="shrink-0" />
            <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-faint)] group-hover:text-[var(--text-secondary)]" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The drawer's title, or "" when the drawer names nothing that exists (then it stays closed). */
export function drawerTitle(d: ProvidersDrawer | null, entities: readonly ProviderEntity[]): string {
  if (!d) return "";
  if (d.kind === "all") return "All providers";
  if (d.kind === "provider") return entities.find((e) => e.key === d.key)?.label ?? "";
  return FLEET_DIAGNOSTICS.find((x) => x.id === d.id)?.name ?? "";
}

/** The ONE drawer's body for a selection (exported so its hosting is provable without a DOM portal). */
export function ProvidersDrawerBody({ drawer, entities, nowMs, hasHosted, renderHosted, onOpenDrawer, onOpenWorkspace }: {
  drawer: ProvidersDrawer;
  entities: readonly ProviderEntity[];
  nowMs: number;
  hasHosted: (key: string) => boolean;
  renderHosted: RenderHosted;
  onOpenDrawer: (d: ProvidersDrawer) => void;
  onOpenWorkspace: (id: string) => void;
}) {
  if (drawer.kind === "all") return <AllProviders entities={entities} onSelect={(key) => onOpenDrawer({ kind: "provider", key })} />;
  if (drawer.kind === "fleet") return <FleetDetail id={drawer.id} renderHosted={renderHosted} onOpenWorkspace={onOpenWorkspace} />;
  const e = entities.find((x) => x.key === drawer.key);
  return e ? <ProviderDetail e={e} hasHosted={hasHosted} renderHosted={renderHosted} onOpenWorkspace={onOpenWorkspace} onOpenFleet={(id) => onOpenDrawer({ kind: "fleet", id })} nowMs={nowMs} /> : null;
}

// ── The surface (prop-driven, fetch-free — every state renders in a test) ────

export interface ProvidersLeadSurfaceProps {
  inputs: ProviderInputs;
  daily: Fetched<RefreshDailySeries>;
  drawer: ProvidersDrawer | null;
  onOpenDrawer: (d: ProvidersDrawer) => void;
  onCloseDrawer: () => void;
  hasHosted: (key: string) => boolean;
  renderHosted: RenderHosted;
  onOpenWorkspace: (id: string) => void;
}

export function ProvidersLeadSurface(p: ProvidersLeadSurfaceProps) {
  const { inputs } = p;
  const entities = providerEntities(inputs);
  const kpis = providerKpis(entities, inputs);
  const hero: HeroModel = {
    title: "Integration health",
    verdict: integrationVerdict(entities, inputs.health),
    checked: inputs.health.data ? hhmm(inputs.health.data.checkedAt) : null,
    caption: inputs.health.data ? integrationCaption(entities) : inputs.health.loading ? "Reading provider health…" : "Provider health unavailable",
    kpis,
    kpiLabels: { first: "Provider health figures", second: "Provider cost figures", all: "Integration health figures" },
  };
  const distribution = inputs.health.data ? healthDistribution(entities) : [];
  const sync = p.daily.data ? refreshDays(p.daily.data, inputs.nowMs, SYNC_DAYS) : null;
  const syncTotal = sync ? sync.filter((d) => d.observed).reduce((a, d) => a + d.succeeded + d.failed + d.other, 0) : 0;
  const syncFailed = sync ? sync.filter((d) => d.observed).reduce((a, d) => a + d.failed, 0) : 0;
  const tiles = entities.slice(0, TILE_ROWS);
  const fleet = FLEET_DIAGNOSTICS.filter((d) => d.keys.some(p.hasHosted));
  const loading = inputs.health.loading || inputs.apiUsage.loading;

  const openProvider = (key: string) => p.onOpenDrawer({ kind: "provider", key });
  const title = drawerTitle(p.drawer, entities);
  const body: ReactNode = p.drawer && title
    ? <ProvidersDrawerBody drawer={p.drawer} entities={entities} nowMs={inputs.nowMs} hasHosted={p.hasHosted} renderHosted={p.renderHosted} onOpenDrawer={p.onOpenDrawer} onOpenWorkspace={p.onOpenWorkspace} />
    : null;

  return (
    <>
      <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-providers-dashboard>
        {/* A — Integration health hero. */}
        <HealthHero model={hero} />

        {/* B — Sync activity (7) · Health distribution (5). */}
        <div className="grid items-stretch gap-6 lg:grid-cols-12 lg:gap-8">
          <Block id="providers-sync" label="Sync activity" className="min-w-0 lg:col-span-7"
            action={<DayBarsLegend items={[{ label: "Succeeded", color: DAY_BAR_COLORS.succeeded }, { label: "Failed", color: DAY_BAR_COLORS.failed }]} />}>
            <Surface className="flex-1 p-4 sm:p-5">
              {sync ? (
                <>
                  <DayBars days={sync} ariaLabel="Bank and wallet syncs per UTC day" noun="sync" />
                  <Caption>{`${n(syncTotal)} syncs · ${n(syncFailed)} failed · ${SYNC_DAYS} UTC days${p.daily.data!.floor ? " · a floor (capped read)" : ""}`}</Caption>
                </>
              ) : (
                <ChartMessage>{p.daily.loading ? "Reading sync activity…" : `Sync activity unavailable${p.daily.error ? ` — ${p.daily.error}` : ""}`}</ChartMessage>
              )}
            </Surface>
          </Block>
          <Block id="providers-distribution" label="Health distribution" className="min-w-0 max-lg:hidden lg:col-span-5"
            action={<span className="text-[11px] text-[var(--text-faint)]">Providers by verdict</span>}>
            <Surface className="flex-1 p-4 sm:p-5">
              <BreakdownWidget
                items={distribution}
                viewMode="donut"
                itemNoun="provider"
                formatValue={(v) => n(v)}
                centerTotal={{ value: entities.length, label: entities.length === 1 ? "provider" : "providers" }}
                centerTone="neutral"
                emptyHeadline={inputs.health.loading ? "Reading provider health…" : "Provider health unavailable"}
              />
            </Surface>
          </Block>
        </div>

        {/* C — Provider tiles (worst first). */}
        <Block id="providers-tiles" label="Providers"
          action={entities.length > TILE_ROWS ? <Doorway label={`See all ${entities.length}`} onSelect={() => p.onOpenDrawer({ kind: "all" })} dialog /> : undefined}>
          {tiles.length > 0 ? (
            <ul aria-label="Providers" className="grid min-w-0 gap-4 sm:grid-cols-2">
              {tiles.map((e, i) => (
                <ProviderTile key={e.key} e={e} onSelect={() => openProvider(e.key)} className={i >= TILE_ROWS_COMPACT ? "max-lg:hidden" : ""} />
              ))}
            </ul>
          ) : (
            <Surface className="px-4 py-3 sm:px-5"><p className="text-xs text-[var(--text-muted)]">{loading ? "Reading providers…" : "No provider reported by any reader"}</p></Surface>
          )}
        </Block>

        {/* D — Fleet diagnostics, each a drawer hosting the existing widgets. */}
        {fleet.length > 0 && (
          <nav aria-label="Provider detail" className="flex flex-wrap items-center gap-x-4">
            {fleet.map((d) => <Doorway key={d.id} label={d.name} onSelect={() => p.onOpenDrawer({ kind: "fleet", id: d.id })} dialog />)}
          </nav>
        )}
      </div>
      {/* The ONE drawer: its body exists only while open (one mount, ever). */}
      <DetailDrawer open={p.drawer !== null && body !== null} onClose={p.onCloseDrawer} eyebrow="Providers" title={title} size="lg">
        {body}
      </DetailDrawer>
    </>
  );
}

export function ProvidersLead({ renderHosted, hasHosted, onOpenWorkspace }: PlatformViewLeadProps) {
  // One clock read per mount (the 7-day window, the cycle, the day axis), never during render.
  const [nowMs] = useState(() => Date.now());
  const opsFrom = utcDay(nowMs - (OPS_WINDOW_DAYS - 1) * 86_400_000);
  const health = useSharedWidgetFetch<ProviderHealthResponse>("/api/platform/platform-ops/provider-health");
  const apiUsage = useSharedWidgetFetch<ApiUsageResponse>("/api/platform/platform-ops/api-usage");
  const email = useSharedWidgetFetch<EmailHealthResponse>("/api/platform/platform-ops/email-health");
  const plaid = useSharedWidgetFetch<PlaidUsage>("/api/platform/platform-ops/plaid-usage");
  const operations = useSharedWidgetFetch<ProviderOperationSummary>(`/api/platform/platform-ops/refresh/provider-operations?from=${opsFrom}`);
  const trend = useSharedWidgetFetch<AiUsageTrend>("/api/platform/platform-ops/ai-usage-trend");
  const daily = useSharedWidgetFetch<RefreshDailySeries>("/api/platform/platform-ops/refresh/daily");
  const [drawer, setDrawer] = useState<ProvidersDrawer | null>(null);

  return (
    <ProvidersLeadSurface
      inputs={{ health, apiUsage, email, plaid, operations, trend, nowMs }}
      daily={daily}
      drawer={drawer}
      onOpenDrawer={setDrawer}
      onCloseDrawer={() => setDrawer(null)}
      hasHosted={hasHosted}
      renderHosted={renderHosted}
      // A doorway inside the drawer closes it, then moves the rail.
      onOpenWorkspace={(id) => { setDrawer(null); onOpenWorkspace(id); }}
    />
  );
}
