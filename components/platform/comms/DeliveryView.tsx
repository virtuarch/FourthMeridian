"use client";

/**
 * components/platform/comms/DeliveryView.tsx  (Customer Success — Communications Center › Delivery & History)
 *
 * Aggregate delivery analytics (contract §4.11) — counts only, no recipient,
 * address or body ever. The route belongs to Session 1's Phase A ledger and is
 * not deployed yet: the view PROBES GET /delivery, shows "coming soon" on
 * 404 / 501, and renders the real payload on 200:
 *
 *   status totals (all eleven, C3; null ⇒ not observed, never 0) · the six
 *   fixed day series incl. captured / dead / cancelled (C4) · suppression
 *   reasons · per-message counts · coverage · "delivery not yet measured"
 *   (measured.delivered === false) · the provider-health link (C6).
 *
 * Owner decisions shown as fact: no open / click tracking ever; 90-day
 * delivery records, then counts only.
 */

import { useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Block, Surface } from "@/components/atlas/Surface";
import { COMMS_CHANNELS, type CommsChannel } from "@/lib/notifications/catalog/types";
import { DEFAULT_DELIVERY_FILTERS, deliveryUrl, type DeliveryFilters } from "@/lib/platform/comms-center/client";
import {
  DELIVERY_SERIES_KEYS, DELIVERY_STATUSES,
  type DeliveryAnalytics, type DeliveryStatus, type DeliveryWindow,
} from "@/lib/platform/comms-center/contract-v1-section-4";
import { Segmented } from "../leads/visual-kit";
import {
  CHANNEL_LABEL, COMMS_POLICY, DELIVERY_STATUS_LABEL, SERIES_LABEL, deliveryTiles, suppressionRows, utcStamp,
} from "./comms-model";
import { DaySeriesBars, DaySeriesLegend, FilterSelect, ListMeta, PolicyNote, ReadState, okData, useCommsRead, type CommsRead } from "./comms-kit";

const n = (v: number) => v.toLocaleString("en-US");

/** Platform Ops owns email provider health (contract §4.11 C6). */
export const PROVIDER_HEALTH_HREF = "/dashboard/platform/PLATFORM_OPS?workspace=platform-providers";

export const DELIVERY_COMING_SOON =
  "Delivery history arrives with the delivery ledger. Until then no send is recorded here — nothing below is a zero, it is simply not measured yet.";

const SERIES_COLOR: Record<(typeof DELIVERY_SERIES_KEYS)[number], string> = {
  accepted: "color-mix(in srgb, var(--meridian-400) 75%, transparent)",
  failed: "var(--coral-400)",
  dead: "var(--accent-negative)",
  suppressed: "var(--text-muted)",
  captured: "var(--brass-300)",
  cancelled: "var(--accent-warning)",
};

function Commitments({ href }: { href: string }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-[11px] text-[var(--text-muted)]" aria-label="Delivery commitments" data-delivery-commitments>
      <li>{COMMS_POLICY.noTracking}</li>
      <li>{COMMS_POLICY.retention}</li>
      <li>{COMMS_POLICY.noPii}</li>
      <li>
        Email provider health is owned by Platform Operations —{" "}
        <Link href={href} prefetch={false} className="inline-flex min-h-11 items-center gap-1 text-[var(--text-secondary)] underline-offset-2 hover:underline lg:min-h-0">
          open Providers <ExternalLink size={11} aria-hidden />
        </Link>
      </li>
    </ul>
  );
}

export interface DeliverySurfaceProps {
  read: CommsRead<DeliveryAnalytics>;
  filters: DeliveryFilters;
  onFilters: (f: DeliveryFilters) => void;
}

