"use client";

/**
 * components/space/widgets/liquidity-adapters.tsx
 *
 * Liquidity Perspective widgets (UX-PER-3). The Liquidity workspace answers ONE
 * question — "How accessible is my money?" It is about ACCESS and READINESS,
 * not total wealth. No net worth, no wealth allocation, no investment
 * performance, no debt payoff, no spending — those belong elsewhere. Assets
 * only; liabilities are excluded.
 *
 * Mirrors wealth-adapters.tsx / debt-adapters.tsx: pure presentational render
 * functions consumed by SpaceDashboard's SectionRegistry, rendered through the
 * EXISTING BreakdownWidget / SummaryWidget presenters (no new chart system).
 *
 * Access horizons from today's account types (checking / savings / investment /
 * crypto / other). NOTE: the schema does not yet distinguish retirement
 * accounts from taxable brokerage, so there is no honest "locked / penalty"
 * tier in v1 — that tier arrives when retirement-account typing exists. We do
 * not fake it.
 *
 * Exports:
 *   renderLiquidityLadder          — assets by access horizon (hero, ranked bars)
 *   renderAccessibleCash           — reachable-now / reachable-soon + access ratio
 *   renderEmergencyFundReadiness    — reachable buffer + honest no-baseline state
 *   renderLiquidityConcentration    — is reachable cash concentrated in one account
 */

import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { SummaryWidget, type SummaryColor } from "@/components/space/widgets/SummaryWidget";
import { classifyAccounts } from "@/lib/account-classifier";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";
import { Droplets } from "lucide-react";
import { totalReachableCash, reachableDisclosure, type ReachableTotal } from "@/lib/balances/reachable";

