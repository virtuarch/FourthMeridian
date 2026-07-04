/**
 * lib/plaid/syncTransactions.ts
 *
 * Reusable, webhook-ready transaction sync for a single PlaidItem.
 * Wraps Plaid's /transactions/sync (cursor-based incremental sync) so the
 * same function can be called from multiple entry points without duplicating
 * sync logic:
 *
 *  - app/api/plaid/exchange-token/route.ts — initial sync, immediately after
 *    a successful Link flow (accounts already imported by that point).
 *  - app/api/plaid/sync/route.ts — manual "Sync Now" endpoint.
 *  - jobs/sync-banks.ts — a pre-existing stub (`export {}`, present since the
 *    v1.0 foundation commit, named for exactly this purpose) now wired to
 *    call this function. jobs/scheduler.ts already registers it on a fixed
 *    interval. Note: startScheduler() itself is not invoked anywhere yet (no
 *    instrumentation.ts hook) — a pre-existing gap unrelated to this work, so
 *    the interval is registered but dormant until that's wired up separately.
 *  - a future Plaid webhook handler (SYNC_UPDATES_AVAILABLE) — endpoint
 *    itself deliberately out of scope for this pass (needs public endpoint
 *    handling, signature verification, retry/error handling of its own);
 *    this is exactly what it would call once built.
 *
 * Design notes:
 *  - Takes our internal PlaidItem.id (not Plaid's item_id) so callers never
 *    need to touch the encrypted access token directly.
 *  - Resumes from PlaidItem.cursor; a null/undefined cursor means "first
 *    sync ever" and Plaid returns the full available transaction history.
 *  - Loops on `has_more` — a single call may require several pages.
 *  - Persists `next_cursor` back onto PlaidItem only after the full loop
 *    completes successfully, so a mid-loop failure can safely retry from the
 *    last *persisted* cursor rather than silently skipping a page.
 *  - Maps Plaid's account_id -> FinancialAccount.id via the unique
 *    plaidAccountId field set at import time. Transactions for an account we
 *    don't recognize (e.g. an account type we don't import) are skipped with
 *    a warning, not an error — one unmapped account can't abort the sync.
 *  - Flips the amount sign: Plaid uses positive = money out (debit),
 *    negative = money in (credit). Fourth Meridian's convention (see
 *    prisma/schema.prisma Transaction model comment) is the opposite:
 *    positive = money in (credit), negative = money out (debit).
 *  - Upserts on the unique `plaidTransactionId` field so re-running a sync
 *    (e.g. retried webhook delivery) never creates duplicates — but Plaid's
 *    transaction_id is NOT always stable for the same real-world posted
 *    transaction across separate sync runs (observed directly: two rows,
 *    same financialAccountId/date/amount/merchant, both pending:false,
 *    different plaidTransactionId, created on different sync runs — see
 *    docs/initiatives/d2/investigations/D2_STEP4C_TRANSACTION_FINGERPRINTING_INVESTIGATION.md). When no row matches by
 *    plaidTransactionId, a fingerprint fallback (financialAccountId, date,
 *    amount, normalized merchant, pending) looks for an existing row before
 *    creating a new one — same shape as the account-level fallback in
 *    lib/accounts/reconcile.ts, applied at the transaction level. This is a
 *    heuristic reuse of an existing row, not a uniqueness constraint:
 *    genuinely repeated same-day/same-amount/same-merchant transactions are
 *    valid data and are never blocked from being created.
 *  - D2 Step 4C — the fingerprint fallback itself (`findByFingerprint`/
 *    `normalizeMerchantKey`) now lives in lib/transactions/fingerprint.ts,
 *    extracted unchanged from this file so future import sources (CSV,
 *    Excel, QuickBooks — Step 4D) can reuse the same matching logic instead
 *    of each writing their own. Behavior here is unchanged by the move —
 *    see docs/initiatives/d2/investigations/D2_STEP4C_TRANSACTION_FINGERPRINTING_INVESTIGATION.md.
 *  - Writes `financialAccountId`, never the legacy `accountId` — Plaid-synced
 *    transactions only ever belong to a FinancialAccount.
 */

