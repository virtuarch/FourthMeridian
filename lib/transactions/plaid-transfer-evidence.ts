/**
 * lib/transactions/plaid-transfer-evidence.ts
 *
 * Stage-1 PROVIDER ADAPTER — Plaid → provider-neutral TransferEvidence.
 *
 * This is the ONLY module that knows Plaid's personal_finance_category detailed
 * strings for transfers. It maps each recognized detailed-code FAMILY to exactly
 * one Fourth Meridian evidence axis (rail / form / venue) and hands off to the
 * canonical layer (transfer-evidence.ts). No Plaid token appears past here.
 *
 * Deterministic by construction:
 *  - The messy detailed code (incl. Plaid's doubled "TRANSFER_OUT_TRANSFER_OUT_*"
 *    artifact) is normalized to a FAMILY token by stripping only leading
 *    TRANSFER_IN_/TRANSFER_OUT_ prefixes, then matched by EXACT family key — no
 *    broad substring guessing that could misclassify overlapping values.
 *  - Every recognized code family in the live dataset is covered:
 *      FROM_APPS → rail PAYMENT_APP; WITHDRAWAL/DEPOSIT → form CASH;
 *      CRYPTO → venue EXCHANGE; INVESTMENT_AND_RETIREMENT_FUNDS → venue BROKERAGE;
 *      ACCOUNT_TRANSFER/SAVINGS → venue DEPOSITORY.
 *  - NO primary-only fallback: a bare TRANSFER_IN/OUT primary does NOT prove a
 *    venue (it could be a payment app, crypto, brokerage, or cash), so absent a
 *    detailed code we return honest UNKNOWN evidence with an explicit reason.
 *
 * Dataset note (why the adapter is honest about missing detail; live counts from
 * the dry-run over 577 flowType = TRANSFER rows):
 *  - ALL Plaid rows whose pfcPrimary is TRANSFER_IN/TRANSFER_OUT carry a detailed
 *    PFC code — 449 rows, every one recognized by this adapter.
 *  - 128 flowType = TRANSFER rows lack a detailed PFC code and get NO adapter
 *    signal (UNKNOWN evidence → axes left unset). Those split into 89 Plaid-sourced
 *    rows classified TRANSFER by category with no PFC detail, and 39 genuinely
 *    non-Plaid/imported rows.
 * So it is NOT true that every canonical TRANSFER row has detailed evidence, and
 * "lacks detail" is not the same as "non-Plaid".
 *
 * Adding another provider (Coinbase, Schwab, a wallet, a CSV mapping, manual
 * entry) means writing a SIBLING adapter that emits TransferEvidence — the
 * canonical derivation and everything downstream stay untouched.
 */

import type {
  MovementDirection,
  TransferEvidence,
  TransferRail,
  MovementForm,
  TransferVenue,
} from "@/lib/transactions/transfer-evidence";

/** Explicit adapter/mapping version — bump on any mapping change (replayability).
 *  2 = CF-P1: a known payment-app brand name (Apple Cash, …) names the RAIL and
 *      overrides Plaid's generic ACCOUNT_TRANSFER→venue=DEPOSITORY mapping, so
 *      outbound payment-app sends stop resolving as external bank transfers. */
export const PLAID_TRANSFER_ADAPTER_VERSION = "plaid-transfer/2";

/**
 * Curated, EXACT known-payment-app brand tokens — an ALLOWLIST, not a broad
 * merchant-name heuristic. A match identifies the movement's RAIL (how the money
 * moved), NEVER its purpose (gift/reimbursement/income/spending stay unknown —
 * doctrine: rail ≠ purpose). It is consulted ONLY to override Plaid's generic
 * ACCOUNT_TRANSFER→DEPOSITORY mapping (or a no/unrecognized signal): Plaid files
 * some payment-app sends (notably Apple Cash outbound) under the generic account-
 * transfer detailed, which — being a VENUE — would rank above the rail and hide
 * the app. Extend only with unambiguous payment-app brands.
 */
const PAYMENT_APP_NAME_TOKENS = ["APPLE CASH", "CASH APP", "CASHAPP", "VENMO", "PAYPAL", "ZELLE"];

function isKnownPaymentApp(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toUpperCase();
  return PAYMENT_APP_NAME_TOKENS.some((t) => n.includes(t));
}

