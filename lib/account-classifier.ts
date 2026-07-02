/**
 * lib/account-classifier.ts
 *
 * Single source of truth for account classification across all dashboards,
 * widgets, and analytics.
 *
 * Every component that previously did `accounts.filter(a => a.type === 'debt')`
 * inline should use this instead. When classification rules change — e.g. when
 * AccountType.asset is added to schema — this is the only file to update.
 *
 * ── Classification rules ──────────────────────────────────────────────────────
 *   checking + savings  → liquid
 *   investment          → investments
 *   crypto              → digitalAssets
 *   other               → realAssets  (ALL 'other' treated as manual/real assets;
 *                          syncStatus='manual' is the canonical discriminator and
 *                          will be used when migrating to AccountType.asset)
 *   debt                → liabilities
 *   anything else       → uncategorized (excluded from all totals; logged in dev)
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   import { classifyAccounts } from "@/lib/account-classifier";
 *
 *   // Works with Account[], SpaceAccount[], or any superset:
 *   const c = classifyAccounts(accounts);
 *   c.netWorth           // total assets - total liabilities
 *   c.liabilities        // Account[] (or SpaceAccount[]) for debt accounts
 *   c.totalInvestments   // pre-summed investment balances
 * ──────────────────────────────────────────────────────────────────────────────
 */

// ─── Minimum required fields ──────────────────────────────────────────────────

/**
 * Minimum account fields required for classification.
 * Structurally compatible with both Account (types/index.ts) and
 * SpaceAccount (SpaceDashboard.tsx local type).
 */
export interface ClassifiableAccount {
  type:        string;
  balance:     number;
  /**
   * Optional — only present on Account (personal dashboard).
   * SpaceAccount does not carry this field, so it will be undefined.
   * The classifier treats ALL type='other' accounts as realAssets regardless
   * of syncStatus, since 'other' has no other semantic meaning in the current schema.
   */
  syncStatus?: string;
}

// ─── Classification result ────────────────────────────────────────────────────

/**
 * Full classification result.
 * T is inferred from the input array type so bucket arrays preserve the
 * original account shape (Account[], SpaceAccount[], etc.).
 */
export interface AccountClassification<T extends ClassifiableAccount = ClassifiableAccount> {
  // ── Classified buckets ──────────────────────────────────────────────────────
  /** Checking + savings accounts */
  liquid:        T[];
  /** Investment (brokerage, IRA, 401k) accounts */
  investments:   T[];
  /** Crypto accounts and wallets */
  digitalAssets: T[];
  /** Manually-entered real assets: property, vehicles, equipment (AccountType.other) */
  realAssets:    T[];
  /** Debt accounts: credit cards, mortgages, auto loans, etc. */
  liabilities:   T[];

  // ── Pre-computed totals ─────────────────────────────────────────────────────
  /** Checking account balances only */
  totalChecking:      number;
  /** Savings account balances only */
  totalSavings:       number;
  /** totalChecking + totalSavings */
  totalLiquid:        number;
  /** Sum of investment account balances */
  totalInvestments:   number;
  /** Sum of crypto account balances */
  totalDigitalAssets: number;
  /** Sum of real asset account balances */
  totalRealAssets:    number;
  /**
   * Sum of positive liability balances (amounts owed).
   * Negative balances (card credits) are excluded — they don't reduce net worth.
   */
  totalLiabilities:   number;
  /** totalLiquid + totalInvestments + totalDigitalAssets + totalRealAssets */
  totalAssets:        number;
  /** totalAssets − totalLiabilities */
  netWorth:           number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function sumBalances(accounts: ClassifiableAccount[]): number {
  return accounts.reduce((s, a) => s + a.balance, 0);
}

/**
 * Classify an array of accounts into named buckets and pre-compute totals.
 *
 * @param accounts - Any array whose elements have at least { type, balance }.
 * @returns AccountClassification<T> with fully-typed bucket arrays.
 */
export function classifyAccounts<T extends ClassifiableAccount>(
  accounts: T[],
): AccountClassification<T> {
  const checking      = accounts.filter((a) => a.type === "checking");
  const savings       = accounts.filter((a) => a.type === "savings");
  const liquid        = [...checking, ...savings];
  const investments   = accounts.filter((a) => a.type === "investment");
  const digitalAssets = accounts.filter((a) => a.type === "crypto");
  // All 'other' accounts are real/manual assets. syncStatus='manual' is the
  // canonical tag but we include all 'other' since no other bucket exists yet.
  const realAssets    = accounts.filter((a) => a.type === "other");
  const liabilities   = accounts.filter((a) => a.type === "debt");

  if (process.env.NODE_ENV === "development") {
    const known = new Set(["checking", "savings", "investment", "crypto", "other", "debt"]);
    const uncategorized = accounts.filter((a) => !known.has(a.type));
    if (uncategorized.length > 0) {
      console.warn(
        "[account-classifier] Uncategorized account types — excluded from all totals:",
        [...new Set(uncategorized.map((a) => a.type))],
      );
    }
  }

  const totalChecking      = sumBalances(checking);
  const totalSavings       = sumBalances(savings);
  const totalLiquid        = totalChecking + totalSavings;
  const totalInvestments   = sumBalances(investments);
  const totalDigitalAssets = sumBalances(digitalAssets);
  const totalRealAssets    = sumBalances(realAssets);
  // Only positive balances count as owed — negative = they owe you
  const totalLiabilities   = liabilities.reduce((s, a) => s + Math.max(0, a.balance), 0);
  const totalAssets        = totalLiquid + totalInvestments + totalDigitalAssets + totalRealAssets;
  const netWorth           = totalAssets - totalLiabilities;

  return {
    liquid,
    investments,
    digitalAssets,
    realAssets,
    liabilities,
    totalChecking,
    totalSavings,
    totalLiquid,
    totalInvestments,
    totalDigitalAssets,
    totalRealAssets,
    totalLiabilities,
    totalAssets,
    netWorth,
  };
}
