/**
 * lib/reasoning/answer/types.ts
 *
 * V26-REASONING Slice 1 — WHAT THE MODEL RETURNS.
 *
 * The model stops returning free prose and starts returning `{ claims[], prose }`,
 * where every stated figure references the address it was licensed at.
 * Verification stops being a parse and becomes an identity check.
 */

/** One figure stated in the prose, and the address it was taken from. */
export interface Claim {
  /** An `fid` from this turn's figure table. */
  fid: string;
  /**
   * The figure EXACTLY as it was written in the prose — "$43,120.55",
   * "$5,000/month", "4.2 months".
   *
   * ⚠️ THIS IS THE ONLY BRIDGE BETWEEN THE TYPES AND THE ENGLISH, and it is
   * deliberately the model's own copy rather than our re-rendering of the value.
   * A model that writes "$15,000" in the prose and reports `statedAs: "$5,000"`
   * fails the prose sweep, not the identity check — both directions are covered
   * and neither requires understanding the sentence.
   */
  statedAs: string;
  /**
   * The AUTHORITY the sentence gives this figure.
   *
   * ⚠️ THIS FIELD EXISTS BECAUSE THE ADDRESS ALONE COULD NOT CARRY IT, AND THE
   * FAILURE WAS DEMONSTRATED. `verifyAnswer` never read `kind`, so a PREMISE
   * figure — the user's own supposition, licensed only to be quoted back as
   * theirs — verified against the prose *"You have $50,000.00 saved."* The
   * rate-versus-stock axis holds because a rate and a stock RENDER differently;
   * a supposed fifty thousand and a measured fifty thousand render identically,
   * so no rendering check can separate them. What separates them is what the
   * sentence CLAIMS, and only the writer of the sentence knows that.
   *
   * So the model declares it, exactly as it already declares `fid`:
   *
   *   FACT        "Your net worth is $33,700.17."
   *   ASSUMPTION  "Assuming $50,000, you'd have…" · "If we use your $50,000…"
   *
   * ⚠️ AND A `PREMISE` FIGURE MAY ONLY EVER BE `ASSUMPTION`. That is the
   * invariant, it is checked by identity against `kind`, and it needs no phrase
   * list and no prose reading. A MEASURE may be either — a measured figure
   * restated inside a scenario sentence is ordinary and correct.
   *
   * ⚠️ THE HONEST LIMIT, stated rather than hidden: a model can declare
   * `ASSUMPTION` and still write a declarative sentence. That is the same trust
   * boundary `claims` itself rests on, and it is acceptable for the same reason
   * — declaring is a strong prior, it is sampleable, and it converts a SILENT
   * category error into a DETECTABLE misdeclaration. Before this field there was
   * nothing to detect.
   */
  frame: 'FACT' | 'ASSUMPTION';
}

export interface Answer {
  claims: Claim[];
  prose:  string;
  /**
   * When `claims` is empty, the WITHHELD subject this answer is speaking to,
   * copied exactly from the WITHHELD block. `null` otherwise.
   *
   * ⚠️ WITHOUT THIS, SILENCE WAS AN ESCAPE HATCH. `{ claims: [], prose: "You are
   * on track and can comfortably afford it." }` verified clean: no figure token
   * in the prose means nothing for the sweep to catch, and an empty claims array
   * means nothing for the identity check to check. A confident financial
   * conclusion could evade the entire boundary by naming no number.
   *
   * The provider was asserted to prevent this — `provider.ts` claimed
   * `strict: true` made an empty array "unrepresentable". It does not; `strict`
   * forbids missing and extra properties, not empty arrays.
   *
   * ⚠️ AND NOT EVERY GOOD ANSWER HAS A FIGURE. A refusal, a limitation, a
   * genuinely qualitative reply are all legitimate — so the rule is not "you
   * must state a number", it is "if you state none, say which withholding you
   * are speaking to, from the list you were given." Identity again, no sentiment
   * classifier, no prose parsing.
   */
  withheld: string | null;
}

/** Why a produced answer was not acceptable. */
export interface VerificationFailure {
  kind:
    /** The claim cites an address that does not exist this turn. */
    | 'UNKNOWN_FID'
    /** `statedAs` does not parse to the figure's value. */
    | 'VALUE_MISMATCH'
    /** `statedAs` does not render the figure's unit — a rate written as a stock. */
    | 'UNIT_NOT_RENDERED'
    /** A figure appears in the prose that no claim accounts for. */
    | 'UNCLAIMED_FIGURE'
    /** A PREMISE figure was claimed as a FACT — the user's supposition asserted. */
    | 'PREMISE_AS_FACT'
    /** No figure was stated and no withholding was cited — a conclusion from nothing. */
    | 'VACUOUS'
    /** The model returned something that is not an Answer at all. */
    | 'MALFORMED';
  detail: string;
  /** The offending text, for the repair instruction. Never a user's prose. */
  offending?: string;
}
