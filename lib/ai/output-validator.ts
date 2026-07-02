/**
 * lib/ai/output-validator.ts
 *
 * AI-4 / KD-2 — deterministic LLM output validator (pure core).
 *
 * The AI architecture doctrine is that the model NARRATES pre-computed,
 * provenance-carrying numbers and never calculates them (see
 * app/api/ai/chat/route.ts and lib/ai/provider.ts). Every figure the model is
 * allowed to state is therefore already present, formatted, in the grounded
 * system prompt. This module checks that invariant by MEMBERSHIP, not by
 * recomputation:
 *
 *   Every flag-eligible numeric claim in the reply must reconcile — within
 *   tolerance — to some number present in the system prompt (or in the user's
 *   own prior turns, which the user may quote and the model may echo).
 *
 * It is a PURE function of two strings (+ the user turns): no DB, no LLM, no
 * I/O, no `server-only`. The caller (the chat route) runs it in shadow mode —
 * observational only, reply byte-for-byte unchanged. Design record:
 * docs/initiatives/ai4/AI-4_PHASE_0_INVESTIGATION.md.
 *
 * v1 scope: the number formats the prompt actually emits — money ($1,234.56, 2
 * dp), percentages (12.3%), coverage months (3.2 months), plus common model
 * abbreviations (k/M/B). Bare integers (years, counts, ordinals) are NOT
 * flag-eligible, to keep false positives near zero. Known unsupported forms
 * (numeric ranges, scientific notation) are documented, never silently passed.
 */

// ── Public types ──────────────────────────────────────────────────────────────

/** A number extracted from the reply that is subject to the membership check. */
export interface NumericClaim {
  /** Normalized numeric value (e.g. "$1,234.56" → 1234.56, "$1.2k" → 1200). */
  value: number;
  /** The raw substring as it appeared in the reply, for the audit record. */
  raw:   string;
}

export interface ValidationResult {
  /** Flag-eligible claims with no reconciling source number. Empty ⇒ clean. */
  unreconciled: NumericClaim[];
  /** Count of flag-eligible claims that were checked. */
  checkedCount: number;
  /** Count of distinct source numbers available for reconciliation. */
  sourceCount:  number;
}

// ── Tokenization ──────────────────────────────────────────────────────────────

/**
 * Matches a numeric token with optional `$` prefix, optional `%` suffix, and an
 * optional trailing scale word/letter (k/m/b/thousand/million/billion). The
 * digit body allows comma grouping and a decimal fraction.
 *
 * Group 1: `$` (money marker, optional)
 * Group 2: the numeric body (with commas / decimal)
 * Group 3: `%` (percent marker, optional)
 * Group 4: scale suffix (optional)
 *
 * The scale suffix is deliberately tight: at most one leading space (never a
 * newline) and a trailing word boundary, so a single-letter scale cannot bleed
 * into an adjacent word — e.g. the `m` in "3.2 months" or the `B` beginning the
 * next line's "Balance" must NOT be read as mega/billion multipliers.
 */
const NUMBER_RE =
  /(\$)?\s?(-?\d[\d,]*(?:\.\d+)?) ?(%)?(?: ?(k|m|b|thousand|million|billion)\b)?/gi;

const SCALE: Record<string, number> = {
  k: 1_000, thousand: 1_000,
  m: 1_000_000, million: 1_000_000,
  b: 1_000_000_000, billion: 1_000_000_000,
};

interface Token {
  value:       number;
  raw:         string;
  hadDollar:   boolean;
  hadPercent:  boolean;
  hadDecimal:  boolean;
  hadScale:    boolean;
  followedByMonths: boolean;
}

/** Extract every numeric token from a string, with the markers needed to classify it. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = NUMBER_RE.exec(text)) !== null) {
    const [raw, dollar, body, percent, scaleWord] = m;
    if (!body) continue;

    const digits = body.replace(/,/g, '');
    let value = Number.parseFloat(digits);
    if (!Number.isFinite(value)) continue;

    const scale = scaleWord ? SCALE[scaleWord.toLowerCase()] : undefined;
    if (scale) value *= scale;

    // Look just past the match for a "month(s)" / "mo" unit (coverage figures).
    const after = text.slice(m.index + raw.length, m.index + raw.length + 8).toLowerCase();
    const followedByMonths = /^\s*(months?\b|mo\b)/.test(after);

    tokens.push({
      value,
      raw:              raw.trim(),
      hadDollar:        Boolean(dollar),
      hadPercent:       Boolean(percent),
      hadDecimal:       body.includes('.'),
      hadScale:         Boolean(scale),
      followedByMonths,
    });
  }

  return tokens;
}

/**
 * A reply token is FLAG-ELIGIBLE (a financial claim we hold the model to) when
 * it carries a financial marker: `$`, `%`, a month unit, a scale abbreviation,
 * or a decimal fraction. A bare integer with no marker (a year, an account
 * count, an ordinal) is NOT flag-eligible — this is the primary false-positive
 * guard.
 */
function isFlagEligible(t: Token): boolean {
  return t.hadDollar || t.hadPercent || t.followedByMonths || t.hadScale || t.hadDecimal;
}

// ── Reconciliation ────────────────────────────────────────────────────────────

/**
 * True when a claimed value reconciles to a source value. Membership semantics:
 * a claim passes if it matches ANY source (so competing legitimate figures —
 * e.g. KD-10's two monthly-expense values — never false-positive).
 *
 * A claim `c` matches a source `s` if any holds:
 *   - exact;
 *   - within max($0.01, 0.5% of |s|)  — absorbs cent-rounding and reformatting;
 *   - equals `s` coarsened to a unit the model plausibly rounded to
 *     (whole dollar / nearest 10 / 100 / 1000) — absorbs "about $1,200".
 */
function matches(c: number, s: number): boolean {
  if (c === s) return true;

  const abs = Math.abs(c - s);
  if (abs <= Math.max(0.01, Math.abs(s) * 0.005)) return true;

  for (const unit of [1, 10, 100, 1000]) {
    if (Math.round(s / unit) * unit === c) return true;
  }
  return false;
}

/** Distinct source values available for reconciliation (prompt + user turns). */
function collectSourceValues(systemPrompt: string, userMessages: string[]): number[] {
  const values = new Set<number>();
  for (const t of tokenize(systemPrompt)) values.add(t.value);
  for (const msg of userMessages) {
    for (const t of tokenize(msg)) values.add(t.value);
  }
  return [...values];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate an LLM reply against its grounding sources.
 *
 * @param reply         The model's reply text.
 * @param systemPrompt  The exact grounded system prompt the model was given.
 * @param userMessages  Prior user-turn contents (secondary source — a user may
 *                      quote a figure the model then echoes).
 * @returns             Which flag-eligible claims could not be reconciled.
 *
 * Pure and total: never throws on ordinary string input, so the shadow caller's
 * try/catch is a belt-and-braces guard, not a routine path.
 */
export function validateOutput(
  reply:        string,
  systemPrompt: string,
  userMessages: string[] = [],
): ValidationResult {
  const sources = collectSourceValues(systemPrompt, userMessages);
  const claims  = tokenize(reply).filter(isFlagEligible);

  const unreconciled: NumericClaim[] = [];
  for (const claim of claims) {
    if (!sources.some((s) => matches(claim.value, s))) {
      unreconciled.push({ value: claim.value, raw: claim.raw });
    }
  }

  return {
    unreconciled,
    checkedCount: claims.length,
    sourceCount:  sources.length,
  };
}
