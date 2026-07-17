/**
 * lib/transactions/liability-payment.ts
 *
 * CCPAY-2A / CCPAY-2B — the SINGLE authority for liability-side payment
 * structure. Every classification entry point reaches this module: the four
 * classifyFlow call sites (Plaid sync, CSV import, merchant corrections, flow
 * backfill) reach it THROUGH lib/transactions/flow-classifier.ts, which is the
 * one chokepoint they all share; the two category-rescue call sites (Plaid sync,
 * scripts/backfill-cc-payment-categories.ts) reach it directly.
 *
 * ── Why this module exists (CCPAY-2A) ────────────────────────────────────────
 * Before it, "is this account a liability?" was written TWICE, in two modules
 * that could silently drift:
 *   • plaid-category.ts  isLiabilityCardPaymentLeg — accountType==="debt" || debtSubtype
 *   • flow-classifier.ts isDebtAccount             — accountType==="debt" || debtSubtype
 * They agreed by luck, not by construction. Both now delegate here. There is
 * exactly ONE definition of liability-ness in the platform.
 *
 * ── Zero runtime dependencies ────────────────────────────────────────────────
 * This module imports NOTHING. That is a hard constraint, not an accident:
 * flow-classifier.ts is PRISMA-FREE and must stay runnable under plain `tsx`
 * without `prisma generate`, and plaid-category.ts re-exports from here — so any
 * import added here could create a cycle or drag Prisma into the classifier.
 * `accountType` is a plain string (callers pass the AccountType enum value,
 * which is already a string) for exactly the reason flow-classifier documents.
 *
 * ── Scope discipline (CCPAY-2A/2B) ───────────────────────────────────────────
 * The descriptor vocabulary below is MOVED VERBATIM from plaid-category.ts. Not
 * one token was added, removed, or reworded, and the matching is still raw
 * case-folded substring. Normalization + vocabulary pruning is CCPAY-2C and is
 * deliberately NOT done here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The liability definition — ONE authority (CCPAY-2A)
// ─────────────────────────────────────────────────────────────────────────────

/** The account-shape half of every predicate here. */
export interface LiabilityAccountContext {
  /**
   * FinancialAccount.type (AccountType value). `"debt"` is the PRIMARY liability
   * signal — Plaid `type: "credit"`/`"loan"` maps to AccountType.debt at import
   * (lib/plaid/exchangeToken.ts mapAccountType). This is the field actually
   * populated for Plaid-synced credit cards.
   */
  accountType?: string | null;
  /**
   * FinancialAccount.debtSubtype — a SECONDARY accepted signal. Never populated
   * by the Plaid import path (only the flat legacy column; real debt data lives
   * on DebtProfile), so it is null for Plaid cards — but a non-null value (e.g.
   * a manually-entered liability) is still honored.
   */
  debtSubtype?: string | null;
}

/** A liability movement: the account shape plus the FM-signed amount. */
export interface LiabilityMovementInput extends LiabilityAccountContext {
  /** FM sign convention: + into the row's own account, − out of it. */
  amount: number;
}

/**
 * THE definition of "this row sits on a liability account". Every other
 * predicate in the platform that needs to know this calls here.
 *
 * Liability is signalled PRIMARILY by `accountType === "debt"` (the field Plaid
 * actually populates) and SECONDARILY by a non-null `debtSubtype` (manual
 * liabilities). Either suffices.
 */
