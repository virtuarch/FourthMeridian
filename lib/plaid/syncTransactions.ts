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
 *  - jobs/sync-banks.ts — the daily scheduled sync, registered in
 *    lib/jobs/registry.ts and executed by the dispatcher cron
 *    (app/api/jobs/dispatch) since OPS-4 S2 (the dormant in-process
 *    jobs/scheduler.ts was retired in that slice).
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
 *  - Persists `next_cursor` back onto PlaidItem after EVERY FULLY-PERSISTED
 *    page, so a mid-loop interruption resumes from the last persisted cursor
 *    instead of restarting the full history pull — and never skips an
 *    unprocessed page. The final update additionally stamps lastSyncedAt and
 *    clears syncIncompleteAt to mark the whole import complete.
 *  - Maps Plaid's account_id -> FinancialAccount.id via the unique
 *    plaidAccountId field set at import time.
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
 *
 * ── THE CURSOR SAFETY INVARIANT (PRE-V26-PLAID-CLOSE Phase 1) ────────────────
 *
 *   A Plaid cursor may advance past a page ONLY when every canonical
 *   persistence obligation for that page has succeeded.
 *
 * Plaid never re-delivers a row behind a consumed cursor, so advancing past a
 * row we failed to store loses it permanently. That is not hypothetical: it is
 * the July-2 2026 payroll incident (a pending→posted transition whose posted
 * successor was skipped while the cursor moved on), recovered only by a manual
 * cursor-reset replay — see scripts/recover-plaid-item-transactions.ts.
 *
 * Two row-level paths could previously drop a transaction and still let the
 * page's cursor advance, because each recorded a SyncIssue and then `continue`d:
 *   1. account resolution miss  → MISSING_ACCOUNT
 *   2. upsert throw             → UPSERT_ERROR
 * Both now mark the PAGE incomplete. An incomplete page does not write its
 * cursor and THROWS `PlaidSyncIncompleteError`, so the same page replays on the
 * next attempt. Replay is idempotent by construction (plaidTransactionId is
 * unique and the write path resolves findUnique→update before create, with a
 * fingerprint fallback), so re-processing a page cannot duplicate anything.
 *
 * DOCTRINE: a visible stall beats silent financial-data loss. This function
 * must never report success while financial data it was handed is unpersisted.
 *
 * Throwing (rather than returning a partial result) is deliberate: every caller
 * already treats a throw as "this sync failed" — runDeferredHistorySync stamps
 * syncIncompleteAt + classifies health + notifies, withPlaidItemSyncLock leaves
 * syncIncompleteAt set, and refreshAllActiveItemsForUser records ok:false. A new
 * partial-result field would have been silently ignored by all of them.
 */

import { randomUUID } from "node:crypto";
import { plaidClient } from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { db } from "@/lib/db";
import { ProviderType, PlaidItemStatus } from "@prisma/client";
import { recordSyncIssue, resolveCursorBlockingIssues } from "@/lib/plaid/syncIssues";
import { retireItemSyncFailure } from "@/lib/plaid/sync-notifications";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { findByFingerprint } from "@/lib/transactions/fingerprint";
// Pure Plaid → TransactionCategory mapping, extracted to a Prisma-free module so
// it is unit-testable in isolation (lib/transactions/plaid-category.test.ts).
// Re-exported below to preserve the historical `@/lib/plaid/syncTransactions`
// import path for mapPlaidCategory.
import { mapPlaidCategory } from "@/lib/transactions/plaid-category";
// CCPAY-2C-3 — the card-payment category rescue is one shared decision, owned by
// the liability-payment authority; this path supplies evidence, not logic.
import { resolveLiabilityPaymentCategory } from "@/lib/transactions/liability-payment";
// SR-2 — the payroll descriptor-evidence rescue, the income-side sibling of the
// card-payment rescue above. Both act ONLY on the "Other" sentinel and both run
// BEFORE classifyFlow, so the descriptor decision produces category + flowType
// coherently and the classifier stays descriptor-blind.
import { resolvePayrollIncomeCategory } from "@/lib/transactions/descriptor-evidence";
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
  withDescriptorEvidenceReason,
  NULL_FLOW_WRITE_FIELDS,
  createShadowStats,
  accumulateShadow,
  summarizeShadow,
} from "@/lib/transactions/plaid-flow-input";
// TE1 — provider-neutral transfer evidence: stage-1 Plaid adapter + persistence
// mapper. Wired beside flowFields/factFields; liquidity/Cash Flow never see Plaid.
import { plaidTransferEvidence } from "@/lib/transactions/plaid-transfer-evidence";
import {
  transferEvidenceWriteFields,
  NULL_TRANSFER_EVIDENCE_FIELDS,
} from "@/lib/transactions/transfer-evidence-write";
// TI2-4 — durable Transaction Intelligence facts, stamped beside FlowType on the
// Plaid write path. Additive: TI columns only, disjoint from flow/MI columns.
// Computed once per payload from the already-derived classification + captured
// metadata; never recomputed inside miData (facts are category-independent).
import { buildTransactionFacts, NULL_TRANSACTION_FACTS } from "@/lib/transactions/transaction-facts";
// Merchant Intelligence M4 — live write-time identity + category provenance and
// identity-safe Plaid counterparty enrichment. Additive: MI columns only; the 7
// original fields, flow columns, and currency are untouched. A resolution
// failure degrades to null MI columns and never blocks the transaction write.
import { resolveMerchantWrite } from "@/lib/transactions/merchant-write";
import { plaidCounterpartyEnrichment, type EnrichmentCapture } from "@/lib/transactions/merchant-enrichment";
import type { CategorySource } from "@prisma/client";

