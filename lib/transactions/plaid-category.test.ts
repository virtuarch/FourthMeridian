/**
 * lib/transactions/plaid-category.test.ts
 *
 * Unit tests for mapPlaidCategory (lib/transactions/plaid-category.ts).
 *
 * The project has no test runner (no jest/vitest). This is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/transactions/flow-classifier.test.ts:
 *
 *     npx tsx lib/transactions/plaid-category.test.ts
 *
 * Exits 0 when all cases pass and 1 on the first failure. It imports ONLY
 * lib/transactions/plaid-category.ts, which uses type-only imports and therefore
 * pulls in NO Prisma client, db, or Plaid client at runtime — so this suite runs
 * without `prisma generate` and without any PLAID_* env vars.
 */

import {
  mapPlaidCategory,
  isCardPaymentDescriptor,
  isLiabilityCardPaymentLeg,
  type PlaidCategoryInput,
} from "./plaid-category";
import { classifyFlow } from "./flow-classifier";

// ── Tiny assert harness ───────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function expectCategory(
  name: string,
  input: Partial<PlaidCategoryInput>,
  want: string,
): void {
  // Cast: tests supply only the fields the mapper reads.
  const got = mapPlaidCategory(input as PlaidCategoryInput);
  if (got === want) { passed++; return; }
  failures.push(`✗ ${name} — got ${got}, want ${want}`);
}

