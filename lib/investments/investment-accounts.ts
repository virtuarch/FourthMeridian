/**
 * lib/investments/investment-accounts.ts  (2026-10-07)
 *
 * The investment ACCOUNTS behind the canonical investment aggregate — so every
 * account that contributes to investment wealth can be found in Assets, whether
 * or not security-level holdings exist for it.
 *
 * THE DEFECT THIS CLOSES. Net worth, the Assets headline and Conversations all
 * value investments from ACCOUNT BALANCES (classifyAccounts over the Space's
 * linked accounts → SpaceSnapshot.stocks + crypto). The Investments section of
 * Assets was built ONLY from positions (holdings). A Sandbox user's 401(k) and
 * IRA — $23,952.74 of balances at an institution with no Investments product —
 * were counted in "Investments & crypto $23,952.74" at the top of the page and
 * rendered as "Portfolio value $0.00 · No holdings for this date" in the
 * section below; the only place they were named was a "Connections" card
 * listing them as connection problems. Holdings are ENRICHMENT; an account's
 * existence and value never depended on them anywhere else.
 *
 * ONE AUTHORITY, BY CONSTRUCTION. Rows come from the SAME reader the snapshot
 * uses (readSpaceAccountsForSnapshot — wallet current values included), the
 * SAME consent-pending exclusion (consentPendingInvestmentAccountIds), and the
 * SAME conversion (convertMoney at the snapshot valuation date); the totals are
 * classifyAccounts' own totals. So Σ counted rows = the canonical investment +
 * digital-asset aggregate, and nothing here is a second interpretation of
 * "investments". Holdings counts are read from the current-positions seam and
 * are never added to a balance (no double counting: holdings describe a
 * balance, they are not a second amount).
 */

import { classifyAccounts, isDigitalAssetAccountType } from "@/lib/account-classifier";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";

export type InvestmentAssetClass = "investment" | "crypto";

/**
 * - holdings              security-level holdings are available
 * - holdings_unavailable  the account is counted at its balance; no holdings
 *                         were reported (institution has no Investments
 *                         product, or none were returned) — never manufactured
 * - consent_required      NOT counted in wealth yet: Investments permission is
 *                         pending (the canonical snapshot excludes these)
 */
export type InvestmentAccountStatus = "holdings" | "holdings_unavailable" | "consent_required";

export interface InvestmentAccountRow {
  id:          string;
  /** Canonical display name, or a generic label when the link withholds detail. */
  name:        string;
  institution: string | null;
  assetClass:  InvestmentAssetClass;
  /** Balance in the reporting currency; null when it could not be converted. */
  value:       number | null;
  /** Counted in the canonical investment aggregate. */
  counted:     boolean;
  status:      InvestmentAccountStatus;
  /** Number of current holdings for this account (0 when unavailable). */
  holdings:    number;
  /** The account's provider connection needs the user (reconnect / error). */
  connectionNeedsAttention: boolean;
}

export interface InvestmentAccountsSlice {
  reportingCurrency: string;
  rows:              InvestmentAccountRow[];
  /** classifyAccounts(counted).totalInvestments — equals SpaceSnapshot.stocks for the same population. */
  investmentsTotal:  number;
  /** classifyAccounts(counted).totalDigitalAssets — equals SpaceSnapshot.crypto. */
  cryptoTotal:       number;
}

export interface InvestmentAccountInput {
  id:          string;
  type:        string;
  balance:     number;
  currency:    string | null;
  name:        string;
  institution: string | null;
  detailVisible: boolean;
  consentPending: boolean;
  connectionNeedsAttention: boolean;
  holdings:    number;
}

const GENERIC_NAME: Record<InvestmentAssetClass, string> = {
  investment: "Investment account",
  crypto:     "Crypto wallet",
};

/**
 * PURE. Investment + digital-asset accounts only; everything else is ignored.
 * `ctx`/`valuationDateISO` are the snapshot's own; omit both for a
 * same-currency read (identity), exactly as classifyAccounts does.
 */
export function assembleInvestmentAccounts(
  inputs:            InvestmentAccountInput[],
  reportingCurrency: string,
  ctx?:              ConversionContext,
  valuationDateISO?: string,
): InvestmentAccountsSlice {
  const relevant = inputs.filter((a) => a.type === "investment" || isDigitalAssetAccountType(a.type));
  const counted  = relevant.filter((a) => !a.consentPending);
  const totals   = classifyAccounts(counted, ctx, valuationDateISO);

  const rows: InvestmentAccountRow[] = relevant.map((a) => {
    const assetClass: InvestmentAssetClass = a.type === "investment" ? "investment" : "crypto";
    const value = ctx && valuationDateISO
      ? convertMoney({ amount: a.balance, currency: a.currency ?? null }, valuationDateISO, ctx).amount
      : a.balance;
    return {
      id:          a.id,
      name:        a.detailVisible ? a.name : GENERIC_NAME[assetClass],
      institution: a.detailVisible ? a.institution : null,
      assetClass,
      value,
      counted:     !a.consentPending,
      status:      a.consentPending ? "consent_required" : a.holdings > 0 ? "holdings" : "holdings_unavailable",
      holdings:    a.holdings,
      connectionNeedsAttention: a.connectionNeedsAttention,
    };
  });
  // Largest first; uncounted rows after counted ones.
  rows.sort((x, y) => Number(y.counted) - Number(x.counted) || (y.value ?? 0) - (x.value ?? 0));

  return {
    reportingCurrency,
    rows,
    investmentsTotal: totals.totalInvestments,
    cryptoTotal:      totals.totalDigitalAssets,
  };
}