// ─── Shared account shape ─────────────────────────────────────────────────────
export interface LiquidityAdapterAccount {
  id:          string;
  name:        string;
  type:        string;
  institution: string;
  balance:     number;
  currency:    string;
  /**
   * V27-L3 — the server-resolved current-state claim (SpaceAccount.currentState).
   * Present on cash accounts only. These widgets all CLAIM reachability, so they
   * consume `reachable`, never `balance`: on CHASE COLLEGE the ledger balance is
   * $5,106.77 and the reachable figure is $1,106.77, and the widget said the
   * first while the word "reachable" was on the screen.
   */
  currentState?: {
    reachable:   number | null;
    unexplained: number | null;
    state:       string;
    pendingCount: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inDisp(amount: number, currency: string | null | undefined, ctx?: ConversionContext): number {
  if (!ctx) return amount;
  // V25-FINAL-1 — unavailable conversion excluded from the visual breakdown (0
  // contribution, never a native magnitude); the Liquidity lens carries the
  // authoritative total + `unconverted` disclosure.
  return convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx).amount ?? 0;
}

function fmtMoney(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}

function valueFormatterProps(ctx?: ConversionContext) {
  return ctx ? { formatValue: (v: number) => formatCurrency(v, ctx.target) } : {};
}

const EMPTY_HEADLINE = "No assets yet";
const EMPTY_SUBLINE  = "Connect asset accounts to see how accessible your money is.";

function emptySummary(): React.ReactElement {
  return (
    <SummaryWidget
      emptyHeadline={EMPTY_HEADLINE}
      emptySubline={EMPTY_SUBLINE}
      emptyIcon={<Droplets size={22} className="text-[var(--text-faint)]" />}
    />
  );
}

// ─── Reachable cash (V27-L3) ──────────────────────────────────────────────────

/**
 * Reachable cash across the CASH accounts, in the display currency.
 *
 * The rule (which accounts count, what an unknown does) lives in
 * lib/balances/reachable; this only converts and delegates. No pending filtering
 * and no reconciliation arithmetic happens in React.
 */
/**
 * Exported so the Liquidity workspace headline and the Sources ledger consume the
 * SAME rule as the section widgets. Three surfaces, one definition of reachable.
 */
export function reachableNow(
  accounts: LiquidityAdapterAccount[],
  ctx?: ConversionContext,
): ReachableTotal {
  const cash = accounts.filter((a) => a.type === "checking" || a.type === "savings");
  return totalReachableCash(
    cash.map((a) => ({
      accountId: a.id,
      // Three states, and the middle one is the whole point:
      //   currentState ABSENT  → no reachable claim was made for this row (a
      //                          payload predating V27-L3, or a historical
      //                          reconstruction). The ledger figure is the only
      //                          answer available and is used, exactly as before.
      //   reachable NULL       → a claim WAS made and reachable is UNKNOWN. The
      //                          account is excluded and counted, never summed as
      //                          its ledger balance under the word "reachable".
      //   reachable a number   → use it.
      reachable: a.currentState === undefined
        ? inDisp(a.balance, a.currency, ctx)
        : a.currentState.reachable === null
          ? null
          : inDisp(a.currentState.reachable, a.currency, ctx),
      unexplained: a.currentState?.unexplained == null
        ? null
        : inDisp(a.currentState.unexplained, a.currency, ctx),
    })),
  );
}

/**
 * One account's reachable figure in the display currency, under the same
 * three-state rule as the total: ABSENT claim → the ledger balance, NULL → not
 * reachable (excluded), a number → itself.
 */
export function reachableForAccount(
  a: LiquidityAdapterAccount,
  ctx?: ConversionContext,
): number | null {
  const isCash = a.type === "checking" || a.type === "savings";
  if (!isCash || a.currentState === undefined) return inDisp(a.balance, a.currency, ctx);
  if (a.currentState.reachable === null) return null;
  return inDisp(a.currentState.reachable, a.currency, ctx);
}

// ─── 1. Liquidity Ladder (hero) ───────────────────────────────────────────────

/** Assets grouped by access horizon: now (cash), days (brokerage/crypto
 *  settlement), illiquid (real/long-term). Horizon-ordered bars — NOT
 *  value-sorted — so the ladder reads top (reachable) → bottom (locked away). */
export function renderLiquidityLadder(
  accounts: LiquidityAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const c = classifyAccounts(accounts, ctx);
  // V27-L3 — the "now" tier is REACHABLE cash, not the ledger sum. The label
  // already said "Available now"; the number now agrees with it.
  const reach = reachableNow(accounts, ctx);
  const items: BreakdownItem[] = [
    { id: "now",      label: "Available now",     value: reach.total,                              color: "#22c55e", meta: "Checking · savings" },
    { id: "days",     label: "Available in days", value: c.totalInvestments + c.totalDigitalAssets, color: "#3b82f6", meta: "Brokerage · crypto (settlement)" },
    { id: "illiquid", label: "Illiquid",          value: c.totalRealAssets,                        color: "#6b7280", meta: "Property · other long-term" },
  ].filter((i) => i.value > 0);

  return (
    <BreakdownWidget
      items={items}
      viewMode="bar"
      itemNoun="tier"
      emptyHeadline={EMPTY_HEADLINE}
      emptySubline={EMPTY_SUBLINE}
      {...valueFormatterProps(ctx)}
    />
  );
}

// ─── 2. Accessible Cash ───────────────────────────────────────────────────────

/** How much you can actually get at, and what share of your money that is.
 *  Runway is deliberately NOT computed here — a monthly-expense baseline isn't
 *  available in this slice, and we don't fake precision. */
export function renderAccessibleCash(
  accounts: LiquidityAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const c = classifyAccounts(accounts, ctx);
  // V27-L3 — "reachable right now" now MEANS reachable: the provider's available
  // cash where attested, else the prediction from provider-observed pending.
  const reach       = reachableNow(accounts, ctx);
  const now         = reach.total;
  const soon        = c.totalInvestments + c.totalDigitalAssets;
  const totalAssets = c.totalAssets;

  if (totalAssets <= 0) return emptySummary();

  const nowPct = (now / totalAssets) * 100;
  const color: SummaryColor = nowPct >= 15 ? "green" : nowPct >= 5 ? "orange" : "red";
  // An unexplained hold is a FIRST-CLASS output — surfaced beside the figure it
  // reduces, never smoothed into it.
  const disclosure = reachableDisclosure(reach, (n) => fmtMoney(n, ctx));

  return (
    <SummaryWidget
      primary={{
        value: fmtMoney(now, ctx),
        label: "reachable right now (cash)",
        color,
        size:  "3xl",
      }}
      stats={[
        { label: "Reachable within days",           value: fmtMoney(soon, ctx) },
        { label: "Share of assets reachable now",   value: `${nowPct.toFixed(0)}%`, accent: nowPct < 10 ? "orange" : "default" },
        ...(disclosure ? [{ label: "Not yet explained", value: disclosure, accent: "orange" as const }] : []),
      ]}
    />
  );
}

// ─── 3. Emergency Fund Readiness ──────────────────────────────────────────────

/** Reachable cash framed as a safety buffer. Months-of-coverage needs a
 *  monthly-expense baseline that isn't threaded in this slice, so we show the
 *  reachable amount and an honest neutral state instead of a fabricated number. */
export function renderEmergencyFundReadiness(
  accounts: LiquidityAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const c = classifyAccounts(accounts, ctx);
  // V27-L3 — an emergency buffer you cannot reach is not a buffer.
  const reachable = reachableNow(accounts, ctx).total;

  if (c.totalAssets <= 0) return emptySummary();

  return (
    <SummaryWidget
      primary={{
        value: fmtMoney(reachable, ctx),
        label: "in reachable emergency cash",
        color: reachable > 0 ? "white" : "orange",
        size:  "2xl",
      }}
      stats={[
        // Honest data-thin state: no expense baseline ⇒ no months-of-coverage.
        { label: "Months of coverage", value: "Set a monthly expense target", accent: "default" },
      ]}
    />
  );
}

// ─── 4. Liquidity Concentration ───────────────────────────────────────────────

/** Is your reachable money spread out or sitting in one account? Ranked bars of
 *  the LIQUID (reachable-now) accounts only — the liquidity analogue of Wealth
 *  concentration, scoped to cash you can actually get at. */
export function renderLiquidityConcentration(
  accounts: LiquidityAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const c = classifyAccounts(accounts, ctx);
  // V27-L3 — concentration OF REACHABLE MONEY. An account whose reachable figure
  // could not be established is EXCLUDED (value 0 ⇒ filtered below) rather than
  // ranked by a ledger balance the surrounding copy calls "reachable".
  const byId = new Map(accounts.map((a) => [a.id, a.currentState]));
  const items: BreakdownItem[] = c.liquid
    .map((a) => ({
      id:    a.id,
      label: a.name,
      value: byId.get(a.id)?.reachable == null
        ? 0
        : inDisp(byId.get(a.id)!.reachable!, a.currency, ctx),
      meta:  a.institution || undefined,
    }))
    .filter((i) => i.value > 0)
    .sort((x, y) => y.value - x.value);

  return (
    <BreakdownWidget
      items={items}
      viewMode="bar"
      itemNoun="account"
      emptyHeadline="No reachable cash yet"
      emptySubline="Add a checking or savings account to see your accessible cash."
      {...valueFormatterProps(ctx)}
    />
  );
}
