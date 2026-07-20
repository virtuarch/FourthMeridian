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
 *   renderWealthAccountCards     — EXPERIMENT (UX): two-column account-card grid
 *   renderInstitutionAllocation  — ranked bars, assets grouped by institution
 *   renderAssetAllocation        — assets-only donut by asset class
 *   renderWealthAllocationChart  — EXPERIMENT (UX): multi-mode (treemap/donut/strip)
 *   renderWealthConcentration    — concentration readout (top account/institution + HHI)
 */

import { useState } from "react";
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { WEALTH_CLASS_COLOR, DEFAULT_CHART_COLOR } from "@/lib/charts/chart-palette";
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

// ─── 1b. Wealth by Account — CARD EXPERIMENT (UX) ─────────────────────────────
//
// TEMPORARY design experiment. Renders the same assets-only, value-descending
// data as renderWealthByAccount, but as a responsive two-column grid of compact
// account cards instead of one long ranked bar list. renderWealthByAccount above
// is left completely untouched — this is an additive, reversible swap wired only
// into the Wealth Perspective's `wealth_by_account` render binding.
//
// Interaction note: cards are built as self-contained objects (not rows) so
// future affordances — click-to-open, hover actions, insights, wallet refresh,
// holdings, transaction drill-down — can attach to the card root without a
// structural rewrite. None of those are implemented here (out of scope).

/** Canonical per-type asset color identity, reused from the app's allocation /
 *  banking / account-modal palette so cards match the rest of the product.
 *  (Liabilities are never rendered here — assets only.) */
const ACCOUNT_TYPE_COLOR: Record<string, string> = {
  checking:   "#3b82f6", // blue   — same as AllocationChart "cash"
  savings:    "#10b981", // emerald
  investment: "#8b5cf6", // violet — AllocationChart "investments"
  crypto:     "#f59e0b", // amber  — AllocationChart "crypto"
  other:      "#14b8a6", // teal   — AllocationChart "real assets"
};
const DEFAULT_ACCOUNT_COLOR = "#3b82f6";

function accountColor(type: string): string {
  return ACCOUNT_TYPE_COLOR[type] ?? DEFAULT_ACCOUNT_COLOR;
}

/** Two-column account-card grid. Same data + ordering as renderWealthByAccount
 *  (assets only, value > 0, largest first); different presentation only. */
export function renderWealthAccountCards(
  accounts: WealthAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  const cards = assetAccounts(accounts)
    .map((a) => ({
      id:          a.id,
      name:        a.name,
      institution: a.institution || "",
      value:       inDisp(a.balance, a.currency, ctx),
      color:       accountColor(a.type),
    }))
    .filter((c) => c.value > 0)
    .sort((x, y) => y.value - x.value);

  const total = cards.reduce((s, c) => s + c.value, 0);

  if (cards.length === 0 || total <= 0) {
    return (
      <div className="text-center py-5 space-y-1">
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{EMPTY_HEADLINE}</p>
        <p className="text-xs leading-relaxed max-w-xs mx-auto" style={{ color: "var(--text-faint)" }}>{EMPTY_SUBLINE}</p>
      </div>
    );
  }

  const fmt = ctx
    ? (v: number) => formatCurrency(v, ctx.target)
    : (v: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);

  // Grid collapses to a single column on narrow widths; two columns otherwise.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {cards.map((c) => {
        const pct    = (c.value / total) * 100;
        const barPct = Math.max(2, pct); // keep a sliver visible for tiny holdings
        return (
          // Card root: the future interaction surface (click / hover / menu).
          <div
            key={c.id}
            data-account-id={c.id}
            className="rounded-xl p-3 flex flex-col gap-2 border"
            style={{
              background:  "var(--surface-inset)",
              borderColor: "var(--border-subtle, rgba(255,255,255,0.06))",
            }}
          >
            <div className="flex items-start gap-2 min-w-0">
              <span className="mt-1 h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate" style={{ color: "var(--text-primary)" }}>{c.name}</p>
                {c.institution && (
                  <p className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{c.institution}</p>
                )}
              </div>
            </div>

            <div className="flex items-baseline justify-between gap-2">
              <span className="text-base font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>{fmt(c.value)}</span>
              <span className="text-[11px] tabular-nums shrink-0" style={{ color: "var(--text-faint)" }}>{pct.toFixed(1)}%</span>
            </div>

            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-base, rgba(255,255,255,0.04))" }}>
              <div className="h-full rounded-full" style={{ width: `${barPct}%`, backgroundColor: c.color }} />
            </div>
          </div>
        );
      })}
    </div>
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

/** Assets-only class breakdown items (Cash / Investments / Crypto / Real assets),
 *  filtered to positive values. Single source of truth shared by the donut
 *  renderer and the multi-mode allocation experiment below, so every mode reports
 *  identical totals, percentages, and classes.
 *
 *  Colours are now carried EXPLICITLY. They used to be omitted so the donut would
 *  take BreakdownWidget's index-assigned palette — but this list drops empty
 *  classes, so a missing class shifted every later one onto the wrong colour
 *  while treemap/strip stayed pinned. Passing the identity colour makes all three
 *  modes agree for every portfolio shape, not just complete ones. */
