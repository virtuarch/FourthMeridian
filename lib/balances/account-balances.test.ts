/**
 * lib/balances/account-balances.test.ts   (v2.6-L2)
 *
 * Behavioural probes for the balance authority. Pure, no DB, standalone tsx.
 *
 * Every fixture below is a REAL row from the live corpus (2026-08-04), because
 * the whole point of this module is that the column's meaning varies by account
 * and only real accounts prove that. The load-bearing case is the Chase card:
 * $562.37 owed and $33,022.48 of unused credit line, from one column, and those
 * two numbers must never be interchangeable.
 */

import { resolveAccountFreshness } from "@/lib/freshness/observation";
import {
  resolveAccountBalances, resolveRowBalances,
  reachableCash, availableCredit, settledCash,
  type AccountBalances,
} from "./account-balances";
import { SECTION_QUANTITY, isCurrentBalanceSection, sectionQuantityNote } from "./section-quantity";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-08-04T12:00:00.000Z");
const YESTERDAY = new Date(NOW.getTime() - 86_400_000).toISOString();

const freshness = (id: string) =>
  resolveAccountFreshness({ accountId: id, ingestedAt: YESTERDAY, providerBalanceAt: null }, NOW);

function build(o: {
  id: string; type: string; balance: number; available?: number | null;
  creditLimit?: number | null; debtSubtype?: string | null; wallet?: boolean;
}): AccountBalances {
  return resolveAccountBalances({
    accountId:           o.id,
    accountType:         o.type,
    debtSubtype:         o.debtSubtype ?? null,
    currency:            "USD",
    balance:             o.balance,
    availableBalance:    o.available ?? null,
    creditLimit:         o.creditLimit ?? null,
    isSelfCustodyWallet: o.wallet ?? false,
    freshness:           freshness(o.id),
  });
}

// ── THE case: one column, three meanings ─────────────────────────────────────

console.log("Chase CREDIT CARD — owed and available credit are never interchangeable");
{
  // Live row: balance 562.37, availableBalance 33,022.48, creditLimit 33,700,
  // debtSubtype NULL (which is why the rule keys on creditLimit, not subtype).
  const b = build({ id: "chase-cc", type: "debt", balance: 562.37, available: 33_022.48, creditLimit: 33_700 });

  check("observed ledger balance is 562.37", b.observed.amount === 562.37);
  check("amount owed is 562.37", b.debt?.owed.amount === 562.37);
  check("available is named AVAILABLE_CREDIT",
    b.available.status === "AVAILABLE" && b.available.quantity === "AVAILABLE_CREDIT");
  check("available credit is 33,022.48", availableCredit(b) === 33_022.48);
  check("the label says 'Available credit'",
    b.available.status === "AVAILABLE" && b.available.label === "Available credit");

  // The $32,460 mistake, asserted as impossible three ways.
  check("available credit is NOT the amount owed", availableCredit(b) !== b.debt!.owed.amount);
  check("available credit is NOT reachable cash", reachableCash(b) === null);
  check("available credit is NOT settled cash", settledCash(b) === null);
  check("the gap a uniform reader would have introduced is $32,460.11",
    Math.abs((availableCredit(b)! - b.debt!.owed.amount) - 32_460.11) < 0.005);

  // The subtype trap: both live Plaid cards carry debtSubtype NULL.
  check("a NULL debtSubtype does not defeat the rule — creditLimit is the evidence",
    b.available.status === "AVAILABLE");
  const noEvidence = build({ id: "x", type: "debt", balance: 100, available: 5_000 });
  check("a debt row with NO limit and NO subtype refuses rather than assuming credit",
    noEvidence.available.status === "UNAVAILABLE" &&
    noEvidence.available.reason === "SEMANTICS_UNATTESTED");
}

console.log("Amex Platinum — a charge card with a $0 line reports $0, not 'unknown'");
{
  // Live row: balance 203.25, available 0.00, creditLimit 0.00.
  const b = build({ id: "amex-plat", type: "debt", balance: 203.25, available: 0, creditLimit: 0 });
  check("owed is 203.25", b.debt?.owed.amount === 203.25);
  check("available credit is the provider's 0, reported as a real figure",
    availableCredit(b) === 0);
  check("a provider zero is NOT collapsed into 'not reported'",
    b.available.status === "AVAILABLE");
}

