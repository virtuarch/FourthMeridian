/**
 * lib/export/types.ts  (OPS-2 S6)
 *
 * Serialisable shapes for the personal-data export. Every field here is a
 * plain JSON value (no Date instances) — the assembler composes existing
 * read-layer DTOs, which are already client-safe, and the tabular sets extend
 * them with the Space they were read through.
 */

import type { Account, Snapshot, Transaction } from "@/types";
import type { ExportPlatformAiConversation, ExportPlatformAiOmission } from "@/lib/platform/intelligence/ai/conversations/export";

/**
 * A visible account tagged with the Space it was exported through.
 *
 * FM-AUDIT-022 — `balance` is `null` (never 0) for an account with no value (an
 * unpriced or never-observed wallet), and `valuationStatus` says why. Both are
 * set ONLY by `toExportAccount` (lib/export/accounts.ts); a valued account
 * carries its number and no `valuationStatus` key.
 */
export type ExportAccount = Omit<Account, "balance" | "valuationUnknown"> & {
  balance:          number | null;
  valuationStatus?: "not_yet_valued";
  spaceId:          string;
  spaceName:        string;
};
/** A banking transaction tagged with its Space. */
export type ExportTransaction = Transaction & { spaceId: string };

/**
 * Where an exported position row came from. `canonical` — the ratified
 * current-position spine (getCurrentPositions), the FULL-authorized value + FX +
 * completeness authority — and since W5 (P2-6 executed) the ONLY source: the
 * `crypto-compat` member died with the legacy `Holding` bridge. The union stays
 * a union so a future second source must declare itself here rather than
 * masquerade as canonical.
 */
export type HoldingExportSource = "canonical";

/**
 * An investment position for the export (P2-5). No longer the legacy `Holding`
 * row — it is projected from the canonical current-position seam, so `value` /
 * `price` are the NATIVE (quote) currency (preserving the pre-P2-5 contract:
 * `value` is denominated in `currency`) and `reportingValue` ADDS the FX-converted
 * figure in the Space `reportingCurrency`. Numeric fields are nullable: an
 * unvalued position keeps its row with a BLANK value — never 0-as-unknown.
 */
export interface ExportHolding {
  /**
   * Stable per-row key, also the cross-Space dedup key:
   * `${accountId}:${instrumentId}` (W5 — the legacy-Holding-id form died with
   * the crypto-compat source).
   */
  id:                string;
  accountId:         string;
  symbol:            string | null;
  name:              string | null;
  quantity:          number | null;
  /** Native/quote-currency unit price; null when the position is unvalued. */
  price:             number | null;
  /** Value in the native/quote currency; null when unvalued (never 0). */
  value:             number | null;
  /** ISO code of `price`/`value` (native/quote currency). */
  currency:          string | null;
  /** `value` converted into the Space reporting currency; null when unvalued. */
  reportingValue:    number | null;
  /** The Space reporting currency (ISO). */
  reportingCurrency: string;
  /** Provider aggregate cost basis in the native currency where supplied; else null. */
  costBasis:         number | null;
  isCash:            boolean;
  spaceId:           string;
  /** Provenance — see HoldingExportSource. */
  source:            HoldingExportSource;
}

/** A daily Space snapshot tagged with its Space. */
export type ExportSnapshot = Snapshot & { spaceId: string; spaceName: string };

export interface ExportManifest {
  app: "fourth-meridian";
  kind: "personal-data-export";
  schemaVersion: string;
  generatedAt: string; // ISO
  userId: string;
  files: string[];
  counts: Record<string, number>;
  /** True when the KD-7 transaction cap truncated the transactions set (D6). */
  truncated: boolean;
  notes: string[];
}

export interface ExportData {
  manifest: ExportManifest;
  profile: Record<string, unknown>;
  settings: Record<string, unknown>;
  security: {
    totpEnabled: boolean;
    sessions: Record<string, unknown>[];
    recoveryCodes: Record<string, unknown>[];
  };
  spaces: Record<string, unknown>[];
  accounts: ExportAccount[];
  connections: {
    accountConnections: Record<string, unknown>[];
    plaidItems: Record<string, unknown>[];
    connections: Record<string, unknown>[];
  };
  transactions: ExportTransaction[];
  holdings: ExportHolding[];
  snapshots: ExportSnapshot[];
  creditHistory: Record<string, unknown>[];
  // W2 — the goals export section was deleted with the Goals retirement.
  auditHistory: Record<string, unknown>[];
  imports: {
    batches: Record<string, unknown>[];
    mappingProfiles: Record<string, unknown>[];
  };
  aiAdvice: Record<string, unknown>[];
  /** PRIV-006 — the user's own AI memory rows (every status, so retired/superseded history is included). */
  aiMemory: Record<string, unknown>[];
  /** PRIV-006 — the user's own Daily Briefs (generated content only). */
  dailyBriefs: Record<string, unknown>[];
  /** PB-1 Phase 1 — sync incidents about the user (live + 13-month archive), allowlisted fields only. */
  syncIncidents: { live: Record<string, unknown>[]; archived: Record<string, unknown>[] };
  /**
   * B11 PR D — the operator's own LIVE Platform AI conversations in areas they
   * hold today, in full (soft-deleted excluded). Empty for every non-operator.
   */
  platformAiConversations: ExportPlatformAiConversation[];
  /**
   * S2 STRICT — live conversations in areas the operator NO LONGER holds: a
   * count and a fixed line per area, never any content.
   */
  platformAiConversationsOmitted: ExportPlatformAiOmission[];
}
