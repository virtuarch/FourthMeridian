/**
 * lib/ai/economic-concepts.ts
 *
 * CF-7 — WHAT "INVESTMENTS" MEANS, DECIDED BY CODE.
 *
 * Pure and deterministic: no DB, no model, no clock. It reads assembled domain
 * payloads and returns a composition — or a refusal to compose.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * After CF-6 the evidence is reachable, and nothing says what to do with it. A
 * user's "investments" spans two authorities the product keeps deliberately
 * apart, and the model was left to join them itself. The measured failure,
 * with illustrative figures of the same shape:
 *
 *     holdings.totalPortfolioValue  $24,900.01
 *     accounts.totalDigitalAssets   $20,000.01
 *     sum                           $44,900.02   ← overstates by $19,900.00
 *
 * That addition is the obvious one to make and it is wrong by ~80%, because
 * `holdings_summary` is the canonical POSITION spine and already contains the
 * digital assets. The two figures look like disjoint components and are not.
 *
 * ── Composition authority vs detail authority ───────────────────────────────
 * The distinction this module exists to enforce:
 *
 *   COMPOSITION  `accounts.totalInvestments` + `accounts.totalDigitalAssets`
 *                — disjoint BY CONSTRUCTION, see `INVESTMENTS` below
 *   DETAIL       `holdings_summary` — positions, weights, concentration
 *
 * A detail authority must never silently become the arithmetic authority. The
 * spine is the right thing to read for "what do I hold"; its total is the wrong
 * thing to add anything to.
 *
 * ── Why a combined total can be withheld ────────────────────────────────────
 * A component is not a number, it is a number OR a reason there isn't one. An
 * account the Space cannot see contributes nothing to the totals, and treating
 * that silence as zero would report someone's finances as smaller than they
 * are. So absence is typed, and a combined figure is emitted only when every
 * component is either measured or provably empty.
 */

import type { AccountsSectionData } from '@/lib/ai/types';
import {
  describeExcludedTypes, excludedFromAiAccounts, partialTotalStatement,
  type ExcludedAccount, type ExcludedAccountClass, type ExclusionDirection, type PartialTotalStatement,
} from '@/lib/balances/unobserved-totals';

/**
 * Whether a component's amount can be stated.
 *
 * ABSENT and UNKNOWN are deliberately different. "You hold no crypto" and "some
 * of your accounts are hidden from this Space" support different sentences, and
 * a system that merges them will eventually report the second as the first.
 */
export const ComponentState = {
  /** Measured. `amount` is the figure. */
  ASSERTABLE: 'ASSERTABLE',
  /** Provably empty: no accounts of this class, nothing hidden. `amount` is 0. */
  ABSENT:     'ABSENT',
  /** Indeterminate — hidden accounts, or balances excluded from the totals. */
  UNKNOWN:    'UNKNOWN',
} as const;

export type ComponentStateKind = typeof ComponentState[keyof typeof ComponentState];

export interface ConceptComponent {
  key:     string;
  /** How this component is described to a person. */
  label:   string;
  state:   ComponentStateKind;
  /** Null unless ASSERTABLE or ABSENT. */
  amount:  number | null;
  /** How many accounts contribute. */
  accountCount: number;
  /** Why the amount cannot be stated, when it cannot. */
  reason:  string | null;
}

export interface ConceptComposition {
  concept: 'INVESTMENTS';
  components: ConceptComponent[];
  /**
   * The sum, or null when any component is UNKNOWN.
   *
   * Derived every time from the components beside it, never stored — the same
   * rule CF-1 and CF-2 use, for the same reason: a total that can disagree with
   * its own parts will eventually do so.
   */
  combined: number | null;
  /** Present when `combined` is null. */
  withheldReason: string | null;
  currency: string;
}

