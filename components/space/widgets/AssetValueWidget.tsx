"use client";

/**
 * AssetValueWidget
 *
 * Generic read-only widget for any owned asset: property, vehicle, equipment,
 * or any future tangible asset type (boat, motorcycle, art, collectibles, …).
 *
 * Data source: SpaceDashboardSection.config (JSON field, already in schema).
 * No new API routes, no schema changes, no editing UI.
 *
 * Runtime compositor flow:
 *   section.key (property_value | vehicle_value | equipment_value | …)
 *     → WIDGET_REGISTRY entry
 *     → AssetValueWidget (this file)
 *     → section.config
 *     → rendered UI
 *
 * The widget is intentionally unaware of which space type it lives in.
 * Everything it needs comes from `meta` + `config`.
 *
 * ── Data model contract ───────────────────────────────────────────────────────
 *   FinancialAccount.balance          = source of truth for the current value
 *   SpaceDashboardSection.config.accountId     = which account this widget displays
 *   SpaceDashboardSection.config.purchasePrice = rendering metadata (gain/loss)
 *   SpaceDashboardSection.config.purchaseDate  = rendering metadata
 *   SpaceDashboardSection.config.notes         = rendering metadata
 *
 * This component never reads a dollar value from config. It receives `accountBalance`
 * from the adapter, which resolves the account via:
 *   1. config.accountId — explicit pin (preferred; set via account picker UI)
 *   2. Name heuristic   — regex on account.name (fallback for existing spaces)
 *   3. First type=other — last resort when space has one manual asset
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { formatCurrency, formatDate, formatPercent } from "@/lib/format";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AssetType = "property" | "vehicle" | "equipment" | "other";

/**
 * Rendering metadata from SpaceDashboardSection.config.
 *
 * IMPORTANT: `currentValue` has been intentionally removed.
 * The live dollar value is the source of truth in FinancialAccount.balance
 * and is passed via `AssetValueWidgetProps.accountBalance` by the adapter.
 * Config holds display hints only: purchase context + estimate provenance.
 *
 * Account resolution order (handled by the adapter, not this component):
 *   1. config.accountId — explicit pin to a specific FinancialAccount.id
 *   2. Name heuristic   — regex match on account.name based on assetType
 *   3. First type=other — fallback when space has only one manual asset
 */
export interface AssetValueConfig {
  /**
   * FinancialAccount.id to use as the live value source.
   * When set, the adapter skips name heuristics entirely.
   * Set via ManageSpaceModal asset section settings.
   */
  accountId?:       string;
  /** Purchase price for gain/loss comparison */
  purchasePrice?:   number;
  /** ISO date string — when the asset was acquired */
  purchaseDate?:    string;
  /** Where the current estimate came from (e.g. "Manual", "Zillow") */
  estimatedSource?: string;
  /** Display currency — falls back to DEFAULT_DISPLAY_CURRENCY */
  currency?:        string;
  /** Optional free-text note shown below the main figures */
  note?:            string;
  /** Legacy compat: ignored if accountBalance is provided */
  notes?:           string;
}

export interface AssetValueWidgetProps {
  /**
   * Human-readable title shown in the widget header area (from section.label
   * or meta.label — caller decides which wins).
   */
  title: string;
  /**
   * Determines the empty-state copy.
   * Everything else is driven by config — this prop does NOT change layout.
   */
  assetType: AssetType;
  /** Parsed from SpaceDashboardSection.config */
  config: AssetValueConfig | null | undefined;
  /**
   * Live balance from the linked FinancialAccount (type=other, syncStatus='manual').
   * When provided, this is the authoritative current value.
   * Falls back to undefined (empty state) if not provided.
   */
  accountBalance?: number;
}

// ─── Copy by asset type ───────────────────────────────────────────────────────

