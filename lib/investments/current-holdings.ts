/**
 * lib/investments/current-holdings.ts
 *
 * Pure, Prisma-free derivation for the read-only "Investment connection state by
 * account" view (Connections card). Given a per-account CONNECTION context plus a
 * canonical non-cash position COUNT, it derives an honest per-account display
 * state. Kept side-effect-free so it is unit-testable with a standalone `tsx`
 * script (no DB, no prisma generate) — same pattern as lib/sync/status.ts.
 *
 * P2-5: this module is a connection-HEALTH surface, NOT a portfolio/valuation
 * surface. It no longer carries holding contents (symbol/quantity/price/value) —
 * position PRESENCE is a single canonical count from getCurrentPositions
 * (countCurrentPositionsByAccount), so Connections can never become a second
 * valuation authority. Connection health / consent come from PlaidItem, account
 * state (balance) from FinancialAccount.
 */

/** Provider of an investment account's data. */
export type InvestmentProvider = "PLAID" | "WALLET" | "MANUAL";

/** Raw per-account input (already visibility-filtered by the data layer). */
export interface InvestmentAccountInput {
  accountId:          string;
  name:               string;
  institution:        string;
  type:               "investment" | "crypto";
  /** Canonical account value in `currency` (Plaid balance / wallet balance). */
  balance:            number;
  currency:           string;
  /** ISO — when Fourth Meridian last wrote this account's balance. */
  lastUpdated:        string | null;
  provider:           InvestmentProvider;
  /** PlaidItem.id (Plaid connections only) — drives Enable/Refresh actions. */
  plaidItemId:        string | null;
  investmentsConsent: "ENABLED" | "CONSENT_REQUIRED" | "UNSUPPORTED" | null;
  itemStatus:         "ACTIVE" | "NEEDS_REAUTH" | "ERROR" | null;
  itemErrorCode:      string | null;
  /** ISO — PlaidItem.lastSyncedAt (last completed sync). */
  lastSyncedAt:       string | null;
  /**
   * Canonical non-cash position count for this account (getCurrentPositions,
   * excluding cash). The ONLY position signal Connections needs — presence, not
   * contents. Unvalued positions still count (a held-but-unpriced position IS
   * present).
   */
  positionCount:      number;
}

/**
 * Honest, distinct per-account states — deliberately NOT collapsed together so
 * a failure never renders the same as "not enabled" (the exact defect this
 * slice fixes). See the Slice B empty/error-state matrix.
 */
export type InvestmentAccountState =
  | "holdings"          // positions exist → render them
  | "zero_holdings"     // consented/synced but Plaid returned no positions
  | "consent_required"  // supported, user must Enable Investments
  | "needs_reauth"      // Plaid item needs reconnection
  | "error"             // Plaid item is in an error state
  | "wallet";           // self-custody / crypto — no Plaid consent concept

export interface InvestmentAccountView extends InvestmentAccountInput {
  /** Canonical account value shown for the account (its own currency = balance). */
  totalValue:    number;
  state:         InvestmentAccountState;
}

/**
 * Derive the display state. Order matters: connection health (error/reauth)
 * and consent gate take precedence over holdings presence, so a broken or
 * un-consented connection never masquerades as "zero holdings".
 */
export function deriveInvestmentAccountState(
  input: Pick<
    InvestmentAccountInput,
    "type" | "provider" | "investmentsConsent" | "itemStatus"
  > & { positionCount: number },
): InvestmentAccountState {
  // Self-custody / crypto accounts have no Plaid Investments consent concept.
  if (input.provider === "WALLET" || input.type === "crypto") return "wallet";

  if (input.itemStatus === "ERROR")        return "error";
  if (input.itemStatus === "NEEDS_REAUTH") return "needs_reauth";

  // Supported but not yet consented — the Enable Investments path.
  if (input.investmentsConsent === "CONSENT_REQUIRED") return "consent_required";

  return input.positionCount > 0 ? "holdings" : "zero_holdings";
}

/** Derive connection state for one account from its canonical position count. */
export function buildInvestmentAccountView(input: InvestmentAccountInput): InvestmentAccountView {
  const state = deriveInvestmentAccountState({
    type:               input.type,
    provider:           input.provider,
    investmentsConsent: input.investmentsConsent,
    itemStatus:         input.itemStatus,
    positionCount:      input.positionCount,
  });

  return {
    ...input,
    totalValue: input.balance,
    state,
  };
}

/** Build the full view list, richest accounts first. */
export function buildInvestmentAccountsView(inputs: InvestmentAccountInput[]): InvestmentAccountView[] {
  return inputs
    .map(buildInvestmentAccountView)
    .sort((a, b) => b.totalValue - a.totalValue);
}