/** One recognized Plaid detailed-code family → exactly one evidence axis + reason. */
type FamilyMapping = {
  railType?:     TransferRail;
  movementForm?: MovementForm;
  venueClass?:   TransferVenue;
  reason:        string;
};

/** Exact family → axis map. Keys are the family token AFTER prefix stripping. */
const FAMILY_MAP: Record<string, FamilyMapping> = {
  FROM_APPS:                       { railType: "PAYMENT_APP", reason: "plaid:from_apps→rail=payment_app" },
  WITHDRAWAL:                      { movementForm: "CASH",    reason: "plaid:withdrawal→form=cash" },
  DEPOSIT:                         { movementForm: "CASH",    reason: "plaid:deposit→form=cash" },
  CRYPTO:                          { venueClass: "EXCHANGE",  reason: "plaid:crypto→venue=exchange" },
  INVESTMENT_AND_RETIREMENT_FUNDS: { venueClass: "BROKERAGE", reason: "plaid:investment_retirement→venue=brokerage" },
  ACCOUNT_TRANSFER:                { venueClass: "DEPOSITORY", reason: "plaid:account_transfer→venue=depository" },
  SAVINGS:                         { venueClass: "DEPOSITORY", reason: "plaid:savings→venue=depository" },
};

/** Strip only leading TRANSFER_IN_/TRANSFER_OUT_ prefixes (handles Plaid's doubled
 *  artifact) to yield the family token; inner "_TRANSFER" tokens are preserved. */
function transferFamily(pfcDetailed: string): string {
  let s = pfcDetailed.toUpperCase();
  while (s.startsWith("TRANSFER_IN_") || s.startsWith("TRANSFER_OUT_")) {
    s = s.startsWith("TRANSFER_IN_") ? s.slice("TRANSFER_IN_".length) : s.slice("TRANSFER_OUT_".length);
  }
  return s;
}

/** Direction from the Fourth-Meridian-signed amount (positive = inflow). */
function directionFromAmount(amount: number): MovementDirection | undefined {
  if (amount > 0) return "IN";
  if (amount < 0) return "OUT";
  return undefined;
}

/**
 * Adapt a Plaid transaction's transfer signal into provider-neutral evidence.
 * `pfcDetailed` is Plaid's personal_finance_category.detailed; `amount` is the
 * Fourth-Meridian-signed amount (already sign-flipped at ingestion). Feed the
 * result to deriveTransferDisposition() with any canonical relationship context.
 */
export function plaidTransferEvidence(input: {
  pfcDetailed: string | null | undefined;
  amount:      number;
  /** Raw merchant/descriptor — consulted ONLY to recognize a known payment-app rail
   *  (CF-P1). Never used for purpose. Optional so existing callers stay valid. */
  name?:       string | null;
}): TransferEvidence {
  const direction = directionFromAmount(input.amount);
  const base = { direction, source: "plaid", version: PLAID_TRANSFER_ADAPTER_VERSION };

  const mapping = input.pfcDetailed ? FAMILY_MAP[transferFamily(input.pfcDetailed)] : undefined;

  // CF-P1 — a known payment-app brand names the RAIL. It overrides ONLY the generic
  // depository venue (ACCOUNT_TRANSFER/SAVINGS) or a no/unrecognized signal — never
  // CASH/CRYPTO/BROKERAGE, and never the explicit FROM_APPS rail (already correct).
  const genericOrNone = !mapping || mapping.venueClass === "DEPOSITORY";
  if (genericOrNone && isKnownPaymentApp(input.name)) {
    return { ...base, railType: "PAYMENT_APP", evidenceConfidence: 1, reason: "plaid:payment_app_name→rail=payment_app" };
  }

  if (!input.pfcDetailed) {
    return { ...base, evidenceConfidence: 0, reason: "plaid:no_signal" };
  }
  if (!mapping) {
    return { ...base, evidenceConfidence: 0, reason: "plaid:unrecognized_detailed" };
  }
  const { reason, ...axes } = mapping;
  // 1.0 = fully confident in THIS adapter translation (an exact deterministic
  // family match), NOT confidence about the movement's purpose or economic meaning.
  return { ...base, ...axes, evidenceConfidence: 1, reason };
}
