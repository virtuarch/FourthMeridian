/**
 * lib/ai/intent/keywords.ts
 *
 * Authoritative keyword vocabulary for Layer 0 intent understanding (KD-11).
 *
 * Before KD-11 the payoff / update-action / update-field vocabularies existed as
 * two divergent copies — one in the intent classifier, one inline in the chat
 * route's knowledge-gap gating. They had drifted, and only the classifier copy
 * was tested. This module is now the single source of truth: the tokens shared
 * by both consumers are defined ONCE (the `*_SHARED` / `*_CORE` cores), and each
 * consumer's full list is composed from that core plus its own additions.
 *
 * ── Deliberate reconciliation (KD-11 Phase B) ─────────────────────────────────
 * The two consumers serve DIFFERENT purposes and are intentionally NOT merged
 * into one flat list — doing so would change behaviour on one side, and the
 * classifier's semantics are frozen. The composition below therefore reproduces
 * each consumer's existing token set EXACTLY (verified token-for-token against
 * the pre-KD-11 arrays), so behaviour is preserved on both sides:
 *
 *   - `*_ROUTING_*`  → consumed by the classifier (classifier.ts) to route intent.
 *   - `*_GAP_*`      → consumed by the chat route's gap gating (gap-intent.ts) to
 *                      decide which knowledge-gap UI to surface.
 *
 * The gain is structural: the shared tokens live in one place, so the two lists
 * can no longer drift silently, and every consumer-specific token is now an
 * explicit, documented decision rather than an accidental divergence.
 *
 * List decisions recorded here (why each consumer differs from the shared core):
 *   PAYOFF   — GAP adds 'minimum payment', 'monthly payment', 'schedule',
 *              'amortize', 'amortization', and the broad 'when will' because the
 *              gap gate must surface a minimumPayment gap for those operational
 *              phrasings. ROUTING instead carries payoff-*plan* phrasings
 *              ('get out of debt', 'pay it down', 'schedule to pay', the 'amortiz'
 *              stem, 'when will i/my', 'time line', 'paid off') used to route
 *              DEBT_PAYOFF_PLAN. These sets were already distinct pre-KD-11 and
 *              are preserved unchanged.
 *   ACTION   — GAP includes 'add'; ROUTING includes 'record', 'adjust', 'modify'.
 *              Preserved as-is (no behavioural change).
 *   FIELD    — GAP uses only the debt-metadata core (apr / rate / minimum
 *              payment). ROUTING additionally recognises 'balance', 'limit',
 *              'credit limit', 'due date', 'statement', and the possessive
 *              'my chase / my card / my account'. Preserved as-is.
 *
 * Reconciling the *content* of these differences (e.g. teaching the gap gate to
 * recognise 'get out of debt', or the router to recognise 'minimum payment') is
 * a deliberate behavioural change and is OUT OF SCOPE for KD-11 — that would
 * require changing classifier semantics and/or route behaviour, both of which
 * KD-11 forbids. It is noted for a future ticket.
 */

// ── Payoff vocabulary ─────────────────────────────────────────────────────────

/** Tokens common to both the router and the gap gate. */
const PAYOFF_SHARED = [
  'payoff', 'pay off', 'pay-off',
  'timeline', 'how long',
  'debt free', 'debt-free',
  'paydown', 'pay down',
  'how many months',
] as const;

/** Classifier (DEBT_PAYOFF_PLAN routing). Frozen — identical to the pre-KD-11 set. */
export const PAYOFF_ROUTING_WORDS: readonly string[] = [
  ...PAYOFF_SHARED,
  'paid off',
  'when will i', 'when will my',
  'time line',
  'pay it down',
  'amortiz',
  'schedule to pay', 'plan to pay',
  'get out of debt',
];

/** Chat route gap gating (surface minimumPayment gaps). Identical to the pre-KD-11 set. */
export const PAYOFF_GAP_KEYWORDS: readonly string[] = [
  ...PAYOFF_SHARED,
  'minimum payment',
  'monthly payment',
  'when will',
  'amortize', 'amortization',
  'schedule',
];

// ── Update-action vocabulary (verbs) ──────────────────────────────────────────

const UPDATE_ACTION_SHARED = [
  'update', 'save', 'set', 'change', 'enter', 'edit', 'fix', 'correct',
] as const;

/** Classifier (UPDATE_KNOWLEDGE routing). Frozen — identical to the pre-KD-11 set. */
export const UPDATE_ACTION_ROUTING_WORDS: readonly string[] = [
  ...UPDATE_ACTION_SHARED,
  'record', 'adjust', 'modify',
];

/** Chat route gap gating. Identical to the pre-KD-11 set. */
export const UPDATE_ACTION_GAP_KEYWORDS: readonly string[] = [
  ...UPDATE_ACTION_SHARED,
  'add',
];

// ── Update-field vocabulary (nouns) ───────────────────────────────────────────

/** Debt-metadata fields recognised by the chat route gap gate (the shared core). */
const UPDATE_FIELD_CORE = [
  'apr', 'interest rate', 'rate', 'minimum payment', 'min payment',
] as const;

/** Chat route gap gating. Identical to the pre-KD-11 set (== the core). */
export const UPDATE_FIELD_GAP_KEYWORDS: readonly string[] = [...UPDATE_FIELD_CORE];

/** Classifier (UPDATE_KNOWLEDGE routing). Frozen — identical to the pre-KD-11 set. */
export const UPDATE_FIELD_ROUTING_WORDS: readonly string[] = [
  ...UPDATE_FIELD_CORE,
  'balance', 'limit', 'credit limit', 'due date', 'statement',
  'my chase', 'my card', 'my account',
];
