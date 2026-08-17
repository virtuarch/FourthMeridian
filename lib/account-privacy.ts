/**
 * lib/account-privacy.ts
 *
 * THE population/boundary authority for privacy-reduced account views —
 * enforcing SpaceAccountLink visibility tiers at the API-response level.
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
 *   aggregated into one row so the UI never renders duplicate generic labels.
 *
 * FULL
 *   All fields are permitted.  No sanitization needed.
 *
 * SUMMARY_ONLY / PRIVATE / legacy SHARED / anything unknown
 *   FAIL CLOSED (REVIEW-3 B-1). These tiers grant no balance disclosure, so
 *   they produce NO row and contribute to NO sum; they are counted in
 *   `redactedCount` so a surface can disclose the redaction — the same
 *   treatment the perspective lenses give them (debt.core.ts partitions them
 *   into `summaryOnly` and excludes them from every total).
 *
 * ── Privacy aggregation happens AFTER financial semantics (REVIEW-3 B-1) ─────
 * The former aggregator summed RAW SIGNED balances into the synthetic row
 * (`existing.balance += a.balance`), UPSTREAM of lib/debt/balance-semantics.ts.
 * Two BALANCE_ONLY cards at +$500 and −$200 netted to a $300 "owed" — an
 * issuer credit discharging another account's debt, which V25-SIDE-1 forbids
 * and which no downstream clamp could see (amountOwed is per-row and the
 * netting had already happened). The rule now:
 *
 *   - Each member is interpreted FIRST by the balance-semantics authority:
 *     a debt member contributes `amountOwed` to the group's owed total and
 *     `creditBalance` to the group's credit total — the two are carried
 *     SEPARATELY and never netted.
 *   - A debt aggregate row's `balance` IS its owed total (Σ per-member
 *     amountOwed, always ≥ 0), so every downstream consumer that clamps
 *     per row (`computeDebtAggregate`, `classifyAccounts`) gets the same
 *     answer as summing the members individually — clamping is idempotent
 *     on an already-clamped figure.
 *   - A non-debt aggregate row's `balance` is the signed member sum, which
 *     is identical to summing the members individually (no clamp applies
 *     to asset rows anywhere downstream).
 *   - Member identity (`aggregate.memberAccountIds`) and count
 *     (`aggregate.memberCount`) ride on the row, so consumers can resolve
 *     per-member state (currentState) and honest counts — the synthetic id
 *     no longer makes those lookups silently miss.
 *
 * Public API:
 *   genericAccountName(hint)              — base label from type + debtSubtype
 *   sanitizeForBalanceOnly(account, name) — single-account safe shape
 *   normalizeSharedAccounts(shares)       — { accounts, redactedCount }
 *   grantsBalanceDisclosure(level)        — the fail-closed tier predicate
 *   aggregateCurrentCashState(claims)     — per-member → aggregate-row claim
 */

import "server-only";
import { possessive } from "@/lib/format";
import { amountOwed, creditBalance } from "@/lib/debt/balance-semantics";

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
 * REVIEW-3 B-1 — what an aggregated privacy-reduced row preserves, separately,
 * so that privacy aggregation never destroys financial semantics:
 *
 *   owed vs credit   — never netted against each other (V25-SIDE-1);
 *   member identity  — the FinancialAccount ids needed to resolve per-member
 *                      currentState (the synthetic row id maps to no account);
 *   member count     — the honest disclosure/count semantics (a Space's
 *                      account count is the LINK count, not the row count).
 */
export interface PrivacyAggregate {
  /** FinancialAccount ids of every member link folded into this row. */
  memberAccountIds: string[];
  /** How many member links this row discloses. */
  memberCount:      number;
  /**
   * Σ amountOwed(member.balance) over debt members — THE "how much is owed"
   * figure for this row, and (for debt rows) identical to `balance`.
   * 0 on non-debt rows.
   */
  owedTotal:        number;
  /**
   * Σ creditBalance(member.balance) over debt members — issuer credit held in
   * the members' favour, as a positive magnitude. DISCLOSED, never netted:
   * an issuer credit is spendable only at that issuer and can never discharge
   * another account's obligation. 0 on non-debt rows.
   */
  creditTotal:      number;
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
  lastUpdated:     string; // ISO string — Fourth Meridian's WRITE clock
  /**
   * v2.6-L1 — FinancialAccount.balanceLastUpdatedAt: the INSTITUTION's own
   * attestation of when it computed the balance. Null when the provider does not
   * supply it (today: every institution in the corpus), and null is honest —
   * `lastUpdated` is never substituted, because our fetch time is not the
   * institution's computation time. Carried at every visibility tier: it is a
   * timestamp about a balance the row already discloses, so it reveals nothing
   * the tier does not already permit.
   *
   * On an aggregated BALANCE_ONLY row it is null unless EVERY member carries an
   * attestation (an aggregate is never more attested than its weakest member),
   * in which case it is the OLDEST of them.
   */
  balanceLastUpdatedAt?: string | null;
  // Present only on FULL rows:
  institution?:    string;
  creditLimit?:    number | null;
  debtSubtype?:    string | null;
  interestRate?:   number | null;
  minimumPayment?: number | null;
  /**
   * YYYY-MM-DD of the account's earliest non-deleted transaction — the same
   * per-account floor the wealth-history regen uses (lib/snapshots/regenerate-
   * history.ts). Attached by the accounts route, not normalizeSharedAccounts
   * itself. Present on FULL rows with transactions; null otherwise (no synced
   * transactions, or a BALANCE_ONLY aggregate row that maps to no single
   * FinancialAccount). Consumed by RebuildHistoryButton as the "From" min.
   */
  earliestTxDate?: string | null;
  /**
   * REVIEW-3 B-1 — present ONLY on aggregated privacy-reduced rows (synthetic
   * id). Absent on FULL rows. See PrivacyAggregate.
   */
  aggregate?: PrivacyAggregate;
}

