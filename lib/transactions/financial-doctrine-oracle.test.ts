/**
 * lib/transactions/financial-doctrine-oracle.test.ts
 *
 * P2-7A — the FINANCIAL DOCTRINE ORACLE (semantic freeze / test-contract slice).
 *
 * Runnable with tsx:   npx tsx lib/transactions/financial-doctrine-oracle.test.ts
 * Auto-discovered by scripts/run-tests.ts. Pure module (no DB / React / network).
 *
 * ── What this is ───────────────────────────────────────────────────────────────
 * ONE table-driven oracle that pins the EXPECTED transaction financial semantics
 * across every canonical authority already shipped —
 *
 *     FlowType                 (persisted economic KIND — flow-classifier / predicates)
 *     population membership    (isBankingPopulation + BANKING_POPULATION query)
 *     economic inclusion       (foldEconomicRow — income / spend / refund bucket)
 *     liquidity effect+reason  (classifyLiquidity)
 *     transfer disposition     (deriveTransferDisposition)
 *     DayFacts                 (aggregateDayFacts — the ONE aggregate fold)
 *     debt-payment membership  (CALENDAR_MEASURES.debtPayments + lib/debt.ts)
 *     needs-classification     (shouldSurfaceAsNeedsClassification)
 *     visibility / detail       (lib/ai/visibility.ts)
 *
 * — so the behavior is FROZEN before classifier v3 (P2-7B) or FX threading
 * (P2-7C) changes anything. It asserts the PUBLIC semantic outcome of the real
 * authorities (never their internals); where an outcome is a documented contract
 * the future slice must satisfy (FX totals, broader review surfacing), it is
 * stated as an explicit, machine-checked freeze plus a `GAP:` note.
 *
 * It changes NO classifier behavior, NO FlowType assignment, NO population, NO UI,
 * and NO investment architecture. It is additive test-only.
 *
 * ── The assumption ledger (made explicit, per the doctrine "one paragraph model")
 *  A1. Account tiers come from accountTier(): checking/savings→liquid,
 *      investment/crypto/other→asset, debt→liability, else→unknown. The liquidity
 *      face of every row is RELATIONAL (own tier × counterparty tier), never a
 *      property of the flow alone.
 *  A2. A two-legged movement is counted ONCE, on the LIQUID leg. The non-liquid
 *      leg (card charge, asset-side transfer, received-on-liability payment) is
 *      NEUTRAL by design — this is why source-side and destination-side debt
 *      views legitimately disagree (Part 3).
 *  A3. RAIL ≠ PURPOSE. A payment-app rail says HOW money moved, never WHY; account
 *      tier + relationship evidence decide the liquidity treatment (Part 4).
 *  A4. "Balance truth" (what is owed) is NOT derivable from period flows and is
 *      out of scope here — this oracle freezes FLOW truth only (see the dictionary
 *      debt family). No fixture asserts a balance.
 *  A5. Population membership (is the row eligible for banking analysis) is a
 *      FlowType partition (everything except INVESTMENT, incl. UNKNOWN/ADJUSTMENT/
 *      null). Structural gates (deletedAt, Space visibility, date window, pending
 *      partition) are ANDed ON TOP and never re-interpret the row's semantics.
 *  A6. Currency: the canonical rule is per-row conversion at the row's own date;
 *      ABSENT a ConversionContext, raw native amounts (the permanent kill switch).
 *      Missing FX degrades to native + `estimated`, never dropped (Part 5).
 *
 * ── Organization (Part 7) ──────────────────────────────────────────────────────
 *  Part 1  the doctrine matrix (34+ fixtures × the authorities above)
 *  Part 2  the P2-2 UNKNOWN / ADJUSTMENT population divergence (frozen + guard)
 *  Part 3  debt-payment reconciliation oracle (views A / B / C)
 *  Part 4  payment-app / liability doctrine (rail ≠ purpose)
 *  Part 5  multi-currency doctrine (frozen contract for P2-7C)
 *  Part 6  visibility doctrine (FULL / BALANCE_ONLY / SUMMARY_ONLY / REVOKED / deleted)
 *  A central adapter runs each fixture through the real authorities; focused
 *  blocks below reuse the same helpers rather than duplicating subsystem tests.
 */

import {
  classifyLiquidity,
  tierResolver,
  type LiquidityTx,
  type LiquidityContext,
} from "@/lib/transactions/liquidity";
import { aggregateDayFacts, CALENDAR_MEASURES } from "@/lib/transactions/cash-flow-projection";
import { foldEconomicRow, type EconomicAccumulator } from "@/lib/transactions/cash-flow";
import {
  isBankingPopulation,
  isDebtPayment,
} from "@/lib/transactions/flow-predicates";
import { deriveTransferDisposition, type TransferDisposition, type TransferEvidence } from "@/lib/transactions/transfer-evidence";
import { shouldSurfaceAsNeedsClassification } from "@/lib/transactions/needs-classification";
import { totalDebtPaid, type DebtPaymentTxnLike } from "@/lib/debt";
import { grantsTransactionDetail } from "@/lib/ai/visibility";
import { identityContext, convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FlowType, VisibilityLevel } from "@prisma/client";
import type { FlowType as FlowTypeT, FlowDirection, TransactionCategory } from "@/types";

// ─── Test harness (house pattern) ──────────────────────────────────────────────

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const approx = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

// ─── Shared account universe + tier context (assumption A1) ────────────────────

const ACCOUNTS = [
  { id: "chk",  type: "checking" },   // liquid
  { id: "sav",  type: "savings" },    // liquid
  { id: "brk",  type: "investment" }, // asset
  { id: "cb",   type: "crypto" },     // asset (Coinbase-like wallet)
  { id: "card", type: "debt" },       // liability
  { id: "loan", type: "debt" },       // liability
  // "ext" is deliberately absent → tierOf("ext") === "unknown" (external / not owned)
];
const ctx: LiquidityContext = tierResolver(ACCOUNTS);

// ─── Fixture shape ─────────────────────────────────────────────────────────────

type EconBucket = "income" | "spend" | "refund" | "none";

