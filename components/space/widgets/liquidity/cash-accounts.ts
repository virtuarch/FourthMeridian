/**
 * components/space/widgets/liquidity/cash-accounts.ts   (v2.7 — Cash accounts)
 *
 * Pure presentation helpers behind the Cash section's DISTRIBUTION donut and
 * CASH ACCOUNTS ledger. No React, no clock, no fetch — and NO new financial
 * formula. Every figure here is one of two already-owned quantities, read per
 * account through the existing authorities:
 *
 *   TOTAL CASH     the ledger `balance` of every checking + savings account,
 *                  restricted (HSA) included, converted per row through
 *                  convertMoney at the latest close — the SAME definition and
 *                  the SAME conversion as `classifyAccounts().totalLiquid +
 *                  totalRestrictedCash` (the net-worth "Cash" composition and
 *                  the Cash hero present-day). An FX-unavailable row contributes
 *                  0, exactly as the classifier excludes it.
 *   AVAILABLE      `reachableForAccount` (liquidity-adapters) — the three-state
 *                  current-state rule `reachableNow()` sums. Restricted cash is
 *                  never "available" (liquidityAccess "restricted"); a null
 *                  reachable is "Not reported" and is excluded from accessible.
 *
 * The RECONCILIATION is pure subtraction over those already-converted
 * per-account figures, so every dollar between "Total cash" and "Accessible
 * now" is explained:
 *
 *   totalCash − restricted − notReported − pending − holds = accessible
 *                                                       (= reachableNow().total)
 *
 * Per covered unrestricted account, ledger − reachable is split from existing
 * currentState fields only: hold = max(unexplained, 0) (positive residual, as
 * lib/balances/reachable counts it); pending = the rest, when the provider
 * observed pending rows (pendingCount > 0) — outflows the bank's current
 * balance has not deducted yet (often in-flight transfers to the user's own
 * accounts that already posted at the destination, so they sit in two ledger
 * balances). A remainder with no pending evidence is kept as `other` so the
 * line still sums exactly.
 * Nothing here changes a classification, a balance, a reachable rule or a
 * snapshot — it only groups and labels.
 */

import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { liquidityAccess, normalizeProviderSubtype } from "@/lib/account-classifier";
import { assignStableColors } from "@/lib/charts/chart-palette";
import type { ConversionContext } from "@/lib/money/types";
import { reachableForAccount, type LiquidityAdapterAccount } from "@/components/space/widgets/liquidity-adapters";

/** The host's shared account row, as far as the Cash ledger reads it (SpaceAccount ⊇ this). */
export interface CashLedgerAccount extends LiquidityAdapterAccount {
  lastUpdated?:          string;
  balanceLastUpdatedAt?: string | null;
  userEstimate?:         true;
  /** REVIEW-3 B-1 — present only on an aggregated privacy-reduced (BALANCE_ONLY) row. */
  aggregate?: {
    memberAccountIds: string[];
    memberCount:      number;
    owedTotal:        number;
    creditTotal:      number;
  };
}

/** What the ledger's Available column states for one account. */
export type CashAvailable =
  | {
      kind:  "amount";
      value: number;
      /** (ledger − reachable) − hold, when the provider observed pending rows
       *  (currentState.pendingCount > 0): outflows the bank's current balance
       *  has not deducted yet. 0 when none. */
      pending: number;
      /** max(currentState.unexplained, 0) — a positive residual nothing explains
       *  (the same positive-only rule as lib/balances/reachable). 0 when none. */
      hold: number;
      /** Any remaining ledger − reachable difference with no pending evidence
       *  (kept so the line still sums exactly; normally 0). */
      other: number;
    }
  /** A current-state claim was made and reachable is UNKNOWN — excluded from accessible. */
  | { kind: "not_reported" }
  /** liquidityAccess "restricted" (e.g. an HSA) — owned cash, never accessible. */
  | { kind: "restricted" };

export interface CashAccountRow {
  account:     CashLedgerAccount;
  /** Display-currency ledger balance (0 when the conversion was unavailable). */
  value:       number;
  estimated:   boolean;
  /** FX-unavailable: excluded from every total (classifier parity), disclosed on the row. */
  unconverted: boolean;
  /** The native amount, when the account's currency differs from the display currency. */
  native:      { amount: number; currency: string } | null;
  /** value / total cash (0 when total cash is 0). */
  share:       number;
  /** "Checking" / "Savings", refined by the provider subtype where one is reported. */
  typeLabel:   string;
  available:   CashAvailable;
  /** Aggregated privacy row — shown as-is, never opened as a single account. */
  isAggregate: boolean;
  /** Link count behind the row (aggregate member count, else 1). */
  memberCount: number;
}

