"use client";

/**
 * components/platform/leads/EconomicsProvidersLead.tsx  (Platform Economics — Providers, cost view)
 *
 * "What does each provider cost us this cycle?" — COST only. One read (GET
 * /api/platform/platform-ops/economics/providers, PLATFORM_OPS READ): one row per
 * provider with its cost figure (status chip; opens its records when it has
 * any), calls this cycle (measured) and its quota ("cap unknown" — no provider
 * exposes one this app stores). Provider HEALTH is not restated here: every row
 * links to Platform Operations › Providers, which owns it.
 *
 * Presentation only — words from economics-model.ts, figures from providers-core.ts.
 */

import { Block, Surface } from "@/components/atlas/Surface";
import { useSharedWidgetFetch } from "../workspace-session";
import type { PlatformViewLeadProps } from "./lead-contract";
import type { Fetched } from "../ops-visual/ops-visual-model";
import type { EconomicsFigure } from "@/lib/platform/economics/snapshot-core";
import type { EconomicsProvidersView } from "@/lib/platform/economics/providers-core";
import { ChartMessage, Doorway } from "./visual-kit";
import { callsText, figureSubText, figureValueText } from "./economics-model";
import { EconomicsDrillDrawer, EconomicsStatusChip, useEconomicsDrill } from "./EconomicsOverviewLead";

export const ECONOMICS_PROVIDERS_URL = "/api/platform/platform-ops/economics/providers";

export interface EconomicsProvidersSurfaceProps {
  view: Fetched<EconomicsProvidersView>;
  onOpenDrill: (f: EconomicsFigure) => void;
  /** Open the workspace that owns provider HEALTH. */
  onOpenHealth: (workspaceId: string) => void;
}

export function EconomicsProvidersSurface({ view, onOpenDrill, onOpenHealth }: EconomicsProvidersSurfaceProps) {
  const v = view.data;
  if (!v) {
    return <Surface className="p-4 sm:p-5"><ChartMessage>{view.loading ? "Reading provider cost…" : `Provider cost unavailable${view.error ? ` — ${view.error}` : ""}`}</ChartMessage></Surface>;
  }
  return (
    <div className="min-w-0 space-y-8 sm:space-y-10 max-lg:space-y-6!" data-economics-providers>
      <Block id="econ-providers" label="Provider cost · this cycle"
        hint={<span className="truncate text-[11px] text-[var(--text-faint)]">{`${v.metered} priced · ${v.unmetered} not priced`}</span>}>
        <Surface className="px-4 py-2 sm:px-5">
          <ul aria-label="Providers" className="flex flex-col divide-y divide-[var(--border-hairline)]">
            {v.providers.map((p) => (
              <li key={p.id} className="flex min-w-0 flex-col gap-1.5 py-3" data-econ-provider={p.id}>
                <span className="flex min-w-0 items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium text-[var(--text-primary)]">{p.label}</span>
                  <EconomicsStatusChip status={p.cost.status} title={p.cost.basis} />
                </span>
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                  {p.cost.drill ? (
                    <button type="button" onClick={() => onOpenDrill(p.cost)} aria-haspopup="dialog" data-econ-tile={p.cost.key} data-econ-drill={p.cost.drill.href}
                      className="text-lg font-semibold tabular-nums text-[var(--text-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
                      {figureValueText(p.cost)}
                    </button>
                  ) : <span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]" data-econ-value={p.id}>{figureValueText(p.cost)}</span>}
                  <span className="min-w-0 break-words text-[11px] text-[var(--text-muted)]">{figureSubText(p.cost)}</span>
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
                  <span className="tabular-nums" data-econ-calls={p.calls.status}>{callsText(p.calls)}</span>
                  <span data-econ-quota title={p.quota.reason}>{`quota: ${p.quota.text}`}</span>
                  <Doorway label="Health in Providers" onSelect={() => onOpenHealth(p.health.workspaceId)} />
                </span>
              </li>
            ))}
          </ul>
        </Surface>
      </Block>
      <p className="text-[10px] leading-relaxed text-[var(--text-faint)]" data-econ-note>{v.note}</p>
    </div>
  );
}

export function EconomicsProvidersLead({ onOpenWorkspace }: PlatformViewLeadProps) {
  const view = useSharedWidgetFetch<EconomicsProvidersView>(ECONOMICS_PROVIDERS_URL);
  const { drill, open, close } = useEconomicsDrill();
  const title = (drill && view.data?.providers.find((p) => p.cost.key === drill.figure)?.cost.label) ?? "Records";
  return (
    <>
      <EconomicsProvidersSurface view={view} onOpenDrill={open} onOpenHealth={onOpenWorkspace} />
      <EconomicsDrillDrawer drill={drill} title={title} onClose={close} />
    </>
  );
}
