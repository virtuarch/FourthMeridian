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
}

export interface Answer {
  claims: Claim[];
  prose:  string;
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
    /** The model returned something that is not an Answer at all. */
    | 'MALFORMED';
  detail: string;
  /** The offending text, for the repair instruction. Never a user's prose. */
  offending?: string;
}
