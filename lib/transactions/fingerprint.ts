/**
 * lib/transactions/fingerprint.ts
 *
 * Shared transaction fingerprint matching — extracted from
 * lib/plaid/syncTransactions.ts (D2 Step 4C) so that future import sources
 * (CSV, Excel, QuickBooks — D2 Step 4D) reuse this exact matching logic
 * instead of each writing their own, independent fingerprint matcher. This
 * is a pure extraction: the matching semantics, query shape, and fallback
 * behavior are unchanged from the pre-4C implementation that lived inline
 * in syncTransactions.ts.
 *
 * See docs/initiatives/d2/investigations/D2_STEP4C_TRANSACTION_FINGERPRINTING_INVESTIGATION.md
 * for the investigation and design rationale behind this shape, and for the
 * questions this step deliberately does NOT resolve (a persisted
 * fingerprintHash column, merchant-or-description precedence for sources
 * without a separate merchant field, collision/edit semantics for import
 * sources, the create-vs-matched discriminator needed for import rollback).
 * Those are explicitly out of scope here — this step only extracts what
 * already existed and re-points the one existing caller onto it.
 */

import { db } from "@/lib/db";

export type TransactionFingerprintCandidate = {
  id: string;
  plaidTransactionId: string | null;
};

/**
 * Normalizes a merchant/description string for fingerprint comparison —
 * trims, collapses internal whitespace, uppercases. Deliberately
 * conservative: it does not strip reference/trace numbers, so two distinct
 * real transactions that merely share a date and amount but differ in their
 * merchant text are never merged.
 */
export function normalizeMerchantKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Fingerprint fallback for the case an exact external-id match misses: the
 * same real-world transaction reappearing with a brand-new id on a later
 * sync/import (Plaid's transaction_id is not always stable across sync runs
 * for the same posted transaction — see lib/plaid/syncTransactions.ts module
 * header). Scoped first by (financialAccountId, date, amount, pending) —
 * financialAccountId+date is already indexed
 * (@@index([financialAccountId, date])) — then narrowed by normalized
 * DESCRIPTOR in memory, since the DB doesn't store a normalized column.
 * Candidate sets here are expected to be small (a handful of same-day
 * transactions per account at most).
 *
 * DF-4 — the narrowing key is the RAW provider DESCRIPTOR (`Transaction.description`,
 * i.e. Plaid's verbatim `txn.name`), NOT the enriched merchant. Plaid's
 * `merchant_name` enrichment DRIFTS across sync runs — a row enriched to
 * "Amazon" on one pass but returned un-enriched (`merchant_name = null`,
 * personal_finance_category OTHER_OTHER) on a re-pull yields two different
 * merchant keys, so the fallback missed and created a duplicate (the 6-Amazon-
 * rows incident). The raw descriptor is stable across enrichment, so replaying
 * the same provider history now resolves to the same canonical row. Callers pass
 * `description ?? merchant` so sources without a separate raw descriptor (some
 * CSV rows) keep their prior merchant-keyed behavior; the compare side coalesces
 * the same way. This is STRICTER than the enriched merchant (a longer, more
 * specific string), so it can only reduce false merges, never increase them.
 * See docs/architecture/TRANSACTION_IDENTITY_DOCTRINE.md.
 *
 * Returns the first match, logging a warning if more than one candidate
 * matches (unexpected, but handled deterministically rather than erroring).
 */
export async function findByFingerprint(
  financialAccountId: string,
  date: Date,
  amount: number,
  /** DF-4 — the RAW descriptor (caller passes `description ?? merchant`), not the enriched merchant. */
  descriptor: string,
  pending: boolean,
  /**
   * PRE-V26-PLAID-CLOSE — optional injected Prisma client (defaults to the real
   * `db`). Additive: every existing caller is unchanged. Needed so a sync run
   * driven by an injected fake client does not silently read through to the real
   * database here — without it, the fingerprint fallback would be the one path
   * in the sync loop that escapes the test seam.
   */
  client: Pick<typeof db, "transaction"> = db,
): Promise<TransactionFingerprintCandidate | null> {
  const candidates = await client.transaction.findMany({
    // deletedAt: null — D2 Step 4D-R: a row soft-deleted by an import
    // rollback must never be treated as a match candidate. Without this,
    // Plaid sync's own fingerprint fallback (lib/plaid/syncTransactions.ts)
    // could silently "adopt" a rolled-back row — setting plaidTransactionId
    // on it without clearing deletedAt — permanently losing a real
    // transaction with no error surfaced anywhere. Same rationale applies to
    // lib/imports/csv.ts's resolveFingerprintOutcome(), the other caller of
    // this helper. See
    // docs/initiatives/d2/investigations/D2_STEP4DR_TRANSACTION_READ_PATH_AUDIT_INVESTIGATION.md §3.
    where:  { financialAccountId, date, amount, pending, deletedAt: null },
    select: { id: true, merchant: true, description: true, plaidTransactionId: true },
  });
  if (candidates.length === 0) return null;

  // DF-4 — narrow on the RAW descriptor (`description ?? merchant`), stable across
  // Plaid enrichment drift, instead of the enriched `merchant` (which drifts).
  const target  = normalizeMerchantKey(descriptor);
  const matches = candidates.filter((c) => normalizeMerchantKey(c.description ?? c.merchant) === target);
  if (matches.length === 0) return null;

  if (matches.length > 1) {
    console.warn(
      `[plaid sync] fingerprint match ambiguous — ${matches.length} existing rows match financialAccountId=${financialAccountId} date=${date.toISOString().slice(0, 10)} amount=${amount} descriptor="${descriptor}"; using the first (id=${matches[0].id})`
    );
  }
  return matches[0];
}
