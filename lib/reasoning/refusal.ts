/**
 * lib/reasoning/refusal.ts
 *
 * V26-REASONING — ONE VOCABULARY FOR "WE ARE NOT SAYING THIS."
 *
 * ⚠️ THIS FILE EXISTS BECAUSE THE PLAN'S SIXTH INVARIANT IS THE ONE THIS
 * CODEBASE HAS BROKEN MOST OFTEN. It carries roughly forty-two status
 * vocabularies and eight separate spellings of "unknown" — `INSUFFICIENT_DATA`,
 * `UNKNOWN`, `BLOCKED_BY_DATA`, `UNRELIABLE`, `LOW_INCOME_SAMPLE`, `REFUSED`,
 * `NONE`, `NOT_APPLICABLE` — and every one of them gets flattened into English
 * at the prompt boundary and then read back out with a regex.
 *
 * So the refusal vocabulary is defined ONCE, here, at the root of the reasoning
 * layer rather than inside whichever slice needed it first. Slice 1 uses it for
 * the WITHHELD block. Slice 3's measures use the same codes for an UNRESOLVED
 * resolution. Adding a ninth spelling later is the design failure, not the
 * inconvenience of reusing these seven.
 *
 * ── REPRESENTATION UNIFIED, SEMANTICS PRESERVED ─────────────────────────────
 * The distinctions survive as codes, because "this quantity does not exist for
 * you" and "we cannot tell" are materially different things to say to a person,
 * and collapsing them would be the flattening in a new costume.
 */

export type RefusalCode =
  /** The quantity does not exist for this user. Not a gap — an absence. */
  | 'NOT_APPLICABLE'
  /** Nothing was captured. */
  | 'NO_EVIDENCE'
  /** Some evidence, below the threshold at which it may be asserted. */
  | 'INSUFFICIENT_EVIDENCE'
  /** Enough evidence, and it contradicts itself. */
  | 'UNRELIABLE_EVIDENCE'
  /** The value is known; its semantics are not. Gross or net, for instance. */
  | 'BASIS_NOT_ESTABLISHED'
  /** True now, and carrying no authority for a claim about that date. */
  | 'NO_LICENCE_AT_HORIZON'
  /**
   * ⚠️ AGGREGATE-ONLY, AND THIS IS A SECURITY CONSTRAINT, NOT A STYLE RULE.
   * A per-account refusal reading "blocked by permission" discloses that a
   * hidden account exists. `lib/ai/assemblers/accounts.ts` already reasons about
   * exactly this for KnowledgeGaps — BALANCE_ONLY accounts are excluded because
   * surfacing gaps for them would implicitly reveal that they are debt accounts.
   *
   * So this code may only ever be rendered as an aggregate ("some accounts in
   * this Space are not visible to you"), never per account, and never with a
   * label that identifies one. Pinned by test.
   */
  | 'BLOCKED_BY_PERMISSION';

/** A withholding, and the reason a person can read. */
export interface Refusal {
  code: RefusalCode;
  /** Rendered verbatim to the user. Names what is missing, never merely that something is. */
  detail: string;
}

/**
 * Every code except the one that must never name a subject.
 *
 * A refusal is normally attached to the subject it withholds ("months of
 * coverage"). `BLOCKED_BY_PERMISSION` is attached to the Space.
 */
export function refusalMayNameSubject(code: RefusalCode): boolean {
  return code !== 'BLOCKED_BY_PERMISSION';
}
