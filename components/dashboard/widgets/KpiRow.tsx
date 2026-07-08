"use client";

/**
 * KpiRow
 *
 * Five-tile executive-summary strip that now opens the Overview tab: Net
 * Worth, Total Assets, Total Liabilities, Cash Flow (MTD), Credit Score.
 * Replaces the old NetWorthCard + CashOnHandCard + FicoCard cluster that
 * used to live inside a "PersonalSectionCard" — same underlying numbers
 * (classifyAccounts() totals, real transaction history, the existing FICO
 * read), just presented as a slim glass strip instead of three stacked
 * cards, per the Spaces dashboard redesign.
 *
 * Hosts may render a subset of tiles via the `tiles` prop (default: all
 * five). The Personal Overview uses this to show only Cash Flow + Credit,
 * because its Net Worth / Assets / Debt now live in the Net Worth card (A).
 *
 * Every trend shown is computed from real data the host already has
 * (account snapshots for Net Worth, real transactions for Cash Flow) —
 * nothing here is fabricated. Tiles with no real historical baseline show
 * the value alone, with no invented delta.
 *
 * FUTURE ENHANCEMENT: FICO snapshots are not stored over time today (only
 * the latest score persists) — once they are, this tile can show a real
 * "+N pts since last update" trend the same way Net Worth does.
 */

import { ReactNode, ElementType } from "react";
import { TrendingUp, TrendingDown, ShieldCheck, Landmark, Scale, Wallet } from "lucide-react";
import { EstimatedChip } from "@/components/ui/EstimatedChip";
import { useDisplayCurrency } from "@/lib/currency-context";
import { GlassPanel } from "@/components/atlas/GlassPanel";

function creditBand(score: number): { label: string; cls: string } {
  if (score >= 740) return { label: "Excellent", cls: "text-[var(--emerald-400)]" };
  if (score >= 670) return { label: "Good", cls: "text-[var(--meridian-400)]" };
  if (score >= 580) return { label: "Fair", cls: "text-[var(--brass-400)]" };
  return { label: "Poor", cls: "text-[var(--coral-400)]" };
}

