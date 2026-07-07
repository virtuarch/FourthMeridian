/**
 * lib/transactions/merchant-enrichment.ts
 *
 * Merchant Intelligence — provider-NEUTRAL enrichment capture (MI1 M4).
 *
 * Plaid already sends counterparty `website` / `logo_url` on every synced
 * transaction and the platform has been discarding it. This module turns that
 * (and, later, other providers' equivalent metadata) into a single neutral
 * `EnrichmentCapture` shape that the write helper stamps onto the Merchant's
 * existing M1 columns (website / logoUrl / enrichmentSource / enrichmentConfidence
 * / enrichedAt). NO MerchantAsset table, NO external fetch, NO blob storage —
 * this only forwards data the provider already handed us.
 *
 * Provider-neutral by construction: `EnrichmentCapture` names only what any
 * provider can supply (website, logoUrl, confidence, source, timestamp). Plaid
 * is the first adapter (`plaidCounterpartyEnrichment`); a future Coinbase /
 * security-metadata / external adapter would return the SAME shape with its own
 * `MerchantEnrichmentSource`, without changing the write helper.
 *
 * Pure — the only @prisma/client import is TYPE-ONLY.
 */

import type { MerchantEnrichmentSource } from "@prisma/client";
import type { CapturedPlaidMetadata } from "@/lib/transactions/plaid-flow-input";

/** The provider-neutral enrichment payload a merchant's fields are stamped from. */
export interface EnrichmentCapture {
  website: string | null;
  logoUrl: string | null;
  /** 0..1 confidence in the enrichment, or null when the provider gives none. */
  confidence: number | null;
  source: MerchantEnrichmentSource;
  timestamp: Date;
}

/** Map a provider confidence level string to a deterministic numeric confidence. */
function levelToConfidence(level: string | null | undefined): number | null {
  switch ((level ?? "").toUpperCase()) {
    case "VERY_HIGH": return 0.99;
    case "HIGH":      return 0.9;
    case "MEDIUM":    return 0.7;
    case "LOW":       return 0.5;
    default:          return null;
  }
}

/**
 * Plaid counterparty → EnrichmentCapture, IDENTITY-SAFE.
 *
 * Returns enrichment ONLY when a counterparty's `entity_id` matches the
 * transaction's `merchant_entity_id` (the same stable id the resolver mints the
 * Merchant against) AND that counterparty carries a website or logo. Any other
 * case — no merchant entity id, no matching counterparty, or a match with no
 * website/logo — returns null, so a logo/website is never attached to the wrong
 * merchant. Pure and deterministic (aside from the capture timestamp).
 */
export function plaidCounterpartyEnrichment(
  captured: CapturedPlaidMetadata,
  now: Date = new Date(),
): EnrichmentCapture | null {
  const entityId = captured.merchantEntityId;
  if (!entityId) return null; // no stable identity → never attach

  const match = captured.counterparties.find(
    (c) => c.entityId === entityId && (c.website !== null || c.logoUrl !== null),
  );
  if (!match) return null;

  return {
    website: match.website,
    logoUrl: match.logoUrl,
    confidence: levelToConfidence(match.confidenceLevel),
    source: "PLAID_COUNTERPARTY",
    timestamp: now,
  };
}
