"use client";

/**
 * components/connections/ManualAssetRow.tsx  (Connections 2.0 — real assets)
 *
 * One compact row per manual asset, in the same shape as ConnectionRow: name,
 * "Real asset · Valued by you · Valued <date>", the user's current estimate and
 * a chevron; the ⋯ menu is a SIBLING of the row button (its own tab stop).
 *
 * Unlike a provider row this one shows a VALUE — the owner-approved carve-out:
 * it is the user's own typed estimate (lib/connections/real-assets.core.ts).
 * Whole currency units: Connections is outside a Space (MONEY-PRECISION-1).
 */

import { ChevronRight, Home } from "lucide-react";
import { formatCurrencyWhole } from "@/lib/currency";
import { summarizeManualAsset, type ManualAssetLite } from "@/lib/connections/real-assets.core";
import { ManualAssetMenu } from "@/components/connections/ManualAssetMenu";
import { DOT, WORD } from "@/components/connections/ConnectionRow";

export function ManualAssetRow({ asset, onOpen, now = new Date() }: { asset: ManualAssetLite; onOpen: () => void; now?: Date }) {
  const s = summarizeManualAsset(asset, now);
  const value = formatCurrencyWhole(asset.value, asset.currency);

  return (
    <li data-manual-asset-row className="flex items-center">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${asset.name} — ${s.kind}, ${s.source.toLowerCase()}, ${value}. Open details`}
        className="group relative flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-md)] px-3.5 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
      >
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2,rgba(255,255,255,0.04))] text-[var(--text-secondary)]">
          <Home size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-[var(--text-primary)]">{asset.name}</span>
            {/* Manual vs synced, said on the row itself. */}
            <span className="shrink-0 rounded-full border border-[var(--border-hairline)] px-1.5 py-px text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Manual</span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">
            {s.kind} · {s.source} · {s.valued}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="text-sm font-medium tabular-nums text-[var(--text-primary)]">{value}</span>
          <span className={`inline-flex items-center gap-1.5 text-[11px] ${WORD[s.tone]}`}>
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[s.tone]}`} />
            {s.status}
          </span>
        </span>
        <ChevronRight aria-hidden size={16} className="shrink-0 text-[var(--text-faint,#6b7280)] transition-transform group-hover:translate-x-0.5" />
      </button>
      <div className="w-11 shrink-0 pr-1.5 flex justify-center">
        <ManualAssetMenu asset={asset} />
      </div>
    </li>
  );
}
