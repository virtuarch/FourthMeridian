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

// ─── Shared account shape ─────────────────────────────────────────────────────
export interface LiquidityAdapterAccount {
  id:          string;
  name:        string;
  type:        string;
  institution: string;
  balance:     number;
  currency:    string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inDisp(amount: number, currency: string | null | undefined, ctx?: ConversionContext): number {
  if (!ctx) return amount;
  return convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx).amount;
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

// ─── 1. Liquidity Ladder (hero) ───────────────────────────────────────────────

/** Assets grouped by access horizon: now (cash), days (brokerage/crypto
 *  settlement), illiquid (real/long-term). Horizon-ordered bars — NOT
 *  value-sorted — so the ladder reads top (reachable) → bottom (locked away). */
export function renderLiquidityLadder(
  accounts: LiquidityAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const c = classifyAccounts(accounts, ctx);
  const items: BreakdownItem[] = [
    { id: "now",      label: "Available now",     value: c.totalLiquid,                            color: "#22c55e", meta: "Checking · savings" },
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
  const now         = c.totalLiquid;
  const soon        = c.totalInvestments + c.totalDigitalAssets;
  const totalAssets = c.totalAssets;

  if (totalAssets <= 0) return emptySummary();

  const nowPct = (now / totalAssets) * 100;
  const color: SummaryColor = nowPct >= 15 ? "green" : nowPct >= 5 ? "orange" : "red";

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
  const reachable = c.totalLiquid;

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
  const items: BreakdownItem[] = c.liquid
    .map((a) => ({
      id:    a.id,
      label: a.name,
      value: inDisp(a.balance, a.currency, ctx),
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