function assetClassItems(
  accounts: WealthAdapterAccount[],
  ctx?:     ConversionContext,
): BreakdownItem[] {
  const c = classifyAccounts(accounts, ctx);
  return [
    { id: "cash",        label: "Cash",        value: c.totalLiquid },
    { id: "investments", label: "Investments", value: c.totalInvestments },
    { id: "crypto",      label: "Crypto",      value: c.totalDigitalAssets },
    { id: "real",        label: "Real assets", value: c.totalRealAssets },
  ]
    .filter((i) => i.value > 0)
    .map((i) => ({ ...i, color: ASSET_CLASS_COLOR[i.id] ?? DEFAULT_CLASS_COLOR }));
}

/** Donut by asset class — assets only (Cash / Investments / Crypto / Real
 *  assets). Deliberately NOT the Overview allocation (which includes debt). */
export function renderAssetAllocation(
  accounts: WealthAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  return (
    <BreakdownWidget
      items={assetClassItems(accounts, ctx)}
      viewMode="donut"
      itemNoun="asset class"
      emptyHeadline={EMPTY_HEADLINE}
      emptySubline={EMPTY_SUBLINE}
      {...valueFormatterProps(ctx)}
    />
  );
}

// ─── 3b. Wealth Allocation — MULTI-MODE CHART EXPERIMENT (UX) ──────────────────
//
// TEMPORARY design experiment. One draggable, section-backed widget that shows
// the SAME assets-only class breakdown as renderAssetAllocation in three modes:
// Treemap (default), Donut, and Allocation strip. renderAssetAllocation is left
// intact and is REUSED verbatim for Donut mode (no duplicated donut logic).
//
// Chart-mode is LOCAL useState only — never persisted. The Wealth Perspective
// workspace renders these as virtual, render-only sections. The toggle stops
// pointerdown propagation defensively.

type AllocationMode = "treemap" | "donut" | "strip";

/** Asset-class colour identity. Previously restated BreakdownWidget's palette
 *  BY INDEX (cash→investments→crypto→real), which only held for a COMPLETE set:
 *  `assetClassItems` drops zero-value classes, so a portfolio without crypto
 *  shifted the donut up a slot while treemap/strip kept these pinned values —
 *  the same class drawn in two colours on one card. Now one identity map, shared
 *  with the donut via explicit item colours. */
const ASSET_CLASS_COLOR = WEALTH_CLASS_COLOR;
const DEFAULT_CLASS_COLOR = DEFAULT_CHART_COLOR;

/** Binary-partition treemap layout. Splits the item set into two value-balanced
 *  halves and slices the rectangle along its longer axis in proportion, recursing
 *  until one item per rect. Always tiles the box exactly and handles 2–8 classes.
 *  Limitation: not aspect-ratio-optimized like a squarified treemap, so with very
 *  lopsided values some rects are elongated — acceptable for a 2–8 class mix.
 *  Coordinates are percentages (0–100) of the container. */
interface TreemapRect { item: BreakdownItem & { color: string }; x: number; y: number; w: number; h: number }
function treemapRects(
  items: Array<BreakdownItem & { color: string }>,
  x: number, y: number, w: number, h: number,
): TreemapRect[] {
  if (items.length === 1) return [{ item: items[0], x, y, w, h }];
  const total = items.reduce((s, i) => s + i.value, 0);
  // Greedy: grow group A (largest-first) until it reaches ~half the total.
  let running = 0, k = 0;
  while (k < items.length - 1 && running + items[k].value < total / 2) { running += items[k].value; k++; }
  const splitAt = Math.min(Math.max(k + 1, 1), items.length - 1);
  const a = items.slice(0, splitAt);
  const b = items.slice(splitAt);
  const frac = a.reduce((s, i) => s + i.value, 0) / total;
  if (w >= h) {
    const wa = w * frac;
    return [...treemapRects(a, x, y, wa, h), ...treemapRects(b, x + wa, y, w - wa, h)];
  }
  const ha = h * frac;
  return [...treemapRects(a, x, y, w, ha), ...treemapRects(b, x, y + ha, w, h - ha)];
}