export interface CashAccountsSummary {
  /** Sorted largest balance first. Every cash account exactly once. */
  rows:        CashAccountRow[];
  /** Σ row values — equals classifyAccounts total cash for the same accounts + ctx. */
  totalCash:   number;
  /** Σ Available amounts — equals reachableNow().total. */
  accessible:  number;
  /** Σ value of restricted rows. */
  restricted:  number;
  /** Σ value of rows whose available figure was not reported. */
  notReported: number;
  /** Σ pending outflows not yet deducted (covered unrestricted rows). */
  pending:     number;
  /** Σ positive unexplained holds (covered unrestricted rows). */
  holds:       number;
  /** Σ any remaining ledger − reachable difference with no pending evidence. */
  other:       number;
  estimated:   boolean;
  unconverted: boolean;
  /** Member-aware account count. */
  accountCount: number;
}

export type CashGrouping = "institution" | "account" | "type";

export const CASH_GROUPINGS: { id: CashGrouping; label: string }[] = [
  { id: "institution", label: "By institution" },
  { id: "account",     label: "By account" },
  { id: "type",        label: "By account type" },
];

export interface CashGroup {
  id:      string;
  label:   string;
  /** Display-currency Σ of the members' balances. */
  value:   number;
  /** value / total cash. */
  share:   number;
  color:   string;
  /** Member-aware account count. */
  count:   number;
  meta?:   string;
}

// ── Labels ────────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = { checking: "Checking", savings: "Savings" };

/** Display names for the provider's depository subtypes (presentation only). */
const SUBTYPE_LABEL: Record<string, string> = {
  "checking":        "Checking",
  "savings":         "Savings",
  "money market":    "Money market",
  "cd":              "CD",
  "hsa":             "HSA",
  "cash management": "Cash management",
  "prepaid":         "Prepaid",
  "paypal":          "PayPal",
  "ebt":             "EBT",
};

/** The account-type label: the provider subtype when reported, else the broad type. */
export function cashTypeLabel(a: { type: string; providerSubtype?: string | null }): string {
  const sub = normalizeProviderSubtype(a.providerSubtype);
  if (sub) return SUBTYPE_LABEL[sub] ?? sub.charAt(0).toUpperCase() + sub.slice(1);
  return TYPE_LABEL[a.type] ?? a.type;
}

/** Is this account part of total cash? checking + savings, restricted included. */
export function isCashAccount(a: { type: string; providerSubtype?: string | null }): boolean {
  const access = liquidityAccess(a);
  return (a.type === "checking" || a.type === "savings") && (access === "cash" || access === "restricted");
}

/** Half a cent — below this a difference is floating-point residue, not money. */
const CENT = 0.005;

// ── Rows + totals ─────────────────────────────────────────────────────────────

export function buildCashAccounts(
  accounts: CashLedgerAccount[],
  ctx?:     ConversionContext,
): CashAccountsSummary {
  const asOf = yesterdayUTCISO();
  let estimated = false, unconverted = false;
  // The adapters' inDisp (convertMoney at the latest close; unavailable ⇒ 0).
  const conv = (amount: number, currency: string | null | undefined) =>
    ctx ? (convertMoney({ amount, currency: currency ?? null }, asOf, ctx).amount ?? 0) : amount;

  const rows: CashAccountRow[] = accounts.filter(isCashAccount).map((a) => {
    // The classifier's per-row conversion (sumBalances): convertMoney at the
    // latest close; an unavailable amount contributes nothing.
    let value = a.balance, est = false, miss = false;
    if (ctx) {
      const c = convertMoney({ amount: a.balance, currency: a.currency ?? null }, asOf, ctx);
      est = c.estimated;
      miss = c.amount === null;
      value = c.amount ?? 0;
    }
    estimated ||= est;
    unconverted ||= miss;

    const restricted = liquidityAccess(a) === "restricted";
    let available: CashAvailable;
    if (restricted) available = { kind: "restricted" };
    else {
      const r = reachableForAccount(a, ctx);
      if (r === null) available = { kind: "not_reported" };
      else {
        // Split ledger − reachable from the existing current-state fields only:
        // the positive unexplained residual is a HOLD; with provider-observed
        // pending rows the rest is PENDING outflows already folded into reachable.
        const cs = a.currentState;
        const unex = cs?.unexplained == null ? 0 : conv(cs.unexplained, a.currency);
        const hold = Math.max(unex, 0);
        const raw = value - r - hold;
        // Sub-cent float residue (e.g. 17000 − 15374.59 − 1625.41) is not a difference.
        const rest = Math.abs(raw) < CENT ? 0 : raw;
        const hasPending = (cs?.pendingCount ?? 0) > 0;
        available = { kind: "amount", value: r, hold, pending: hasPending ? rest : 0, other: hasPending ? 0 : rest };
      }
    }

    const display = ctx?.target;
    return {
      account:     a,
      value,
      estimated:   est,
      unconverted: miss,
      native:      display && a.currency && a.currency !== display ? { amount: a.balance, currency: a.currency } : null,
      share:       0,
      typeLabel:   cashTypeLabel(a),
      available,
      isAggregate: a.aggregate != null,
      memberCount: a.aggregate?.memberCount ?? 1,
    };
  });

  let totalCash = 0, accessible = 0, restricted = 0, notReported = 0, pending = 0, holds = 0, other = 0, accountCount = 0;
  for (const r of rows) {
    totalCash += r.value;
    accountCount += r.memberCount;
    if (r.available.kind === "restricted") restricted += r.value;
    else if (r.available.kind === "not_reported") notReported += r.value;
    else { accessible += r.available.value; pending += r.available.pending; holds += r.available.hold; other += r.available.other; }
  }
  for (const r of rows) r.share = totalCash !== 0 ? r.value / totalCash : 0;
  rows.sort((x, y) => y.value - x.value || x.account.name.localeCompare(y.account.name));

  return { rows, totalCash, accessible, restricted, notReported, pending, holds, other, estimated, unconverted, accountCount };
}