export function isLiabilityAccount(input: LiabilityAccountContext): boolean {
  return (
    input.accountType === "debt" ||
    (input.debtSubtype != null && input.debtSubtype !== "")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CCPAY-2B — the structural negative-liability veto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TRUE when money moved OUT of a liability account — i.e. the balance owed went
 * UP. Structurally this is a charge: a purchase, a fee, an interest accrual, a
 * cash advance. It is NEVER a debt payment: you cannot pay a card down by
 * increasing what you owe on it.
 *
 * This is the veto condition behind CCPAY-2B. It is PURELY STRUCTURAL — it reads
 * only the account shape and the sign, never a provider category, never a
 * descriptor, never an institution. That is the whole point: it holds no matter
 * what a provider claims.
 *
 * Motivating evidence (CCPAY-1 census of the live corpus): five posted rows were
 * classified DEBT_PAYMENT purely because Plaid's PFC said LOAN_PAYMENTS, while
 * every one of them was an ordinary card purchase —
 *   Qlub (a restaurant bill-split app)  −387.24 / −403.43  LOAN_PAYMENTS_CAR_PAYMENT
 *   AMERICAN EXPRESS TRASEATTLE         −506.98            LOAN_PAYMENTS_CREDIT_CARD_PAYMENT
 *   AplPay DISCOVER SINGSINGAPORE SG     −77.56            LOAN_PAYMENTS_CREDIT_CARD_PAYMENT
 *   DYNEFF DACGRAINC2972954             −107.41            LOAN_PAYMENTS_OTHER_PAYMENT
 * $1,482.62 of real spending filed as debt reduction and excluded from the spend
 * ledger. Plaid saw the brand string "AMERICAN EXPRESS" on a travel booking and
 * tagged it a credit-card payment. Account context outranks the provider tag.
 *
 * This is the SAME argument CF-4 already made for TRANSFER_OUT (a liability
 * holds no owned cash to transfer out); CCPAY-2B applies it to the LOAN_PAYMENTS
 * and Payment-category paths, which CF-4 never covered.
 */
export function isLiabilityOutflow(input: LiabilityMovementInput): boolean {
  return isLiabilityAccount(input) && input.amount < 0;
}

/**
 * TRUE when money moved INTO a liability account — the balance owed went DOWN.
 * The structural PRECONDITION of a card-payment leg, and deliberately NOT
 * sufficient on its own: this population also contains merchant refunds,
 * statement credits, reward redemptions, dispute credits, and fee reversals
 * (CCPAY-1 measured 34 such rows against 109 real payments). An attestation —
 * today a descriptor match — is still required.
 */
export function isLiabilityInflow(input: LiabilityMovementInput): boolean {
  return isLiabilityAccount(input) && input.amount > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// CC-1 — the liability-side payment-candidate predicate.
//
// MOVED VERBATIM from lib/transactions/plaid-category.ts (CCPAY-2A). Behavior is
// byte-identical; only the home changed, so that the liability definition above
// has exactly one implementation. plaid-category.ts re-exports these for its
// existing importers.
//
// The DESTINATION leg of a card payment is a positive credit sitting on the
// card's own account ("Payment Thank You-Mobile"). Plaid tags these
// inconsistently, so some fall through mapPlaidCategory's `default → Other`
// (see docs/investigations/CREDIT_CARD_PAYMENT_CLASSIFICATION_INVESTIGATION.md).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CCPAY-2C-1 — descriptor normalization (FORMAT ONLY)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Separators an issuer may use where another issuer uses a space. Folded to a
 * space, never deleted: the observed defect was Chase's pending descriptor
 * "PAYMENT-THANK YOU" failing to match "payment thank you" over a single hyphen.
 *
 * Includes the Unicode en/em dashes because NFKD does NOT decompose them to
 * ASCII hyphen-minus. HONESTY: no real provider descriptor in the corpus carries
 * one — the only 36 instances are prisma/seed.ts fixture text ("Acme Corp —
 * Invoice #1046"). They are folded because it is free and structural, NOT
 * because a bank was observed doing it. Same for `_ . , / \ : ; * # ( ) [ ]`:
 * only the hyphen forms are attested. This comment exists so the next reader
 * does not mistake this set for evidence.
 */
const DESCRIPTOR_SEPARATORS = /[-–—_.,/\\:;*#()[\]]+/g;

/** Combining marks left behind by NFKD (e.g. "é" → "e" + U+0301). */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * FORMAT-ONLY descriptor normalization. Folds the ways issuers write the SAME
 * phrase; never changes which phrases mean "payment" (that is vocabulary, and
 * CCPAY-2C deliberately does not touch it).
 *
 *   PAYMENT-THANK YOU  ·  PAYMENT.THANK.YOU  ·  PAYMENT_THANK_YOU
 *   PAYMENT / THANK YOU  ·  PAYMENT  THANK  YOU  ·  PAYMENT—THANK YOU
 *        ↓ all become ↓
 *   payment thank you
 *
 * Deliberately NOT lib/transactions/merchant.ts's normalizeMerchant: that folds
 * punctuation at the EDGES only (trimSeparators is anchored ^/$), so it would
 * not fix "PAYMENT-THANK YOU" at all. It is also a merchant-IDENTITY normalizer
 * (it strips store numbers and masked tails) whose output feeds Merchant keys —
 * a different job with a different contract. Consolidating the platform's other
 * normalizers is explicitly out of scope here.
 */
export function normalizeDescriptor(value: string): string {
  return value
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(DESCRIPTOR_SEPARATORS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalized words of a descriptor, in order. `[]` for an empty descriptor. */
function descriptorWords(value: string): string[] {
  const n = normalizeDescriptor(value);
  return n === "" ? [] : n.split(" ");
}

/**
 * True when `needle`'s words appear as a CONTIGUOUS WORD SUBSEQUENCE of `words`.
 *
 * Word-boundary matching is load-bearing, not stylistic. Substring matching over
 * NORMALIZED text is actively unsafe: normalizing the token "e-payment" yields
 * "e payment", which is a substring of "mobil<e payment>", "Zell<e payment> to
 * Mom", and every "Payment Thank You-Mobil<e>" + "<payment>" seam — measured at
 * 156 rows against 0 for word-boundary. One token's blast radius went 0 → 156
 * purely from normalizing it.
 *
 * It also dissolves an otherwise irreconcilable tension: "payment-thank you"
 * needs `-` → space, while "e-payment" needs `-` → deleted. As word sequences
 * both are simply themselves.
 */
function containsPhrase(words: readonly string[], needle: string): boolean {
  const target = descriptorWords(needle);
  if (target.length === 0) return false;
  for (let i = 0; i + target.length <= words.length; i++) {
    let hit = true;
    for (let j = 0; j < target.length; j++) {
      if (words[i + j] !== target[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * INSTITUTION-AGNOSTIC card-payment acknowledgment phrases — the descriptors
 * issuers put on the card-side payment credit. Deliberately NOT tied to any
 * brand (no "chase"): the pattern is the payment acknowledgment.
 *
 * ── CCPAY-2C-2: every token here is ATTESTED in real provider data ───────────
 * Nine tokens were removed. Each matched ZERO of 4,334 real rows under BOTH the
 * old literal matcher and the new word-boundary one — they were authored from
 * imagination about issuers this platform has never connected:
 *   cardmember payment · cardmember serv · credit crd autopay · card autopay
 *   autopay payment · online payment · payment received · epayment · e-payment
 *
 * COVERAGE DELIBERATELY SURRENDERED — a payment descriptor that does NOT say
 * "thank you" (bare "ONLINE PAYMENT", "DISCOVER E-PAYMENT", "CARDMEMBER SERV WEB
 * PMT", "CREDIT CRD AUTOPAY 1234") no longer rescues. Descriptors that DO say
 * "thank you" still do, via "payment thank you", regardless of the prefix —
 * "AUTOPAY PAYMENT - THANK YOU" and "ONLINE PAYMENT, THANK YOU" both still
 * match. The surrender is pinned as explicit negative assertions in
 * plaid-category.test.ts, NOT left silent: when real Citi/Discover/Wells rows
 * arrive, re-add the tokens their descriptors actually use and flip those tests.
 *
 * Measured over the corpus (rows matched / rows ONLY this token matches):
 *   payment thank you   109 / 1   ← load-bearing; the only token matching
 *                                   Chase's pending "PAYMENT-THANK YOU"
 *   thank you mobile    108 / 0   ← attested, redundant, kept (see below)
 *   mobile payment      108 / 0   ← attested, redundant, kept (see below)
 *
 * "payment thank you" alone covers all 109. The other two are kept because they
 * are ATTESTED — they occur in real Chase/Amex descriptor text — not because
 * they add coverage. Pruning to a single token would over-fit a two-issuer
 * corpus, and they are proven to add zero false positives even UNGUARDED.
 */
export const CARD_PAYMENT_DESCRIPTORS: readonly string[] = [
  "payment thank you",  // "PAYMENT-THANK YOU" (Chase, pending) · "Payment Thank You-Mobile" (Chase, posted) · "MOBILE PAYMENT - THANK YOU" (Amex)
  "thank you mobile",   // "Payment Thank You-Mobile" (Chase, posted)
  "mobile payment",     // "MOBILE PAYMENT - THANK YOU" (Amex)
];

/**
 * True when the COMBINED merchant + description evidence contains a card-payment
 * phrase.
 *
 * ── The combined-evidence contract (do not narrow this to one field) ─────────
 * Both fields are searched because they carry DIFFERENT text. `description` is
 * the raw issuer descriptor (Plaid `txn.name`); `merchant` is Plaid's ENRICHED
 * name with a raw fallback (`txn.merchant_name ?? txn.name`). Measured over
 * 4,334 rows: they differ on 2,168 (50%) — "Apple" vs "APPLE.COM/BILL". All 109
 * real card payments happen to have merchant === description only because Plaid
 * failed to enrich them; that is luck, not contract. The moment an issuer's
 * payment row IS enriched (merchant → "Chase Card Services"), the descriptor
 * survives ONLY in description. Searching one field would silently lose it.
 *
 * KNOWN PROPERTY of joining the fields: the join can synthesize a phrase present
 * in NEITHER field. When merchant === description (a Description-only CSV, or an
 * unenriched Plaid row), "MOBILE PAYMENT - THANK YOU" joins to "...thank you
 * mobile payment thank you", so "thank you mobile" matches across the seam. This
 * is measured, benign (0 false positives across the whole corpus, guarded or
 * not), and pinned by test — recorded here rather than "fixed", since narrowing
 * the join would break the enrichment contract above.
 *
 * Descriptor-only — NOT sufficient alone to classify a payment (an ordinary
 * checking row can carry payment text); it MUST be combined with the account-side
 * + sign guard in isLiabilityCardPaymentLeg.
 */
export function isCardPaymentDescriptor(
  merchant: string | null | undefined,
  name?: string | null | undefined,
): boolean {
  const words = descriptorWords(`${merchant ?? ""} ${name ?? ""}`);
  if (words.length === 0) return false;
  return CARD_PAYMENT_DESCRIPTORS.some((token) => containsPhrase(words, token));
}

/** Inputs for the guarded card-payment-leg predicate. FM sign convention: amount > 0 = money into the row's own account. */
export interface CardPaymentLegInput extends LiabilityMovementInput {
  merchant: string | null | undefined;
  name?:    string | null | undefined;
}

/**
 * SINGLE source of truth for "this row is the destination leg of a credit-card
 * payment" — used by BOTH the live sync write path and the historical backfill
 * so they can never diverge.
 *
 * Deterministic guard, all three conditions required:
 *   1. the row sits on a LIABILITY account, AND
 *   2. amount > 0 (a credit INTO that liability — i.e. a payment received), AND
 *   3. the descriptor matches a generalized card-payment phrase.
 *
 * Conditions 1+2 are now `isLiabilityInflow` — the same authority the CCPAY-2B
 * veto reads, so the promote and veto halves can never disagree about what a
 * liability is.
 *
 * The liability + positive-sign guard is what prevents ordinary merchant rows
 * (or a checking-account "online payment") from ever being misread as a debt
 * payment, and prevents ANY card PURCHASE (amount < 0) from flipping to Payment.
 */
export function isLiabilityCardPaymentLeg(input: CardPaymentLegInput): boolean {
  return isLiabilityInflow(input) && isCardPaymentDescriptor(input.merchant, input.name);
}

// ─────────────────────────────────────────────────────────────────────────────
// CCPAY-2C-3 — the ONE category-rescue decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only category the rescue may overwrite: the "provider told us nothing
 * useful" sentinel that mapPlaidCategory's `default` and the CSV importer's
 * mapCategory fallback both produce.
 */
const UNRESOLVED_CATEGORY = "Other";

/**
 * Evidence for the rescue decision. Both descriptor fields are REQUIRED (not
 * optional) so a caller CANNOT silently pass half the evidence — the combined
 * merchant+description contract is pinned by the type, not by convention. Pass
 * an explicit null for a genuinely absent field (a Payee-only CSV import has no
 * description; every Plaid row has both).
 */
export interface LiabilityPaymentEvidence extends LiabilityMovementInput {
  merchant:    string | null;
  description: string | null;
}

/**
 * SINGLE authority for "should this row's category be rescued to the payment
 * category?" — the decision previously inlined at the Plaid sync seam and
 * reachable from nowhere else.
 *
 * ── RESCUE-ONLY by construction ─────────────────────────────────────────────
 * Returns `category` UNCHANGED unless it is the unresolved sentinel. It can
 * therefore never contradict a category a provider decided confidently, never
 * overwrite a user correction, and never demote anything. It is a promote-from-
 * unknown, nothing more. The symmetric demote (a liability OUTFLOW wrongly
 * carrying "Payment") is NOT this function's job — CCPAY-2B handles that
 * structurally in the classifier, and duplicating it here would create a second
 * authority for the same fact.
 *
 * `paymentCategory` is supplied by the caller rather than named here because
 * this module is zero-import BY CONTRACT (flow-classifier.ts imports it and must
 * stay Prisma-free and tsx-runnable), so it cannot reference the
 * TransactionCategory enum. The generic keeps the call site fully type-checked:
 * T is inferred as TransactionCategory, so an invalid value will not compile.
 */
export function resolveLiabilityPaymentCategory<T extends string>(
  category: T,
  paymentCategory: T,
  evidence: LiabilityPaymentEvidence,
): T {
  if (category !== UNRESOLVED_CATEGORY) return category;
  return isLiabilityCardPaymentLeg({ ...evidence, name: evidence.description })
    ? paymentCategory
    : category;
}