/** Build a PFC input. */
function pfc(primary: string, detailed: string, merchant_name?: string, name?: string): Partial<PlaidCategoryInput> {
  return {
    personal_finance_category: { primary, detailed, confidence_level: "HIGH" } as PlaidCategoryInput["personal_finance_category"],
    merchant_name: merchant_name ?? null,
    name: name ?? merchant_name ?? "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Positive — allowlisted merchant WITH an ENTERTAINMENT_* PFC → Subscriptions.
//    Detection is merchant-driven: the PFC bucket alone is NOT sufficient.
// ─────────────────────────────────────────────────────────────────────────────

expectCategory("Netflix (TV_AND_MOVIES)",  pfc("ENTERTAINMENT", "ENTERTAINMENT_TV_AND_MOVIES",  "Netflix"), "Subscriptions");
expectCategory("Spotify (MUSIC_AND_AUDIO)", pfc("ENTERTAINMENT", "ENTERTAINMENT_MUSIC_AND_AUDIO", "Spotify"), "Subscriptions");

// ─────────────────────────────────────────────────────────────────────────────
// 2. Positive — merchant allowlist fallback (PFC bucket is too broad to allowlist)
// ─────────────────────────────────────────────────────────────────────────────

expectCategory("Adobe (GENERAL_SERVICES_OTHER)",   pfc("GENERAL_SERVICES", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "Adobe"),               "Subscriptions");
expectCategory("Microsoft 365 (GENERAL_SERVICES)", pfc("GENERAL_SERVICES", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "Microsoft 365"),       "Subscriptions");
expectCategory("Google One (GENERAL_SERVICES)",    pfc("GENERAL_SERVICES", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "Google One"),          "Subscriptions");
expectCategory("Google Workspace",                 pfc("GENERAL_SERVICES", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "Google Workspace"),    "Subscriptions");
expectCategory("YouTube Premium",                  pfc("GENERAL_SERVICES", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "YouTube Premium"),      "Subscriptions");
expectCategory("Hulu",                             pfc("ENTERTAINMENT", "ENTERTAINMENT_OTHER_ENTERTAINMENT", "Hulu"),                          "Subscriptions");
expectCategory("Disney+ ",                         pfc("ENTERTAINMENT", "ENTERTAINMENT_OTHER_ENTERTAINMENT", "Disney Plus"),                   "Subscriptions");

// Apple billing descriptor lives in `name`, while merchant_name is the clean brand.
expectCategory("Apple.com/Bill via name field",    pfc("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ELECTRONICS", "Apple", "APPLE.COM/BILL CUPERTINO CA"), "Subscriptions");

// Case-insensitivity.
expectCategory("NETFLIX.COM upper-cased",          pfc("ENTERTAINMENT", "ENTERTAINMENT_OTHER_ENTERTAINMENT", "NETFLIX.COM"),                   "Subscriptions");

// Merchant allowlist overrides a would-be Shopping bucket.
expectCategory("Apple.com/Bill overrides Shopping", pfc("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ELECTRONICS", "Apple.com/Bill"),           "Subscriptions");

// ─────────────────────────────────────────────────────────────────────────────
// 3. Positive — merchant allowlist applies when Plaid sent NO PFC at all
// ─────────────────────────────────────────────────────────────────────────────

expectCategory("Netflix, no PFC", { personal_finance_category: null, merchant_name: "Netflix", name: "Netflix" }, "Subscriptions");

// ─────────────────────────────────────────────────────────────────────────────
// 4. Negative / non-regression — existing mapping behavior unchanged
// ─────────────────────────────────────────────────────────────────────────────

expectCategory("Restaurant → Dining",       pfc("FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT", "Chipotle"),                 "Dining");
expectCategory("Target → Shopping",          pfc("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_SUPERSTORES", "Target"),        "Shopping");
expectCategory("Utilities",                  pfc("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY", "PG&E"),   "Utilities");
expectCategory("Income",                     pfc("INCOME", "INCOME_WAGES", "ACME Payroll"),                                  "Income");
expectCategory("Transfer in",                pfc("TRANSFER_IN", "TRANSFER_IN_DEPOSIT", "Deposit"),                           "Transfer");
expectCategory("Transfer out",               pfc("TRANSFER_OUT", "TRANSFER_OUT_WITHDRAWAL", "ATM"),                          "Transfer");
expectCategory("Loan payment → Payment",     pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_CAR_PAYMENT", "Toyota Financial"),          "Payment");
expectCategory("Bank fee → Fee",             pfc("BANK_FEES", "BANK_FEES_ATM_FEES", "Some Bank"),                            "Fee");
expectCategory("Travel",                     pfc("TRAVEL", "TRAVEL_FLIGHTS", "United"),                                      "Travel");
expectCategory("Interest override",          pfc("BANK_FEES", "BANK_FEES_INTEREST_CHARGE", "Card Issuer"),                   "Interest");

// Core of this correction: ENTERTAINMENT_* detaileds are NOT wholesale
// subscriptions. Streaming buckets with a non-allowlisted merchant → Other.
expectCategory("Generic music/audio → Other", pfc("ENTERTAINMENT", "ENTERTAINMENT_MUSIC_AND_AUDIO", "Local Concert Hall"),  "Other");
expectCategory("Vinyl store (audio) → Other", pfc("ENTERTAINMENT", "ENTERTAINMENT_MUSIC_AND_AUDIO", "Amoeba Records"),       "Other");
expectCategory("Movie theater (tv/movies) → Other", pfc("ENTERTAINMENT", "ENTERTAINMENT_TV_AND_MOVIES", "AMC Theatres"),     "Other");
expectCategory("Sporting event → Other",     pfc("ENTERTAINMENT", "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS", "Ticketmaster"), "Other");
expectCategory("Video games → Other",        pfc("ENTERTAINMENT", "ENTERTAINMENT_VIDEO_GAMES", "Steam"),                    "Other");
expectCategory("Casino → Other",             pfc("ENTERTAINMENT", "ENTERTAINMENT_CASINOS_AND_GAMBLING", "DraftKings"),      "Other");

// Substring safety: "Microsoft Store" must NOT match the "microsoft 365" token.
expectCategory("Microsoft Store → Shopping", pfc("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ELECTRONICS", "Microsoft Store"), "Shopping");

// Legacy category-array fallback (no PFC), non-subscription and subscription.
expectCategory("Legacy food array → Dining", { personal_finance_category: null, category: ["Food and Drink", "Restaurants"], merchant_name: "Diner", name: "Diner" }, "Dining");
// Legacy fallback inspects only category[0] (original, unchanged contract).
expectCategory("Legacy subscription array",  { personal_finance_category: null, category: ["Subscription"], merchant_name: "X", name: "X" },                         "Subscriptions");

// Empty / unknown → Other.
expectCategory("No PFC, non-sub merchant → Other", { personal_finance_category: null, merchant_name: "Local Hardware", name: "Local Hardware" }, "Other");

// ─────────────────────────────────────────────────────────────────────────────
// 5. Merchant Intelligence Slice 1 — global merchant→category rules
//    Rules sit BELOW flow-structural PFC (step 2) and ABOVE the spend-bucket
//    switch (step 5). See lib/transactions/merchant-rules.ts.
// ─────────────────────────────────────────────────────────────────────────────

// Rescue from Other: Plaid returns TRANSPORTATION for rideshare, which is NOT a
// mapped primary → would default to Other. The Uber rule fixes it to Travel.
expectCategory("Uber (TRANSPORTATION→Other) rescued → Travel", pfc("TRANSPORTATION", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES", "Uber"), "Travel");
// Ordering guard end-to-end: "uber eats" beats "uber" even under a non-food PFC.
expectCategory("Uber Eats overrides GENERAL_MERCHANDISE → Dining", pfc("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER", "Uber Eats"), "Dining");
// Regional-global.
expectCategory("Careem (TRANSPORTATION) → Travel", pfc("TRANSPORTATION", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES", "Careem"), "Travel");
expectCategory("Gathern (TRAVEL) → Travel",        pfc("TRAVEL", "TRAVEL_LODGING", "Gathern"),                          "Travel");
// Curated SaaS: PFC would otherwise bucket into Other/Shopping.
expectCategory("Anthropic overrides GENERAL_MERCHANDISE → Subscriptions", pfc("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER", "Anthropic"), "Subscriptions");
expectCategory("Vercel (GENERAL_SERVICES) → Subscriptions",               pfc("GENERAL_SERVICES", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES", "Vercel"), "Subscriptions");
// Shopping rescue from an unmapped primary (PERSONAL_CARE → would be Other).
expectCategory("Sephora (PERSONAL_CARE→Other) rescued → Shopping", pfc("PERSONAL_CARE", "PERSONAL_CARE_HAIR_AND_BEAUTY", "Sephora"), "Shopping");
expectCategory("Ajmal (PERSONAL_CARE) → Shopping",                pfc("PERSONAL_CARE", "PERSONAL_CARE_OTHER_PERSONAL_CARE", "Ajmal Perfumes"), "Shopping");
// Amex membership fee via a non-fee PFC → Fee by rule.
expectCategory("Amex annual fee overrides GENERAL_MERCHANDISE → Fee", pfc("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER", "AMEX ANNUAL FEE"), "Fee");

// Precedence: flow-structural PFC must WIN over a merchant rule.
expectCategory("Netflix on TRANSFER_OUT stays Transfer (structural wins)", pfc("TRANSFER_OUT", "TRANSFER_OUT_WITHDRAWAL", "Netflix"), "Transfer");
expectCategory("Uber on LOAN_PAYMENTS stays Payment (structural wins)",    pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_OTHER_PAYMENT", "Uber"),   "Payment");
expectCategory("Anthropic on INCOME stays Income (structural wins)",       pfc("INCOME", "INCOME_WAGES", "Anthropic"),                    "Income");

// No-PFC path: merchant rules still apply (not just subscriptions).
expectCategory("Uber, no PFC → Travel",   { personal_finance_category: null, merchant_name: "Uber", name: "Uber" },       "Travel");
expectCategory("Sephora, no PFC → Shopping", { personal_finance_category: null, merchant_name: "Sephora", name: "Sephora" }, "Shopping");

// Held-out merchants must NOT be classified by a rule (fall through to PFC/Other).
expectCategory("PlayStation held out (VIDEO_GAMES) → Other", pfc("ENTERTAINMENT", "ENTERTAINMENT_VIDEO_GAMES", "PlayStation Network"), "Other");
expectCategory("Namecheap held out (GENERAL_MERCHANDISE) → Shopping", pfc("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER", "Namecheap"), "Shopping");

// ─────────────────────────────────────────────────────────────────────────────
// 6. CC-1 — Credit-card payment classification correctness
// ─────────────────────────────────────────────────────────────────────────────

function expectBool(name: string, got: boolean, want: boolean): void {
  if (got === want) { passed++; return; }
  failures.push(`✗ ${name} — got ${got}, want ${want}`);
}

// 6a. mapPlaidCategory: the CREDIT_CARD_PAYMENT detailed rescues Payment even
//     when the primary is not LOAN_PAYMENTS (self-identifying, account-blind).
expectCategory("CREDIT_CARD_PAYMENT detailed under LOAN_PAYMENTS → Payment",
  pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", "Payment Thank You"), "Payment");
expectCategory("CREDIT_CARD_PAYMENT detailed under an UNMAPPED primary → Payment (rescue)",
  pfc("TRANSPORTATION", "TRANSPORTATION_CREDIT_CARD_PAYMENT", "Payment Thank You-Mobile"), "Payment");
// Ordinary card purchase must stay put (NOT all card rows become Payment).
expectCategory("Ordinary card purchase (Amazon) → Shopping",
  pfc("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", "Amazon"), "Shopping");
// A genuine transfer row remains Transfer.
expectCategory("Transfer row stays Transfer",
  pfc("TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER", "Transfer"), "Transfer");

// 6b. isCardPaymentDescriptor — generalized, institution-agnostic phrase match.
expectBool("descriptor: Chase 'Payment Thank You-Mobile'", isCardPaymentDescriptor("Payment Thank You-Mobile"), true);
expectBool("descriptor: Amex 'AUTOPAY PAYMENT - THANK YOU'", isCardPaymentDescriptor("AUTOPAY PAYMENT", "AUTOPAY PAYMENT - THANK YOU"), true);
expectBool("descriptor: Citi 'ONLINE PAYMENT THANK YOU'", isCardPaymentDescriptor("ONLINE PAYMENT, THANK YOU"), true);
expectBool("descriptor: ordinary merchant 'Uber' → false", isCardPaymentDescriptor("Uber"), false);
expectBool("descriptor: 'Amazon' → false", isCardPaymentDescriptor("Amazon", "AMAZON MKTP"), false);

// ── CCPAY-2C-2 — COVERAGE DELIBERATELY SURRENDERED ───────────────────────────
// These two asserted `true` until CCPAY-2C-2 pruned the nine tokens that matched
// ZERO of 4,334 real rows. Both fixtures were authored from imagination — no
// Discover or Citi account has ever been connected to this platform, and neither
// string occurs in any corpus row.
//
// They are INVERTED rather than deleted so the surrender stays visible in the
// suite instead of vanishing with the tokens. The rule that survived is: a
// payment descriptor SAYING "thank you" still rescues regardless of prefix (the
// two Citi/Amex cases above still pass via "payment thank you"); one that does
// NOT say "thank you" no longer rescues.
//
// TO RESTORE: when a real Discover/Citi/Wells row is observed, re-add the token
// its descriptor ACTUALLY uses (not a guessed one) and flip these back.
expectBool("SURRENDERED: Discover 'DISCOVER E-PAYMENT' no longer rescues (token 'e-payment' pruned, 0 real rows)",
  isCardPaymentDescriptor("DISCOVER E-PAYMENT"), false);
expectBool("SURRENDERED: 'CARDMEMBER SERV WEB PMT' no longer rescues (token 'cardmember serv' pruned, 0 real rows)",
  isCardPaymentDescriptor("CARDMEMBER SERV WEB PMT"), false);

// 6c. isLiabilityCardPaymentLeg — the guarded destination-leg predicate.
//     Requires: liability account + amount > 0 + descriptor.
//     PRIMARY liability signal is accountType === "debt" — the shape Plaid
//     actually produces for a synced credit card (type=debt, debtSubtype=null).
//     CC-1 correction: the original guard keyed on debtSubtype and matched 0 rows.
expectBool("guard: Plaid card (type=debt, debtSubtype=null, +1500, descriptor) → true",
  isLiabilityCardPaymentLeg({ accountType: "debt", debtSubtype: null, amount: 1500, merchant: "Payment Thank You-Mobile" }), true);
expectBool("guard: Amex payment credit (type=debt) → true",
  isLiabilityCardPaymentLeg({ accountType: "debt", amount: 3500, merchant: "AUTOPAY PAYMENT", name: "AUTOPAY PAYMENT - THANK YOU" }), true);
// SECONDARY signal: manually-entered liability (accountType not "debt" but debtSubtype set) still qualifies.
expectBool("guard: manual liability (debtSubtype=credit_card) as secondary signal → true",
  isLiabilityCardPaymentLeg({ accountType: "other", debtSubtype: "credit_card", amount: 500, merchant: "Payment Thank You" }), true);
// NON-liability account (checking, no debt signal) with 'online payment' text must NOT qualify.
expectBool("guard: checking (type=checking, debtSubtype null) + 'online payment' → false",
  isLiabilityCardPaymentLeg({ accountType: "checking", debtSubtype: null, amount: 1500, merchant: "ONLINE PAYMENT" }), false);
// Liability but a PURCHASE (amount < 0) must NOT qualify — never flips a purchase.
expectBool("guard: card purchase (type=debt, -12, no descriptor) → false",
  isLiabilityCardPaymentLeg({ accountType: "debt", amount: -12.11, merchant: "Uber" }), false);
// Liability + positive but NO descriptor (e.g. a refund) → false.
expectBool("guard: card refund credit without descriptor → false",
  isLiabilityCardPaymentLeg({ accountType: "debt", amount: 40, merchant: "Amazon Refund" }), false);
// Liability + descriptor but amount == 0 → false (strict positive).
expectBool("guard: zero-amount → false",
  isLiabilityCardPaymentLeg({ accountType: "debt", amount: 0, merchant: "Payment Thank You" }), false);

// 6d. Payment → DEBT_PAYMENT through the EXISTING flow classifier (no change).
//     Destination leg (on the card, amount > 0) is an inflow to the liability.
{
  const dest = classifyFlow({ category: "Payment", amount: 1500, debtSubtype: "credit_card" });
  expectBool("flow: Payment +amount → DEBT_PAYMENT", dest.flowType === "DEBT_PAYMENT", true);
  expectBool("flow: Payment +amount → INFLOW", dest.flowDirection === "INFLOW", true);
}
{
  // Source leg (paid FROM checking, amount < 0) is INTERNAL.
  const src = classifyFlow({ category: "Payment", amount: -1500 });
  expectBool("flow: Payment -amount → DEBT_PAYMENT", src.flowType === "DEBT_PAYMENT", true);
  expectBool("flow: Payment -amount → INTERNAL", src.flowDirection === "INTERNAL", true);
}
{
  const xfer = classifyFlow({ category: "Transfer", amount: 100 });
  expectBool("flow: Transfer stays TRANSFER", xfer.flowType === "TRANSFER", true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(`✓ plaid-category: all ${passed} checks passed`);
  process.exit(0);
} else {
  console.error(`✗ plaid-category: ${failures.length} failure(s), ${passed} passed:\n${failures.join("\n")}`);
  process.exit(1);
}