export function DeliverySurface({ read, filters, onFilters }: DeliverySurfaceProps) {
  const d = okData(read);
  const tiles = d ? deliveryTiles(d.totals, d.measured.delivered) : [];
  const reasons = d ? suppressionRows(d.suppressedByReason) : null;
  return (
    <div className="flex min-w-0 flex-col gap-8 md:gap-10" data-comms-view="delivery">
      <Block id="comms-delivery" label="Delivery & history" className="min-w-0"
        hint={<span className="text-[11px] text-[var(--text-faint)] max-sm:hidden">Counts only</span>}
        action={<Segmented label="Window" value={filters.window} onChange={(w: DeliveryWindow) => onFilters({ ...filters, window: w })}
          options={[{ id: "7d", label: "7 d" }, { id: "30d", label: "30 d" }, { id: "90d", label: "90 d" }]} />}>
        <Surface className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
          <div className="grid min-w-0 grid-cols-2 gap-3 sm:max-w-md">
            <FilterSelect label="Channel" value={filters.channel} options={COMMS_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
              onChange={(v) => onFilters({ ...filters, channel: v as CommsChannel | null })} />
            <FilterSelect label="Status" value={filters.status} options={DELIVERY_STATUSES.map((s) => ({ value: s, label: DELIVERY_STATUS_LABEL[s] }))}
              onChange={(v) => onFilters({ ...filters, status: v as DeliveryStatus | null })} />
          </div>

          <ReadState read={read} what="delivery history" comingSoon={DELIVERY_COMING_SOON} />

          {d && (
            <>
              {!d.measured.delivered && (
                <p className="rounded-[var(--radius-md)] border border-[var(--border-hairline)] px-3 py-2 text-xs text-[var(--text-secondary)]" data-delivery-not-measured>
                  <span className="font-medium text-[var(--text-primary)]">Delivery not yet measured.</span>{" "}
                  “Accepted” means the email provider took the message — not that it reached the inbox.
                </p>
              )}
              <ul aria-label="Totals by status" className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-delivery-totals>
                {tiles.map((t) => (
                  <li key={t.status} className="flex min-w-0 flex-col gap-0.5 rounded-[var(--radius-md)] border border-[var(--border-hairline)] p-2.5" style={{ background: "var(--surface-inset)" }} data-status-tile={t.status}>
                    <span className="truncate text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{t.label}</span>
                    {t.value === null
                      ? <span className="text-sm text-[var(--text-muted)]">— <span className="text-[11px]">{t.note}</span></span>
                      : <span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{n(t.value)}</span>}
                  </li>
                ))}
              </ul>
              <PolicyNote>
                {d.coverage.ledgerSince ? `Totals count the observed part of the window (ledger since ${d.coverage.ledgerSince}).` : "Nothing observed yet — the ledger has no rows in this window."}
                {d.coverage.directSendsCovered ? "" : " Direct sends are not yet covered."}
                {d.coverage.environment !== "production" ? ` ${d.coverage.environment === "preview" ? "Preview" : "Development"} captures sends instead of delivering them — volume shows under Captured.` : ""}
              </PolicyNote>
              <ListMeta checkedAt={d.checkedAt} floor={d.floor} capped={d.capped} extra={`${d.from} → ${d.to} UTC`} />
            </>
          )}
          <Commitments href={d?.providerHealth.href ?? PROVIDER_HEALTH_HREF} />
        </Surface>
      </Block>

      {d && (
        <>
          <Block id="comms-delivery-series" label="Per day, by outcome" className="min-w-0">
            <Surface className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
              <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3" data-delivery-series>
                {DELIVERY_SERIES_KEYS.map((k) => (
                  <div key={k} className="min-w-0" data-series={k}>
                    <p className="mb-1.5 text-[11px] font-medium text-[var(--text-secondary)]">{SERIES_LABEL[k]}</p>
                    <DaySeriesBars series={d.series[k]} label={`${SERIES_LABEL[k]} per UTC day`} color={SERIES_COLOR[k]} />
                  </div>
                ))}
              </div>
              <DaySeriesLegend />
            </Surface>
          </Block>

          <div className="grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-12">
            <Block id="comms-delivery-reasons" label="Why messages were not sent" className="min-w-0 lg:col-span-5">
              <Surface className="flex min-w-0 flex-col gap-2 p-4 sm:p-5">
                {reasons === null ? <p className="text-xs text-[var(--text-muted)]">Not observed.</p>
                  : reasons.length === 0 ? <p className="text-xs text-[var(--text-secondary)]">No suppressed messages in the observed window.</p> : (
                  <ul className="flex flex-col divide-y divide-[var(--border-hairline)]" aria-label="Suppression reasons">
                    {reasons.map((r) => (
                      <li key={r.reason} className="flex min-h-9 items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 truncate text-[var(--text-primary)]">{r.label}</span>
                        <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">{n(r.count)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Surface>
            </Block>
            <Block id="comms-delivery-bykey" label="By message" className="min-w-0 lg:col-span-7">
              <Surface className="flex min-w-0 flex-col gap-2 p-4 sm:p-5">
                {d.byKey === null ? <p className="text-xs text-[var(--text-muted)]">Not observed.</p>
                  : d.byKey.length === 0 ? <p className="text-xs text-[var(--text-secondary)]">No messages in the observed window.</p> : (
                  <ul className="flex flex-col divide-y divide-[var(--border-hairline)]" aria-label="Counts by message" data-delivery-bykey>
                    {d.byKey.map((row) => (
                      <li key={row.key} className="flex min-w-0 flex-col gap-0.5 py-2">
                        <code className="min-w-0 break-all font-mono text-[11px] text-[var(--text-primary)]">{row.key}</code>
                        <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
                          {(["ACCEPTED", "FAILED", "DEAD", "SUPPRESSED", "CAPTURED", "CANCELLED"] as const).map((s) => `${n(row.counts[s] ?? 0)} ${DELIVERY_STATUS_LABEL[s].toLowerCase()}`).join(" · ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <span className="text-[11px] text-[var(--text-muted)]">Checked {utcStamp(d.checkedAt)}{d.capped ? " · capped list" : ""}</span>
              </Surface>
            </Block>
          </div>
        </>
      )}
    </div>
  );
}

export function CommsDeliveryLead() {
  const [filters, setFilters] = useState<DeliveryFilters>(DEFAULT_DELIVERY_FILTERS);
  const read = useCommsRead<DeliveryAnalytics>(deliveryUrl(filters));
  return <DeliverySurface read={read} filters={filters} onFilters={setFilters} />;
}
