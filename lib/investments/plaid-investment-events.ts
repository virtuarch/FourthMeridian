/**
 * lib/investments/plaid-investment-events.ts
 *
 * A3-2 — pure stage-1 adapter: Plaid InvestmentTransaction → canonical
 * InvestmentEvent write shape. PURE, deterministic, total (every one of the
 * 6 types × 48 subtypes yields a canonical type; UNKNOWN is a valid output,
 * silence is not). No Prisma, no I/O, no Date.now, no env reads, no globals.
 * Provider strings are preserved verbatim and never leak into canonical
 * semantics. See FOURTH_MERIDIAN_A3_INVESTMENT_EVENT_FOUNDATION_INVESTIGATION
 * §5. Never throws, never drops — an unrecognized input maps to UNKNOWN with
 * every raw field intact.
 */

import type { InvestmentTransaction } from "plaid";
import { InvestmentEventType } from "@prisma/client";
import { parsePlaidDate } from "@/lib/investments/position-capture";

/** Stage-1 adapter version — bump when the type/subtype mapping changes. */
export const MAPPER_VERSION = 1;

export const PLAID_EVENT_SOURCE = "plaid";

/** Canonical event write shape (account/instrument/import ids are set by the ingest layer). */
export interface MappedInvestmentEvent {
  type:               InvestmentEventType;
  date:               Date;
  datetime:           Date | null;
  quantity:           number | null;
  price:              number | null;
  amount:             number | null;
  fees:               number | null;
  currency:           string | null;
  source:             string;
  externalEventId:    string;
  providerType:       string;
  providerSubtype:    string;
  providerSecurityId: string | null;
  description:        string;
  mapperVersion:      number;
}

/**
 * Classify (raw Plaid type, subtype) → canonical InvestmentEventType.
 * Deterministic and total. `cancel` is a Plaid *type* (its subtype echoes the
 * cancelled row's), so it is matched first. Sign-ambiguous subtypes (`trade`,
 * `transfer`/`send`/`stock distribution`, `contribution`) resolve by quantity
 * sign / presence of a security. Any unrecognized subtype → UNKNOWN.
 */
export function classifyInvestmentEventType(input: {
  type: string;
  subtype: string;
  quantity: number;
  amountFm: number;
  hasSecurity: boolean;
}): InvestmentEventType {
  const T = InvestmentEventType;
  const type = input.type.toLowerCase();
  const subtype = input.subtype.toLowerCase();

  // `cancel` type negates a prior row regardless of its echoed subtype.
  if (type === "cancel") return T.CANCEL;

  switch (subtype) {
    // ── sign-ambiguous ─────────────────────────────────────────────────────
    case "trade":
      return input.quantity > 0 ? T.BUY : input.quantity < 0 ? T.SELL : T.ADJUSTMENT;
    case "contribution":
      // With a security it is a purchase from contributed cash; cash-only is external funding.
      return input.hasSecurity ? T.BUY : T.CONTRIBUTION;
    case "transfer":
    case "send":
    case "stock distribution": {
      // In-kind: sign by quantity. Cash-only (no security): sign by FM amount.
      const signedBy = input.hasSecurity && input.quantity !== 0 ? input.quantity : input.amountFm;
      return signedBy >= 0 ? T.TRANSFER_IN : T.TRANSFER_OUT;
    }

    // ── acquisitions ───────────────────────────────────────────────────────
    case "buy":
    case "buy to cover":
      return T.BUY;

    // ── disposals (incl. option exercise/assignment dispositions) ──────────
    case "sell":
    case "sell short":
    case "exercise":
    case "assignment":
      return T.SELL;

    // ── reinvestments (cash + quantity legs) ───────────────────────────────
    case "dividend reinvestment":
    case "interest reinvestment":
    case "long-term capital gain reinvestment":
    case "short-term capital gain reinvestment":
      return T.REINVESTMENT;

    // ── external cash in / out ─────────────────────────────────────────────
    case "deposit":
      return T.CONTRIBUTION;
    case "withdrawal":
    case "request":
    case "distribution":
      return T.WITHDRAWAL;

    // ── income ─────────────────────────────────────────────────────────────
    case "dividend":
    case "qualified dividend":
    case "non-qualified dividend":
      return T.DIVIDEND;
    case "interest":
    case "interest receivable":
      return T.INTEREST;
    case "long-term capital gain":
    case "short-term capital gain":
    case "unqualified gain":
      return T.CAPITAL_GAIN;

    // ── tax ────────────────────────────────────────────────────────────────
    case "tax":
    case "tax withheld":
    case "non-resident tax":
      return T.TAX;

    // ── provisional cash movements (no pending flag exists — do not fabricate) ─
    case "pending credit":
    case "pending debit":
      return T.ADJUSTMENT;

    // ── fees (always a cost) ───────────────────────────────────────────────
    case "account fee":
    case "management fee":
    case "fund fee":
    case "legal fee":
    case "transfer fee":
    case "trust fee":
    case "miscellaneous fee":
    case "margin expense":
      return T.FEE;

    // ── corporate actions (distinct — A4 treats them differently) ──────────
    case "split":
      return T.SPLIT;
    case "merger":
      return T.MERGER;
    case "spin off":
      return T.SPIN_OFF;

    // ── position/cash effects with no cleaner semantics ───────────────────
    case "adjustment":
    case "rebalance":
    case "loan payment":
    case "return of principal":
    case "expire":
      return T.ADJUSTMENT;

    // ── unrecognized / future Plaid additions ─────────────────────────────
    default:
      return T.UNKNOWN;
  }
}

/**
 * Map a Plaid InvestmentTransaction to the canonical event write shape.
 * Sign normalization: amount_fm = −plaid amount (FM: + cash in / − cash out);
 * quantity sign passed through (Plaid's +buy/−sell already = +units in);
 * fees → absolute; currency = iso ?? unofficial. Raw fields preserved verbatim.
 * Pure-cash rows (no security) carry a null quantity (MC1: null = not applicable
 * unit) — cash routing is by `currency`.
 */
export function mapPlaidInvestmentTransactionToEvent(txn: InvestmentTransaction): MappedInvestmentEvent {
  const amountFm = -txn.amount;
  const hasSecurity = txn.security_id != null;
  const type = classifyInvestmentEventType({
    type: txn.type, subtype: txn.subtype, quantity: txn.quantity, amountFm, hasSecurity,
  });
  return {
    type,
    date:               parsePlaidDate(txn.date) ?? new Date(NaN),
    datetime:           txn.transaction_datetime ? new Date(txn.transaction_datetime) : null,
    // Units only meaningful with a security; pure-cash rows route by currency.
    quantity:           hasSecurity ? txn.quantity : null,
    price:              txn.price,
    amount:             amountFm,
    fees:               txn.fees == null ? null : Math.abs(txn.fees),
    currency:           txn.iso_currency_code ?? txn.unofficial_currency_code ?? null,
    source:             PLAID_EVENT_SOURCE,
    externalEventId:    txn.investment_transaction_id,
    providerType:       txn.type,
    providerSubtype:    txn.subtype,
    providerSecurityId: txn.security_id ?? null,
    description:        txn.name,
    mapperVersion:      MAPPER_VERSION,
  };
}
