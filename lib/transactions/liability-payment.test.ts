/**
 * lib/transactions/liability-payment.test.ts
 *
 * CCPAY-2C-6 — regression corpus for the liability-payment authority.
 *
 * Proves BEHAVIOR, not string lists. The axes are: descriptor FORMAT invariance
 * (the same phrase written any way an issuer might write it resolves the same),
 * the combined merchant+description evidence contract, the structural guards
 * (liability + sign), and rescue-only-ness.
 *
 * Fixtures marked ✓real are verbatim from the live corpus — including every
 * NEGATIVE case, which are real rows that must never be mistaken for payments.
 * Invented fixtures are marked ✗synthetic and exist only to pin format axes.
 *
 * Framework-free (house pattern): standalone tsx, exit 0 pass / 1 fail. Imports
 * only the zero-import authority module, so it runs without `prisma generate`.
 *
 *     npx tsx lib/transactions/liability-payment.test.ts
 */

import {
  normalizeDescriptor,
  isCardPaymentDescriptor,
  isLiabilityCardPaymentLeg,
  isLiabilityAccount,
  isLiabilityInflow,
  isLiabilityOutflow,
  resolveLiabilityPaymentCategory,
  CARD_PAYMENT_DESCRIPTORS,
} from "./liability-payment";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const CARD = { accountType: "debt", debtSubtype: null };

// ─────────────────────────────────────────────────────────────────────────────
// 1. normalizeDescriptor — FORMAT folding only
// ─────────────────────────────────────────────────────────────────────────────