import { plaidClient } from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { db } from "@/lib/db";
import { ProviderType, PlaidItemStatus } from "@prisma/client";
import { findByFingerprint } from "@/lib/transactions/fingerprint";
// Pure Plaid → TransactionCategory mapping, extracted to a Prisma-free module so
// it is unit-testable in isolation (lib/transactions/plaid-category.test.ts).
// Re-exported below to preserve the historical `@/lib/plaid/syncTransactions`
// import path for mapPlaidCategory.
import { mapPlaidCategory, isLiabilityCardPaymentLeg } from "@/lib/transactions/plaid-category";
export { mapPlaidCategory } from "@/lib/transactions/plaid-category";
import { withPlaidRetry } from "@/lib/plaid/retry";
// FlowType P2 (import fidelity) — shadow classification only. Nothing below is
// persisted or used to alter any write, total, or AI read; it exists solely to
// exercise the P1 classifier against real Plaid inputs and emit a non-PII
// distribution when FLOWTYPE_SHADOW is enabled. Default (off) is a no-op.
import { classifyFlow, FLOW_CLASSIFIER_VERSION } from "@/lib/transactions/flow-classifier";
import {
  buildPlaidFlowInput,
  buildFlowWriteFields,
  NULL_FLOW_WRITE_FIELDS,
  createShadowStats,
  accumulateShadow,
  summarizeShadow,
} from "@/lib/transactions/plaid-flow-input";

export interface SyncTransactionsResult {
  /** Count of transactions Plaid reported in its `added` array this run (Plaid's own count, unchanged semantics). */
  added:    number;
  /** Count of transactions Plaid reported in its `modified` array this run (Plaid's own count, unchanged semantics). */
  modified: number;
  /** Count of rows actually deleted via Plaid's `removed` array. */
  removed:  number;
  cursor:   string | null;

  /** Of the added+modified transactions processed this run: brand-new rows inserted (no plaidTransactionId or fingerprint match found). */
  created:              number;
  /** Of the added+modified transactions processed this run: existing rows updated via an exact plaidTransactionId match. */
  updatedByPlaidId:      number;
  /** Of the added+modified transactions processed this run: existing rows updated via the fingerprint fallback (plaidTransactionId had no match, but financialAccountId+date+amount+merchant+pending did) — plaidTransactionId on that row is replaced with the new one. */
  updatedByFingerprint:  number;
  /** Transactions dropped because no FinancialAccount matched the Plaid account_id. */
  skippedMissingAccount: number;
}

/**
 * Runs an incremental transaction sync for the given PlaidItem.
 *
 * @param plaidItemDbId  Our internal PlaidItem.id (primary key), not Plaid's item_id.
 */