/** Round to the cent. */
const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * INVESTMENTS = traditional investments + digital assets.
 *
 * ── Disjointness, proven rather than assumed ────────────────────────────────
 * `classifyAccounts` (lib/account-classifier.ts) partitions on ONE scalar field:
 *
 *     investments   = accounts.filter(a => a.type === 'investment')
 *     digitalAssets = accounts.filter(a => isDigitalAssetAccountType(a.type))
 *                     where DIGITAL_ASSET_ACCOUNT_TYPES = ['crypto']
 *
 * `type === 'investment'` and `type === 'crypto'` are mutually exclusive
 * predicates over a single value, so no account can land in both bucket. That
 * is disjointness BY CONSTRUCTION — a property of the partition, not of any
 * Space's data — which is what makes the sum safe universally rather than
 * safe-so-far. The classifier states the same rule in its own words: "a crypto
 * position must never also count as an investment."
 *
 * ⚠️ `holdings.totalPortfolioValue` is NOT a substitute for the first component.
 * It spans both classes, so adding it to the second double-counts.
 */
export function composeInvestments(
  accounts: AccountsSectionData | null | undefined,
): ConceptComposition | null {
  if (!accounts) return null;

  const currency = 'USD';

  // Two facts that make ANY component indeterminate, because neither is
  // attributable to a class: a hidden account might be an investment account,
  // and an unconvertible balance was dropped from whichever total it belonged
  // to. Coarse on purpose — a redacted checking account also withholds the
  // combined figure, which errs toward silence rather than toward a total that
  // might be short.
  const hidden      = (accounts.redactedCount ?? 0) > 0;
  const unconverted = accounts.totalsUnconverted === true;
  const indeterminate = hidden
    ? `${accounts.redactedCount} account(s) in this Space are hidden from this context, so an unseen investment account cannot be ruled out`
    : unconverted
      ? 'at least one balance could not be converted to the reporting currency and was excluded from the totals'
      : null;

  // FM-AUDIT-022 / Mortgage F8a — an account of unknown balance was EXCLUDED
  // from its class total (never counted at 0). Attributed BY TYPE through the
  // one detector: an unvalued crypto wallet makes digital assets indeterminate,
  // an unobserved investment account makes traditional investments
  // indeterminate, and an unobserved mortgage (or any debt / cash account)
  // touches NEITHER — it is a partial debt total (`composeExcludedTotals`).
  const excluded = excludedFromAiAccounts(accounts);
  const digitalIndeterminate = classExclusionReason(excluded, ['DIGITAL_ASSET', 'UNKNOWN'], 'digital-asset total');
  const tradIndeterminate    = classExclusionReason(excluded, ['INVESTMENT', 'UNKNOWN'], 'investment total');

  const component = (
    key: string, label: string, amount: number | undefined, accountCount: number,
    classIndeterminate: string | null = null,
  ): ConceptComponent => {
    if (indeterminate) {
      return { key, label, state: ComponentState.UNKNOWN, amount: null, accountCount, reason: indeterminate };
    }
    if (classIndeterminate) {
      return { key, label, state: ComponentState.UNKNOWN, amount: null, accountCount, reason: classIndeterminate };
    }
    if (accountCount === 0) {
      // Provably empty: the classification found no accounts of this class and
      // nothing is hidden. Zero is a fact here, not a missing value.
      return { key, label, state: ComponentState.ABSENT, amount: 0, accountCount: 0, reason: null };
    }
    return {
      key, label, state: ComponentState.ASSERTABLE,
      amount: cents(amount ?? 0), accountCount, reason: null,
    };
  };

  const components = [
    component('TRADITIONAL_INVESTMENTS', 'Traditional investments',
      accounts.totalInvestments, accounts.counts?.investments ?? 0, tradIndeterminate),
    component('DIGITAL_ASSETS', 'Digital assets',
      accounts.totalDigitalAssets, accounts.counts?.digitalAssets ?? 0, digitalIndeterminate),
  ];

  // Nothing of either kind, and nothing hidden — the concept does not apply and
  // must not be rendered as a row of zeroes.
  if (components.every((c) => c.state === ComponentState.ABSENT)) return null;

  const unknown = components.filter((c) => c.state === ComponentState.UNKNOWN);
  // Summed from the ROUNDED components, not from the raw balances.
  //
  // The two differ by a cent here (illustratively $5,000.01 + $20,000.01 = $25,000.02,
  // while rounding the raw sum gives $25,000.01) and the rounded-component sum is the
  // right one: the components are what the user is shown, and a total they
  // cannot reproduce by adding the two figures in front of them reads as an
  // error in the system rather than as rounding.
  const combined = unknown.length > 0
    ? null
    : cents(components.reduce((s, c) => s + (c.amount ?? 0), 0));

  return {
    concept: 'INVESTMENTS',
    components,
    combined,
    withheldReason: unknown.length > 0
      ? `${unknown.map((c) => c.label.toLowerCase()).join(' and ')} cannot be measured here — ${unknown[0].reason}`
      : null,
    currency,
  };
}

