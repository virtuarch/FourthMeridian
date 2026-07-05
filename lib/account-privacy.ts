/**
 * lib/account-privacy.ts
 *
 * Helpers for enforcing SpaceAccountLink visibility tiers at the
 * API-response level.
 *
 * BALANCE_ONLY
 *   The sharing user has chosen to expose only a balance total to space
 *   members.  No identifying information must leak:
 *     - real account name (user-set or institution-derived)
 *     - institution name
 *     - credit limit, interest rate, minimum payment, raw debt subtype
 *     - Plaid / connection metadata
 *     - transactions or holdings
 *
 *   Multiple BALANCE_ONLY accounts from the same owner of the same type are
 *   aggregated into one row with a summed balance so the UI never renders
 *   duplicate generic labels.
 *
 * FULL
 *   All fields are permitted.  No sanitization needed.
 *
 * Public API:
 *   genericAccountName(hint)              — base label from type + debtSubtype
 *   sanitizeForBalanceOnly(account, name) — single-account safe shape
 *   normalizeSharedAccounts(shares)       — aggregate + normalize full share list
 */

import "server-only";
import { possessive } from "@/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal shape required to produce a generic display name. */
export interface AccountTypeHint {
  type:            string;
  debtSubtype:     string | null;
  /** First name of the account owner. When provided, produces "Jane's Checking Account". */
  ownerFirstName?: string | null;
}

/** Fields a BALANCE_ONLY caller is allowed to see (single account). */
export interface BalanceOnlyAccount {
  id:          string;
  /** Generic display name — never the real account name or institution-derived name. */
  name:        string;
  type:        string;
  balance:     number;
  currency:    string;
  lastUpdated: string; // ISO string
}

/**
 * Consistent account shape returned by normalizeSharedAccounts.
 * Widgets consume this without needing to know about visibilityLevel.
 * FULL-only fields are undefined on BALANCE_ONLY aggregate rows.
 */
export interface NormalizedAccount {
  id:              string;
  name:            string;
  type:            string;
  balance:         number;
  currency:        string;
  lastUpdated:     string; // ISO string
  // Present only on FULL rows:
  institution?:    string;
  creditLimit?:    number | null;
  debtSubtype?:    string | null;
  interestRate?:   number | null;
  minimumPayment?: number | null;
}

/** Raw share row shape expected by normalizeSharedAccounts. */
export interface ShareRow {
  visibilityLevel:  string;
  addedByUserId:    string;
  addedByUser:      { firstName: string | null; name: string | null };
  financialAccount: {
    id:             string;
    name:           string;
    type:           string;
    institution:    string;
    balance:        number;
    currency:       string;
    lastUpdated:    Date;
    creditLimit:    number | null;
    debtSubtype:    string | null;
    interestRate:   number | null;
    minimumPayment: number | null;
  };
}

// ── Plural forms ──────────────────────────────────────────────────────────────

// Explicit map so pluralisation is predictable and never surprises.
const PLURAL_BASE: Record<string, string> = {
  "Checking Account":   "Checking Accounts",
  "Savings Account":    "Savings Accounts",
  "Investment Account": "Investment Accounts",
  "Crypto Wallet":      "Crypto Wallets",
  "Credit Card":        "Credit Cards",
  "Mortgage Account":   "Mortgage Accounts",
  "Auto Loan":          "Auto Loans",
  "Loan Account":       "Loan Accounts",
  "Debt Account":       "Debt Accounts",
  "Other Account":      "Other Accounts",
};

function pluralizeBase(base: string): string {
  return PLURAL_BASE[base] ?? `${base}s`;
}

// ── Generic display name ──────────────────────────────────────────────────────

/**
 * Returns a generic, non-identifying display name for an account.
 *
 * `debtSubtype` is consumed internally to pick a more specific label for debt
 * accounts (e.g. "Credit Card" vs "Loan Account") but the raw value is never
 * present in the output.
 */
export function genericAccountName({ type, debtSubtype, ownerFirstName }: AccountTypeHint): string {
  let base: string;

  switch (type) {
    case "checking":
      base = "Checking Account"; break;
    case "savings":
      base = "Savings Account"; break;
    case "investment":
      base = "Investment Account"; break;
    case "crypto":
      base = "Crypto Wallet"; break;
    case "debt": {
      switch (debtSubtype) {
        case "credit_card":
        case "line_of_credit":
        case "heloc":
          base = "Credit Card"; break;
        case "mortgage":
          base = "Mortgage Account"; break;
        case "auto_loan":
          base = "Auto Loan"; break;
        case "personal_loan":
        case "student_loan":
          base = "Loan Account"; break;
        default:
          base = "Debt Account";
      }
      break;
    }
    default:
      base = "Other Account";
  }

  return ownerFirstName ? `${possessive(ownerFirstName)} ${base}` : base;
}

