"use client";

/**
 * components/space/widgets/wealth-adapters.tsx
 *
 * Wealth Perspective widgets (UX-PER-3). The Wealth workspace answers ONE
 * question — "Where is my money?" — and is ASSETS ONLY (no net worth, no
 * liabilities, no debt, no spending; those belong to Overview / Debt / Cash
 * Flow). Each adapter renders through the EXISTING BreakdownWidget /
 * SummaryWidget presenters — no new chart system.
 *
 * Mirrors debt-adapters.tsx: pure presentational render functions consumed by
 * SpaceDashboard's SectionRegistry. Callers pass a normalized account array;
 * adapters ignore liabilities (type === "debt") entirely.
 *
 * Exports:
 *   renderWealthByAccount        — horizontal ranked bars, assets by account (hero)
 *   renderInstitutionAllocation  — ranked bars, assets grouped by institution
 *   renderAssetAllocation        — assets-only donut by asset class
 *   renderWealthConcentration    — concentration readout (top account/institution + HHI)
 */

import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { SummaryWidget, type SummaryColor } from "@/components/space/widgets/SummaryWidget";
import { classifyAccounts } from "@/lib/account-classifier";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";
import { Gem } from "lucide-react";

// ─── Shared account shape ─────────────────────────────────────────────────────
// Structurally compatible with SpaceDashboard's SpaceAccount and types/Account;
// only the fields the adapters read are required.
export interface WealthAdapterAccount {
  id:          string;
  name:        string;
  type:        string;
  institution: string;
  balance:     number;
  currency:    string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert an amount into the display currency when a context is present
 *  (identity pass-through otherwise — the all-USD / kill-switch path). */
function inDisp(amount: number, currency: string | null | undefined, ctx?: ConversionContext): number {
  if (!ctx) return amount;
  return convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx).amount;
}

/** Assets only — liabilities (debt) are never part of the Wealth question. */
function assetAccounts(accounts: WealthAdapterAccount[]): WealthAdapterAccount[] {
  return accounts.filter((a) => a.type !== "debt");
}

/** Value formatter honoring the display currency when a context is present;
 *  otherwise BreakdownWidget's default (USD, no cents) is left untouched. */
function valueFormatterProps(ctx?: ConversionContext) {
  return ctx ? { formatValue: (v: number) => formatCurrency(v, ctx.target) } : {};
}

const EMPTY_HEADLINE = "No assets yet";
const EMPTY_SUBLINE  = "Connect or add asset accounts to see where your money sits.";

// ─── 1. Wealth by Account (hero) ──────────────────────────────────────────────

/** Horizontal ranked bars: every asset account by balance, largest first. */
export function renderWealthByAccount(
  accounts: WealthAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const items: BreakdownItem[] = assetAccounts(accounts)
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
      emptyHeadline={EMPTY_HEADLINE}
      emptySubline={EMPTY_SUBLINE}
      {...valueFormatterProps(ctx)}
    />
  );
}

// ─── 2. Institution Allocation ────────────────────────────────────────────────

/** Ranked bars: assets grouped by institution — institution-level concentration. */
export function renderInstitutionAllocation(
  accounts: WealthAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const byInstitution = new Map<string, number>();
  for (const a of assetAccounts(accounts)) {
    const value = inDisp(a.balance, a.currency, ctx);
    if (value <= 0) continue;
    const key = a.institution?.trim() || "Other";
    byInstitution.set(key, (byInstitution.get(key) ?? 0) + value);
  }

  const items: BreakdownItem[] = [...byInstitution.entries()]
    .map(([label, value]) => ({ id: label, label, value }))
    .sort((x, y) => y.value - x.value);

  return (
    <BreakdownWidget
      items={items}
      viewMode="bar"
      itemNoun="institution"
      emptyHeadline={EMPTY_HEADLINE}
      emptySubline={EMPTY_SUBLINE}
      {...valueFormatterProps(ctx)}
    />
  );
}

// ─── 3. Asset Allocation (assets-only class mix) ──────────────────────────────

/** Donut by asset class — assets only (Cash / Investments / Crypto / Real
 *  assets). Deliberately NOT the Overview allocation (which includes debt). */
export function renderAssetAllocation(
  accounts: WealthAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const c = classifyAccounts(accounts, ctx);
  const items: BreakdownItem[] = [
    { id: "cash",        label: "Cash",        value: c.totalLiquid },
    { id: "investments", label: "Investments", value: c.totalInvestments },
    { id: "crypto",      label: "Crypto",      value: c.totalDigitalAssets },
    { id: "real",        label: "Real assets", value: c.totalRealAssets },
  ].filter((i) => i.value > 0);

  return (
    <BreakdownWidget
      items={items}
      viewMode="donut"
      itemNoun="asset class"
      emptyHeadline={EMPTY_HEADLINE}
      emptySubline={EMPTY_SUBLINE}
      {...valueFormatterProps(ctx)}
    />
  );
}

// ─── 4. Wealth Concentration ──────────────────────────────────────────────────

/** How concentrated is the asset base: largest account / institution share and
 *  a simple HHI diversification score. Directly supports the Wealth verdict
 *  ("Your assets are becoming concentrated"). */
export function renderWealthConcentration(
  accounts: WealthAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const valued = assetAccounts(accounts)
    .map((a) => ({ a, v: inDisp(a.balance, a.currency, ctx) }))
    .filter((x) => x.v > 0);
  const total = valued.reduce((s, x) => s + x.v, 0);

  if (total <= 0) {
    return (
      <SummaryWidget
        emptyHeadline={EMPTY_HEADLINE}
        emptySubline={EMPTY_SUBLINE}
        emptyIcon={<Gem size={22} className="text-[var(--text-faint)]" />}
      />
    );
  }

  // Herfindahl–Hirschman Index over account shares (0 = perfectly diversified,
  // 1 = everything in one account).
  const hhi = valued.reduce((s, x) => s + (x.v / total) ** 2, 0);

  const topAccount    = valued.reduce((m, x) => (x.v > m.v ? x : m), valued[0]);
  const topAccountPct = (topAccount.v / total) * 100;

  const byInstitution = new Map<string, number>();
  for (const { a, v } of valued) {
    const key = a.institution?.trim() || "Other";
    byInstitution.set(key, (byInstitution.get(key) ?? 0) + v);
  }
  const [topInstName, topInstVal] = [...byInstitution.entries()].reduce((m, e) => (e[1] > m[1] ? e : m));
  const topInstPct = (topInstVal / total) * 100;

  const level: string       = hhi >= 0.25 ? "Concentrated" : hhi >= 0.15 ? "Moderately concentrated" : "Well diversified";
  const color: SummaryColor = hhi >= 0.15 ? "orange" : "green";

  const fmt = (v: number) => (ctx ? formatCurrency(v, ctx.target) : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v));

  return (
    <SummaryWidget
      primary={{
        value: level,
        label: `HHI ${hhi.toFixed(2)} · ${valued.length} asset account${valued.length === 1 ? "" : "s"}`,
        color,
        size:  "2xl",
      }}
      stats={[
        { label: `Largest account · ${topAccount.a.name}`, value: `${topAccountPct.toFixed(0)}%`, accent: topAccountPct >= 40 ? "orange" : "default" },
        { label: `Top institution · ${topInstName}`,       value: `${topInstPct.toFixed(0)}%`,    accent: topInstPct >= 50 ? "orange" : "default" },
      ]}
      rows={[
        { id: topAccount.a.id, label: topAccount.a.name, sublabel: topAccount.a.institution || undefined, value: fmt(topAccount.v) },
      ]}
    />
  );
}
