/**
 * lib/imports/provider-capabilities.ts
 *
 * D2 Step 5, slice #1. Smallest possible capability lookup for import
 * sources — replaces the hardcoded
 * `source === ImportSource.QUICKBOOKS` check in
 * app/api/accounts/[id]/import/route.ts and its read-only parity check in
 * app/api/accounts/[id]/import/preview/route.ts. See
 * docs/initiatives/d2/investigations/D2_STEP5_ADAPTER_INTERFACE_INVESTIGATION.md §6-§7 for
 * why this is a flat per-source registry rather than a
 * discoverAccounts/syncActivity/normalizeProviderData-style adapter object:
 * import sources have no Connection, no credential, and no second
 * capability today that would justify a larger shape.
 *
 * Not a sync adapter. Not a parsing abstraction — CSV/Excel/QuickBooks
 * already converge on NormalizedTransaction via lib/imports/csv.ts; this
 * file does not touch that.
 */

import { ImportSource } from "@prisma/client";

export interface ImportProviderCapabilities {
  /**
   * True if an exact externalTransactionId match for this source should
   * overwrite the existing Transaction's allow-listed fields
   * (computeQuickBooksUpdateDiff's field set) instead of leaving it
   * untouched. Never applies to a fingerprint-fallback match, regardless
   * of this flag — callers must keep gating on `matchedVia === "externalId"`
   * separately.
   */
  supportsUpdateOnMatch: boolean;
}

const REGISTRY: Record<ImportSource, ImportProviderCapabilities> = {
  [ImportSource.CSV]:        { supportsUpdateOnMatch: false },
  [ImportSource.EXCEL]:      { supportsUpdateOnMatch: false },
  [ImportSource.QUICKBOOKS]: { supportsUpdateOnMatch: true  },
};

export function getImportProviderCapabilities(
  source: ImportSource
): ImportProviderCapabilities {
  return REGISTRY[source];
}