/** Why a class total is withheld, naming the excluded types — or null. */
function classExclusionReason(
  excluded: readonly ExcludedAccount[], classes: readonly ExcludedAccountClass[], totalName: string,
): string | null {
  const hit = excluded.filter((e) => classes.includes(e.accountClass));
  if (hit.length === 0) return null;
  const n = hit.reduce((s, e) => s + e.count, 0);
  const verb = n === 1 ? 'is' : 'are';
  const why = hit.every((e) => e.reason === 'UNVALUED')
    ? `not yet valued (no price or no observation) and ${verb} excluded from the ${totalName}`
    : `of unknown balance (never observed or not yet valued) and ${verb} excluded from the ${totalName}`;
  return `${describeExcludedTypes(hit)} ${verb} ${why}`;
}

// ── Excluded balances, attributed by type (Mortgage F8a) ─────────────────────

/** The class a PARTIAL attribution is reported under. */
export type ExcludedClassKey =
  | 'DEBT' | 'CASH' | 'TRADITIONAL_INVESTMENTS' | 'DIGITAL_ASSETS' | 'OTHER_ASSETS' | 'UNATTRIBUTED';

export interface ExcludedClassComponent {
  key:       ExcludedClassKey;
  label:     string;
  state:     'PARTIAL';
  direction: ExclusionDirection;
  count:     number;
  /** In-sentence type names, e.g. ["mortgage"]. */
  types:     string[];
  reason:    string;
}

export interface ExcludedTotalsComposition {
  concept: 'EXCLUDED_BALANCES';
  /** One per class with an exclusion, debt first. */
  classes: ExcludedClassComponent[];
  /** Each headline total that is PARTIAL, with direction and typed wording. */
  totals:  PartialTotalStatement[];
}

const CLASS_KEY: Readonly<Record<ExcludedAccountClass, { key: ExcludedClassKey; label: string; total: string }>> = {
  DEBT:          { key: 'DEBT',                    label: 'Debt',                    total: 'debt total' },
  CASH:          { key: 'CASH',                    label: 'Cash',                    total: 'cash total' },
  INVESTMENT:    { key: 'TRADITIONAL_INVESTMENTS', label: 'Traditional investments', total: 'investment total' },
  DIGITAL_ASSET: { key: 'DIGITAL_ASSETS',          label: 'Digital assets',          total: 'digital-asset total' },
  OTHER_ASSET:   { key: 'OTHER_ASSETS',            label: 'Other assets',            total: 'other-asset total' },
  UNKNOWN:       { key: 'UNATTRIBUTED',            label: 'Unattributed accounts',   total: 'totals' },
};

const CLASS_ORDER: readonly ExcludedAccountClass[] = ['DEBT', 'CASH', 'INVESTMENT', 'DIGITAL_ASSET', 'OTHER_ASSET', 'UNKNOWN'];

/**
 * Which class totals are PARTIAL because an account of unknown balance was
 * excluded, attributed BY TYPE — never misattributed. An unobserved mortgage
 * is a DEBT partial ("debt may be understated"), never a digital-asset one.
 * Null when nothing was excluded.
 */