console.log("CHASE COLLEGE — observed and reachable are separate quantities");
{
  const b = build({ id: "chase-chk", type: "checking", balance: 5_106.77, available: 1_106.77 });
  check("observed is 5,106.77", b.observed.amount === 5_106.77);
  check("reachable cash is 1,106.77", reachableCash(b) === 1_106.77);
  // Float tolerance: 5106.77 − 1106.77 is 4000.0000000000005 in IEEE-754.
  check("the two differ by the $4,000 hold",
    Math.abs((b.observed.amount - reachableCash(b)!) - 4_000) < 0.005);
  check("named AVAILABLE_CASH",
    b.available.status === "AVAILABLE" && b.available.quantity === "AVAILABLE_CASH");
  check("a checking row carries no debt claims", b.debt === null);
  check("checking is never read as available credit", availableCredit(b) === null);
}

console.log("Amex HYSA — savings behaves as depository");
{
  const b = build({ id: "amex-hysa", type: "savings", balance: 6_315.04, available: 2_315.04 });
  check("observed is 6,315.04", b.observed.amount === 6_315.04);
  check("reachable cash is 2,315.04", reachableCash(b) === 2_315.04);
  check("the $4,000 gap is visible, not smoothed", b.observed.amount - reachableCash(b)! === 4_000);
}

console.log("Schwab Individual — account VALUE is not available cash");
{
  // Live row: balance 901.66 (six security holdings, zero cash), available 0.00.
  const b = build({ id: "schwab-ind", type: "investment", balance: 901.66, available: 0 });
  check("observed value is 901.66", b.observed.amount === 901.66);
  check("settled cash is 0.00 — the provider's own number", settledCash(b) === 0);
  check("the value did NOT become available cash", settledCash(b) !== b.observed.amount);
  check("investment settled cash is not liquidity's reachable cash", reachableCash(b) === null);
}

console.log("Schwab LLC — settled cash EQUALS value, because it holds no securities");
{
  const b = build({ id: "schwab-llc", type: "investment", balance: 3_557.72, available: 3_557.72 });
  check("settled cash is the provider's 3,557.72", settledCash(b) === 3_557.72);
  // Equality here is the provider's claim about an all-cash account, NOT a
  // fallback by us — the distinction that matters is that a NULL never does this.
  const nulled = build({ id: "schwab-llc-null", type: "investment", balance: 3_557.72, available: null });
  check("a NULL available never becomes the balance", nulled.available.status === "UNAVAILABLE");
  check("...and says the provider reported nothing",
    nulled.available.status === "UNAVAILABLE" && nulled.available.reason === "PROVIDER_DID_NOT_REPORT");
  check("...and exposes no amount to read at all",
    !("amount" in nulled.available));
}

console.log("Robinhood — uninvested cash inside a brokerage");
{
  const b = build({ id: "rh", type: "investment", balance: 484.25, available: 471.21 });
  check("settled cash is 471.21", settledCash(b) === 471.21);
  check("positions account for the difference (~13.04)",
    Math.abs((b.observed.amount - settledCash(b)!) - 13.04) < 0.01);
}

console.log("Crypto — no available amount ever escapes");
{
  // Cold Wallet BTC: self-custodied, available NULL.
  const wallet = build({ id: "btc", type: "crypto", balance: 15_283.79, available: null, wallet: true });
  check("a self-custodied wallet has NO available quantity",
    wallet.available.status === "UNAVAILABLE" && wallet.available.reason === "NOT_APPLICABLE");
  check("the wallet's value is still observed", wallet.observed.amount === 15_283.79);

  // Robinhood Crypto: an exchange row that DOES carry a figure.
  const exch = build({ id: "rh-crypto", type: "crypto", balance: 0, available: 0 });
  check("an exchange figure is refused as unattested, not named",
    exch.available.status === "UNAVAILABLE" && exch.available.reason === "SEMANTICS_UNATTESTED");
  check("no crypto row exposes an available amount",
    !("amount" in wallet.available) && !("amount" in exch.available));
}

console.log("Loans — an amortising debt has no available quantity");
{
  const mortgage = build({ id: "mort", type: "debt", balance: 285_000, available: null, debtSubtype: "mortgage" });
  check("a mortgage refuses with NOT_APPLICABLE",
    mortgage.available.status === "UNAVAILABLE" && mortgage.available.reason === "NOT_APPLICABLE");
  check("...and still reports what is owed", mortgage.debt?.owed.amount === 285_000);
  const auto = build({ id: "auto", type: "debt", balance: 11_200, available: 999, debtSubtype: "auto_loan" });
  check("an installment loan refuses even when a figure arrived",
    auto.available.status === "UNAVAILABLE" && auto.available.reason === "NOT_APPLICABLE");
}

