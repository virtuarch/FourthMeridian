/**
 * lib/investments/scope-divergence.ts
 *
 * HIST-1D — the shared-Space scope-divergence DISCLOSURE (INVEST-1 §7 #2). PURE,
 * no DB, no arithmetic.
 *
 * On a SHARED Space two correct surfaces answer "what were my investments worth"
 * over DIFFERENT account sets, by design (KD-21a privacy):
 *   - Wealth / net worth values investments over ALL linked accounts (snapshot
 *     scope "all") — a BALANCE_ONLY-shared account's value still counts toward
 *     whole-Space wealth;
 *   - the member-facing Investments surface (A10 / getCurrentPositions) values
 *     only FULL-visibility links (scope "detailEligible"), so it never exposes the
 *     holdings of an account shared without per-item detail.
 * So on the SAME date the two figures can legitimately disagree. INVEST-1 flagged
 * this as intentional in mechanism yet undisclosed in effect. This surfaces WHY —
 * it reconciles nothing, changes no number, and touches no visibility rule.
 *
 * Returns null wherever the divergence cannot arise (a personal Space, or a shared
 * Space with no reduced-visibility investment link), so a consumer renders the
 * note ONLY where appropriate. Reusable by any surface that shows the reduced
 * (detailEligible) investments figure alongside — or in place of — whole-Space wealth.
 */

export interface ScopeDivergenceInput {
  /** Only a SHARED Space can diverge; a personal Space is the account's home. */
  isSharedSpace: boolean;
  /**
   * ACTIVE investment / digital-asset links in this Space whose visibility
   * withholds per-item detail (BALANCE_ONLY / SUMMARY_ONLY / …) — counted in
   * whole-Space wealth (scope "all") but excluded from the member-facing
   * Investments detail (scope "detailEligible"). Zero ⇒ the two surfaces cover
   * the same accounts and cannot disagree.
   */
  redactedInvestmentAccountCount: number;
}

export interface ScopeDivergenceDisclosure {
  /** How many shared investment accounts withhold per-holding detail here. */
  redactedAccountCount: number;
  /** Short chip/heading. */
  title: string;
  /** One name-free sentence explaining the legitimate divergence. */
  note: string;
}

/**
 * The disclosure for the Investments surface, or null when it does not apply.
 * Deterministic; pure copy composition.
 */
export function investmentsScopeDivergence(
  input: ScopeDivergenceInput,
): ScopeDivergenceDisclosure | null {
  if (!input.isSharedSpace) return null;
  const n = input.redactedInvestmentAccountCount;
  if (n <= 0) return null;

  const account = n === 1 ? "account" : "accounts";
  const contributes = n === 1 ? "contributes" : "contribute";
  const keeps = n === 1 ? "keeps" : "keep";
  return {
    redactedAccountCount: n,
    title: "Why this can differ from total wealth",
    note:
      `${n} shared ${account} ${contributes} to this Space's total wealth but ${keeps} ` +
      `individual holdings private, so the investments shown here can read lower than ` +
      `the wealth figure for the same date.`,
  };
}