export function composeExcludedTotals(
  accounts: AccountsSectionData | null | undefined,
): ExcludedTotalsComposition | null {
  const excluded = excludedFromAiAccounts(accounts);
  if (excluded.length === 0) return null;
  const classes: ExcludedClassComponent[] = [];
  for (const cls of CLASS_ORDER) {
    const hit = excluded.filter((e) => e.accountClass === cls);
    if (hit.length === 0) continue;
    const meta = CLASS_KEY[cls];
    const n = hit.reduce((s, e) => s + e.count, 0);
    const types = [...new Set(hit.map((e) => e.label))];
    const isDebt = cls === 'DEBT';
    classes.push({
      key: meta.key, label: meta.label, state: 'PARTIAL',
      direction: isDebt ? 'TRUE_TOTAL_HIGHER' : 'TRUE_TOTAL_MAY_BE_HIGHER',
      count: n, types,
      reason: `${describeExcludedTypes(hit)} of unknown balance ${n === 1 ? 'is' : 'are'} excluded from the ${meta.total} — `
        + (isDebt
          ? 'debt may be understated, so net worth may be overstated. Never estimate the missing balance.'
          : 'it may be understated. Never estimate the missing balance or treat it as zero.'),
    });
  }
  const totals = (['NET_WORTH', 'TOTAL_DEBT', 'TOTAL_ASSETS', 'LIQUID_CASH', 'LIQUID_NET_WORTH'] as const)
    .map((t) => partialTotalStatement(t, excluded))
    .filter((t): t is PartialTotalStatement => t !== null);
  return { concept: 'EXCLUDED_BALANCES', classes, totals };
}

// ── Breadth ──────────────────────────────────────────────────────────────────

/**
 * How much of the concept a question is asking about.
 *
 * The distinction the product needs: "what are my investments?" spans both
 * components, "what stocks do I own?" spans one, and answering either with the
 * other's scope is wrong in a way no caveat repairs. It also drives retrieval
 * (CF-6), so a crypto question does not pay for the position spine.
 */
export const ConceptBreadth = {
  /** Both components. */
  BROAD:            'BROAD',
  /** Securities only. */
  TRADITIONAL_ONLY: 'TRADITIONAL_ONLY',
  /** Digital assets only. */
  DIGITAL_ONLY:     'DIGITAL_ONLY',
  /** Not an investment question. */
  NONE:             'NONE',
} as const;

export type ConceptBreadthKind = typeof ConceptBreadth[keyof typeof ConceptBreadth];

/** Securities vocabulary — nothing here names a digital asset. */
const TRADITIONAL_VOCABULARY =
  /\b(traditional|stock|stocks|share|shares|equit(?:y|ies)|securit(?:y|ies)|brokerage|etf|etfs|mutual fund|index fund|bond|bonds|ticker|tickers|401k|ira|roth|retirement account|schwab|fidelity|vanguard|robinhood)\b/i;

/** Digital-asset vocabulary — nothing here names a security. */
const DIGITAL_VOCABULARY =
  /\b(crypto|cryptocurrency|cryptocurrencies|bitcoin|btc|ethereum|eth|solana|sol|wallet|wallets|digital asset|digital assets|on[- ]chain|coin|coins|token|tokens)\b/i;

/** Concept-level vocabulary — names the whole thing, not a part of it. */
const BROAD_INVESTMENT_VOCABULARY =
  /\b(invest(?:ed|ing|ment|ments)?|portfolio|holding|holdings|position|positions|allocation|asset allocation|diversif\w*)\b/i;

/** Questions about total financial position, which include the concept. */
const WHOLE_PICTURE_VOCABULARY =
  /\b(net worth|networth|financial (?:health|position|picture|situation|overview|shape)|overall finances|how am i doing|full picture|whole picture|everything i (?:have|own)|total assets|balance sheet)\b/i;

/**
 * Resolve how broadly a message asks about INVESTMENTS.
 *
 * Order is the contract. A message naming BOTH sides ("traditional vs crypto",
 * "stocks and bitcoin") is BROAD — it is explicitly a comparison, and narrowing
 * it to whichever vocabulary matched first would drop half the answer.
 *
 * Deliberately bounded. This resolves the phrasings the product sees, not every
 * financial synonym; an unrecognised phrasing falls to NONE and behaves exactly
 * as it did before CF-7, which is a miss rather than an error.
 */