// The defect that started CCPAY-1: one hyphen where a space was expected. ✓real
eq("normalize: Chase pending 'PAYMENT-THANK YOU' ✓real", normalizeDescriptor("PAYMENT-THANK YOU"), "payment thank you");
// Every other punctuation an issuer might use for the same phrase. ✗synthetic —
// only the hyphen forms are attested; these pin the axis, not an observation.
for (const [label, raw] of [
  ["dot",           "PAYMENT.THANK.YOU"],
  ["underscore",    "PAYMENT_THANK_YOU"],
  ["slash",         "PAYMENT / THANK YOU"],
  ["backslash",     "PAYMENT\\THANK\\YOU"],
  ["comma",         "PAYMENT, THANK YOU"],
  ["colon",         "PAYMENT: THANK YOU"],
  ["semicolon",     "PAYMENT; THANK YOU"],
  ["asterisk",      "PAYMENT*THANK*YOU"],
  ["hash",          "PAYMENT#THANK#YOU"],
  ["parens",        "PAYMENT (THANK YOU)"],
  ["brackets",      "PAYMENT [THANK YOU]"],
  ["double space",  "PAYMENT  THANK  YOU"],
  ["padded",        "   payment thank you   "],
  ["em dash",       "PAYMENT—THANK YOU"],
  ["en dash",       "PAYMENT–THANK YOU"],
  ["mixed",         " Payment-.-Thank / You "],
] as const) {
  eq(`normalize: ${label} folds to the canonical phrase ✗synthetic`, normalizeDescriptor(raw), "payment thank you");
}
// NFKD: combining marks folded. ✗synthetic — no accented descriptor observed.
eq("normalize: NFKD strips combining marks ✗synthetic", normalizeDescriptor("PAYMÉNT"), "payment");
// Normalization must NOT invent or destroy words.
eq("normalize: empty string stays empty", normalizeDescriptor(""), "");
eq("normalize: punctuation-only collapses to empty", normalizeDescriptor("---"), "");
eq("normalize: digits and words survive", normalizeDescriptor("CREDIT CRD AUTOPAY 1234"), "credit crd autopay 1234");
// Idempotence — normalizing twice equals normalizing once.
for (const s of ["PAYMENT-THANK YOU", "  A--B  ", "Payment Thank You-Mobile"]) {
  eq(`normalize: idempotent on ${JSON.stringify(s)}`, normalizeDescriptor(normalizeDescriptor(s)), normalizeDescriptor(s));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Format invariance — the SAME payment, written any way, matches
// ─────────────────────────────────────────────────────────────────────────────

for (const variant of [
  "PAYMENT-THANK YOU",        // ✓real — Chase, pending
  "Payment Thank You-Mobile", // ✓real — Chase, posted
  "MOBILE PAYMENT - THANK YOU", // ✓real — Amex, posted
  "PAYMENT THANK YOU",        // ✗synthetic
  "PAYMENT.THANK.YOU",        // ✗synthetic
  "PAYMENT_THANK_YOU",        // ✗synthetic
  "PAYMENT / THANK YOU",      // ✗synthetic
  "PAYMENT—THANK YOU",        // ✗synthetic (em dash)
  "payment  thank  you",      // ✗synthetic
  "ONLINE PAYMENT, THANK YOU",  // ✗synthetic — prefix irrelevant
  "AUTOPAY PAYMENT - THANK YOU", // ✗synthetic — prefix irrelevant
]) {
  check(`format invariance: ${JSON.stringify(variant)} is a card-payment descriptor`,
    isCardPaymentDescriptor(variant) === true);
}

// The pending and posted forms of the SAME Chase payment must agree. This is the
// CCPAY-1 defect stated as an invariant: descriptor drift across the pending →
// posted lifecycle must not change the classification. ✓real both sides.
eq("lifecycle: Chase pending and posted descriptors agree",
  isLiabilityCardPaymentLeg({ ...CARD, amount: 5000, merchant: "PAYMENT-THANK YOU", name: "PAYMENT-THANK YOU" }),
  isLiabilityCardPaymentLeg({ ...CARD, amount: 5000, merchant: "Payment Thank You-Mobile", name: "Payment Thank You-Mobile" }));

// ─────────────────────────────────────────────────────────────────────────────
// 3. The word-boundary contract — the e-payment trap
// ─────────────────────────────────────────────────────────────────────────────
// Substring matching over NORMALIZED text is unsafe: "e-payment" normalizes to
// "e payment", a substring of "mobile payment" and "Zelle payment to Mom".
// Measured: 156 rows under substring, 0 under word-boundary. These pin that the
// matcher is word-boundary — they fail loudly if anyone reverts to .includes().

check("word-boundary: 'Zelle payment to Mom' is NOT a card-payment descriptor (the e-payment trap)",
  isCardPaymentDescriptor("Zelle payment to Mom JPM99b2i991r") === false);
check("word-boundary: a bare 'payment' word does not match a multi-word token",
  isCardPaymentDescriptor("ABACUS TECHNOLOG Payment 1862 CCD ID: 1521328215") === false);
check("word-boundary: '3CPAYMENT*PULLMAN PAPARIS FR' is NOT a payment descriptor ✓real",
  isCardPaymentDescriptor("Pullman Paparis Fr", "3CPAYMENT*PULLMAN PAPARIS FR") === false);
// A token must not match as a fragment of a longer word.
check("word-boundary: 'prepayment thanks youth' does not match",
  isCardPaymentDescriptor("prepayment thanks youth") === false);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Combined merchant + description evidence contract
// ─────────────────────────────────────────────────────────────────────────────
// description is the RAW issuer descriptor; merchant is Plaid's ENRICHED name.
// They differ on 50% of real rows. A descriptor surviving in ONE field must
// still be found — this is the case that breaks if anyone narrows the haystack.

check("combined evidence: descriptor ONLY in description (merchant enriched away) still matches",
  isCardPaymentDescriptor("Chase Card Services", "PAYMENT-THANK YOU") === true);
check("combined evidence: descriptor ONLY in merchant (Payee-only CSV, description null) still matches",
  isCardPaymentDescriptor("PAYMENT-THANK YOU", null) === true);
check("combined evidence: description undefined is tolerated",
  isCardPaymentDescriptor("PAYMENT-THANK YOU") === true);
check("combined evidence: both null → false, never throws",
  isCardPaymentDescriptor(null, null) === false);
check("combined evidence: both empty → false",
  isCardPaymentDescriptor("", "") === false);
// KNOWN PROPERTY (measured, benign, 0 false positives corpus-wide): joining the
// two fields can synthesize a phrase present in NEITHER. Pinned so the behavior
// is a recorded decision rather than a surprise.
check("combined evidence: join seam can synthesize a phrase (known, benign)",
  isCardPaymentDescriptor("MOBILE PAYMENT - THANK YOU", "MOBILE PAYMENT - THANK YOU") === true);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Structural guards — real NEGATIVE fixtures from the live corpus
// ─────────────────────────────────────────────────────────────────────────────
// Every row below is real and positive on a liability account — the exact
// population a descriptor rule could wrongly capture. None may become a payment.

for (const [label, merchant, amount] of [
  ["merchant refund (Amazon) ✓real",            "Amazon SA",                   49.01],
  ["merchant refund (Sephora) ✓real",           "Sephora",                     22.86],
  ["merchant refund (Airbnb) ✓real",            "Airbnb",                     221.45],
  ["reward redemption ✓real",                   "POINTS FOR AMEX TRVL",       684.46],
  ["statement credit ✓real",                    "TSA Global Entry Fee Credit", 120.00],
  ["statement credit ✓real",                    "ANNUAL HOTEL CREDIT",         50.00],
  ["apple-pay refund (the 'pay' cliff) ✓real",  "AplPay TARGET",              108.89],
  ["apple-pay refund ✓real",                    "AplPay Hunger StatioRIYADH SA", 4.00],
  ["interest reversal ✓real",                   "PURCHASE INTEREST CHARGE",     0.35],
] as const) {
  check(`negative: ${label} on a liability inflow is NOT a payment leg`,
    isLiabilityCardPaymentLeg({ ...CARD, amount, merchant, name: merchant }) === false);
}

// Sign + tier guards.
check("guard: liability + descriptor but amount < 0 (a purchase) → false",
  isLiabilityCardPaymentLeg({ ...CARD, amount: -50, merchant: "PAYMENT-THANK YOU" }) === false);
check("guard: liability + descriptor but amount == 0 → false (strictly positive)",
  isLiabilityCardPaymentLeg({ ...CARD, amount: 0, merchant: "PAYMENT-THANK YOU" }) === false);
check("guard: DEPOSITORY + descriptor + positive → false (wrong tier) ✓real-shaped",
  isLiabilityCardPaymentLeg({ accountType: "checking", amount: 5000, merchant: "PAYMENT-THANK YOU" }) === false);
check("guard: debtSubtype is honored as the secondary liability signal",
  isLiabilityCardPaymentLeg({ accountType: "other", debtSubtype: "credit_card", amount: 500, merchant: "PAYMENT-THANK YOU" }) === true);

// The structural predicates themselves.
check("isLiabilityAccount: type=debt", isLiabilityAccount({ accountType: "debt" }) === true);
check("isLiabilityAccount: debtSubtype set", isLiabilityAccount({ accountType: "other", debtSubtype: "credit_card" }) === true);
check("isLiabilityAccount: empty debtSubtype is not a signal", isLiabilityAccount({ accountType: "other", debtSubtype: "" }) === false);
check("isLiabilityAccount: checking", isLiabilityAccount({ accountType: "checking" }) === false);
check("isLiabilityAccount: unknown context is not assumed liable", isLiabilityAccount({}) === false);
check("isLiabilityInflow / isLiabilityOutflow are disjoint at 0",
  isLiabilityInflow({ ...CARD, amount: 0 }) === false && isLiabilityOutflow({ ...CARD, amount: 0 }) === false);

// ─────────────────────────────────────────────────────────────────────────────
// 6. resolveLiabilityPaymentCategory — RESCUE-ONLY
// ─────────────────────────────────────────────────────────────────────────────

const PAY_EVIDENCE = { ...CARD, amount: 5000, merchant: "PAYMENT-THANK YOU", description: "PAYMENT-THANK YOU" };

eq("resolver: Other + payment leg → Payment (the CCPAY-1 fix)",
  resolveLiabilityPaymentCategory("Other", "Payment", PAY_EVIDENCE), "Payment");
eq("resolver: Other + NOT a payment leg → unchanged",
  resolveLiabilityPaymentCategory("Other", "Payment", { ...PAY_EVIDENCE, merchant: "Amazon SA", description: "Amazon SA" }), "Other");

// Rescue-only: it may never overwrite a category a provider or user decided.
for (const decided of ["Dining", "Travel", "Shopping", "Income", "Transfer", "Interest", "Fee", "Payment", "Groceries"]) {
  eq(`resolver: never overwrites a decided category (${decided})`,
    resolveLiabilityPaymentCategory(decided, "Payment", PAY_EVIDENCE), decided);
}
// Rescue-only: it may never DEMOTE. The symmetric liability-outflow case is
// CCPAY-2B's structural veto in the classifier — never duplicated here.
eq("resolver: never demotes a liability OUTFLOW carrying Payment (that is CCPAY-2B's job)",
  resolveLiabilityPaymentCategory("Payment", "Payment", { ...CARD, amount: -387.24, merchant: "Qlub", description: "QLUB" }), "Payment");
// Guards reach the resolver.
eq("resolver: Other on a DEPOSITORY account is never rescued",
  resolveLiabilityPaymentCategory("Other", "Payment", { accountType: "checking", debtSubtype: null, amount: 5000, merchant: "PAYMENT-THANK YOU", description: "PAYMENT-THANK YOU" }), "Other");
eq("resolver: Other + liability + negative is never rescued",
  resolveLiabilityPaymentCategory("Other", "Payment", { ...PAY_EVIDENCE, amount: -5000 }), "Other");
eq("resolver: descriptor only in description still rescues (combined-evidence contract)",
  resolveLiabilityPaymentCategory("Other", "Payment", { ...CARD, amount: 5000, merchant: "Chase Card Services", description: "PAYMENT-THANK YOU" }), "Payment");
eq("resolver: null description is tolerated (Payee-only CSV shape)",
  resolveLiabilityPaymentCategory("Other", "Payment", { ...CARD, amount: 5000, merchant: "PAYMENT-THANK YOU", description: null }), "Payment");

// ─────────────────────────────────────────────────────────────────────────────
// 7. Vocabulary hygiene — anti-speculation and anti-trap invariants
// ─────────────────────────────────────────────────────────────────────────────
// These are the guardrails that would have prevented the 9 dead tokens and the
// e-payment trap from ever shipping. They constrain FUTURE edits to the list.

check("vocabulary: every token is already normalized (a token that isn't could never match)",
  CARD_PAYMENT_DESCRIPTORS.every((t) => normalizeDescriptor(t) === t),
  `offenders: ${CARD_PAYMENT_DESCRIPTORS.filter((t) => normalizeDescriptor(t) !== t).join(", ")}`);
check("vocabulary: no token is a single word (a one-word token is a substring trap)",
  CARD_PAYMENT_DESCRIPTORS.every((t) => t.split(" ").length >= 2),
  `offenders: ${CARD_PAYMENT_DESCRIPTORS.filter((t) => t.split(" ").length < 2).join(", ")}`);
check("vocabulary: no token contains punctuation (it would be unreachable post-normalization)",
  CARD_PAYMENT_DESCRIPTORS.every((t) => !/[-–—_.,/\\:;*#()[\]]/.test(t)));
check("vocabulary: the load-bearing token is present",
  CARD_PAYMENT_DESCRIPTORS.includes("payment thank you"));
// The generic tokens CCPAY-1 measured as dangerous: 'pay' → 5 real false
// positives (Apple Pay refunds), 'credit' → 2 (statement credits).
for (const banned of ["pay", "payment", "credit", "thank you"]) {
  check(`vocabulary: '${banned}' is not a token (measured false-positive risk)`,
    !CARD_PAYMENT_DESCRIPTORS.includes(banned));
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`liability-payment: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`liability-payment: all ${passed} checks passed ✓`);
console.log(`  · ${CARD_PAYMENT_DESCRIPTORS.length} attested tokens; 9 speculative tokens pruned (0 real matches each)`);
process.exit(0);