/** Raw share row shape expected by normalizeSharedAccounts. */
export interface ShareRow {
  visibilityLevel:  string;
  // OPS-2 S5 — nullable since SpaceAccountLink.addedByUserId flipped to
  // SetNull: a link whose adder's account was deleted has a null adder.
  addedByUserId:    string | null;
  addedByUser:      { firstName: string | null; name: string | null } | null;
  financialAccount: {
    id:             string;
    name:           string;
    type:           string;
    institution:    string;
    balance:        number;
    currency:       string;
    lastUpdated:    Date;
    /** v2.6-L1 — optional so existing callers that do not select it still compile;
     *  absent is treated exactly like null (no provider attestation). */
    balanceLastUpdatedAt?: Date | null;
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

// ── The fail-closed tier predicate ────────────────────────────────────────────

/**
 * True when this SpaceAccountLink tier permits the BALANCE of the account to be
 * disclosed to the Space (FULL: everything; BALANCE_ONLY: the balance alone).
 *
 * Everything else — SUMMARY_ONLY, PRIVATE, legacy SHARED, unknown/future
 * values — FAILS CLOSED: no row, no contribution to any sum, disclosed only as
 * a redaction count. This mirrors lib/ai/visibility.ts's discipline (absence of
 * a grant always fails closed) at the balance tier; it is deliberately a plain
 * string predicate so pure/client-safe callers can share it.
 */
export function grantsBalanceDisclosure(level: string): boolean {
  return level === "FULL" || level === "BALANCE_ONLY";
}

// ── Aggregate current-state (reachable cash) ──────────────────────────────────

/** Structural shape of the v2.6-L3 per-account current-state claim. */
export interface CurrentCashStateClaim {
  /** Reachable cash in the account's native currency, or null when unknown. */
  reachable:    number | null;
  /** The signed unexplained residual, or null when not reconcilable. */
  unexplained:  number | null;
  /** EXACT | PARTIALLY_ATTRIBUTED | UNAVAILABLE | CONTRADICTORY. */
  state:        string;
  /** Provider-observed pending rows backing the prediction. */
  pendingCount: number;
}

/**
 * REVIEW-3 B-1 — the aggregate-row current-state claim, composed from the
 * members' ALREADY-RESOLVED claims (lib/balances is the only resolver; this
 * only combines). The synthetic row id maps to no account, so before this the
 * currentState lookup silently missed and the LEDGER balance was published as
 * reachable cash on the Liquidity surfaces.
 *
 * Rules (same doctrine as the v2.6-L1 freshness aggregation above — an
 * aggregate is never more certain than its weakest member):
 *   - A claim exists only when EVERY member made one; otherwise undefined
 *     (no claim), matching the "absent = no claim was made" semantics.
 *   - `reachable` is the member sum, or null the moment ANY member's is null —
 *     a partial sum published under the word "reachable" would silently
 *     understate while claiming coverage.
 *   - `unexplained` sums POSITIVE member residuals only (a negative residual
 *     is a per-account contradiction and is never netted against real holds —
 *     same rule as lib/balances/reachable.ts); null when no member reported one.
 *   - `state` merges pessimistically: CONTRADICTORY > UNAVAILABLE >
 *     PARTIALLY_ATTRIBUTED > EXACT.
 */
export function aggregateCurrentCashState(
  members: (CurrentCashStateClaim | undefined)[],
): CurrentCashStateClaim | undefined {
  if (members.length === 0 || members.some((m) => m === undefined)) return undefined;
  const claims = members as CurrentCashStateClaim[];

  let reachable: number | null = 0;
  let unexplained: number | null = null;
  let pendingCount = 0;
  for (const c of claims) {
    if (c.reachable === null) reachable = null;
    else if (reachable !== null) reachable += c.reachable;
    if (c.unexplained !== null) {
      unexplained = (unexplained ?? 0) + Math.max(c.unexplained, 0);
    }
    pendingCount += c.pendingCount;
  }

  const states = new Set(claims.map((c) => c.state));
  const state =
    states.has("CONTRADICTORY") ? "CONTRADICTORY"
    : states.has("UNAVAILABLE") ? "UNAVAILABLE"
    : states.has("PARTIALLY_ATTRIBUTED") ? "PARTIALLY_ATTRIBUTED"
    : "EXACT";

  return { reachable, unexplained, state, pendingCount };
}

// ── Aggregating normalizer ────────────────────────────────────────────────────

/** The full result of normalising a share list — rows plus the redaction the
 *  fail-closed tiers produced, so a surface can disclose what was withheld. */
export interface NormalizedSharedAccounts {
  accounts: NormalizedAccount[];
  /**
   * ACTIVE links whose tier grants no balance disclosure (SUMMARY_ONLY /
   * PRIVATE / legacy SHARED / unknown). They are in NO row and NO sum — this
   * count is the only thing a consumer may say about them.
   */
  redactedCount: number;
}

/**
 * Converts a raw list of SpaceAccountLink rows into a normalised account
 * array safe for every space widget to consume, plus a redaction count.
 *
 * Rules:
 *  - FULL shares pass through as individual records with all fields intact.
 *  - BALANCE_ONLY shares are sanitised and then grouped by
 *      owner × base label × currency
 *    so that multiple accounts of the same type from the same person collapse
 *    into one row with a plural label when count > 1.
 *  - REVIEW-3 B-1: aggregation happens AFTER financial semantics (see module
 *    header). Debt rows carry `balance = Σ amountOwed` with issuer credit
 *    disclosed separately on `aggregate.creditTotal`; member ids and count
 *    ride on `aggregate`.
 *  - Non-disclosing tiers (SUMMARY_ONLY / PRIVATE / SHARED / unknown) FAIL
 *    CLOSED into `redactedCount` — never a row, never a sum.
 *  - Currency is part of the grouping key — mixed-currency accounts are never
 *    summed blindly.
 *  - Aggregated rows use a stable synthetic id:
 *      "balance-only:{ownerId}:{baseLabel}:{currency}"
 *  - No identifying field (real name, institution, rates, Plaid metadata) is
 *    present on BALANCE_ONLY rows.
 *  - Output is sorted: type asc, name asc — same order the DB query used.
 */
export function normalizeSharedAccounts(shares: ShareRow[]): NormalizedSharedAccounts {
  const fullRows: NormalizedAccount[] = [];
  let redactedCount = 0;

  // Aggregation state for BALANCE_ONLY groups.
  const groups = new Map<
    string,
    {
      count:          number;
      memberAccountIds: string[];
      // OPS-2 S5 — null when the adder's account was deleted (SetNull); such
      // rows still group correctly (the map key stringifies null uniformly).
      ownerId:        string | null;
      ownerFirstName: string | null;
      baseLabel:      string;  // singular, no owner prefix
      type:           string;
      /** Non-debt members only: signed sum (identical to per-member sums). */
      assetTotal:     number;
      /** Debt members only: Σ amountOwed — clamped PER MEMBER, never netted. */
      owedTotal:      number;
      /** Debt members only: Σ creditBalance — disclosed, never netted. */
      creditTotal:    number;
      currency:       string;
      lastUpdated:    Date;
      /** OLDEST member attestation, or null the moment ANY member lacks one. */
      balanceLastUpdatedAt: Date | null;
      /** False once a member arrives with no provider attestation. */
      allAttested:    boolean;
    }
  >();

  for (const share of shares) {
    const a = share.financialAccount;

    // REVIEW-3 B-1 — fail closed BEFORE any arithmetic: a tier that does not
    // grant balance disclosure contributes to no sum and produces no row.
    if (!grantsBalanceDisclosure(share.visibilityLevel)) {
      redactedCount += 1;
      continue;
    }

    if (share.visibilityLevel === "FULL") {
      fullRows.push({
        id:             a.id,
        name:           a.name,
        type:           a.type,
        institution:    a.institution,
        balance:        a.balance,
        currency:       a.currency,
        lastUpdated:    a.lastUpdated.toISOString(),
        balanceLastUpdatedAt: a.balanceLastUpdatedAt?.toISOString() ?? null,
        creditLimit:    a.creditLimit,
        debtSubtype:    a.debtSubtype,
        interestRate:   a.interestRate,
        minimumPayment: a.minimumPayment,
      });
      continue;
    }

    // BALANCE_ONLY — derive owner name and base label, then group.
    const ownerFirstName =
      share.addedByUser?.firstName?.trim() ||
      share.addedByUser?.name?.trim().split(" ")[0] ||
      null;

    // Base label has no owner prefix — the prefix is added after aggregation
    // so the key stays stable even if first names differ (they shouldn't, but
    // we group by ownerId not ownerFirstName).
    const baseLabel = genericAccountName({ type: a.type, debtSubtype: a.debtSubtype });
    const key       = `${share.addedByUserId}:${baseLabel}:${a.currency}`;

    // ⚠️ REVIEW-3 B-1 — THE AGGREGATION SITE. Semantics BEFORE aggregation:
    // the raw signed balance is interpreted per member by the balance-semantics
    // authority and only the interpreted quantities are summed. A raw signed
    // sum here (`+= a.balance` on a debt member) is the defect this slice
    // removed — it let an issuer credit discharge another account's debt.
    const isDebt      = a.type === "debt";
    const memberOwed  = isDebt ? amountOwed(a.balance)    : 0;
    const memberCred  = isDebt ? creditBalance(a.balance) : 0;
    const memberAsset = isDebt ? 0 : a.balance;

    const existing = groups.get(key);
    if (existing) {
      existing.count       += 1;
      existing.memberAccountIds.push(a.id);
      existing.owedTotal   += memberOwed;
      existing.creditTotal += memberCred;
      existing.assetTotal  += memberAsset;
      // v2.6-L1 — the group's freshness is its OLDEST member, not its newest.
      // This was a MAX: a summed balance was claiming the freshness of whichever
      // member happened to be refreshed most recently, so one fresh account made
      // an aggregate of stale ones look current. A sum is only as observed as its
      // stalest addend.
      if (a.lastUpdated < existing.lastUpdated) existing.lastUpdated = a.lastUpdated;
      // Provider attestation survives aggregation only if EVERY member has one.
      const attested = a.balanceLastUpdatedAt ?? null;
      if (attested === null) {
        existing.allAttested = false;
        existing.balanceLastUpdatedAt = null;
      } else if (existing.allAttested) {
        if (existing.balanceLastUpdatedAt === null || attested < existing.balanceLastUpdatedAt) {
          existing.balanceLastUpdatedAt = attested;
        }
      }
    } else {
      const attested = a.balanceLastUpdatedAt ?? null;
      groups.set(key, {
        count:          1,
        memberAccountIds: [a.id],
        ownerId:        share.addedByUserId,
        ownerFirstName,
        baseLabel,
        type:           a.type,
        assetTotal:     memberAsset,
        owedTotal:      memberOwed,
        creditTotal:    memberCred,
        currency:       a.currency,
        lastUpdated:    a.lastUpdated,
        balanceLastUpdatedAt: attested,
        allAttested:    attested !== null,
      });
    }
  }

  // Build aggregated rows from groups.
  const aggregatedRows: NormalizedAccount[] = [];
  for (const [key, g] of groups) {
    const displayBase = g.count > 1 ? pluralizeBase(g.baseLabel) : g.baseLabel;
    const displayName = g.ownerFirstName ? `${possessive(g.ownerFirstName)} ${displayBase}` : displayBase;

    // REVIEW-3 B-1 — a debt row's balance IS what is owed (per-member clamps,
    // already summed); issuer credit is a separate disclosed magnitude. The
    // invariant is asserted at the site that owns it, not left to a consumer.
    const balance = g.type === "debt" ? g.owedTotal : g.assetTotal;
    if (g.type === "debt" && (g.owedTotal < 0 || g.creditTotal < 0 || amountOwed(balance) !== balance)) {
      throw new Error(
        `account-privacy invariant violated: debt aggregate "${key}" carries a netted/signed balance ` +
        `(owedTotal=${g.owedTotal}, creditTotal=${g.creditTotal})`,
      );
    }

    aggregatedRows.push({
      id:          `balance-only:${key}`,
      name:        displayName,
      type:        g.type,
      balance,
      currency:    g.currency,
      lastUpdated: g.lastUpdated.toISOString(),
      balanceLastUpdatedAt: g.allAttested ? (g.balanceLastUpdatedAt?.toISOString() ?? null) : null,
      aggregate: {
        memberAccountIds: g.memberAccountIds,
        memberCount:      g.count,
        owedTotal:        g.owedTotal,
        creditTotal:      g.creditTotal,
      },
    });
  }

  // Sort both sets by type then name for consistent widget ordering.
  const sort = (rows: NormalizedAccount[]) =>
    rows.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  return { accounts: [...sort(fullRows), ...sort(aggregatedRows)], redactedCount };
}