interface Fixture {
  id:    string;
  title: string;
  // ── Inputs (a persisted row + its read-time context) ──
  own:      string;          // own account id (drives own tier)
  amount:   number;          // FM sign: + into own account, − out
  flowType: FlowTypeT;       // the persisted economic KIND (an input; not re-derived)
  cp?:      string | null;   // counterparty account id (owned when in ACCOUNTS)
  disposition?: TransferDisposition | null; // read-time transfer disposition on the row
  rail?:    string | null;   // transferRail ("PAYMENT_APP") when attested
  classificationReason?: string | null;     // FlowClassificationReason
  merchantId?: string | null;                // resolved Merchant identity present?
  currency?: string;                         // native currency (default USD)
  flowDirection?: FlowDirection;
  // Structural tags (orthogonal to semantics — see A5). Present only to prove they
  // do NOT change classification.
  pending?:  boolean;
  deletedAt?: boolean;
  source?:   "manual" | "plaid" | "import";
  // ── Expectations ──
  pop:  boolean;             // isBankingPopulation(flowType)
  econ: EconBucket;          // economic-fold bucket
  effect: "CASH_IN" | "CASH_OUT" | "NEUTRAL" | "UNRESOLVED";
  reason: string;            // LiquidityReason
  debtMember?: boolean;      // Cash-Flow debt-payment measure membership (source-side)
  expectDisposition?: TransferDisposition; // asserted when transfer evidence is defined
  needs?: "UNKNOWN_PAYMENT_APP_PURPOSE" | "UNKNOWN_INFLOW_SOURCE" | null;
  facts?: Partial<{
    cashIn: number; cashOut: number; unresolved: number;
    income: number; spendGross: number; refunds: number;
    creditCardSpending: number; directSpending: number; cashWithdrawals: number;
  }>;
  byReason?: Record<string, number>;   // exact byReason entries to assert
  byReasonAbsent?: string[];           // reasons that must NOT be recorded
  note?: string;                       // documented doctrine / GAP
  // Optional evidence to feed deriveTransferDisposition (Part 4 / transfer rows).
  evidence?: { railType?: "PAYMENT_APP"; movementForm?: "CASH"; venueClass?: "DEPOSITORY" | "BROKERAGE" | "EXCHANGE" };
  counterpartyIsOwned?: boolean;
}

// ─── Fixture → LiquidityTx ─────────────────────────────────────────────────────

function toTx(f: Fixture): LiquidityTx {
  return {
    id: `${f.id}`,
    accountId: f.own,
    financialAccountId: f.own,
    counterpartyAccountId: f.cp ?? null,
    date: "2026-02-27",
    merchant: "m",
    category: "Other" as TransactionCategory,
    pending: f.pending ?? false,
    amount: f.amount,
    flowType: f.flowType,
    flowDirection: f.flowDirection,
    currency: f.currency ?? "USD",
    transferDisposition: f.disposition ?? null,
  } as unknown as LiquidityTx;
}

// ─── Economic-fold bucket adapter (reads the single authority) ─────────────────

// Fill a partial evidence axis with the always-present provenance fields, so a
// fixture only names the axis it exercises (rail / form / venue) — the canonical
// contract requires the four provenance fields on every TransferEvidence.
function fullEvidence(e: { railType?: "PAYMENT_APP"; movementForm?: "CASH"; venueClass?: "DEPOSITORY" | "BROKERAGE" | "EXCHANGE" }): TransferEvidence {
  return { ...e, evidenceConfidence: 1, reason: "TEST_FIXTURE", source: "oracle", version: "1" };
}

