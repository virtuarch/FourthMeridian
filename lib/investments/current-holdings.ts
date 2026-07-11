/**
 * lib/investments/current-holdings.ts
 *
 * Pure, Prisma-free derivation for the read-only "current Investments by
 * account" view (Slice B). Groups already-persisted Holding rows under their
 * investment/crypto account and derives an honest per-account display state.
 * Kept side-effect-free so it is unit-testable with a standalone `tsx` script
 * (no DB, no prisma generate) — same pattern as lib/sync/status.ts.
 *
 * This is a CURRENT-STATE read model only. No historical positions, prices,
 * cost basis history, returns, or simulations — see the Slice B scope.
 */

export interface HoldingView {
  id:        string;
  symbol:    string;
  name:      string;
  quantity:  number;
  price:     number;
  value:     number;
  /** Native currency of price/value (null = unknown residue). */
  currency:  string | null;
  change24h: number;
  /** Synthetic brokerage-cash row (account.balance − Σ positions). */
  isCash:    boolean;
}

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
  /** All holdings for this account (positions + any cash row). */
  holdings:           HoldingView[];
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
  /** Non-cash positions, highest value first. */
  positions:     HoldingView[];
  /** The single synthetic brokerage-cash row, if Plaid reported one. */
  cash:          HoldingView | null;
  positionCount: number;
  /** Canonical portfolio value shown for the account (its own currency). */
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

/** Group + split holdings and derive state for one account. */
export function buildInvestmentAccountView(input: InvestmentAccountInput): InvestmentAccountView {
  const positions = input.holdings
    .filter((h) => !h.isCash)
    .sort((a, b) => b.value - a.value);
  const cash = input.holdings.find((h) => h.isCash) ?? null;

  const state = deriveInvestmentAccountState({
    type:               input.type,
    provider:           input.provider,
    investmentsConsent: input.investmentsConsent,
    itemStatus:         input.itemStatus,
    positionCount:      positions.length,
  });

  return {
    ...input,
    positions,
    cash,
    positionCount: positions.length,
    totalValue:    input.balance,
    state,
  };
}

/** Build the full view list, richest accounts first. */
export function buildInvestmentAccountsView(inputs: InvestmentAccountInput[]): InvestmentAccountView[] {
  return inputs
    .map(buildInvestmentAccountView)
    .sort((a, b) => b.totalValue - a.totalValue);
}