export function resolveConceptBreadth(question: string | undefined): ConceptBreadthKind {
  if (!question) return ConceptBreadth.NONE;

  const traditional = TRADITIONAL_VOCABULARY.test(question);
  const digital     = DIGITAL_VOCABULARY.test(question);

  // Both sides named — a comparison, and unambiguously the whole concept.
  if (traditional && digital) return ConceptBreadth.BROAD;
  if (traditional) return ConceptBreadth.TRADITIONAL_ONLY;
  if (digital)     return ConceptBreadth.DIGITAL_ONLY;

  if (BROAD_INVESTMENT_VOCABULARY.test(question)) return ConceptBreadth.BROAD;
  if (WHOLE_PICTURE_VOCABULARY.test(question))    return ConceptBreadth.BROAD;

  return ConceptBreadth.NONE;
}

/**
 * Does this breadth need the position spine?
 *
 * TRADITIONAL_ONLY and BROAD do — the spine is where individual securities
 * live. DIGITAL_ONLY does not: everything a crypto question wants (account
 * totals, per-chain quantity coverage, presence) is already in the accounts
 * domain and the CF-5 envelope, and the spine would add tokens and nothing
 * else — even though it happens to contain the crypto positions too.
 */
export function breadthNeedsPositionDetail(breadth: ConceptBreadthKind): boolean {
  return breadth === ConceptBreadth.BROAD || breadth === ConceptBreadth.TRADITIONAL_ONLY;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function money(n: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n);
}

/**
 * The concept block, rendered only when a question is actually about it.
 *
 * The decomposition is mandatory and the combined figure is optional — never
 * the other way round. A single "Investments: $25,000" hides that four fifths
 * of it is crypto, which is the first thing anyone asking would want to know,
 * and it hides which authority produced it.
 */
export function describeInvestmentConcept(
  composition: ConceptComposition | null,
  breadth: ConceptBreadthKind,
): string[] {
  if (!composition || breadth === ConceptBreadth.NONE) return [];

  const lines: string[] = [];
  const { components, combined, currency } = composition;

  const shown = breadth === ConceptBreadth.TRADITIONAL_ONLY
    ? components.filter((c) => c.key === 'TRADITIONAL_INVESTMENTS')
    : breadth === ConceptBreadth.DIGITAL_ONLY
      ? components.filter((c) => c.key === 'DIGITAL_ASSETS')
      : components;

  lines.push(
    'INVESTMENTS — the deterministic composition. These figures and this breakdown are ' +
    'authoritative; do not redefine what counts as an investment, and do not add any other ' +
    'total to them:',
  );

  for (const c of shown) {
    lines.push(
      c.state === ComponentState.ASSERTABLE
        ? `  ${c.label}: ${money(c.amount!, currency)} across ${c.accountCount} account(s).`
        : c.state === ComponentState.ABSENT
          ? `  ${c.label}: none — this Space holds no such accounts.`
          : `  ${c.label}: NOT MEASURABLE here — ${c.reason}. Do not treat this as zero.`,
    );
  }

  if (breadth === ConceptBreadth.BROAD) {
    if (combined !== null) {
      lines.push(
        `  Combined investments: ${money(combined, currency)}. Valid ONLY because every component ` +
        'above is measured and the two are disjoint by account classification — one account is ' +
        'either an investment account or a digital-asset account, never both.',
      );
      lines.push(
        '  Always give the components alongside this total; a single combined figure hides the ' +
        'split, which is usually the point of the question.',
      );
    } else {
      lines.push(
        `  Combined investments: WITHHELD — ${composition.withheldReason}. State the component(s) ` +
        'you do have and say the total cannot be completed. Do NOT add up what is present and ' +
        'present it as the whole.',
      );
    }
  } else {
    // A specific question. Naming the other component would answer a question
    // the user did not ask; the concept still forbids conflating the two.
    lines.push(
      breadth === ConceptBreadth.TRADITIONAL_ONLY
        ? '  This question is about traditional securities. Answer from those; do not fold digital ' +
          'assets into the figures or the discussion unless asked.'
        : '  This question is about digital assets. Answer from those; do not fold traditional ' +
          'securities into the figures or the discussion unless asked.',
    );
  }

  // The trap, stated wherever the position spine is also in the prompt.
  if (breadthNeedsPositionDetail(breadth)) {
    lines.push(
      '  The holdings/position data below is DETAIL, not arithmetic: its portfolio total already ' +
      'includes the digital assets, so it must never be added to the digital-asset figure above.',
    );
  }

  return lines;
}