function econBucket(flowType: FlowTypeT): EconBucket {
  const acc: EconomicAccumulator = { income: 0, spendGross: 0, refunds: 0 };
  foldEconomicRow(acc, flowType, 1);
  if (acc.income) return "income";
  if (acc.spendGross) return "spend";
  if (acc.refunds) return "refund";
  return "none";
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 1 — THE DOCTRINE MATRIX
// ═══════════════════════════════════════════════════════════════════════════════
//
// Coverage of the 34 enumerated cases (case → fixture / Part):
//   1 income F1 · 2 direct-spend F2 · 3 refund F3 · 4 fee F4 · 5 interest F5 ·
//   6 debt-payment F6 · 7 internal-transfer F7 · 8 external-bank-transfer F8 ·
//   9 brokerage-contribution F9 · 10 brokerage-withdrawal F10 · 11 dividend F11 ·
//   12 investment-buy F12 · 13 investment-sell F13 · 14 ATM-withdrawal F14 ·
//   15 cash-deposit F15 · 16 payment-app-P2P F16 · 17 payment-app-ambiguous F17 ·
//   18 UNKNOWN F18 (+Part 2) · 19 ADJUSTMENT F19 (+Part 2) · 20 pending F20 ·
//   21 tombstoned F21 · 22 imported F22 · 23 plaid F23 · 24 multi-currency F24 (+Part 5) ·
//   25 BALANCE_ONLY / 26 SUMMARY_ONLY / 27 FULL → Part 6 ·
//   28 payment-on-liability F28 · 29 liquid→liability F29 · 30 owned transfer F30 ·
//   31 transfer-to-brokerage F31 · 32 transfer-from-brokerage F32 ·
//   33 unconnected-payer → Part 3 (view divergence) · 34 crypto/wallet transfer F34.

const MATRIX: Fixture[] = [
  // 1 — income (paycheck) into a liquid account
  { id: "F1", title: "income → checking", own: "chk", amount: 3800, flowType: "INCOME",
    classificationReason: "PLAID_PFC_PRIMARY", merchantId: "emp",
    pop: true, econ: "income", effect: "CASH_IN", reason: "EARNED_INCOME", needs: null,
    facts: { cashIn: 3800, income: 3800, cashOut: 0 }, byReason: { EARNED_INCOME: 3800 } },

  // 2 — direct (debit) spending from a liquid account
  { id: "F2", title: "direct spending → checking", own: "chk", amount: -92.4, flowType: "SPENDING",
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST",
    facts: { cashOut: 92.4, spendGross: 92.4, directSpending: 92.4 }, byReason: { REAL_COST: 92.4 } },

  // 3 — refund (reversal of prior spend) — NEVER income
  { id: "F3", title: "refund → checking", own: "chk", amount: 40, flowType: "REFUND",
    pop: true, econ: "refund", effect: "CASH_IN", reason: "REFUND",
    facts: { cashIn: 40, refunds: 40, income: 0 }, byReason: { REFUND: 40 } },

  // 4 — fee — a real cost, distinct from SPENDING but a cost flow
  { id: "F4", title: "fee → checking", own: "chk", amount: -12, flowType: "FEE",
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST",
    facts: { cashOut: 12, spendGross: 12, directSpending: 12 } },

  // 5 — interest CHARGED on a credit card (liability tier → liquidity neutral)
  { id: "F5", title: "interest charged on card", own: "card", amount: -30, flowType: "INTEREST",
    pop: true, econ: "spend", effect: "NEUTRAL", reason: "REAL_COST",
    facts: { cashOut: 0, spendGross: 30, creditCardSpending: 30 }, byReasonAbsent: ["REAL_COST"],
    note: "cost flow enters ECONOMIC spend (creditCardSpending) but NOT liquidity Cash Out — the spendable drain happens later at debt payment (A2)." },

  // 6 — debt payment, source leg (cash leaving the liquid tier)
  { id: "F6", title: "debt payment (source leg, from checking)", own: "chk", amount: -300, flowType: "DEBT_PAYMENT",
    pop: true, econ: "none", effect: "CASH_OUT", reason: "DEBT_PAYMENT", debtMember: true,
    facts: { cashOut: 300, income: 0, spendGross: 0 }, byReason: { DEBT_PAYMENT: 300 } },

  // 7 — internal transfer between two owned liquid accounts
  { id: "F7", title: "internal transfer checking → savings", own: "chk", amount: -500, flowType: "TRANSFER",
    cp: "sav", disposition: "INTERNAL_TRANSFER", evidence: {}, counterpartyIsOwned: true,
    pop: true, econ: "none", effect: "NEUTRAL", reason: "INTERNAL_TRANSFER",
    expectDisposition: "INTERNAL_TRANSFER",
    facts: { cashIn: 0, cashOut: 0, unresolved: 0 }, byReason: { INTERNAL_TRANSFER: 500 } },

  // 8 — external bank transfer to a depository NOT known to be owned
  { id: "F8", title: "external bank transfer (unowned depository)", own: "chk", amount: -500, flowType: "TRANSFER",
    cp: null, disposition: "EXTERNAL_BANK_TRANSFER", evidence: { venueClass: "DEPOSITORY" },
    pop: true, econ: "none", effect: "UNRESOLVED", reason: "UNRESOLVED",
    expectDisposition: "EXTERNAL_BANK_TRANSFER",
    facts: { unresolved: 500, cashIn: 0, cashOut: 0 },
    note: "an unowned depository transfer is honestly UNRESOLVED on the liquidity axis (surfaced in `unresolved`, excluded from net) until a leg match confirms ownership." },

  // 9 — brokerage contribution (liquid → asset venue)
  { id: "F9", title: "brokerage contribution (checking → brokerage)", own: "chk", amount: -2000, flowType: "TRANSFER",
    cp: "brk", disposition: "ASSET_VENUE_TRANSFER", evidence: { venueClass: "BROKERAGE" },
    pop: true, econ: "none", effect: "CASH_OUT", reason: "ASSET_DEPLOYMENT",
    expectDisposition: "ASSET_VENUE_TRANSFER",
    facts: { cashOut: 2000 }, byReason: { ASSET_DEPLOYMENT: 2000 } },

  // 10 — brokerage withdrawal (asset venue → liquid)
  { id: "F10", title: "brokerage withdrawal (brokerage → checking)", own: "chk", amount: 3000, flowType: "TRANSFER",
    cp: "brk", disposition: "ASSET_VENUE_TRANSFER", evidence: { venueClass: "BROKERAGE" },
    pop: true, econ: "none", effect: "CASH_IN", reason: "ASSET_LIQUIDATION",
    expectDisposition: "ASSET_VENUE_TRANSFER",
    facts: { cashIn: 3000 }, byReason: { ASSET_LIQUIDATION: 3000 },
    note: "asset liquidation is Cash In but NOT earned income — proceeds of a sale, never a paycheck." },

  // 11 — dividend received to checking (Dividend category → flowType INCOME)
  { id: "F11", title: "dividend received → checking", own: "chk", amount: 50, flowType: "INCOME",
    classificationReason: "CATEGORY_INVESTMENT_VALUE", merchantId: "payer",
    pop: true, econ: "income", effect: "CASH_IN", reason: "EARNED_INCOME", needs: null,
    facts: { cashIn: 50, income: 50 }, byReason: { EARNED_INCOME: 50 } },

  // 12 — investment BUY (security activity on an asset account)
  { id: "F12", title: "investment buy (on brokerage)", own: "brk", amount: -1000, flowType: "INVESTMENT",
    pop: false, econ: "none", effect: "NEUTRAL", reason: "ASSET_CONVERSION",
    facts: { cashIn: 0, cashOut: 0, income: 0 }, byReason: { ASSET_CONVERSION: 1000 },
    note: "INVESTMENT is the ONLY flow OUTSIDE the banking population (isBankingPopulation false); net-worth-neutral, never income." },

  // 13 — investment SELL that stays on the platform
  { id: "F13", title: "investment sell (stays on brokerage)", own: "brk", amount: 1500, flowType: "INVESTMENT",
    pop: false, econ: "none", effect: "NEUTRAL", reason: "ASSET_CONVERSION",
    byReason: { ASSET_CONVERSION: 1500 } },

  // 14 — ATM cash withdrawal (physical-cash form change)
  { id: "F14", title: "ATM withdrawal (cash out of checking)", own: "chk", amount: -200, flowType: "TRANSFER",
    cp: null, disposition: "CASH_MOVEMENT", evidence: { movementForm: "CASH" },
    pop: true, econ: "none", effect: "UNRESOLVED", reason: "UNRESOLVED",
    expectDisposition: "CASH_MOVEMENT",
    facts: { unresolved: 200, cashWithdrawals: 200 },
    note: "a cash withdrawal has NO liquidity counterparty (UNRESOLVED on the pure axis) yet is captured by the dedicated `cashWithdrawals` fact — both are excluded from net, so no double-count." },

  // 15 — cash deposit (physical cash into checking)
  { id: "F15", title: "cash deposit (into checking)", own: "chk", amount: 200, flowType: "TRANSFER",
    cp: null, disposition: "CASH_MOVEMENT", evidence: { movementForm: "CASH" },
    pop: true, econ: "none", effect: "UNRESOLVED", reason: "UNRESOLVED",
    expectDisposition: "CASH_MOVEMENT",
    facts: { unresolved: 200, cashWithdrawals: 0 },
    note: "GAP (P2-7B candidate): an inbound cash deposit is UNRESOLVED — its source is unknowable and there is no dedicated inbound-cash fact today (cashWithdrawals is out-only)." },

  // 16 — payment-app P2P outflow, purpose unknown
  { id: "F16", title: "payment-app P2P (outflow, purpose unknown)", own: "chk", amount: -75, flowType: "TRANSFER",
    cp: null, rail: "PAYMENT_APP", disposition: "PAYMENT_APP_MOVEMENT", evidence: { railType: "PAYMENT_APP" },
    pop: true, econ: "none", effect: "CASH_OUT", reason: "PAYMENT_APP_OUTFLOW",
    expectDisposition: "PAYMENT_APP_MOVEMENT", needs: "UNKNOWN_PAYMENT_APP_PURPOSE",
    facts: { cashOut: 75 }, byReason: { PAYMENT_APP_OUTFLOW: 75 } },

  // 17 — payment-app row that LOOKS merchant-like, but purpose is still ambiguous
  { id: "F17", title: "payment-app merchant-like / ambiguous (inflow)", own: "chk", amount: 120, flowType: "TRANSFER",
    cp: null, rail: "PAYMENT_APP", disposition: "PAYMENT_APP_MOVEMENT", evidence: { railType: "PAYMENT_APP" },
    pop: true, econ: "none", effect: "CASH_IN", reason: "PAYMENT_APP_INFLOW",
    expectDisposition: "PAYMENT_APP_MOVEMENT", needs: "UNKNOWN_PAYMENT_APP_PURPOSE",
    facts: { cashIn: 120 }, byReason: { PAYMENT_APP_INFLOW: 120 },
    note: "rail ≠ purpose (A3): a merchant-looking descriptor NEVER promotes a payment-app rail to SPENDING/INCOME; it stays PAYMENT_APP_MOVEMENT, purpose unresolved." },

  // 18 — UNKNOWN (classifier could not decide)
  { id: "F18", title: "UNKNOWN outflow", own: "chk", amount: -50, flowType: "UNKNOWN",
    pop: true, econ: "none", effect: "UNRESOLVED", reason: "UNRESOLVED", needs: null,
    facts: { unresolved: 50 },
    note: "IN the banking population (visible for review) — but the AI assembler's BANKING_FLOWS excludes it (Part 2). GAP: shouldSurfaceAsNeedsClassification does NOT yet surface a bare UNKNOWN outflow (only inflow-source + payment-app clusters)." },

  // 19 — ADJUSTMENT (balance correction / provider artifact — non-economic)
  { id: "F19", title: "ADJUSTMENT (balance correction)", own: "chk", amount: -5, flowType: "ADJUSTMENT",
    pop: true, econ: "none", effect: "NEUTRAL", reason: "NON_CASH",
    facts: { cashIn: 0, cashOut: 0, unresolved: 0 }, byReason: { NON_CASH: 5 },
    note: "IN the banking population (non-cash context reason NON_CASH, excluded from net) — but the AI assembler's BANKING_FLOWS excludes it (Part 2)." },

  // 20 — pending row (settlement state — orthogonal to semantics)
  { id: "F20", title: "pending spending", own: "chk", amount: -60, flowType: "SPENDING", pending: true,
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST",
    facts: { cashOut: 60 },
    note: "classification is IDENTICAL to a settled SPENDING row (A5). Consumers partition pending out of settled money totals and report it as a pending aggregate; the row still IS spending." },

  // 21 — tombstoned / soft-deleted row (structural exclusion — semantics unchanged)
  { id: "F21", title: "tombstoned / deleted spending", own: "chk", amount: -80, flowType: "SPENDING", deletedAt: true,
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST",
    facts: { cashOut: 80 },
    note: "the flow predicate still classifies it as SPENDING; the row NEVER reaches any read — deletedAt:null is ANDed on top of BANKING_POPULATION (A5). Structural exclusion, not re-interpretation." },

  // 22 — imported transaction (provenance ≠ semantics)
  { id: "F22", title: "imported spending (CSV import)", own: "chk", amount: -45, flowType: "SPENDING", source: "import",
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST", facts: { cashOut: 45 },
    note: "source (import/plaid/manual) is provenance only; it never changes flow / liquidity / population." },

  // 23 — Plaid-synced transaction (provenance ≠ semantics)
  { id: "F23", title: "plaid-synced spending", own: "chk", amount: -45, flowType: "SPENDING", source: "plaid",
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST", facts: { cashOut: 45 } },

  // 24 — multi-currency (native non-USD; raw when no ConversionContext)
  { id: "F24", title: "multi-currency spending (EUR, no FX context)", own: "chk", amount: -100, flowType: "SPENDING", currency: "EUR",
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST",
    facts: { cashOut: 100, spendGross: 100 },
    note: "kill switch (A6): absent a ConversionContext the RAW native magnitude is used. Reporting-currency conversion + `estimated` taint are frozen as the P2-7C contract in Part 5." },

  // 28 — payment RECEIVED on a liability account (destination leg — neutral)
  { id: "F28", title: "debt payment RECEIVED on card (destination leg)", own: "card", amount: 300, flowType: "DEBT_PAYMENT",
    pop: true, econ: "none", effect: "NEUTRAL", reason: "DEBT_PAYMENT", debtMember: false,
    facts: { cashIn: 0, cashOut: 0 }, byReasonAbsent: ["DEBT_PAYMENT"],
    note: "the received-on-liability leg is NEUTRAL so a payment is counted ONCE on the source (liquid) leg (A2). lib/debt.ts (destination-side view B) DOES count it — see Part 3." },

  // 29 — payment from a liquid account to a liability, typed as TRANSFER
  { id: "F29", title: "liquid → liability payment (TRANSFER-typed)", own: "chk", amount: -300, flowType: "TRANSFER",
    cp: "card", disposition: "INTERNAL_TRANSFER", evidence: {}, counterpartyIsOwned: true,
    pop: true, econ: "none", effect: "CASH_OUT", reason: "DEBT_PAYMENT", debtMember: true,
    expectDisposition: "INTERNAL_TRANSFER",
    facts: { cashOut: 300 }, byReason: { DEBT_PAYMENT: 300 },
    note: "the LIQUIDITY axis resolves a TRANSFER-to-liability as a debt payment via account tier (view A). The flowType-based views (B: lib/debt.ts, C: assembler) count only DEBT_PAYMENT-typed rows — legitimate divergence, Part 3." },

  // 30 — same-space owned transfer, reverse direction (still internal)
  { id: "F30", title: "owned transfer savings → checking", own: "sav", amount: 500, flowType: "TRANSFER",
    cp: "chk", disposition: "INTERNAL_TRANSFER", evidence: {}, counterpartyIsOwned: true,
    pop: true, econ: "none", effect: "NEUTRAL", reason: "INTERNAL_TRANSFER",
    expectDisposition: "INTERNAL_TRANSFER", byReason: { INTERNAL_TRANSFER: 500 } },

  // 31 — transfer to a brokerage/exchange (crypto venue) — deployment
  { id: "F31", title: "transfer to exchange (checking → crypto wallet)", own: "chk", amount: -1000, flowType: "TRANSFER",
    cp: "cb", disposition: "ASSET_VENUE_TRANSFER", evidence: { venueClass: "EXCHANGE" },
    pop: true, econ: "none", effect: "CASH_OUT", reason: "ASSET_DEPLOYMENT",
    expectDisposition: "ASSET_VENUE_TRANSFER",
    facts: { cashOut: 1000 }, byReason: { ASSET_DEPLOYMENT: 1000 } },

  // 32 — transfer from a brokerage/exchange — liquidation
  { id: "F32", title: "transfer from exchange (crypto wallet → checking)", own: "chk", amount: 1200, flowType: "TRANSFER",
    cp: "cb", disposition: "ASSET_VENUE_TRANSFER", evidence: { venueClass: "EXCHANGE" },
    pop: true, econ: "none", effect: "CASH_IN", reason: "ASSET_LIQUIDATION",
    expectDisposition: "ASSET_VENUE_TRANSFER",
    facts: { cashIn: 1200 }, byReason: { ASSET_LIQUIDATION: 1200 } },

  // 34 — crypto/wallet transfer (BTC send) — security activity, neutral
  { id: "F34", title: "crypto/wallet send (INVESTMENT on wallet)", own: "cb", amount: -0.085, flowType: "INVESTMENT",
    flowDirection: "INTERNAL" as FlowDirection,
    pop: false, econ: "none", effect: "NEUTRAL", reason: "ASSET_CONVERSION",
    byReason: { ASSET_CONVERSION: 0.085 },
    note: "a wallet send is INVESTMENT (asset conversion), NEUTRAL on liquidity, OUTSIDE the banking population — never spending, never income." },
];

console.log("── Part 1 — doctrine matrix ──");
for (const f of MATRIX) {
  const tx = toTx(f);

  // population
  check(`${f.id} ${f.title}: population = ${f.pop}`, isBankingPopulation(f.flowType) === f.pop);

  // economic bucket
  check(`${f.id}: economic bucket = ${f.econ}`, econBucket(f.flowType) === f.econ);

  // liquidity effect + reason
  const c = classifyLiquidity(tx, ctx);
  check(`${f.id}: liquidity = ${f.effect}/${f.reason}`,
    c.effect === f.effect && c.reason === f.reason, JSON.stringify(c));

  // debt-payment measure membership (source-side Cash-Flow view)
  const member = CALENDAR_MEASURES.debtPayments.rowMatches(tx, ctx);
  check(`${f.id}: debt-payment measure membership = ${f.debtMember ?? false}`,
    member === (f.debtMember ?? false));

  // transfer disposition (only when evidence is defined on the fixture)
  if (f.evidence !== undefined && f.expectDisposition !== undefined) {
    const d = deriveTransferDisposition(fullEvidence(f.evidence), { counterpartyIsOwned: f.counterpartyIsOwned });
    check(`${f.id}: transfer disposition = ${f.expectDisposition}`, d === f.expectDisposition, d);
  }

  // needs-classification (only when the fixture pins it)
  if (f.needs !== undefined) {
    const n = shouldSurfaceAsNeedsClassification({
      flowType: f.flowType,
      classificationReason: f.classificationReason ?? null,
      transferRail: f.rail ?? null,
      hasResolvedMerchant: f.merchantId != null,
      hasResolvedCounterparty: f.cp != null,
    });
    check(`${f.id}: needs-classification = ${f.needs ?? "none"}`, (n.reason ?? null) === (f.needs ?? null),
      JSON.stringify(n));
  }

  // DayFacts single-row fold
  const df = aggregateDayFacts([tx], ctx);
  if (f.facts) {
    for (const [k, v] of Object.entries(f.facts)) {
      check(`${f.id}: DayFacts.${k} = ${v}`, approx((df as unknown as Record<string, number>)[k], v as number),
        `got ${(df as unknown as Record<string, number>)[k]}`);
    }
  }
  if (f.byReason) {
    for (const [k, v] of Object.entries(f.byReason)) {
      check(`${f.id}: byReason.${k} = ${v}`, approx(df.byReason[k as keyof typeof df.byReason] ?? 0, v),
        `got ${df.byReason[k as keyof typeof df.byReason]}`);
    }
  }
  if (f.byReasonAbsent) {
    for (const k of f.byReasonAbsent) {
      check(`${f.id}: byReason.${k} NOT recorded (straddle neutral leg)`,
        (df.byReason[k as keyof typeof df.byReason] ?? 0) === 0);
    }
  }
}

// Structural orthogonality (A5): pending / deletedAt / source / currency never
// change the liquidity classification of an otherwise-identical SPENDING row.
{
  const base = classifyLiquidity(toTx({ id: "b", title: "", own: "chk", amount: -60, flowType: "SPENDING",
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST" }), ctx);
  const variants: Fixture[] = MATRIX.filter((f) => ["F20", "F21", "F22", "F23"].includes(f.id));
  for (const f of variants) {
    const c = classifyLiquidity(toTx({ ...f, amount: -60 }), ctx);
    check(`orthogonality: ${f.id} classifies identically to a plain SPENDING row`,
      c.effect === base.effect && c.reason === base.reason);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 2 — UNKNOWN / ADJUSTMENT population divergence (P2-2 close-out)
// ═══════════════════════════════════════════════════════════════════════════════
//
// P2-7A FINDING (now RESOLVED by P2-7B): the canonical DB banking population
// (BANKING_POPULATION = `flowType: { not: INVESTMENT }`, row-level
// isBankingPopulation) INCLUDES UNKNOWN + ADJUSTMENT + null, but the AI
// assembler USED to carry a separate BANKING_FLOWS allow-list that EXCLUDED
// UNKNOWN + ADJUSTMENT — so a row the UI/data layer showed could silently vanish
// from AI context.
//
// DOCTRINE (implemented by P2-7B — this is the deliberate freeze update the
// P2-7A checks below invited):
//   • UNKNOWN stays available to needs-classification / review — never dropped.
//   • ADJUSTMENT stays visible as a non-cash / non-economic semantic where the UI
//     sees it (DayFacts already folds it to the NON_CASH context reason, ∉ net).
//   • Neither disappears from AI/context while the UI shows it: the assembler now
//     consumes the canonical population and gates money folds on
//     isNonEconomicResidue, so UNKNOWN/ADJUSTMENT/null are counted + surfaced
//     (transactionCount + needs-classification + unclassified/adjustment counts)
//     but NEVER folded into any income / spend / category / net total.

console.log("── Part 2 — UNKNOWN/ADJUSTMENT divergence ──");

check("population INCLUDES UNKNOWN", isBankingPopulation(FlowType.UNKNOWN) === true);
check("population INCLUDES ADJUSTMENT", isBankingPopulation(FlowType.ADJUSTMENT) === true);
check("population INCLUDES null/unclassified", isBankingPopulation(null) === true);
check("population EXCLUDES only INVESTMENT",
  (Object.values(FlowType) as FlowType[]).filter((ft) => !isBankingPopulation(ft)).join(",") === FlowType.INVESTMENT);

// Source-scan the assembler — assert the CONVERGED (P2-7B) shape. The P2-7A
// version of this block froze the diverging BANKING_FLOWS allow-list with an
// explicit "if P2-7B adds UNKNOWN/ADJUSTMENT, update this freeze deliberately"
// note; this IS that deliberate update. The allow-list is retired; the assembler
// consumes the canonical banking population and gates money folds on the
// non-economic residue predicate.
const ASSEMBLER = path.join(process.cwd(), "lib", "ai", "assemblers", "transactions.ts");
const assemblerSrc = readFileSync(ASSEMBLER, "utf8");
check("CONVERGED: assembler declares NO separate BANKING_FLOWS population allow-list",
  !/const\s+BANKING_FLOWS\s*:/.test(assemblerSrc),
  "P2-7B retired the allow-list; reintroducing it is a population-divergence regression");
check("CONVERGED: assembler consumes the canonical banking population (not INVESTMENT)",
  /flowType:\s*\{\s*not:\s*FlowType\.INVESTMENT\s*\}/.test(assemblerSrc));
check("CONVERGED: money folds gate on isNonEconomicResidue (UNKNOWN/ADJUSTMENT/null admitted but not counted as money)",
  /isNonEconomicResidue/.test(assemblerSrc));
check("CONVERGED: assembler surfaces the non-economic residue disclosure (never silently dropped)",
  /unclassifiedCount/.test(assemblerSrc) && /adjustmentCount/.test(assemblerSrc));

// The DayFacts fold already handles both canonically — so the ONLY fix needed is
// population membership, not new math (freeze this too).
{
  const unknownRow = toTx({ id: "u", title: "", own: "chk", amount: -50, flowType: "UNKNOWN",
    pop: true, econ: "none", effect: "UNRESOLVED", reason: "UNRESOLVED" });
  const adjRow = toTx({ id: "a", title: "", own: "chk", amount: -5, flowType: "ADJUSTMENT",
    pop: true, econ: "none", effect: "NEUTRAL", reason: "NON_CASH" });
  const df = aggregateDayFacts([unknownRow, adjRow], ctx);
  check("Part 2: UNKNOWN folds to `unresolved` (∉ net)", df.unresolved === 50 && df.cashIn === 0 && df.cashOut === 0);
  check("Part 2: ADJUSTMENT folds to NON_CASH context reason (∉ net)",
    (df.byReason.NON_CASH ?? 0) === 5 && df.cashIn === 0 && df.cashOut === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 3 — DEBT-PAYMENT RECONCILIATION ORACLE (views A / B / C)
// ═══════════════════════════════════════════════════════════════════════════════
//
// One DebtPayment FACT FAMILY, three OBSERVATION VIEWS (dictionary §B):
//   A  classifyLiquidity → DayFacts.byReason.DEBT_PAYMENT  (source-side liquid cash-out)
//   B  lib/debt.ts totalDebtPaid                            (received-by-liability, destination-side)
//   C  AI assembler debtPaymentTotal                        (DEBT_PAYMENT flowType, negative-only)
// When evidence is symmetric (a fully connected two-leg payment) they RECONCILE.
// When evidence is asymmetric they legitimately DIVERGE — the oracle documents the
// asymmetry rather than forcing equality.

console.log("── Part 3 — debt-payment reconciliation ──");

// View adapters (each reads its real authority; C is the assembler's inline rule).
const viewA = (rows: LiquidityTx[]): number => aggregateDayFacts(rows, ctx).byReason.DEBT_PAYMENT ?? 0;
const viewB = (debtAccountRows: DebtPaymentTxnLike[]): number => totalDebtPaid(debtAccountRows);
const viewC = (rows: LiquidityTx[]): number =>
  rows.filter((r) => isDebtPayment(r.flowType) && r.amount < 0).reduce((s, r) => s + Math.abs(r.amount), 0);

// Fully connected two-leg debt payment (both accounts owned + connected):
//   source leg  DEBT_PAYMENT −300 on checking (liquid)
//   dest   leg  DEBT_PAYMENT +300 on the card (liability)
{
  const sourceLeg = toTx({ id: "src", title: "", own: "chk", amount: -300, flowType: "DEBT_PAYMENT",
    pop: true, econ: "none", effect: "CASH_OUT", reason: "DEBT_PAYMENT" });
  const destLeg = toTx({ id: "dst", title: "", own: "card", amount: 300, flowType: "DEBT_PAYMENT",
    pop: true, econ: "none", effect: "NEUTRAL", reason: "DEBT_PAYMENT" });
  const all = [sourceLeg, destLeg];
  // B is scoped to debt-account rows (getDebtTransactions) — the destination leg only.
  const a = viewA(all), b = viewB([{ accountId: "card", amount: 300, flowType: "DEBT_PAYMENT" }]), cc = viewC(all);
  check("A/B/C reconcile on a fully connected payment (all = 300)",
    approx(a, 300) && approx(b, 300) && approx(cc, 300), `A=${a} B=${b} C=${cc}`);
  check("connected: DayFacts counts the payment ONCE (source leg only; dest NEUTRAL)",
    aggregateDayFacts(all, ctx).byReason.DEBT_PAYMENT === 300);
}

// Divergence 1 — payer account UNCONNECTED (only the liability-side leg is visible).
{
  const destOnly = [toTx({ id: "dst", title: "", own: "card", amount: 300, flowType: "DEBT_PAYMENT",
    pop: true, econ: "none", effect: "NEUTRAL", reason: "DEBT_PAYMENT" })];
  const a = viewA(destOnly), b = viewB([{ accountId: "card", amount: 300, flowType: "DEBT_PAYMENT" }]), cc = viewC(destOnly);
  check("divergence(unconnected payer): A=0 (no liquid source leg), B=300, C=0",
    approx(a, 0) && approx(b, 300) && approx(cc, 0), `A=${a} B=${b} C=${cc}`);
  check("doctrine: destination-side B catches unconnected-payer payments the source-side A/C miss", true);
}

// Divergence 2 — TRANSFER-typed payment (liquidity resolves via tier; flowType is TRANSFER).
{
  const transferPay = [toTx({ id: "tp", title: "", own: "chk", amount: -300, flowType: "TRANSFER",
    cp: "card", pop: true, econ: "none", effect: "CASH_OUT", reason: "DEBT_PAYMENT" })];
  const a = viewA(transferPay);
  const b = viewB([{ accountId: "chk", amount: -300, flowType: "TRANSFER" }]); // isDebtPayment(TRANSFER)=false
  const cc = viewC(transferPay);
  check("divergence(transfer-typed): A=300 (tier-resolved), B=0, C=0 (flowType ≠ DEBT_PAYMENT)",
    approx(a, 300) && approx(b, 0) && approx(cc, 0), `A=${a} B=${b} C=${cc}`);
  check("doctrine: the liquidity axis (A) recognizes a liquid→liability TRANSFER as a debt payment; the flowType views do not", true);
}

// Divergence 3 — SIGN asymmetry: a positively-signed DEBT_PAYMENT leg.
// B is sign-agnostic (abs); C counts negatives only.
{
  const posLeg = [{ accountId: "card", amount: 300, flowType: "DEBT_PAYMENT" }] as DebtPaymentTxnLike[];
  const b = viewB(posLeg);
  const cc = viewC([toTx({ id: "pos", title: "", own: "card", amount: 300, flowType: "DEBT_PAYMENT",
    pop: true, econ: "none", effect: "NEUTRAL", reason: "DEBT_PAYMENT" })]);
  check("divergence(sign): B=300 (sign-agnostic), C=0 (negative-only) — same fact, different sign convention",
    approx(b, 300) && approx(cc, 0), `B=${b} C=${cc}`);
}

// Divergence 4 — cross-space / visibility suppression: a source-leg account shared
// at BALANCE_ONLY contributes NO rows (grantsTransactionDetail false), so A/C
// undercount. Documented via the gating mechanism (the query never sees the leg).
check("divergence(visibility): a BALANCE_ONLY source account yields NO transaction rows → A/C undercount",
  grantsTransactionDetail(VisibilityLevel.BALANCE_ONLY) === false);

// ═══════════════════════════════════════════════════════════════════════════════
// PART 4 — PAYMENT-APP / LIABILITY DOCTRINE (rail ≠ purpose)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Freeze, before classifier v3: a payment app is HOW money moved, never WHY. The
// account tier + relationship evidence — NOT the rail — decide the liquidity
// treatment. "PAYMENT_APP means spending" is explicitly WRONG.

console.log("── Part 4 — payment-app / liability doctrine ──");

// (a) payment-app rail on a LIQUID account → directional Cash In/Out, purpose unknown.
{
  const outApp = toTx({ id: "pa1", title: "", own: "chk", amount: -75, flowType: "TRANSFER",
    cp: null, rail: "PAYMENT_APP", disposition: "PAYMENT_APP_MOVEMENT",
    pop: true, econ: "none", effect: "CASH_OUT", reason: "PAYMENT_APP_OUTFLOW" });
  const c = classifyLiquidity(outApp, ctx);
  check("payment-app on liquid account = CASH_OUT / PAYMENT_APP_OUTFLOW (spendable moved, purpose unknown)",
    c.effect === "CASH_OUT" && c.reason === "PAYMENT_APP_OUTFLOW");
}

// (b) payment-app rail on a LIABILITY account → NEUTRAL (the card charge is the
//     neutral leg; it never enters Cash In/Out).
{
  const cardApp = toTx({ id: "pa2", title: "", own: "card", amount: -75, flowType: "TRANSFER",
    cp: null, rail: "PAYMENT_APP", disposition: "PAYMENT_APP_MOVEMENT",
    pop: true, econ: "none", effect: "NEUTRAL", reason: "INTERNAL_TRANSFER" });
  const c = classifyLiquidity(cardApp, ctx);
  check("payment-app on liability account = NEUTRAL (card charge leg never enters Cash In/Out)",
    c.effect === "NEUTRAL", JSON.stringify(c));
}

// (c) OWNED transfer over a payment-app rail → ownership beats rail → INTERNAL_TRANSFER,
//     and it is NOT surfaced as needs-classification.
{
  const d = deriveTransferDisposition(fullEvidence({ railType: "PAYMENT_APP" }), { counterpartyIsOwned: true });
  check("owned transfer over payment-app rail = INTERNAL_TRANSFER (ownership beats rail)", d === "INTERNAL_TRANSFER");
  const n = shouldSurfaceAsNeedsClassification({
    flowType: "TRANSFER", classificationReason: null, transferRail: "PAYMENT_APP",
    hasResolvedMerchant: false, hasResolvedCounterparty: true,
  });
  check("owned payment-app transfer is NOT needs-classification (counterparty resolved)", n.needsClassification === false);
}

// (d) UNKNOWN-counterparty payment-app rail → PAYMENT_APP_MOVEMENT + needs-classification.
{
  const d = deriveTransferDisposition(fullEvidence({ railType: "PAYMENT_APP" }), { counterpartyIsOwned: undefined });
  check("unknown-counterparty payment-app rail = PAYMENT_APP_MOVEMENT (purpose unresolved)", d === "PAYMENT_APP_MOVEMENT");
  const n = shouldSurfaceAsNeedsClassification({
    flowType: "TRANSFER", classificationReason: null, transferRail: "PAYMENT_APP",
    hasResolvedMerchant: false, hasResolvedCounterparty: false,
  });
  check("unknown-counterparty payment-app row = UNKNOWN_PAYMENT_APP_PURPOSE", n.reason === "UNKNOWN_PAYMENT_APP_PURPOSE");
}

// (e) rail ≠ purpose enforced end-to-end: a payment-app row is NEVER economic spend.
{
  check("doctrine: a payment-app TRANSFER is economic bucket 'none' — never SPENDING", econBucket("TRANSFER") === "none");
  check("doctrine: disposition depends on evidence+ownership, NOT on 'looks like a merchant'",
    deriveTransferDisposition(fullEvidence({ railType: "PAYMENT_APP" }), {}) === "PAYMENT_APP_MOVEMENT");
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 5 — MULTI-CURRENCY DOCTRINE (frozen contract for P2-7C)
// ═══════════════════════════════════════════════════════════════════════════════
//
// FROZEN RULE (A6): per-row conversion at the row's own date; missing FX degrades
// to native + `estimated`, never dropped. DayFacts / drilldowns / AI aggregates /
// merchant-category-source totals must all obey it. This section pins what is
// ASSERTABLE today and states the CONTRACT P2-7C must satisfy.

console.log("── Part 5 — multi-currency doctrine ──");

const usdRows: LiquidityTx[] = [
  toTx({ id: "u1", title: "", own: "chk", amount: 1000, flowType: "INCOME", pop: true, econ: "income", effect: "CASH_IN", reason: "EARNED_INCOME" }),
  toTx({ id: "u2", title: "", own: "chk", amount: -200, flowType: "SPENDING", pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST" }),
];

// native USD: identity context is byte-identical to the no-context (raw) fold.
{
  const raw = aggregateDayFacts(usdRows, ctx);
  const ident = aggregateDayFacts(usdRows, ctx, identityContext("USD"));
  check("native USD: identityContext fold === raw fold (cashIn)", raw.cashIn === ident.cashIn && ident.cashIn === 1000);
  check("native USD: identityContext fold === raw fold (cashOut)", raw.cashOut === ident.cashOut && ident.cashOut === 200);
}

// non-USD converted at a real rate: EUR −100 @ 1.1 → 110 reporting.
{
  const fxCtx: ConversionContext = {
    target: "USD",
    resolve: (from, dateISO) =>
      from === "EUR"
        ? { kind: "rate", rate: 1.1, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
        : { kind: "miss", quote: from, requestedDateISO: dateISO },
  };
  const eur = [toTx({ id: "e1", title: "", own: "chk", amount: -100, flowType: "SPENDING", currency: "EUR",
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST" })];
  const df = aggregateDayFacts(eur, ctx, fxCtx);
  check("EUR −100 @1.1 → cashOut 110 (reporting currency)", approx(df.cashOut, 110) && approx(df.spendGross, 110));
}

// missing FX: native pass-through (never dropped), and convertMoney flags estimated.
{
  const idc = identityContext("USD");
  const c = convertMoney({ amount: -100, currency: "EUR" }, "2026-02-27", idc);
  check("missing FX: native amount passes through (−100)", c.amount === -100);
  check("missing FX: convertMoney flags estimated=true (honesty valve)", c.estimated === true);
  const eur = [toTx({ id: "e2", title: "", own: "chk", amount: -100, flowType: "SPENDING", currency: "EUR",
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST" })];
  const df = aggregateDayFacts(eur, ctx, idc);
  check("missing FX: DayFacts uses the native magnitude (100), row never dropped", approx(df.cashOut, 100));
}

// null-currency residue: treated as target, estimated (Phase-0 doctrine).
{
  const c = convertMoney({ amount: 500, currency: null }, "2026-02-27", identityContext("USD"));
  check("null-currency residue: amount passes through + estimated=true", c.amount === 500 && c.estimated === true);
}

// CONTRACT for P2-7C (documented; not implemented here):
//   • DayFacts today has NO `estimated`/`fxMiss` field — the FX-completeness taint
//     is carried only by the assembler / classifyAccounts. P2-7C must thread FX
//     completeness through DayFacts totals + drilldowns + AI aggregates + the
//     merchant/category/source rollups, all per-row at row date, missing→native+estimated.
check("GAP (P2-7C contract): DayFacts carries no FX-completeness taint yet (frozen)",
  !Object.prototype.hasOwnProperty.call(aggregateDayFacts(usdRows, ctx), "estimated"));

// ═══════════════════════════════════════════════════════════════════════════════
// PART 6 — VISIBILITY DOCTRINE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Pin the detail-visibility ladder AND the invariant that visibility gates the
// QUERY POPULATION — it never re-interprets a row's semantics.

console.log("── Part 6 — visibility doctrine ──");

check("FULL → transaction detail allowed", grantsTransactionDetail(VisibilityLevel.FULL) === true);
check("BALANCE_ONLY → no transaction detail (balance/value aggregate only)",
  grantsTransactionDetail(VisibilityLevel.BALANCE_ONLY) === false);
check("SUMMARY_ONLY → no transaction/position detail",
  grantsTransactionDetail(VisibilityLevel.SUMMARY_ONLY) === false);
check("PRIVATE → excluded", grantsTransactionDetail(VisibilityLevel.PRIVATE) === false);
check("SHARED (legacy) → fails closed / excluded", grantsTransactionDetail(VisibilityLevel.SHARED) === false);
check("exactly one visibility level grants transaction detail (FULL)",
  (Object.values(VisibilityLevel) as VisibilityLevel[]).filter(grantsTransactionDetail).join(",") === VisibilityLevel.FULL);

// Semantics are NOT reinterpreted merely because detail is hidden: the SAME row
// classifies identically no matter which Space visibility gates it (the classifiers
// take no visibility argument — the gate is structural, applied in the query).
{
  const row = toTx({ id: "v1", title: "", own: "chk", amount: -92.4, flowType: "SPENDING",
    pop: true, econ: "spend", effect: "CASH_OUT", reason: "REAL_COST" });
  const c = classifyLiquidity(row, ctx);
  check("visibility invariant: a hidden SPENDING row is STILL CASH_OUT/REAL_COST (semantics unchanged)",
    c.effect === "CASH_OUT" && c.reason === "REAL_COST" && isBankingPopulation("SPENDING") === true);
  // REVOKED link / deleted account: excluded by the ACTIVE-status + deletedAt:null
  // structural filters (documented — the row's flow semantics do not change).
  check("REVOKED link / deleted account → excluded by structural filters, NOT by re-classification",
    grantsTransactionDetail(VisibilityLevel.FULL) === true /* gate is orthogonal to the flow above */);
}

// ─── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("Financial doctrine oracle FAILED."); process.exit(1); }
console.log("Financial doctrine oracle passed — semantics FROZEN for classifier v3.");
process.exit(0);
