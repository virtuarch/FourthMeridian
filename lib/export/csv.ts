/**
 * lib/export/csv.ts  (OPS-2 S6)
 *
 * PURE CSV serialisers for the tabular export sets. Uses papaparse's `unparse`
 * (already a dependency, used for import PARSING) so the export writer and the
 * import reader share one CSV library.
 *
 * transactions.csv deliberately uses the SAME canonical column names the CSV
 * importer detects (`date`, `merchant`, `description`, `amount`, `category` —
 * see HEADER_ALIASES in lib/imports/csv.ts) so an exported transactions file
 * round-trips back through the importer. lib/export/csv.test.ts pins this by
 * running the importer's own detectColumns() over the produced header row.
 * Extra columns (currency, account/space ids) are additive context the
 * importer ignores.
 */

import Papa from "papaparse";
import { describeRowNature } from "@/lib/transactions/flow-presentation";
import type {
  ExportAccount,
  ExportHolding,
  ExportSnapshot,
  ExportTransaction,
} from "@/lib/export/types";

/** transactions.csv — importer-compatible columns first, context columns after. */
export function toTransactionsCsv(rows: ExportTransaction[]): string {
  return Papa.unparse(
    rows.map((r) => ({
      // L8-B — `date` is the ECONOMIC date (when it happened); `posting_date` is
      // provenance. Both labelled explicitly so a downloaded file is never
      // ambiguous about which chronology it carries.
      date:            r.date,
      posting_date:    r.postingDate ?? r.date,
      merchant:    r.merchant,
      description: r.description ?? "",
      amount:      r.amount,
      category:    r.category,
      currency:    r.currency ?? "",
      account_id:  r.accountId,
      space_id:    r.spaceId,
      // ── V27-TRUTH-5 — ADDITIVE income columns ───────────────────────────
      // Appended AFTER every pre-existing column, and no existing column is
      // renamed, reordered or removed, so a consumer reading by header name or
      // by leading position is unaffected. Empty for outflows and for rows the
      // read supplied no attribution for — never a fabricated class.
      income_class:            r.incomeClass ?? "",
      income_subtype:          r.incomeSubtype ?? "",
      source_account_id:       r.incomeSourceAccountId ?? "",
      source_instrument_id:    r.incomeInstrumentId ?? "",
      included_in_broad_income:
        r.incomeClass == null ? "" : String(r.incomeClass !== "NOT_INCOME"),
      exclusion_reason:
        r.incomeClass === "NOT_INCOME" ? (r.incomeSubtype ?? "NOT_INCOME") : "",
      // ── V27-TRUTH-7 — ADDITIVE canonical-meaning columns ────────────────
      // Appended after everything above, same additive contract.
      //
      // `category` remains for importer round-trip (it is the column
      // detectColumns() looks for), but no exported MEANING depends on it any
      // more: `flow_type` is the canonical economic kind, `row_nature` is what
      // the app itself calls the row, and `income_subtype` above refines
      // inflows. A downstream consumer no longer has to guess whether the
      // "Payment" category string meant a debt payment or a merchant named
      // Payment.
      flow_type:   r.flowType ?? "",
      row_nature:  describeRowNature({
        flowType:      r.flowType ?? null,
        incomeSubtype: r.incomeSubtype ?? null,
    transferMaturity: r.transferMaturity ?? null,
        amount:        r.amount,
        hasOwnedCounterparty: r.counterpartyAccountId != null,
      }).nature,
      // The owned account on the other side of a transfer, where the transfer
      // authority established one. Empty when it did not — never a guess, and
      // never a descriptor-derived name.
      transfer_counterparty_account_id: r.counterpartyAccountId ?? "",
      // The transfer authority's verdict about the DESTINATION, where it ran.
      transfer_maturity: r.transferMaturity ?? "",
    })),
  );
}

/** accounts.csv */
export function toAccountsCsv(rows: ExportAccount[]): string {
  return Papa.unparse(
    rows.map((r) => ({
      id:              r.id,
      name:            r.name,
      type:            r.type,
      institution:     r.institution,
      balance:         r.balance,
      currency:        r.currency,
      credit_limit:    r.creditLimit ?? "",
      interest_rate:   r.interestRate ?? "",
      minimum_payment: r.minimumPayment ?? "",
      last_updated:    r.lastUpdated,
      space_id:        r.spaceId,
      space_name:      r.spaceName,
    })),
  );
}