function AllocationModeToggle({ mode, onChange }: { mode: AllocationMode; onChange: (m: AllocationMode) => void }) {
  const MODES: Array<{ id: AllocationMode; label: string }> = [
    { id: "treemap", label: "Treemap" },
    { id: "donut",   label: "Donut" },
    { id: "strip",   label: "Strip" },
  ];
  return (
    // Defensive: keep pointerdown from reaching any section drag source. Drag is
    // handle-based today, so this only matters if a future wrapper makes the body
    // a drag source — the control stays interactive either way.
    <div
      className="inline-flex rounded-lg p-0.5 gap-0.5"
      style={{ background: "var(--surface-inset)" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {MODES.map((m) => {
        const active = m.id === mode;
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(m.id)}
            className="text-[11px] leading-none px-2 py-1 rounded-md transition-colors"
            style={
              active
                ? { background: "var(--surface-base, rgba(255,255,255,0.06))", color: "var(--text-primary)" }
                : { color: "var(--text-muted)" }
            }
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

/** Quiet total-assets header for Treemap/Strip. Donut shows its own centre total,
 *  so it is deliberately NOT given this header (no duplicate). Uses the same
 *  `total` + `fmt` the whole widget shares, so it matches the allocation math. */
function AllocationTotalHeader({ total, fmt }: { total: number; fmt: (v: number) => string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Total assets</span>
      <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>{fmt(total)}</span>
    </div>
  );
}

function TreemapView({ items, total, fmt }: { items: Array<BreakdownItem & { color: string }>; total: number; fmt: (v: number) => string }) {
  const rects = treemapRects(items, 0, 0, 100, 100);
  return (
    <div className="space-y-2">
      <AllocationTotalHeader total={total} fmt={fmt} />
      <div className="relative w-full overflow-hidden rounded-lg" style={{ height: 208 }}>
      {rects.map(({ item, x, y, w, h }) => {
        const pct = (item.value / total) * 100;
        // Only label blocks large enough to hold text without clipping.
        const showName  = w > 16 && h > 14;
        const showValue = w > 24 && h > 26;
        return (
          <div
            key={item.id}
            data-class-id={item.id}
            title={`${item.label} · ${fmt(item.value)} · ${pct.toFixed(1)}%`}
            className="absolute p-1.5 flex flex-col justify-between overflow-hidden"
            style={{
              left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%`,
              backgroundColor: item.color,
              outline: "1px solid var(--surface-base, rgba(0,0,0,0.25))",
            }}
          >
            {showName && (
              <span className="text-[11px] font-medium leading-tight truncate" style={{ color: "#fff" }}>{item.label}</span>
            )}
            {showValue && (
              <span className="text-[11px] leading-tight tabular-nums" style={{ color: "rgba(255,255,255,0.85)" }}>
                {fmt(item.value)} · {pct.toFixed(0)}%
              </span>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

function StripView({ items, total, fmt }: { items: Array<BreakdownItem & { color: string }>; total: number; fmt: (v: number) => string }) {
  return (
    <div className="space-y-3">
      <AllocationTotalHeader total={total} fmt={fmt} />
      {/* One 100%-of-assets stacked bar. */}
      <div className="flex h-4 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-inset)" }}>
        {items.map((item) => (
          <div
            key={item.id}
            title={`${item.label} · ${fmt(item.value)}`}
            style={{ width: `${(item.value / total) * 100}%`, backgroundColor: item.color }}
          />
        ))}
      </div>
      {/* Legend with value + percent. */}
      <div className="space-y-1.5">
        {items.map((item) => {
          const pct = (item.value / total) * 100;
          return (
            <div key={item.id} className="flex items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
              <span className="flex-1 min-w-0 truncate" style={{ color: "var(--text-secondary)" }}>{item.label}</span>
              <span className="tabular-nums shrink-0" style={{ color: "var(--text-primary)" }}>{fmt(item.value)}</span>
              <span className="tabular-nums shrink-0 w-12 text-right" style={{ color: "var(--text-faint)" }}>{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Multi-mode assets-only allocation widget (Treemap default / Donut / Strip).
 *  Same data + totals as renderAssetAllocation. Local chart-mode state only. */
function WealthAllocationChart({ accounts, ctx }: { accounts: WealthAdapterAccount[]; ctx?: ConversionContext }) {
  const [mode, setMode] = useState<AllocationMode>("treemap");

  const base  = assetClassItems(accounts, ctx);
  const total = base.reduce((s, i) => s + i.value, 0);

  if (base.length === 0 || total <= 0) {
    return (
      <div className="text-center py-5 space-y-1">
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{EMPTY_HEADLINE}</p>
        <p className="text-xs leading-relaxed max-w-xs mx-auto" style={{ color: "var(--text-faint)" }}>{EMPTY_SUBLINE}</p>
      </div>
    );
  }

  const colored = base.map((i) => ({ ...i, color: ASSET_CLASS_COLOR[i.id] ?? DEFAULT_CLASS_COLOR }));
  const fmt = ctx
    ? (v: number) => formatCurrency(v, ctx.target)
    : (v: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <AllocationModeToggle mode={mode} onChange={setMode} />
      </div>
      {mode === "donut"
        // Reuse the existing donut renderer verbatim — identical visual + data.
        ? renderAssetAllocation(accounts, ctx)
        : mode === "strip"
          ? <StripView   items={colored} total={total} fmt={fmt} />
          : <TreemapView items={colored} total={total} fmt={fmt} />}
    </div>
  );
}

/** SectionRegistry adapter for the multi-mode allocation experiment. */
export function renderWealthAllocationChart(
  accounts: WealthAdapterAccount[],
  ctx?:     ConversionContext,
): React.ReactElement {
  return <WealthAllocationChart accounts={accounts} ctx={ctx} />;
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