/** One canonical persistence obligation this page failed to discharge. */
export interface PagePersistenceFailure {
  kind:               "MISSING_ACCOUNT" | "UPSERT_ERROR";
  plaidTransactionId: string;
  plaidAccountId:     string;
}

/**
 * Thrown when a page could not be fully persisted. The cursor for that page is
 * deliberately NOT written, so the next attempt replays the same page.
 *
 * Deliberately NOT an Axios error: `classifyPlaidErrorForHealth` returns null
 * for non-Axios errors, so this leaves PlaidItem.status ACTIVE and only stamps
 * syncIncompleteAt — the item is "retry me", not "broken / needs re-auth". The
 * resume path and the daily cron therefore keep retrying it.
 */
export class PlaidSyncIncompleteError extends Error {
  readonly plaidItemId: string;
  readonly failures:    readonly PagePersistenceFailure[];
  /** The cursor that was NOT advanced past — the page that must replay. */
  readonly heldCursor:  string | null;

  constructor(plaidItemId: string, failures: readonly PagePersistenceFailure[], heldCursor: string | null) {
    const kinds = [...new Set(failures.map((f) => f.kind))].join(" + ");
    super(
      `Plaid sync incomplete for item ${plaidItemId}: ${failures.length} transaction(s) failed to persist (${kinds}). ` +
      `Cursor held at ${heldCursor === null ? "the beginning (null)" : "its previous value"} so the page replays; ` +
      `no transaction was skipped.`,
    );
    this.name        = "PlaidSyncIncompleteError";
    this.plaidItemId = plaidItemId;
    this.failures    = failures;
    this.heldCursor  = heldCursor;
  }
}

/**
 * Injected dependencies. Both default to the real singletons, so every
 * production caller is unchanged. Tests pass fakes (`as never`, the house idiom
 * from lib/investments/opening-position.ts) — this is the seam that makes the
 * cursor invariant provable without a live database or the Plaid API.
 */
export interface SyncTransactionsDeps {
  db?:    typeof db;
  plaid?: Pick<typeof plaidClient, "transactionsSync">;
}

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
  // NOTE (PRE-V26-PLAID-CLOSE Phase 2): there is deliberately NO `failedRows`
  // field. A returned result is SYNONYMOUS with complete persistence — a page
  // with any unmet persistence obligation throws `PlaidSyncIncompleteError`
  // rather than returning. A counter that is always 0 would only invite callers
  // to branch on a state this contract makes unrepresentable.
}

/**
 * Runs an incremental transaction sync for the given PlaidItem.
 *
 * @param plaidItemDbId  Our internal PlaidItem.id (primary key), not Plaid's item_id.
 */