/**
 * holdings.csv (P2-5). `value`/`price`/`currency` are the NATIVE (quote) currency
 * — the pre-P2-5 contract. `reporting_value`/`reporting_currency` are the ADDED
 * FX-converted figure from the canonical seam; `cost_basis` is added where the
 * provider supplied it; `source` marks canonical vs the temporary crypto bridge.
 * Null numerics render as BLANK cells — an unvalued position is never shown as 0.
 */
export function toHoldingsCsv(rows: ExportHolding[]): string {
  const blank = (n: number | null): number | string => (n == null ? "" : n);
  return Papa.unparse(
    rows.map((r) => ({
      account_id:         r.accountId,
      symbol:             r.symbol ?? "",
      name:               r.name ?? "",
      quantity:           blank(r.quantity),
      price:              blank(r.price),
      value:              blank(r.value),
      currency:           r.currency ?? "",
      reporting_value:    blank(r.reportingValue),
      reporting_currency: r.reportingCurrency,
      cost_basis:         blank(r.costBasis),
      is_cash:            r.isCash,
      source:             r.source,
      space_id:           r.spaceId,
    })),
  );
}

/** snapshots.csv */
export function toSnapshotsCsv(rows: ExportSnapshot[]): string {
  return Papa.unparse(
    rows.map((r) => ({
      space_id:          r.spaceId,
      space_name:        r.spaceName,
      date:              r.date,
      posting_date:      (r as { postingDate?: string }).postingDate ?? r.date,
      net_worth:         r.netWorth,
      total_assets:      r.totalAssets,
      total_debt:        r.totalDebt,
      total_cash:        r.totalCash,
      total_savings:     r.totalSavings,
      total_investments: r.totalInvestments,
      total_crypto:      r.totalCrypto,
      cash_on_hand:      r.cashOnHand,
      is_estimated:      r.isEstimated ?? false,
      // ── V26-CRYPTO-STATUS-1 — assertability, beside the raw values ─────────
      //
      // Auditability first: `total_crypto`, `total_assets` and `net_worth` above
      // keep the EXACT number stored on the row, even when it may not be
      // asserted. Blanking or zeroing them would destroy the audit trail and
      // silently rewrite history; relabelling them would present a stale figure
      // as a corrected one. Instead these four columns say what the number is
      // worth, so a downstream system can tell apart:
      //   · the raw stored value              → total_crypto / total_assets / net_worth
      //   · whether it may be asserted        → crypto_assertable
      //   · whether the totals built on it    → asset_side_contaminated
      //     are affected
      //   · why not                           → crypto_unavailable_reason
      //
      // All four are READ from the canonical state resolved at the snapshot
      // boundary. This module derives nothing: no floor, no provider, no date
      // rule, no materiality threshold.
      //
      // Empty means the producing caller did not resolve a state (no such path
      // exists in the app today); it is deliberately distinct from `false`.
      crypto_valuation_state:    r.cryptoValuationState ?? "",
      crypto_assertable:         r.cryptoAssertable ?? "",
      asset_side_contaminated:   r.assetSideContaminated ?? "",
      crypto_unavailable_reason: r.cryptoUnavailableReason ?? "",
      // V27-A/B — AGGREGATE authorisation, beside the component's. The raw
      // stored totals above are preserved unchanged for audit; these say which
      // of them may be asserted and why. Empty when the producing caller
      // resolved no authorisation (a pre-Slice-A DTO) — deliberately distinct
      // from a recorded `false`.
      net_worth_state:      r.aggregateAuthorisation?.netWorth.state ?? "",
      net_worth_assertable: r.aggregateAuthorisation?.netWorth.assertable ?? "",
      total_assets_state:   r.aggregateAuthorisation?.totalAssets.state ?? "",
      net_liquid_state:     r.aggregateAuthorisation?.netLiquid.state ?? "",
    })),
  );
}