// ── Groups (the distribution donut) ───────────────────────────────────────────

function groupKey(r: CashAccountRow, by: CashGrouping): { id: string; label: string; meta?: string } {
  switch (by) {
    case "account":
      return { id: `account:${r.account.id}`, label: r.account.name, ...(r.account.institution ? { meta: r.account.institution } : {}) };
    case "type":
      return { id: `type:${r.typeLabel}`, label: r.typeLabel };
    case "institution": {
      // An aggregated privacy row never carries an institution (it is identifying).
      const inst = r.account.institution?.trim();
      return inst
        ? { id: `institution:${inst}`, label: inst }
        : { id: "institution:", label: r.isAggregate ? "Shared (institution withheld)" : "Institution not reported" };
    }
  }
}

/**
 * Group the rows. Σ group values === summary.totalCash (every row lands in
 * exactly one group). Colours are DERIVED from the group's stable id
 * (assignStableColors), so the donut slice and its legend row always agree and a
 * balance change never recolours a group.
 */
export function groupCashAccounts(summary: CashAccountsSummary, by: CashGrouping): CashGroup[] {
  const map = new Map<string, CashGroup>();
  for (const r of summary.rows) {
    const k = groupKey(r, by);
    const g = map.get(k.id) ?? { id: k.id, label: k.label, value: 0, share: 0, color: "", count: 0, ...(k.meta ? { meta: k.meta } : {}) };
    g.value += r.value;
    g.count += r.memberCount;
    map.set(k.id, g);
  }
  const groups = [...map.values()];
  const colors = assignStableColors(groups.map((g) => g.id));
  groups.forEach((g, i) => {
    g.color = colors[i];
    g.share = summary.totalCash !== 0 ? g.value / summary.totalCash : 0;
  });
  return groups.sort((x, y) => y.value - x.value || x.label.localeCompare(y.label));
}

// ── The reconciling line ──────────────────────────────────────────────────────

export interface ReconcileTerm {
  id:     "restricted" | "not_reported" | "pending" | "holds" | "other";
  /** Signed contribution to the line: total − … ⇒ negative for a deduction. */
  amount: number;
  label:  string;
}

/**
 * The non-zero terms between total cash and accessible, in the order the line
 * reads them. Σ terms + totalCash === accessible (to floating precision).
 */
export function reconcileTerms(s: CashAccountsSummary): ReconcileTerm[] {
  const terms: ReconcileTerm[] = [];
  if (Math.abs(s.restricted) >= CENT)  terms.push({ id: "restricted",   amount: -s.restricted,  label: "restricted" });
  if (Math.abs(s.notReported) >= CENT) terms.push({ id: "not_reported", amount: -s.notReported, label: "no available balance reported" });
  if (Math.abs(s.pending) >= CENT)     terms.push({ id: "pending",      amount: -s.pending,     label: "pending outflows not yet deducted" });
  if (Math.abs(s.holds) >= CENT)       terms.push({ id: "holds",        amount: -s.holds,       label: "on hold" });
  if (Math.abs(s.other) >= CENT)       terms.push({ id: "other",        amount: -s.other,       label: s.other > 0 ? "other provider difference" : "available above balance" });
  return terms;
}
