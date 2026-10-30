"use client";

/**
 * components/platform/leads/ProvidersLead.tsx  (Platform Operations 2.0 — R2, plan §4.3)
 *
 * THE PROVIDERS WORKSPACE — master–detail.
 *
 *   Master   one compact EntityRow per provider a reader reports (providers-
 *            model.ts), grouped (Banking & market data · Wallet networks ·
 *            Platform services · Other) so no section exceeds five rows; then
 *            "Fleet diagnostics" (Connections · Resource freshness · Usage ledger)
 *   Detail   the selected provider: usage (today / 7 d / 30 d — the windows the
 *            usage reader persists; no invented daily series), allowance
 *            (unknown unless a reader exposes one), spend with provenance,
 *            errors / rate limiting, related health + connection doorway, and
 *            the technical diagnostics as lazily-mounted disclosures hosting the
 *            existing widgets unchanged.
 *
 * Desktop (lg+): list left, detail right. Below lg: the list, and a tap opens
 * the detail as a full-height sheet (DetailDrawer). Collapse is by CSS classes
 * only (two renders of the list, one per breakpoint) — no viewport read.
 *
 * Connection diagnostics (with its history-recovery panel) and provider cleanup
 * render through `renderHosted`, i.e. the registry widget with its DB row and
 * the operator's access — so their own gating is untouched.
 */

import { useState } from "react";
import { DetailDrawer, EntityList, EntityRow, KpiTile, ProvenanceChip } from "../ui";
import { useSharedWidgetFetch } from "../workspace-session";
import { ToneBadge } from "../platform-surface";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { ApiUsageResponse } from "@/app/api/platform/platform-ops/api-usage/route";
import type { EmailHealthResponse } from "@/app/api/platform/platform-ops/email-health/route";
import type { PlaidUsage } from "@/lib/platform/plaid/usage";
import type { ProviderOperationSummary } from "@/lib/platform/refresh/types";
import type { PlatformViewLeadProps, RenderHosted } from "./lead-contract";
import { LazyDisclosure, LeadSection } from "./lead-kit";
import {
  ALLOWANCE_UNKNOWN,
  CONNECTION_PROVIDERS,
  DIAGNOSTIC_TITLE,
  FLEET_DIAGNOSTICS,
  defaultSelection,
  groupEntities,
  providerEntities,
  spendText,
  usageText,
  usd,
  type ProviderEntity,
  type ProviderInputs,
} from "./providers-model";

const n = (v: number) => v.toLocaleString("en-US");
const DOORWAY =
  "inline-flex min-h-11 items-center rounded-[var(--radius-sm)] border border-[var(--border-hairline-strong)] px-3 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]";

// ── Master ───────────────────────────────────────────────────────────────────

function ProviderRow({ e, selected, onSelect }: { e: ProviderEntity; selected: boolean; onSelect: () => void }) {
  return (
    <EntityRow
      name={e.label}
      status={e.status}
      summary={`${usageText(e)} · ${e.errors.text}`}
      metrics={[
        { label: "Allowance", value: ALLOWANCE_UNKNOWN },
        { label: e.spend.kind === "ESTIMATED" ? "Spend · est." : "Spend", value: spendText(e.spend) },
      ]}
      selected={selected}
      onSelect={onSelect}
    />
  );
}