export async function syncTransactionsForItem(plaidItemDbId: string): Promise<SyncTransactionsResult> {
  const item = await db.plaidItem.findUnique({ where: { id: plaidItemDbId } });
  if (!item) {
    throw new Error(`syncTransactionsForItem: PlaidItem ${plaidItemDbId} not found`);
  }

  const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);

  let cursor: string | undefined = item.cursor ?? undefined;
  let added = 0;
  let modified = 0;
  let removed = 0;
  let hasMore = true;

  let created               = 0;
  let updatedByPlaidId      = 0;
  let updatedByFingerprint  = 0;
  let skippedMissingAccount = 0;

  // FlowType observability (FLOWTYPE_SHADOW). Classification itself now runs
  // unconditionally (P3 Phase B — it feeds the write); this flag only controls
  // the optional aggregate, non-PII distribution summary. Default off = no log.
  const shadowMode = (process.env.FLOWTYPE_SHADOW ?? "off").toLowerCase();
  const shadowEnabled = shadowMode !== "off";
  const shadowStats = createShadowStats();

  // Account-context cache for the classifier (accountType/debtSubtype), which
  // the write path does not otherwise load. Populated lazily per account.
  // Independent of the resolveFinancialAccountId path used by writes.
  const accountMetaCache = new Map<string, { type: string | null; debtSubtype: string | null }>();
  async function resolveAccountMeta(financialAccountId: string): Promise<{ type: string | null; debtSubtype: string | null }> {
    const cached = accountMetaCache.get(financialAccountId);
    if (cached) return cached;
    const fa = await db.financialAccount.findUnique({
      where:  { id: financialAccountId },
      select: { type: true, debtSubtype: true },
    });
    const meta = { type: (fa?.type as string | undefined) ?? null, debtSubtype: fa?.debtSubtype ?? null };
    accountMetaCache.set(financialAccountId, meta);
    return meta;
  }

  // Cache plaidAccountId -> FinancialAccount.id within this run — avoids a
  // query per transaction when many transactions share a handful of accounts.
  const accountIdCache = new Map<string, string | null>();
  async function resolveFinancialAccountId(plaidAccountId: string): Promise<string | null> {
    if (accountIdCache.has(plaidAccountId)) return accountIdCache.get(plaidAccountId)!;

    // D2 Step 3F — resolved primarily via ProviderAccountIdentity (provider=
    // PLAID, externalAccountId=plaidAccountId) rather than
    // FinancialAccount.plaidAccountId directly, with a fallback to the
    // legacy lookup if no identity row exists yet. Fallback-first, not a
    // hard replacement — mirrors Steps 3C/3D/3E. The resolved id (from
    // either path) is cached exactly as before.
    // D2 Step 1D — findFirst, not findUnique: see lib/accounts/reconcile.ts
    // for why (provider, externalAccountId) is no longer a named unique key).
    const plaidIdentity = await db.providerAccountIdentity.findFirst({
      where:  { provider: ProviderType.PLAID, externalAccountId: plaidAccountId },
      select: { financialAccount: { select: { id: true } } },
    });

    let fa = plaidIdentity?.financialAccount ?? null;
    if (!fa) {
      fa = await db.financialAccount.findUnique({
        where:  { plaidAccountId },
        select: { id: true },
      });
      if (fa) {
        console.warn(
          `[plaid][D2-3F] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fa.id} externalAccountId=${plaidAccountId}. Coverage gap; investigate before removing fallback.`
        );
      }
    }

    const resolved = fa?.id ?? null;
    accountIdCache.set(plaidAccountId, resolved);
    return resolved;
  }

  while (hasMore) {
    const resp = await withPlaidRetry(
      () => plaidClient.transactionsSync({
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
      }),
      "transactionsSync"
    );
    const { added: addedTxns, modified: modifiedTxns, removed: removedTxns, has_more, next_cursor } = resp.data;

    for (const txn of [...addedTxns, ...modifiedTxns]) {
      const financialAccountId = await resolveFinancialAccountId(txn.account_id);
      if (!financialAccountId) {
        skippedMissingAccount++;
        console.warn(
          `[plaid sync] no FinancialAccount for plaidAccountId ${txn.account_id} — skipping transaction ${txn.transaction_id}`
        );
        continue;
      }

      // Plaid: positive = debit (money out), negative = credit (money in).
      // Fourth Meridian: positive = credit (money in), negative = debit (money out).
      const amount      = -txn.amount;
      let   category    = mapPlaidCategory(txn); // `let`: CC-1 may refine below
      const date         = new Date(txn.date);
      const merchant     = txn.merchant_name ?? txn.name;
      const description  = txn.name;

      // FlowType P3 Phase B — classify and persist the flow columns. Computed
      // unconditionally (it feeds the write). Wrapped so a classification
      // failure degrades to all-null flow columns and NEVER blocks the write:
      // the row still persists with its original fields. resolveAccountMeta is
      // resolved once here and reused by the CC-1 guard AND flow classification.
      let flowFields = NULL_FLOW_WRITE_FIELDS;
      try {
        const meta = await resolveAccountMeta(financialAccountId);

        // CC-1 — rescue the destination (card-side) leg of a credit-card payment
        // that Plaid filed under Other. Guarded by isLiabilityCardPaymentLeg:
        // liability account (debtSubtype != null) + amount > 0 + a generalized,
        // institution-agnostic card-payment descriptor. Scoped to Other only, so
        // it can NEVER reclassify a purchase (amount < 0) or a row Plaid tagged
        // with a confident category. Applied BEFORE classifyFlow so the flow
        // classifier sees Payment → DEBT_PAYMENT (no classifier change needed).
        if (
          category === "Other" &&
          isLiabilityCardPaymentLeg({ accountType: meta.type, debtSubtype: meta.debtSubtype, amount, merchant, name: description })
        ) {
          category = "Payment";
        }

        const { input, captured } = buildPlaidFlowInput(txn, {
          category,
          amount,
          accountType: meta.type,
          debtSubtype: meta.debtSubtype,
        });
        const classification = classifyFlow(input);
        flowFields = buildFlowWriteFields(classification, input, captured, FLOW_CLASSIFIER_VERSION);
        if (shadowEnabled) accumulateShadow(shadowStats, classification, category, amount);
      } catch (e) {
        console.warn(`[flowtype] classification skipped for ${txn.transaction_id} — writing null flow columns:`, e);
      }

      // The 7 original values are byte-identical; flow columns are additive.
      const fields = { financialAccountId, date, merchant, description, category, amount, pending: txn.pending, ...flowFields };

      try {
        // 1. Exact match — same row Plaid is telling us about.
        const existingByPlaidId = await db.transaction.findUnique({
          where:  { plaidTransactionId: txn.transaction_id },
          select: { id: true },
        });

        if (existingByPlaidId) {
          await db.transaction.update({ where: { id: existingByPlaidId.id }, data: fields });
          updatedByPlaidId++;
          continue;
        }

        // 2. No plaidTransactionId match — check the fingerprint fallback
        // before assuming this is a genuinely new transaction (see module
        // header + findByFingerprint for why).
        const fingerprintMatch = await findByFingerprint(financialAccountId, date, amount, merchant, txn.pending);

        if (fingerprintMatch) {
          await db.transaction.update({
            where: { id: fingerprintMatch.id },
            data:  { ...fields, plaidTransactionId: txn.transaction_id },
          });
          updatedByFingerprint++;
          console.warn(
            `[plaid sync] fingerprint match — reusing existing transaction ${fingerprintMatch.id} for new plaidTransactionId ${txn.transaction_id} (previously ${fingerprintMatch.plaidTransactionId ?? "null"})`
          );
          continue;
        }

        // 3. Genuinely new transaction.
        await db.transaction.create({ data: { ...fields, plaidTransactionId: txn.transaction_id } });
        created++;
      } catch (e) {
        console.error(`[plaid sync] failed to upsert transaction ${txn.transaction_id}:`, e);
      }
    }
    added    += addedTxns.length;
    modified += modifiedTxns.length;

    if (removedTxns.length > 0) {
      const ids = removedTxns.map((t) => t.transaction_id);
      const result = await db.transaction.deleteMany({ where: { plaidTransactionId: { in: ids } } });
      removed += result.count;
    }

    hasMore = has_more;
    cursor  = next_cursor;
  }

  await db.plaidItem.update({
    where: { id: plaidItemDbId },
    data:  { cursor: cursor ?? null, lastSyncedAt: new Date(), status: PlaidItemStatus.ACTIVE, errorCode: null },
  });

  console.log(
    `[plaid sync] item ${plaidItemDbId} — created ${created}, updatedByPlaidId ${updatedByPlaidId}, updatedByFingerprint ${updatedByFingerprint}, skippedMissingAccount ${skippedMissingAccount}, removed ${removed}`
  );

  // FlowType P2 shadow — one aggregate, non-PII summary line per run when enabled.
  if (shadowEnabled) {
    console.log(summarizeShadow(shadowStats));
  }

  return {
    added,
    modified,
    removed,
    cursor: cursor ?? null,
    created,
    updatedByPlaidId,
    updatedByFingerprint,
    skippedMissingAccount,
  };
}