const EMPTY_COPY: Record<AssetType, { headline: string; subline: string }> = {
  property: {
    headline: "Property value hasn't been configured yet.",
    subline:  "This widget can display the current value of your property, equity built, and gain/loss since purchase.",
  },
  vehicle: {
    headline: "Vehicle value hasn't been configured yet.",
    subline:  "This widget can display your vehicle's current market value and depreciation since purchase.",
  },
  equipment: {
    headline: "Equipment value hasn't been configured yet.",
    subline:  "This widget can display the current value of your equipment and depreciation since purchase.",
  },
  other: {
    headline: "Asset value hasn't been configured yet.",
    subline:  "This widget can display the current value of this asset and gain/loss since acquisition.",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Converts a loose config value that may have been stored as a string to number. */
function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

function toStringVal(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return String(v);
}

// ─── Component ────────────────────────────────────────────────────────────────

// `title` is part of the widget contract for future standalone/fullscreen renders.
// The SectionCard header currently renders the label, so it is intentionally unused here.
export function AssetValueWidget({ title: _title, assetType, config, accountBalance }: AssetValueWidgetProps) {
  // currentValue: live account balance takes precedence over any legacy config value.
  // Config should never store a dollar value — but handle it as a fallback for
  // any rows seeded before this convention was established.
  const currentValue  = accountBalance ?? toNumber((config as Record<string, unknown> | null | undefined)?.["currentValue"]);
  const purchasePrice = toNumber(config?.purchasePrice);
  const purchaseDate  = toStringVal(config?.purchaseDate);
  const currency      = toStringVal(config?.currency) ?? DEFAULT_DISPLAY_CURRENCY;
  // Support both 'note' (legacy) and 'notes' (current seed field)
  const note          = toStringVal(config?.note) ?? toStringVal(config?.notes);

  // ── Empty state ────────────────────────────────────────────────────────────
  if (currentValue === undefined) {
    const copy = EMPTY_COPY[assetType] ?? EMPTY_COPY.other;
    return (
      <div className="text-center py-5 space-y-1">
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{copy.headline}</p>
        <p className="text-xs leading-relaxed max-w-xs mx-auto" style={{ color: "var(--text-faint)" }}>{copy.subline}</p>
      </div>
    );
  }

  // ── Computed metrics ───────────────────────────────────────────────────────
  const hasComparison     = purchasePrice !== undefined && purchasePrice > 0;
  const delta             = hasComparison ? currentValue - purchasePrice! : null;
  const deltaPercent      = hasComparison && purchasePrice! > 0
    ? ((currentValue - purchasePrice!) / purchasePrice!) * 100
    : null;
  const isGain            = delta !== null && delta >= 0;
  const isFlat            = delta === 0;

  // Colour tokens — semantic state only (gain → positive, loss → negative);
  // "no change" resolves to neutral ink.
  const gainColor = isFlat ? "var(--text-secondary)" : isGain ? "var(--accent-positive)" : "var(--accent-negative)";
  const deltaSign = delta !== null && delta > 0 ? "+" : "";

  return (
    <div className="space-y-4">

      {/* ── Primary value ─────────────────────────────────────────────────── */}
      <div>
        <p className="text-3xl font-bold" style={{ color: "var(--text-primary)" }}>
          {formatCurrency(currentValue, currency)}
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Current estimated value</p>
      </div>

      {/* ── Gain / loss vs purchase price ─────────────────────────────────── */}
      {hasComparison && delta !== null && deltaPercent !== null && (
        <div className="grid grid-cols-2 gap-3">
          {/* Purchase price */}
          <div className="rounded-xl p-3" style={{ background: "var(--surface-inset)" }}>
            <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>Purchase price</p>
            <p className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
              {formatCurrency(purchasePrice!, currency)}
            </p>
          </div>

          {/* Gain / loss */}
          <div className="rounded-xl p-3" style={{ background: "var(--surface-inset)" }}>
            <div className="flex items-center gap-1 mb-1">
              {isFlat
                ? <Minus   size={11} style={{ color: "var(--text-muted)" }} />
                : isGain
                  ? <TrendingUp   size={11} style={{ color: "var(--accent-positive)" }} />
                  : <TrendingDown size={11} style={{ color: "var(--accent-negative)" }} />}
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                {isFlat ? "No change" : isGain ? "Gain" : "Loss"}
              </p>
            </div>
            <p className="text-base font-semibold" style={{ color: gainColor }}>
              {deltaSign}{formatCurrency(Math.abs(delta), currency)}
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: gainColor }}>
              {deltaSign}{formatPercent(Math.abs(deltaPercent))}
            </p>
          </div>
        </div>
      )}

      {/* ── Meta row (purchase date / note) ───────────────────────────────── */}
      {(purchaseDate || note) && (
        <div className="space-y-1">
          {purchaseDate && (
            <div className="flex items-center justify-between text-xs">
              <span style={{ color: "var(--text-faint)" }}>Purchased</span>
              <span style={{ color: "var(--text-secondary)" }}>{formatDate(purchaseDate)}</span>
            </div>
          )}
          {note && (
            <p
              className="text-[11px] rounded-lg px-3 py-2 leading-relaxed border"
              style={{ color: "var(--text-faint)", borderColor: "var(--border-hairline)" }}
            >
              {note}
            </p>
          )}
        </div>
      )}

      {/* ── Config nudge: purchase price missing ──────────────────────────── */}
      {currentValue !== undefined && purchasePrice === undefined && (
        <p className="text-[11px] text-center" style={{ color: "var(--text-faint)" }}>
          Add a purchase price in this section&apos;s settings to see gain/loss.
        </p>
      )}
    </div>
  );
}
