/**
 * lib/providers/catalog.ts
 *
 * D6/D7 Provider Catalog — Slice 1. Static registry of integration methods
 * Fourth Meridian supports. This is an internal routing layer, not a
 * user-facing institution list.
 *
 * DEPENDENCY DIRECTION — one-way and strict:
 *   This module MAY be imported by UI/launch-decision code and future
 *   Institution Catalog resolution logic.
 *   This module MUST NOT be imported by lib/plaid/*, lib/imports/*,
 *   app/api/*, or any adapter. The catalog sits in front of adapters;
 *   adapters must not depend on it.
 *
 * SLUG CONVENTION:
 *   Slugs in this file name *integration methods*, not institutions.
 *   Institution Catalog slugs (future, separate layer) name institutions.
 *   Native institution adapters use the "{institution}-native" suffix
 *   (e.g. "coinbase-native") to avoid collision when both layers exist.
 *
 * See docs/initiatives/d6/D6_PROVIDER_CATALOG_INVESTIGATION.md and
 * docs/initiatives/d6/D6_INSTITUTION_CATALOG_INVESTIGATION.md.
 */

import { ImportSource, ProviderType } from "@prisma/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Presentation group for UI grouping and filtering.
 * Deliberately named "providerGroup" rather than "category" to avoid
 * future collision with AccountType / SpaceCategory / InstitutionType.
 */
export type ProviderGroup =
  | "BANKS_BROKERAGES"
  | "CRYPTO"
  | "IMPORTS"
  | "ACCOUNTING"
  | "MANUAL";

/**
 * Discriminated union describing which existing flow a catalog entry routes
 * to. The catalog carries routing metadata only — it never imports or
 * instantiates the adapter or pipeline itself.
 *
 * - "connection": routes to a Connection-model flow keyed by ProviderType.
 *   For PLAID this is the Plaid Link / exchange-token flow. For WALLET this
 *   is the wallet address flow. For EXCHANGE/BROKERAGE this is a future
 *   native adapter (currently disabled).
 * - "import": routes to the import pipeline keyed by ImportSource.
 *   Matches the existing ImportSource enum; the caller passes this value
 *   to getImportProviderCapabilities() and the import pipeline separately.
 * - "manual": routes to manual account creation. No credential, no import.
 */
export type CatalogDispatch =
  | { kind: "connection"; providerType: ProviderType }
  | { kind: "import";     importSource: ImportSource }
  | { kind: "manual" };

export interface ProviderCatalogEntry {
  /** Stable kebab-case identifier. Treat as immutable once shipped — any
   *  rename is a migration event, not a cosmetic edit. */
  slug: string;
  /** User-visible name. May change without breaking anything. */
  displayName: string;
  /** Presentation grouping. */
  providerGroup: ProviderGroup;
  /** Routing descriptor. Points at an existing flow; does not couple this
   *  module to the flow's implementation. */
  dispatch: CatalogDispatch;
  /**
   * Whether this entry can currently be launched.
   * false = no working adapter or flow exists behind this dispatch target.
   * Disabled entries are excluded from listEnabledProviderCatalogEntries()
   * and must not appear as live options in any UI.
   */
  enabled: boolean;
  /** Optional path or CDN URL for a provider logo. Absent for coming-soon
   *  entries. */
  logoUrl?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: ProviderCatalogEntry[] = [
  // ── Enabled entries ──────────────────────────────────────────────────────

  {
    slug:          "plaid",
    displayName:   "Banks & Brokerages",
    providerGroup: "BANKS_BROKERAGES",
    dispatch:      { kind: "connection", providerType: ProviderType.PLAID },
    enabled:       true,
  },
  {
    slug:          "wallet",
    displayName:   "Crypto Wallet",
    providerGroup: "CRYPTO",
    dispatch:      { kind: "connection", providerType: ProviderType.WALLET },
    enabled:       true,
  },
  {
    slug:          "csv",
    displayName:   "CSV Import",
    providerGroup: "IMPORTS",
    dispatch:      { kind: "import", importSource: ImportSource.CSV },
    enabled:       true,
  },
  {
    slug:          "excel",
    displayName:   "Excel Import",
    providerGroup: "IMPORTS",
    dispatch:      { kind: "import", importSource: ImportSource.EXCEL },
    enabled:       true,
  },
  {
    slug:          "quickbooks",
    displayName:   "QuickBooks Import",
    providerGroup: "ACCOUNTING",
    dispatch:      { kind: "import", importSource: ImportSource.QUICKBOOKS },
    enabled:       true,
  },
  {
    slug:          "manual",
    displayName:   "Manual Account",
    providerGroup: "MANUAL",
    dispatch:      { kind: "manual" },
    enabled:       true,
  },

  // ── Disabled placeholders — no adapter exists yet ─────────────────────────
  // Slugs use the "-native" suffix: Institution Catalog slugs name
  // institutions ("coinbase"); Provider Catalog slugs name integration
  // methods ("coinbase-native"). The suffix prevents collision when both
  // layers exist simultaneously.

  {
    // No adapter yet — see feature/provider-adapter-layer (branch 3).
    slug:          "coinbase-native",
    displayName:   "Coinbase",
    providerGroup: "CRYPTO",
    dispatch:      { kind: "connection", providerType: ProviderType.EXCHANGE },
    enabled:       false,
  },
  {
    // No adapter yet — see feature/provider-adapter-layer (branch 3).
    slug:          "schwab-native",
    displayName:   "Charles Schwab",
    providerGroup: "BANKS_BROKERAGES",
    dispatch:      { kind: "connection", providerType: ProviderType.BROKERAGE },
    enabled:       false,
  },
  {
    // No adapter yet — see feature/provider-adapter-layer (branch 3).
    slug:          "kraken-native",
    displayName:   "Kraken",
    providerGroup: "CRYPTO",
    dispatch:      { kind: "connection", providerType: ProviderType.EXCHANGE },
    enabled:       false,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All entries, including disabled placeholders. */
export function listProviderCatalogEntries(): ProviderCatalogEntry[] {
  return REGISTRY;
}

/** Only entries whose underlying flow is currently launchable. */
export function listEnabledProviderCatalogEntries(): ProviderCatalogEntry[] {
  return REGISTRY.filter((e) => e.enabled);
}

/** Look up a single entry by slug. Returns undefined if not found. */
export function getProviderCatalogEntry(
  slug: string
): ProviderCatalogEntry | undefined {
  return REGISTRY.find((e) => e.slug === slug);
}
