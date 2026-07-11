/**
 * lib/data/accounts-asof.fixtures.ts
 *
 * A5-S2 — the canonical as-of resolver fixtures. Owned here and imported by
 * accounts-asof.test.ts and (later) the P2/P3 Liquidity/Debt as-of tests.
 * Downstream streams REUSE these — forking them is a drift vector and a
 * review-rejectable offense (parallelization investigation §11). Pure data +
 * date helpers only; no DB, no Prisma.
 *
 * One deterministic Space with today = 2026-07-04 and every resolution class:
 *   - cash (checking + savings) with transaction history to walk back
 *   - a revolving credit card with purchase/payment history
 *   - an installment loan (held flat)
 *   - an investment position (held flat) whose floor is mid-window, so a date
 *     before it exercises the before-coverage / incomplete path
 */

import { fromISO } from "@/lib/snapshots/backfill-core";
import type { AsOfAccountInput } from "./accounts-asof.core";

/** The fixture "now" (UTC midnight). */
export const TODAY = fromISO("2026-07-04");

/** As-of dates the tests exercise. */
export const ASOF = {
  /** Two days back — inside every account's coverage; cash/card walk. */
  inCoverage:     fromISO("2026-07-02"),
  /** Before the investment's floor (2026-06-15) but after the others'. */
  beforeInvFloor: fromISO("2026-06-10"),
  /** The present — resolves to current, observed balances. */
  present:        fromISO("2026-07-04"),
} as const;

export const ACCOUNTS: AsOfAccountInput[] = [
  { id: "chk",  type: "checking",   balance: 1000,  debtSubtype: null,          creditLimit: null, floorISO: "2026-06-01" },
  { id: "sav",  type: "savings",    balance: 5000,  debtSubtype: null,          creditLimit: null, floorISO: "2026-06-01" },
  { id: "card", type: "debt",       balance: 500,   debtSubtype: "credit_card", creditLimit: 2000, floorISO: "2026-06-01" },
  { id: "loan", type: "debt",       balance: 10000, debtSubtype: "auto_loan",   creditLimit: null, floorISO: "2026-06-01" },
  { id: "inv",  type: "investment", balance: 20000, debtSubtype: null,          creditLimit: null, floorISO: "2026-06-15" },
];

/**
 * Cash deltas: accountId → isoDate → Σ signed amount (FM +in / −out) posted
 * that day. Only checking/savings ids appear here.
 *   chk: −50 dated 07-04, +200 dated 07-03
 *     ⇒ eod(07-03) = 1000 − (−50) = 1050 ; eod(07-02) = 1050 − 200 = 850
 *   sav: no deltas ⇒ holds flat at 5000
 */
export const CASH_DELTAS = new Map<string, Map<string, number>>([
  ["chk", new Map<string, number>([
    ["2026-07-04", -50],
    ["2026-07-03", 200],
  ])],
]);

/**
 * Card deltas: only reconstructable-card ids appear here.
 *   card: −100 (purchase) dated 07-03
 *     ⇒ owed(07-02) = 500 + (−100) = 400 (correctly lower before the charge)
 */
export const CARD_DELTAS = new Map<string, Map<string, number>>([
  ["card", new Map<string, number>([
    ["2026-07-03", -100],
  ])],
]);