function Trend({ pct }: { pct: number }) {
  const positive = pct >= 0;
  return (
    <span
      className={[
        "inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums",
        positive ? "text-[var(--emerald-400)]" : "text-[var(--coral-400)]",
      ].join(" ")}
    >
      {positive ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

function Tile({
  label,
  value,
  sub,
  trendPct,
  icon: Icon,
  onClick,
  estimated,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  trendPct?: number | null;
  icon: ElementType;
  /** MC1 P4 Slice 3 (D-5) — renders the muted "est." chip after the value. */
  estimated?: boolean;
  /** Opens a Glass modal with the full picture behind this number (IA
   *  refactor point 4) — reuses existing chart/widget/business logic,
   *  never a new computation. Tiles with no real destination yet stay
   *  inert (no onClick passed). */
  onClick?: () => void;
}) {
  return (
    <GlassPanel
      as={onClick ? "button" : "div"}
      type={onClick ? "button" : undefined}
      onClick={onClick}
      interactive={!!onClick}
      depth="thin"
      elevation="e2"
      radius="lg"
      className={`p-4 text-left w-full ${onClick ? "cursor-pointer hover:bg-[var(--surface-hover)]" : ""}`}
    >
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
        <Icon size={13} className="text-[var(--text-muted)] shrink-0" />
      </div>
      <p className="text-xl font-bold text-[var(--text-primary)] mt-1.5 tabular-nums truncate">{value}{estimated && <EstimatedChip />}</p>
      {(sub !== undefined || trendPct !== undefined) && (
        <div className="flex items-center gap-1.5 mt-1 min-h-[15px]">
          {trendPct !== undefined && trendPct !== null && <Trend pct={trendPct} />}
          {sub}
        </div>
      )}
    </GlassPanel>
  );
}

/** The five tiles this strip can render, in canonical left-to-right order. */
export type KpiTileKey = "netWorth" | "totalAssets" | "totalLiabilities" | "cashFlow" | "credit";
const ALL_KPI_TILES: KpiTileKey[] = ["netWorth", "totalAssets", "totalLiabilities", "cashFlow", "credit"];

export interface KpiRowProps {
  /**
   * MC1 Phase 4 Slice 3 (D-5) — true when the classification totals feeding
   * netWorth/totalAssets/totalLiabilities carry estimated conversions.
   * Silent (no marker) when false/omitted.
   */
  estimated?: boolean;
  /** MC1 QA Q2 — cash-flow value is now converted by the host; taint for its tile. */
  cashFlowEstimated?: boolean;
  /**
   * Which tiles to render, in canonical order (default: all five). A host can
   * pass a subset — e.g. the Personal Overview renders card A for net worth /
   * assets / debt and asks this strip for only `["cashFlow", "credit"]`.
   * Money props are only required for the tiles actually shown.
   */
  tiles?: KpiTileKey[];
  netWorth?: number;
  /** Signed percentage change over the host's selected interval; null = no baseline yet. */
  netWorthChangePct?: number | null;
  totalAssets?: number;
  totalLiabilities?: number;
  cashFlowMTD?: number;
  /** Signed percentage change vs. last calendar month; null = no prior-month data. */
  cashFlowChangePct?: number | null;
  ficoScore: number | null;
  /** IA refactor point 4 — each tile opens a large Glass modal reusing the
   *  host's existing widgets/business logic. Omitting a handler leaves that
   *  tile inert, so a host can opt in tile-by-tile. */
  onNetWorthClick?: () => void;
  onAssetsClick?: () => void;
  onLiabilitiesClick?: () => void;
  onCashFlowClick?: () => void;
  onCreditClick?: () => void;
}

export function KpiRow({
  estimated,
  cashFlowEstimated,
  tiles = ALL_KPI_TILES,
  netWorth = 0,
  netWorthChangePct = null,
  totalAssets = 0,
  totalLiabilities = 0,
  cashFlowMTD = 0,
  cashFlowChangePct = null,
  ficoScore,
  onNetWorthClick,
  onAssetsClick,
  onLiabilitiesClick,
  onCashFlowClick,
  onCreditClick,
}: KpiRowProps) {
  const band = ficoScore !== null ? creditBand(ficoScore) : null;

  // MC1 QA Q1 — these tiles render CONVERTED classification values (Phase 3),
  // so their labels must use the display currency, not lib/format's USD
  // default (the "converts but still shows $" bug). The Slice 8 provider
  // wrapper already supplies the effective currency here.
  const displayCurrency = useDisplayCurrency();
  const fmtDisplay = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: displayCurrency, maximumFractionDigits: 0 }).format(n);

  // Render only the requested tiles (default: all five), in canonical order.
  // Grid columns follow the count so a 2-tile subset (e.g. the Personal
  // Overview's Cash Flow + Credit) doesn't stretch across five columns.
  const shown = ALL_KPI_TILES.filter((t) => tiles.includes(t));
  const gridCols =
    shown.length <= 2 ? "grid-cols-2"
    : shown.length === 3 ? "grid-cols-2 sm:grid-cols-3"
    : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5";

  const tileNodes: Record<KpiTileKey, ReactNode> = {
    netWorth: (
      <Tile
        key="netWorth"
        label="Net Worth"
        value={`${estimated ? "≈ " : ""}${fmtDisplay(netWorth)}`}
        estimated={estimated}
        trendPct={netWorthChangePct}
        icon={Scale}
        onClick={onNetWorthClick}
      />
    ),
    totalAssets: (
      <Tile key="totalAssets" label="Total Assets" value={`${estimated ? "≈ " : ""}${fmtDisplay(totalAssets)}`} estimated={estimated} icon={Landmark} onClick={onAssetsClick} />
    ),
    totalLiabilities: (
      <Tile
        key="totalLiabilities"
        label="Total Liabilities"
        value={`${estimated ? "≈ " : ""}${fmtDisplay(Math.abs(totalLiabilities))}`}
        estimated={estimated}
        icon={Wallet}
        onClick={onLiabilitiesClick}
      />
    ),
    // MC1 QA Q2 — cashFlowMTD now converts in the host (per-row dates), so
    // its label follows into the display currency.
    cashFlow: (
      <Tile
        key="cashFlow"
        label="Cash Flow (MTD)"
        value={`${cashFlowEstimated ? "≈ " : ""}${fmtDisplay(cashFlowMTD)}`}
        estimated={cashFlowEstimated}
        trendPct={cashFlowChangePct}
        icon={TrendingUp}
        onClick={onCashFlowClick}
      />
    ),
    credit: (
      <Tile
        key="credit"
        label="Credit Score"
        value={ficoScore !== null ? String(ficoScore) : "—"}
        sub={
          band ? (
            <span className={`text-[11px] font-semibold ${band.cls}`}>{band.label}</span>
          ) : (
            <a
              href="/dashboard/credit"
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] font-semibold text-[var(--meridian-400)] hover:text-[var(--meridian-300)] transition-colors"
            >
              Add score
            </a>
          )
        }
        icon={ShieldCheck}
        onClick={onCreditClick}
      />
    ),
  };

  return (
    <div className={`grid ${gridCols} gap-3`}>
      {shown.map((t) => tileNodes[t])}
    </div>
  );
}