console.log("Seed credit cards — a revolving subtype with no reported figure");
{
  const b = build({ id: "beacon-cc", type: "debt", balance: 5_800, available: null, creditLimit: 15_000, debtSubtype: "credit_card" });
  check("owed is 5,800", b.debt?.owed.amount === 5_800);
  check("a null figure on a known revolving card is PROVIDER_DID_NOT_REPORT",
    b.available.status === "UNAVAILABLE" && b.available.reason === "PROVIDER_DID_NOT_REPORT");
  check("the credit limit alone does NOT manufacture an available figure",
    !("amount" in b.available));
}

console.log("Manual / seed assets — honest unknowns and observed values");
{
  const home = build({ id: "home", type: "other", balance: 485_000, available: null });
  check("a manual asset reports its stated value", home.observed.amount === 485_000);
  check("...and has no available quantity",
    home.available.status === "UNAVAILABLE" && home.available.reason === "NOT_APPLICABLE");
  const seedChecking = build({ id: "demo-chk", type: "checking", balance: 3_450, available: 3_450 });
  check("a seeded checking row still resolves as depository cash", reachableCash(seedChecking) === 3_450);
}

console.log("Liability sign convention — composed, never re-derived");
{
  const overpaid = build({ id: "credit", type: "debt", balance: -124.04, available: 5_124, creditLimit: 5_000 });
  check("an overpaid card owes ZERO, never negative", overpaid.debt?.owed.amount === 0);
  check("the issuer credit is a positive magnitude", overpaid.debt?.issuerCredit?.amount === 124.04);
  check("state is 'credit'", overpaid.debt?.state === "credit");
  const settled = build({ id: "paid", type: "debt", balance: 0, creditLimit: 5_000, available: 5_000 });
  check("a settled card owes 0 and holds no issuer credit",
    settled.debt?.owed.amount === 0 && settled.debt?.issuerCredit === null);
  check("...and still exists as a debt row (membership is structural)", settled.debt !== null);
}

console.log("Freshness composes; it is never re-derived here");
{
  const f = freshness("x");
  const b = build({ id: "x", type: "checking", balance: 1, available: 1 });
  check("the freshness answer travels with the balance claim",
    b.freshness.balance.basis === f.balance.basis && b.freshness.accountId === "x");
  check("...carrying the ingestion basis unchanged", b.freshness.balance.basis === "INGESTION");
}

console.log("resolveRowBalances — the row convenience");
{
  const b = resolveRowBalances({
    id: "row", type: "debt", currency: "USD", balance: 562.37,
    availableBalance: 33_022.48, creditLimit: 33_700, debtSubtype: null,
    walletAddress: null, lastUpdated: YESTERDAY, balanceLastUpdatedAt: null,
    ledgerThroughDate: "2026-08-02", ledgerQueried: true,
  }, NOW);
  check("resolves the same credit claim from a row", availableCredit(b) === 33_022.48);
  check("...and resolves freshness through the L1 authority",
    b.freshness.balance.basis === "INGESTION" && b.freshness.ledger.kind === "OBSERVED");
}

// ── Section quantity map ─────────────────────────────────────────────────────

console.log("Section quantity map");
{
  check("a liquidity card is a current-balance surface", isCurrentBalanceSection("accessible_cash"));
  // v2.6-L3 — the liquidity family migrated from OBSERVED_LEDGER to REACHABLE_CASH.
  // The widgets said "reachable" all along; now the quantity underneath agrees.
  check("...and discloses the REACHABLE quantity, not the ledger one",
    sectionQuantityNote("accessible_cash") === "Available now");
  check("the whole liquidity family migrated together",
    ["liquidity_ladder", "accessible_cash", "emergency_fund_readiness", "liquidity_concentration"]
      .every((k) => SECTION_QUANTITY[k] === "REACHABLE_CASH"));
  check("net worth did NOT migrate — it is a statement about observed balances",
    SECTION_QUANTITY.net_worth === "OBSERVED_LEDGER");
  check("a debt card discloses amounts owed",
    sectionQuantityNote("debt_by_account") === "Amounts owed");
  check("a snapshot-backed card carries NO current-balance label",
    sectionQuantityNote("net_worth_chart") === null && SECTION_QUANTITY.net_worth_chart === "HISTORICAL");
  check("a flow card carries NO current-balance label",
    sectionQuantityNote("cash_flow_summary") === null && SECTION_QUANTITY.cash_flow_summary === "FLOW");
  check("a non-financial card carries none either", sectionQuantityNote("credit_score") === null);
  check("an unknown key is not labelled", sectionQuantityNote("no_such_widget") === null);
}

if (failures > 0) { console.error(`\naccount-balances: ${failures} failure(s).`); process.exit(1); }
console.log("\naccount-balances: all passed.");