export function ProvidersMaster({ entities, selected, onSelect, hasHosted, loading }: {
  entities: readonly ProviderEntity[];
  selected: string | null;
  onSelect: (id: string) => void;
  hasHosted: (key: string) => boolean;
  loading: boolean;
}) {
  const diagnostics = FLEET_DIAGNOSTICS.filter((d) => d.keys.some(hasHosted));
  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-6">
      {groupEntities(entities).map((g) => (
        <LeadSection key={g.group} title={g.label}>
          <EntityList label={g.label}>
            {g.items.slice(0, 5).map((e) => <ProviderRow key={e.key} e={e} selected={selected === e.key} onSelect={() => onSelect(e.key)} />)}
          </EntityList>
        </LeadSection>
      ))}
      {loading && entities.length === 0 && <p role="status" className="text-xs text-[var(--text-muted)]">Reading providers…</p>}
      {diagnostics.length > 0 && (
        <LeadSection title="Fleet diagnostics">
          <EntityList label="Fleet diagnostics">
            {diagnostics.map((d) => <EntityRow key={d.id} name={d.name} summary={d.summary} selected={selected === d.id} onSelect={() => onSelect(d.id)} />)}
          </EntityList>
        </LeadSection>
      )}
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

export function ProviderDetail({ e, hasHosted, renderHosted, onSelect, onOpenWorkspace }: {
  e: ProviderEntity;
  hasHosted: (key: string) => boolean;
  renderHosted: RenderHosted;
  onSelect: (id: string) => void;
  onOpenWorkspace: (id: string) => void;
}) {
  const h = e.health;
  const resend = e.key === "RESEND" ? e.email : null;
  const diagnostics = e.diagnostics.filter(hasHosted);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ToneBadge word={e.status.word} tone={e.status.tone} />
        <span className="text-[11px] text-[var(--text-muted)]">{e.statusBasis}</span>
        {e.asOf && <span className="ml-auto"><ProvenanceChip kind="MEASURED" asOf={e.asOf} /></span>}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        {resend ? (
          <KpiTile label={`Deliveries · ${resend.windowDays} d`} value={n(resend.counts.total)} provenance={<ProvenanceChip kind="MEASURED" />}
            note={`${n(resend.counts.sent)} sent · ${n(resend.counts.captured)} captured · ${n(resend.counts.skipped)} skipped`} />
        ) : (
          <KpiTile label="Calls today" value={e.usage ? n(e.usage.today) : null} unavailableReason="not metered"
            note={e.usage ? `7 d ${n(e.usage.d7)} · 30 d ${n(e.usage.d30)}` : undefined}
            provenance={e.usage ? <ProvenanceChip kind="MEASURED" /> : <ProvenanceChip kind="UNKNOWN" />} />
        )}
        <KpiTile label="Allowance" value={null} unavailableReason={ALLOWANCE_UNKNOWN} note={e.allowance.reason} provenance={<ProvenanceChip kind="UNKNOWN" />} />
        {e.spend.kind === "ESTIMATED" ? (
          <KpiTile label={`Spend · ${e.spend.window}`} value={usd(e.spend.usd)} note={e.spend.basis} provenance={<ProvenanceChip kind="ESTIMATED" />} />
        ) : (
          <KpiTile label="Spend" value={null} unavailableReason={e.spend.reason} provenance={<ProvenanceChip kind="UNKNOWN" />} />
        )}
        <KpiTile label="Errors" value={e.errors.count === null ? null : n(e.errors.count)} unavailableReason="not recorded"
          note={e.errors.count === null ? undefined : `${e.errors.text}${e.errors.window ? ` · ${e.errors.window}` : ""}`}
          provenance={e.errors.count === null ? <ProvenanceChip kind="UNKNOWN" /> : <ProvenanceChip kind="MEASURED" />} />
      </div>

      {h && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
          <div className="flex flex-col gap-0.5"><dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Freshness</dt><dd className="text-[var(--text-primary)]">{h.freshness.detail}</dd></div>
          <div className="flex flex-col gap-0.5"><dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Last success</dt><dd className="tabular-nums text-[var(--text-primary)]">{h.lastSuccessAt ? `${h.lastSuccessAt.slice(0, 16).replace("T", " ")} UTC` : "none in the window"}</dd></div>
          {h.notes.slice(0, 2).map((note) => (
            <div key={note} className="flex flex-col gap-0.5 sm:col-span-2"><dt className="sr-only">Note</dt><dd className="text-[var(--text-secondary)]">{note}</dd></div>
          ))}
        </dl>
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
          <button type="button" className={DOORWAY} onClick={() => onSelect("diag:connections")}>Connection diagnostics</button>
        )}
        {e.key === "OPENAI" && <button type="button" className={DOORWAY} onClick={() => onOpenWorkspace("platform-ai")}>Open AI &amp; Costs</button>}
        {e.key === "PLAID" && <button type="button" className={DOORWAY} onClick={() => onOpenWorkspace("platform-costs")}>Plaid economics</button>}
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

function DiagnosticDetail({ id, renderHosted, onOpenWorkspace }: { id: string; renderHosted: RenderHosted; onOpenWorkspace: (id: string) => void }) {
  const d = FLEET_DIAGNOSTICS.find((x) => x.id === id);
  if (!d) return null;
  return <div className="flex min-w-0 flex-col gap-6">{d.keys.map((k) => <div key={k} className="min-w-0">{renderHosted(k, onOpenWorkspace)}</div>)}</div>;
}

function titleOf(id: string | null, entities: readonly ProviderEntity[]): string {
  if (!id) return "";
  return entities.find((e) => e.key === id)?.label ?? FLEET_DIAGNOSTICS.find((d) => d.id === id)?.name ?? "";
}

// ── The lead ─────────────────────────────────────────────────────────────────

export function ProvidersLeadSurface({ inputs, selected, sheetOpen, onSelect, onCloseSheet, hasHosted, renderHosted, onOpenWorkspace }: {
  inputs: ProviderInputs;
  /** null ⇒ the worst-first default. */
  selected: string | null;
  sheetOpen: boolean;
  onSelect: (id: string, from: "desktop" | "mobile") => void;
  onCloseSheet: () => void;
  hasHosted: (key: string) => boolean;
  renderHosted: RenderHosted;
  onOpenWorkspace: (id: string) => void;
}) {
  const entities = providerEntities(inputs);
  const loading = inputs.health.loading || inputs.apiUsage.loading;
  const current = selected ?? defaultSelection(entities);
  const entity = entities.find((e) => e.key === current) ?? null;
  const detail = (from: "desktop" | "mobile") => entity
    ? <ProviderDetail e={entity} hasHosted={hasHosted} renderHosted={renderHosted} onSelect={(id) => onSelect(id, from)} onOpenWorkspace={onOpenWorkspace} />
    : current ? <DiagnosticDetail id={current} renderHosted={renderHosted} onOpenWorkspace={onOpenWorkspace} /> : null;

  return (
    <>
      {/* Mobile / tablet: the list; a tap opens the full-height sheet. */}
      <div className="lg:hidden">
        <ProvidersMaster entities={entities} selected={null} onSelect={(id) => onSelect(id, "mobile")} hasHosted={hasHosted} loading={loading} />
      </div>
      {/* Desktop: master–detail. */}
      <div className="hidden min-w-0 gap-6 lg:grid lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-5">
          <ProvidersMaster entities={entities} selected={current} onSelect={(id) => onSelect(id, "desktop")} hasHosted={hasHosted} loading={loading} />
        </div>
        <section aria-label="Provider detail" className="min-w-0 lg:col-span-7">
          {current && (
            <LeadSection title={titleOf(current, entities)}>{detail("desktop")}</LeadSection>
          )}
        </section>
      </div>
      <DetailDrawer open={sheetOpen && current != null} onClose={onCloseSheet} eyebrow="Providers" title={titleOf(current, entities)} size="lg">
        {sheetOpen ? detail("mobile") : null}
      </DetailDrawer>
    </>
  );
}

export function ProvidersLead({ renderHosted, hasHosted, onOpenWorkspace }: PlatformViewLeadProps) {
  const health = useSharedWidgetFetch<ProviderHealthResponse>("/api/platform/platform-ops/provider-health");
  const apiUsage = useSharedWidgetFetch<ApiUsageResponse>("/api/platform/platform-ops/api-usage");
  const email = useSharedWidgetFetch<EmailHealthResponse>("/api/platform/platform-ops/email-health");
  const plaid = useSharedWidgetFetch<PlaidUsage>("/api/platform/platform-ops/plaid-usage");
  const operations = useSharedWidgetFetch<ProviderOperationSummary>("/api/platform/platform-ops/refresh/provider-operations");
  const [selected, setSelected] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <ProvidersLeadSurface
      inputs={{ health, apiUsage, email, plaid, operations }}
      selected={selected}
      sheetOpen={sheetOpen}
      onSelect={(id, from) => { setSelected(id); if (from === "mobile") setSheetOpen(true); }}
      onCloseSheet={() => setSheetOpen(false)}
      hasHosted={hasHosted}
      renderHosted={renderHosted}
      onOpenWorkspace={(id) => { setSheetOpen(false); onOpenWorkspace(id); }}
    />
  );
}
