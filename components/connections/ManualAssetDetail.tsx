"use client";

/**
 * components/connections/ManualAssetDetail.tsx  (Connections 2.0 — real assets)
 *
 * The body of a selected manual asset, in the same drawer and with the same
 * tab primitive (DetailTabs) as a provider connection's detail:
 *
 *   Overview  kind, the user's current estimate, currency, valued-as-of date,
 *             acquisition facts when given, and the Spaces it is shown in
 *   Health    "You value this asset yourself", the last valuation date and the
 *             freshness rule (over 12 months ⇒ consider updating) — never sync
 *             or provider language
 *   History   two separate things, labelled as such:
 *               · Valuation history — the AssetValuation ledger, read from
 *                 GET /api/accounts/manual/[id]/valuations (AssetValuationHistory)
 *               · Activity — the user's own audit events for this asset
 *             Nothing earlier than the ledger is ever drawn or implied.
 *
 * Every sentence comes from lib/connections/real-assets.core.ts.
 */

import { useState } from "react";
import { Home } from "lucide-react";
import { formatCurrencyWhole } from "@/lib/currency";
import {
  formatAssetDate, manualAssetHealth, summarizeManualAsset, MANUAL_ASSET_KIND_LABEL, type ManualAssetLite,
} from "@/lib/connections/real-assets.core";
import { ESTIMATE_DISCLOSURE } from "@/lib/assets/manual-asset";
import { AssetValuationHistory } from "@/components/space/widgets/wealth/AssetValuationHistory";
import { Badge, DetailTabs, Facts, SectionLabel } from "@/components/connections/ConnectionDetailTabs";
import { DOT, WORD } from "@/components/connections/ConnectionRow";

type AssetTab = "overview" | "health" | "history";
const ASSET_TABS: Array<{ key: AssetTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "health",   label: "Health" },
  { key: "history",  label: "History" },
];

export function ManualAssetDetail({ asset }: { asset: ManualAssetLite }) {
  const [tab, setTab] = useState<AssetTab>("overview");
  const now = new Date();
  const summary = summarizeManualAsset(asset, now);
  const health = manualAssetHealth(asset, now);
  const purchaseCurrency = asset.purchaseCurrency ?? asset.currency;

  return (
    <div data-manual-asset-tabs className="flex min-h-[calc(92dvh-9rem)] flex-col sm:min-h-0">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(125,168,255,.10)] text-[var(--meridian-400)]">
          <Home size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--text-secondary)]">{summary.kind} · {summary.source.toLowerCase()}</p>
        </div>
        <Badge tone={summary.tone}>{summary.status}</Badge>
      </div>

      {/* Remounted per asset (keyed by the list) so a new selection opens on Overview. */}
      <DetailTabs tabs={ASSET_TABS} tab={tab} onTab={setTab} label="Asset detail" render={(key) => (
        <>
          {key === "overview" && (
            <>
              <Facts rows={[
                ["Kind", MANUAL_ASSET_KIND_LABEL],
                ["Current value", <span key="v" className="tabular-nums">{formatCurrencyWhole(asset.value, asset.currency)}</span>],
                ["Currency", asset.currency],
                ["Valued as of", asset.valuedAsOfISO ? formatAssetDate(asset.valuedAsOfISO) : "Not dated"],
                asset.purchasePrice !== null && ["Purchase price", <span key="p" className="tabular-nums">{formatCurrencyWhole(asset.purchasePrice, purchaseCurrency)}</span>],
                asset.acquisitionDateISO !== null && ["Acquired", formatAssetDate(asset.acquisitionDateISO)],
                asset.spaces.length > 0 && ["Shown in", asset.spaces.map((s) => s.name).join(", ")],
              ]} />
              <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">{ESTIMATE_DISCLOSURE}</p>
            </>
          )}

          {key === "health" && (
            <>
              <p className={`flex items-center gap-2 text-sm font-medium ${health.tone === "ok" ? "text-[var(--text-primary)]" : WORD[health.tone]}`}>
                <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[health.tone]}`} />
                {health.headline}
              </p>
              <ul className="mt-3 divide-y divide-[var(--border-hairline)] rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
                {health.lines.map((l) => (
                  <li key={l.key} data-health={l.key} className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">{l.label}</span>
                    <span className={`flex min-w-0 items-center gap-1.5 text-right text-sm ${l.tone === "ok" ? "text-[var(--text-primary)]" : WORD[l.tone]}`}>
                      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[l.tone]}`} />
                      {l.text}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {key === "history" && (
            <>
              <SectionLabel>Valuation history</SectionLabel>
              <p className="mb-3 text-xs text-[var(--text-muted)]">The values you recorded, each with the date it describes.</p>
              {/* Re-read after a revaluation: the refreshed page changes this key. */}
              <AssetValuationHistory key={`${asset.id}-${asset.valuedAsOfISO}-${asset.value}-${asset.activity.length}`} accountId={asset.id} />

              <SectionLabel>Activity</SectionLabel>
              {asset.activity.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">No recorded activity for this asset.</p>
              ) : (
                <ul data-asset-activity className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
                  {asset.activity.map((a, i) => (
                    <li key={`${a.atISO}-${i}`} className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
                      <span className="text-sm text-[var(--text-secondary)]">{a.label}</span>
                      <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">{formatAssetDate(a.atISO)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )} />
    </div>
  );
}