export async function syncTransactionsForItem(
  plaidItemDbId: string,
  deps: SyncTransactionsDeps = {},
): Promise<SyncTransactionsResult> {
  // One resolution point for the injected seam; everything below uses these.
  const database = deps.db    ?? db;
  const plaid    = deps.plaid ?? plaidClient;

  // PRE-V26-PLAID-CLOSE Phase 4 — one id per sync RUN, stamped into every
  // SyncIssue this invocation writes. Platform Ops correlates episodes on
  // (plaidItemId, runId), so one Chase run's tombstones and failures group
  // together and an unrelated Amex run an hour later never merges into them.
  // Carried in `detail` (Json) — no schema change, and `JobRun.executionId` does
  // not cover manual-refresh or webhook syncs.
  const runId = randomUUID();

  const item = await database.plaidItem.findUnique({ where: { id: plaidItemDbId } });
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

  // Live import progress (see PlaidItem.syncImportedCount). A null cursor means
  // this is a FRESH import, so the counter starts at zero; any other value means
  // we are resuming a partial import and must continue from what it already
  // reached — resetting there would make the customer's progress visibly jump
  // backwards, which is worse than showing nothing at all.
  const importedBase = item.cursor == null ? 0 : (item.syncImportedCount ?? 0);
  const importedSoFar = () => importedBase + created + updatedByPlaidId + updatedByFingerprint;

  // FlowType observability (FLOWTYPE_SHADOW). Classification itself now runs
  // unconditionally (P3 Phase B — it feeds the write); this flag only controls
  // the optional aggregate, non-PII distribution summary. Default off = no log.
  const shadowMode = (process.env.FLOWTYPE_SHADOW ?? "off").toLowerCase();
  const shadowEnabled = shadowMode !== "off";
  const shadowStats = createShadowStats();

  // Account-context cache for the classifier (accountType/debtSubtype), which
  // the write path does not otherwise load. Populated lazily per account.
  // Independent of the resolveFinancialAccountId path used by writes.
  const accountMetaCache = new Map<string, { type: string | null; debtSubtype: string | null; currency: string | null; ownerUserId: string | null }>();
  async function resolveAccountMeta(financialAccountId: string): Promise<{ type: string | null; debtSubtype: string | null; currency: string | null; ownerUserId: string | null }> {
    const cached = accountMetaCache.get(financialAccountId);
    if (cached) return cached;
    const fa = await database.financialAccount.findUnique({
      where:  { id: financialAccountId },
      // currency: MC1 Phase 0 Slice 2 — account-level fallback for the
      // per-transaction currency stamp when Plaid omits iso_currency_code.
      // createdByUserId (MI M5): the account owner whose USER MerchantRules apply.
      select: { type: true, debtSubtype: true, currency: true, createdByUserId: true },
    });
    const meta = { type: (fa?.type as string | undefined) ?? null, debtSubtype: fa?.debtSubtype ?? null, currency: fa?.currency ?? null, ownerUserId: fa?.createdByUserId ?? null };
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
    const plaidIdentity = await database.providerAccountIdentity.findFirst({
      where:  { provider: ProviderType.PLAID, externalAccountId: plaidAccountId },
      select: { financialAccount: { select: { id: true } } },
    });

    let fa = plaidIdentity?.financialAccount ?? null;
    if (!fa) {
      fa = await database.financialAccount.findUnique({
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
    // PRE-V26-PLAID-CLOSE — canonical persistence obligations this PAGE failed
    // to discharge. Reset per page: the cursor decision is per page, and earlier
    // fully-persisted pages legitimately keep their advanced cursor.
    const pageFailures: PagePersistenceFailure[] = [];

    const resp = await withPlaidRetry(
      () => plaid.transactionsSync({
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
        // M1 — durable record of a transaction dropped for lack of an account.
        await recordSyncIssue({
          kind:               "MISSING_ACCOUNT",
          plaidItemId:        plaidItemDbId,
          plaidAccountId:     txn.account_id,
          plaidTransactionId: txn.transaction_id,
          detail:             { stage: "transaction-persist", runId, cursorBlocking: true, merchant: txn.merchant_name ?? txn.name, amount: txn.amount, date: txn.date, pending: txn.pending },
        }, database);
        // CURSOR SAFETY — this transaction was delivered and NOT persisted. The
        // page is incomplete, so its cursor must not advance (see header).
        pageFailures.push({
          kind:               "MISSING_ACCOUNT",
          plaidTransactionId: txn.transaction_id,
          plaidAccountId:     txn.account_id,
        });
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
      // MC1 Phase 0 Slice 2 — currency provenance stamp. Provider code first
      // (Plaid sends iso_currency_code per transaction); account currency as
      // fallback (resolved inside the classification try below so a meta
      // failure degrades to provider-code-or-null and never blocks the write,
      // matching the flow-fields degradation contract). Never defaulted to
      // USD here — null means "denomination not recorded".
      let currency: string | null = txn.iso_currency_code ?? null;
      let flowFields = NULL_FLOW_WRITE_FIELDS;
      // TI2-4 — durable TI facts; degrade to all-null on any failure, mirroring
      // flowFields. Computed once below from the same classification + captured.
      let factFields = NULL_TRANSACTION_FACTS;
      // TE1 — provider-neutral transfer evidence; degrade to all-null on failure,
      // and stay all-null for non-transfer rows. Computed once below (gated on the
      // classifier's TRANSFER kind) from the same stored Plaid PFC + amount.
      let transferFields = NULL_TRANSFER_EVIDENCE_FIELDS;
      // MI M4 — identity-safe Plaid counterparty enrichment, captured from the
      // same `captured` sidecar buildPlaidFlowInput already produces. Best-effort;
      // null on any classification failure.
      let enrichment: EnrichmentCapture | null = null;
      try {
        const meta = await resolveAccountMeta(financialAccountId);
        currency = currency ?? meta.currency;

        // CC-1 — rescue the destination (card-side) leg of a credit-card payment
        // that Plaid filed under Other. Guarded: liability account + amount > 0 +
        // a generalized, institution-agnostic card-payment descriptor. Scoped to
        // Other only, so it can NEVER reclassify a purchase (amount < 0) or a row
        // Plaid tagged with a confident category. Applied BEFORE classifyFlow so
        // the flow classifier sees Payment → DEBT_PAYMENT (no classifier change
        // needed) AND the persisted category stays in sync with the persisted
        // flowType — one decision, two coherent columns.
        //
        // CCPAY-2C-3 — the decision itself now lives in the single authority
        // (lib/transactions/liability-payment.ts). This seam only supplies the
        // provider's evidence and the enum value. `description` is passed
        // explicitly and is REQUIRED by the evidence type: it is the RAW issuer
        // descriptor (txn.name), while `merchant` is Plaid's ENRICHED name — they
        // differ on 50% of rows, and an enriched payment row can carry the
        // descriptor in description ONLY.
        category = resolveLiabilityPaymentCategory(category, "Payment", {
          accountType: meta.type,
          debtSubtype: meta.debtSubtype,
          amount,
          merchant,
          description,
        });

        // SR-2 — payroll descriptor rescue: an inbound "Other" whose descriptor
        // attests earned income (PAYROLL / DIRECT DEPOSIT / SALARY) becomes
        // `Income`, so classifyFlow yields INCOME instead of the sign-default
        // UNKNOWN. Rescue-only + Other-only, so it can never fire after the
        // card-payment rescue above already resolved the category, and never
        // touches a purchase or a provider-decided category.
        const categoryBeforePayroll = category;
        category = resolvePayrollIncomeCategory(category, "Income", {
          amount,
          merchant,
          description,
        });
        // SR-4 — the descriptor resolver (not the descriptor-blind classifier)
        // decided the kind when it promoted Other → Income here. Stamp the
        // provenance so a freshly-synced pending payroll carries the same
        // DESCRIPTOR_EVIDENCE reason as a row the repair fixed retroactively.
        const payrollRescued = category !== categoryBeforePayroll;

        const { input, captured } = buildPlaidFlowInput(txn, {
          category,
          amount,
          accountType: meta.type,
          debtSubtype: meta.debtSubtype,
        });
        const classification = classifyFlow(input);
        flowFields = withDescriptorEvidenceReason(
          buildFlowWriteFields(classification, input, captured, FLOW_CLASSIFIER_VERSION),
          payrollRescued,
        );
        // TI2-4 — reuse the already-computed classification + captured metadata;
        // do NOT re-run classifyFlow. TI facts are category-independent, so they
        // are computed here once and never recomputed in miData's override branch.
        factFields = buildTransactionFacts({
          captured,
          pending:         txn.pending,
          rowCurrency:     currency,
          accountCurrency: meta.currency,
          flowType:        classification.flowType,
          flowDirection:   classification.flowDirection,
        });
        enrichment = plaidCounterpartyEnrichment(captured);
        // TE1 — for transfer-like rows only, normalize the stored Plaid PFC signal
        // into provider-neutral evidence and map to the persisted axes. Non-transfer
        // rows keep the all-null default (no stamp). Follows the flowFields
        // convention: provider re-sync recomputes and refreshes provider-derived
        // facts (a manual/user override, when that source lands, would be preserved
        // via reconcileTransferEvidence — no such source writes today).
        if (classification.flowType === "TRANSFER") {
          const ev = plaidTransferEvidence({ pfcDetailed: input.pfcDetailed, amount, name: merchant ?? description ?? null });
          // Persist ONLY when a descriptive axis was recognized — a no-signal /
          // unrecognized transfer stays unclassified (no fabricated default).
          if (ev.railType || ev.movementForm || ev.venueClass) {
            transferFields = transferEvidenceWriteFields(ev);
          }
        }
        if (shadowEnabled) accumulateShadow(shadowStats, classification, category, amount);
      } catch (e) {
        console.warn(`[flowtype] classification skipped for ${txn.transaction_id} — writing null flow columns:`, e);
      }

      // The 7 original values are byte-identical; flow columns are additive.
      // currency (MC1 Phase 0 Slice 2) rides the shared fields object. Category +
      // flow are held SEPARATELY so a USER correction can override or preserve
      // them (MI M5) without disturbing the base fields.
      // TI2-4 — factFields ride baseFields so they are stamped identically on all
      // three write sites (create, modified-update, fingerprint-update), disjoint
      // from category/flow (which ride `mi`) and independent of MI resolution.
      const baseFields = { financialAccountId, date, merchant, description, amount, pending: txn.pending, currency, ...factFields, ...transferFields };
      const defaultCategoryFlow = { category, ...flowFields };

      // MI M4/M5 — resolve merchant identity + category provenance, mint/reuse the
      // Merchant (+ alias + safe enrichment), apply an owner USER rule (override),
      // or preserve an existing USER_* correction. Returns the full mergeable
      // patch (category/flow + MI columns). Never blocks the write on failure.
      async function miData(current: {
        merchantId: string | null;
        categorySource: CategorySource | null;
      }): Promise<Record<string, unknown>> {
        try {
          const meta = await resolveAccountMeta(financialAccountId as string);
          const mi = await resolveMerchantWrite(
            database,
            {
              merchant,
              description,
              provider: {
                pfcPrimary:         txn.personal_finance_category?.primary ?? null,
                pfcDetailed:        txn.personal_finance_category?.detailed ?? null,
                pfcConfidenceLevel: txn.personal_finance_category?.confidence_level ?? null,
              },
              merchantEntityId:      txn.merchant_entity_id ?? null,
              currentCategory:       category,
              currentCategorySource: current.categorySource,
              currentMerchantId:     current.merchantId,
              ownerUserId:           meta.ownerUserId,
            },
            enrichment,
          );
          const columns = mi.setMerchantId && mi.merchantId ? { merchantId: mi.merchantId } : {};
          // PRESERVE — existing USER_OVERRIDE / USER_RULE: do not touch category/flow.
          if (mi.preserveExisting) return { ...columns };
          // OVERRIDE — a USER rule applies its category; re-derive flow from it
          // through the authoritative pipeline so category and flowType stay in sync.
          if (mi.category) {
            const { input, captured } = buildPlaidFlowInput(txn, { category: mi.category, amount, accountType: meta.type, debtSubtype: meta.debtSubtype });
            const overrideFlow = buildFlowWriteFields(classifyFlow(input), input, captured, FLOW_CLASSIFIER_VERSION);
            return { ...columns, category: mi.category, ...overrideFlow, categorySource: "USER_RULE", ...(mi.categoryRuleId ? { categoryRuleId: mi.categoryRuleId } : {}) };
          }
          // NORMAL — default category + flow, stamp confirmed provenance.
          return { ...columns, ...defaultCategoryFlow, ...(mi.categorySource ? { categorySource: mi.categorySource } : {}) };
        } catch (e) {
          console.warn(`[merchant-intelligence] resolution skipped for ${txn.transaction_id} — writing default category/flow, no MI:`, e);
          return { ...defaultCategoryFlow };
        }
      }

      try {
        // 1. Exact match — same row Plaid is telling us about.
        const existingByPlaidId = await database.transaction.findUnique({
          where:  { plaidTransactionId: txn.transaction_id },
          select: { id: true, merchantId: true, categorySource: true },
        });

        if (existingByPlaidId) {
          // Integrity hardening: resurrect (deletedAt: null). If this row had
          // been tombstoned by a prior removed[] and Plaid now re-sends it in
          // added/modified, it is live again — Plaid only sends added/modified
          // for live transactions, so clearing deletedAt here is correct.
          const mi = await miData({ merchantId: existingByPlaidId.merchantId, categorySource: existingByPlaidId.categorySource });
          await database.transaction.update({ where: { id: existingByPlaidId.id }, data: { ...baseFields, deletedAt: null, ...mi } });
          updatedByPlaidId++;
          continue;
        }

        // 2. No plaidTransactionId match — check the fingerprint fallback
        // before assuming this is a genuinely new transaction (see module
        // header + findByFingerprint for why).
        const fingerprintMatch = await findByFingerprint(financialAccountId, date, amount, merchant, txn.pending, database);

        if (fingerprintMatch) {
          // Read the matched row's current MI state so the update never
          // re-points an existing merchant or overwrites set provenance.
          const cur = await database.transaction.findUnique({
            where:  { id: fingerprintMatch.id },
            select: { merchantId: true, categorySource: true },
          });
          const mi = await miData({ merchantId: cur?.merchantId ?? null, categorySource: cur?.categorySource ?? null });
          await database.transaction.update({
            where: { id: fingerprintMatch.id },
            data:  { ...baseFields, plaidTransactionId: txn.transaction_id, ...mi },
          });
          updatedByFingerprint++;
          console.warn(
            `[plaid sync] fingerprint match — reusing existing transaction ${fingerprintMatch.id} for new plaidTransactionId ${txn.transaction_id} (previously ${fingerprintMatch.plaidTransactionId ?? "null"})`
          );
          continue;
        }

        // 3. Genuinely new transaction. `category` is included explicitly as the
        // required baseline; miData's category (normal/override) overrides it via
        // the later spread (preserve never occurs on a create).
        const mi = await miData({ merchantId: null, categorySource: null });
        await database.transaction.create({ data: { ...baseFields, category, plaidTransactionId: txn.transaction_id, ...mi } });
        created++;
      } catch (e) {
        console.error(`[plaid sync] failed to upsert transaction ${txn.transaction_id}:`, e);
        // M1 — durable record of a transaction that failed to persist.
        await recordSyncIssue({
          kind:               "UPSERT_ERROR",
          plaidItemId:        plaidItemDbId,
          financialAccountId,
          plaidAccountId:     txn.account_id,
          plaidTransactionId: txn.transaction_id,
          detail:             { stage: "transaction-persist", runId, cursorBlocking: true, merchant, amount, date: date.toISOString(), pending: txn.pending, error: e instanceof Error ? e.message : String(e) },
        }, database);
        // CURSOR SAFETY — delivered and NOT persisted; the page is incomplete.
        pageFailures.push({
          kind:               "UPSERT_ERROR",
          plaidTransactionId: txn.transaction_id,
          plaidAccountId:     txn.account_id,
        });
      }
    }
    added    += addedTxns.length;
    modified += modifiedTxns.length;

    if (removedTxns.length > 0) {
      const ids = removedTxns.map((t) => t.transaction_id);
      // Integrity hardening: SOFT-delete (tombstone) instead of physical delete.
      // Preserves the row + plaidTransactionId for forensics/recovery, so a
      // pending removed during a pending→posted transition is never lost without
      // a trace. Readers already filter deletedAt: null (D2 Step 4D-R), so
      // tombstoned rows do not resurface in UI/AI/totals/snapshots. Guarded on
      // deletedAt: null so re-processing preserves the original removal time
      // (idempotent). The removed ids are logged for forensics.
      const result = await database.transaction.updateMany({
        where: { plaidTransactionId: { in: ids }, deletedAt: null },
        data:  { deletedAt: new Date() },
      });
      removed += result.count;
      if (result.count > 0) {
        console.warn(
          `[plaid sync] removed[] soft-deleted ${result.count} transaction(s) for item ${plaidItemDbId} — plaidTransactionIds: ${ids.join(", ")}`
        );
        // M1 — durable record of the removed[] tombstone batch for forensics.
        await recordSyncIssue({
          kind:        "REMOVED_TOMBSTONE",
          plaidItemId: plaidItemDbId,
          detail:      { runId, count: result.count, ids },
        }, database);
      }
    }

    // ── CURSOR SAFETY GATE ───────────────────────────────────────────────────
    // The page is only "consumed" if every row Plaid handed us was persisted.
    // Bail BEFORE touching `cursor` or writing it, so the held cursor is still
    // the one this page was fetched with and the next attempt replays this exact
    // page. Throwing (not returning) is what makes callers treat the run as
    // failed — see the header. The SyncIssue rows written above are the durable
    // forensic record; this error is the control-flow signal.
    if (pageFailures.length > 0) {
      const heldCursor = cursor ?? null;
      console.error(
        `[plaid sync] page INCOMPLETE for item ${plaidItemDbId} — ${pageFailures.length} transaction(s) failed to persist ` +
        `(${pageFailures.map((f) => `${f.kind}:${f.plaidTransactionId}`).join(", ")}). ` +
        `Cursor NOT advanced; this page will replay on the next sync.`,
      );
      throw new PlaidSyncIncompleteError(plaidItemDbId, pageFailures, heldCursor);
    }

    hasMore = has_more;
    cursor  = next_cursor;

    // Persist the cursor after EVERY completed page, not just once at the end.
    // A mid-loop interruption (timeout, transient error, hard kill) now
    // preserves progress: the next attempt resumes from this page's cursor
    // instead of restarting the full 730-day pull. The transactions from this
    // page are already committed above (the CURSOR SAFETY GATE just proved it),
    // so advancing the cursor in lockstep is correct — it can never skip an
    // unprocessed page and can never skip an unpersisted row. lastSyncedAt /
    // syncIncompleteAt are intentionally NOT touched here: the item is not
    // "done" until the loop exits, so the incomplete marker stays set until the
    // final update below clears it.
    // syncImportedCount rides along with the cursor deliberately: both describe
    // "progress through this import", so writing them in one statement keeps the
    // number the customer sees consistent with the page actually committed.
    await database.plaidItem.update({
      where: { id: plaidItemDbId },
      data:  { cursor: cursor ?? null, syncImportedCount: importedSoFar() },
    });
  }

  // CH-2 — the success/recovery health flip (ACTIVE, errorCode cleared) goes
  // through the chokepoint: it writes the same live columns and appends a
  // durable transition row ONLY when the item was actually broken before (a
  // normal healthy re-sync re-affirms ACTIVE/null → no duplicate row). The
  // cursor / lastSyncedAt / syncIncompleteAt writes ride along in the same
  // update; syncIncompleteAt: null clears the marker set at connect / by a
  // failed prior attempt, flipping the item to "ready" (lib/sync/status.ts).
  await setPlaidItemHealth(
    plaidItemDbId,
    { status: PlaidItemStatus.ACTIVE, errorCode: null },
    { cursor: cursor ?? null, lastSyncedAt: new Date(), syncIncompleteAt: null,
      syncImportedCount: importedSoFar() },
    database,
  );

  // Phase 4 — the run completed, so the cursor advanced past every page. Under
  // the Phase 1 invariant that is PROOF every obligation was discharged, which
  // is what licenses closing this item's cursor-blocking issues. Best-effort and
  // deliberately after the health flip: resolution is bookkeeping, never a
  // precondition for reporting the item healthy.
  await resolveCursorBlockingIssues(plaidItemDbId, database);

  // OPS-3 S5 Wave 3 — the item provably works again: retire the open
  // SYNC_FAILED condition (releases the :open dedupe key + archives the stale
  // "needs attention" row) so a FUTURE outage notifies afresh. Best-effort.
  await retireItemSyncFailure(plaidItemDbId, { itemClient: database });

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