// ── Single-account sanitizer ──────────────────────────────────────────────────

/**
 * Strips all identifying fields from an account record and returns only the
 * fields permitted under the BALANCE_ONLY visibility tier.
 *
 * Use this for one-off sanitisation.  For a full share list, prefer
 * normalizeSharedAccounts which also aggregates duplicate generic rows.
 */
export function sanitizeForBalanceOnly(
  account: {
    id:          string;
    type:        string;
    debtSubtype: string | null;
    balance:     number;
    currency:    string;
    lastUpdated: Date | string;
  },
  ownerFirstName?: string | null,
): BalanceOnlyAccount {
  return {
    id:          account.id,
    name:        genericAccountName({
      type:          account.type,
      debtSubtype:   account.debtSubtype,
      ownerFirstName,
    }),
    type:        account.type,
    balance:     account.balance,
    currency:    account.currency,
    lastUpdated: typeof account.lastUpdated === "string"
      ? account.lastUpdated
      : account.lastUpdated.toISOString(),
  };
}

// ── Aggregating normalizer ────────────────────────────────────────────────────

/**
 * Converts a raw list of SpaceAccountLink rows into a normalised account
 * array safe for every space widget to consume.
 *
 * Rules:
 *  - FULL shares pass through as individual records with all fields intact.
 *  - BALANCE_ONLY shares are sanitised and then grouped by
 *      owner × base label × currency
 *    so that multiple accounts of the same type from the same person collapse
 *    into one row with a summed balance and a plural label when count > 1.
 *  - Currency is part of the grouping key — mixed-currency accounts are never
 *    summed blindly.
 *  - Aggregated rows use a stable synthetic id:
 *      "balance-only:{ownerId}:{baseLabel}:{currency}"
 *  - No identifying field (real name, institution, rates, Plaid metadata) is
 *    present on BALANCE_ONLY rows.
 *  - Output is sorted: type asc, name asc — same order the DB query used.
 */
export function normalizeSharedAccounts(shares: ShareRow[]): NormalizedAccount[] {
  const fullRows: NormalizedAccount[] = [];

  // Aggregation state for BALANCE_ONLY groups.
  const groups = new Map<
    string,
    {
      count:          number;
      ownerId:        string;
      ownerFirstName: string | null;
      baseLabel:      string;  // singular, no owner prefix
      type:           string;
      balance:        number;
      currency:       string;
      lastUpdated:    Date;
    }
  >();

  for (const share of shares) {
    const a = share.financialAccount;

    if (share.visibilityLevel === "FULL") {
      fullRows.push({
        id:             a.id,
        name:           a.name,
        type:           a.type,
        institution:    a.institution,
        balance:        a.balance,
        currency:       a.currency,
        lastUpdated:    a.lastUpdated.toISOString(),
        creditLimit:    a.creditLimit,
        debtSubtype:    a.debtSubtype,
        interestRate:   a.interestRate,
        minimumPayment: a.minimumPayment,
      });
      continue;
    }

    // BALANCE_ONLY — derive owner name and base label, then group.
    const ownerFirstName =
      share.addedByUser.firstName?.trim() ||
      share.addedByUser.name?.trim().split(" ")[0] ||
      null;

    // Base label has no owner prefix — the prefix is added after aggregation
    // so the key stays stable even if first names differ (they shouldn't, but
    // we group by ownerId not ownerFirstName).
    const baseLabel = genericAccountName({ type: a.type, debtSubtype: a.debtSubtype });
    const key       = `${share.addedByUserId}:${baseLabel}:${a.currency}`;

    const existing = groups.get(key);
    if (existing) {
      existing.count   += 1;
      existing.balance += a.balance;
      if (a.lastUpdated > existing.lastUpdated) existing.lastUpdated = a.lastUpdated;
    } else {
      groups.set(key, {
        count:          1,
        ownerId:        share.addedByUserId,
        ownerFirstName,
        baseLabel,
        type:           a.type,
        balance:        a.balance,
        currency:       a.currency,
        lastUpdated:    a.lastUpdated,
      });
    }
  }

  // Build aggregated rows from groups.
  const aggregatedRows: NormalizedAccount[] = [];
  for (const [key, g] of groups) {
    const displayBase = g.count > 1 ? pluralizeBase(g.baseLabel) : g.baseLabel;
    const displayName = g.ownerFirstName ? `${possessive(g.ownerFirstName)} ${displayBase}` : displayBase;

    aggregatedRows.push({
      id:          `balance-only:${key}`,
      name:        displayName,
      type:        g.type,
      balance:     g.balance,
      currency:    g.currency,
      lastUpdated: g.lastUpdated.toISOString(),
    });
  }

  // Sort both sets by type then name for consistent widget ordering.
  const sort = (rows: NormalizedAccount[]) =>
    rows.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  return [...sort(fullRows), ...sort(aggregatedRows)];
}
