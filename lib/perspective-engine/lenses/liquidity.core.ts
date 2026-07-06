/**
 * lib/perspective-engine/lenses/liquidity.core.ts
 *
 * Liquidity lens — pure computation core (commit 2 of the approved plan in
 * docs/investigations/PERSPECTIVE_ENGINE_FOUNDATION_INVESTIGATION.md).
 *
 * Answers: "How much money could I actually get at, and how fast?"
 *
 * This module is PURE: no data access, no clock, no imports beyond engine
 * types and lib/format. The data binding (getAccountsWithVisibility →
 * LiquidityAccountRow[]) lives in ./liquidity.ts; tests exercise this core
 * directly with fixtures (lib/perspective-engine/liquidity.test.ts).
 *
 * ── Input privacy by construction ────────────────────────────────────────────
 * LiquidityAccountRow deliberately has NO name, institution, or any other
 * identifying field — the adapter never maps them in, so this lens cannot
 * leak what it never receives. Rows carry only: id, type, balance,
 * creditLimit (FULL rows only), lastUpdated, visibilityLevel.
 *
 * ── Tier rules (investigation §5) ────────────────────────────────────────────
 *   FULL         — balance feeds its tier sum; creditLimit feeds available
 *                  credit.
 *   BALANCE_ONLY — balance feeds its tier sum (the balance is exactly what
 *                  this tier grants). No credit contribution (creditLimit is
 *                  a withheld identifying field and is never present on
 *                  these rows anyway — enforced fail-closed here too).
 *   SUMMARY_ONLY — contributes to NO numeric aggregate. Counted in
 *                  tierCounts, surfaced as a redaction line, excluded from
 *                  accountIds and dataAsOf. Fails closed.
 *   anything else (PRIVATE / legacy SHARED / unknown) — treated as
 *                  SUMMARY_ONLY: fail closed, never fail open.
 *
 * ── Money semantics ──────────────────────────────────────────────────────────
 *   cashNow    = Σ balance   (checking, savings)
 *   marketable = Σ balance   (investment, crypto) — "could be raised by
 *                selling", always with the before-tax/penalty assumption
 *   illiquid   = Σ balance   (other — manual/real assets)
 *   credit     = Σ max(creditLimit − |balance|, 0)  (FULL debt rows with a
 *                known limit) — borrowing capacity, NEVER counted as
 *                liquidity and never in the headline or verdict sums
 * Balances are used as last reported (the data layer does not expose
 * availableBalance; stated as an assumption). Sums mirror the dashboard's
 * classifyAccounts() behavior: raw addition on the context-less kill-switch
 * path, and — MC1 Phase 3 Slice 5 (F-3) — per-row conversion into the
 * Space's reporting currency when a ConversionContext is supplied, valuing
 * at the latest close relative to the injected clock (options.now(), so the
 * module stays pure). Unresolvable rows degrade per plan D-3 (native amount,
 * `estimated` taint on the result — data-only until Phase 4).
 */

import { formatCurrency } from "@/lib/format";
import { convertMoney } from "@/lib/money/convert";
import { minusDaysISO, toISODateUTC } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";
import type {
  ComputeOptions,
  LensAssumption,
  LensMetric,
  LensResult,
  PerspectiveScope,
} from "../types";

// ── Version & static copy ─────────────────────────────────────────────────────

/** Bump whenever this lens's math or verdict semantics change. */
export const LIQUIDITY_LENS_VERSION = 1;

/**
 * Static empty copy — must read identically whether accounts are absent or
 * merely invisible to the viewer (investigation §5.8): asserts nothing
 * about what exists, only about what is measurable here.
 */
export const LIQUIDITY_EMPTY = {
  headline: "Nothing to measure yet",
  subline:  "Link a bank or investment account to see what you could access.",
} as const;

// ── Input ─────────────────────────────────────────────────────────────────────

/**
 * The only account fields this lens is allowed to see. The adapter
 * (./liquidity.ts) maps AccountWithVisibility rows down to exactly this —
 * no names, no institutions, ever.
 */
export interface LiquidityAccountRow {
  id:      string;
  /** AccountType string: checking | savings | investment | crypto | debt | other */
  type:    string;
  balance: number;
  /**
   * MC1 Phase 3 Slice 5 — native currency of `balance`/`creditLimit` (Phase 0
   * provenance; non-identifying, so it does not weaken the privacy contract).
   * Only consulted when a ConversionContext is supplied; absent/null is the
   * null-residue case (native pass-through + estimated, plan D-3).
   */
  currency?: string | null;
  /** Present only on FULL rows (withheld otherwise by the data layer). */
  creditLimit?: number;
  /** ISO timestamp of last balance write (Account.lastUpdated). */
  lastUpdated: string;
  /** SpaceAccountLink.visibilityLevel string (existing model, no parallel vocabulary). */
  visibilityLevel: string;
}

// ── Core computation ──────────────────────────────────────────────────────────

const CASH_TYPES       = new Set(["checking", "savings"]);
const MARKETABLE_TYPES = new Set(["investment", "crypto"]);
const ILLIQUID_TYPES   = new Set(["other"]);

export function computeLiquidity(
  scope:   PerspectiveScope,
  options: ComputeOptions,
  rows:    LiquidityAccountRow[],
  // MC1 Phase 3 Slice 5 — optional conversion context (classifier pattern).
  // Absent ⇒ the original raw addition, byte-for-byte (kill switch).
  ctx?:    ConversionContext,
): LensResult {
  const computedAt = options.now().toISOString();

  // Latest close relative to the INJECTED clock — keeps this module pure and
  // fixture-deterministic (plan D-6 valuation rule for live balances).
  const valuationDateISO = ctx ? minusDaysISO(toISODateUTC(options.now()), 1) : undefined;
  const flag = { estimated: false };

  /** Row amount in the context target (native + taint per D-3 when unresolvable). */
  const inTarget = (amount: number, currency: string | null | undefined): number => {
    if (!ctx) return amount;
    const c = convertMoney({ amount, currency: currency ?? null }, valuationDateISO!, ctx);
    if (c.estimated) flag.estimated = true;
    return c.amount;
  };

  const base = {
    lensId: "liquidity" as const,
    lensVersion: LIQUIDITY_LENS_VERSION,
    scope,
    computedAt,
  };

  // No visible rows at all → empty (safe static copy; provenance zeroed).
  if (rows.length === 0) {
    return {
      ...base,
      status: "empty",
      metrics: [],
      assumptions: [],
      provenance: {
        accountIds: [],
        tierCounts: { full: 0, balanceOnly: 0, summaryOnly: 0 },
        dataAsOf: null,
        redactions: [],
      },
      empty: { ...LIQUIDITY_EMPTY },
    };
  }

  // ── Tier partition (fail closed: unknown levels are treated as summary-only) ─
  let full = 0, balanceOnly = 0, summaryOnly = 0;
  const contributing: LiquidityAccountRow[] = [];
  for (const r of rows) {
    if (r.visibilityLevel === "FULL") {
      full++;
      contributing.push(r);
    } else if (r.visibilityLevel === "BALANCE_ONLY") {
      balanceOnly++;
      contributing.push(r);
    } else {
      summaryOnly++;
    }
  }

  // ── Sums ──────────────────────────────────────────────────────────────────
  let cashNow = 0, marketable = 0, illiquid = 0, credit = 0;
  let creditKnown = false;
  for (const r of contributing) {
    if (CASH_TYPES.has(r.type))            cashNow    += inTarget(r.balance, r.currency);
    else if (MARKETABLE_TYPES.has(r.type)) marketable += inTarget(r.balance, r.currency);
    else if (ILLIQUID_TYPES.has(r.type))   illiquid   += inTarget(r.balance, r.currency);
    else if (r.type === "debt" && r.visibilityLevel === "FULL" && typeof r.creditLimit === "number") {
      // creditLimit and balance share the row's native currency, so the
      // clamped headroom converts as one native amount (convert-then-clamp
      // would be equivalent under positive rates; clamp-then-convert keeps
      // the existing max() shape byte-identical without a context).
      credit += inTarget(Math.max(r.creditLimit - Math.abs(r.balance), 0), r.currency);
      creditKnown = true;
    }
  }

  // ── Provenance ────────────────────────────────────────────────────────────
  // accountIds: contributing rows only (summary-only rows never appear),
  // sorted so equal inputs serialize identically. dataAsOf: OLDEST input
  // freshness among contributors — "as of" must never overstate freshness.
  const accountIds = contributing.map((r) => r.id).sort();
  const dataAsOf = contributing.length
    ? contributing.map((r) => r.lastUpdated).sort()[0]
    : null;

  const redactions: string[] = [];
  if (summaryOnly > 0) {
    redactions.push(
      `${summaryOnly} account${summaryOnly === 1 ? "" : "s"} with summary-only sharing ${summaryOnly === 1 ? "is" : "are"} excluded from all totals.`,
    );
  }
  if (balanceOnly > 0) {
    redactions.push(
      `${balanceOnly} shared account${balanceOnly === 1 ? "" : "s"} contribute${balanceOnly === 1 ? "s" : ""} a balance only.`,
    );
  }

  // ── Metrics ───────────────────────────────────────────────────────────────
  const headline: LensMetric = {
    id: "cashNow",
    label: "Available as cash now",
    value: cashNow,
    format: "currency",
    tone: cashNow > 0 ? "positive" : "warning",
  };
  const metrics: LensMetric[] = [
    headline,
    { id: "marketable", label: "Raisable by selling investments", value: marketable, format: "currency" },
    { id: "illiquid",   label: "Held in other assets (not readily sellable)", value: illiquid, format: "currency" },
  ];
  if (creditKnown) {
    metrics.push({
      id: "availableCredit",
      label: "Unused credit (borrowing capacity, not savings)",
      value: credit,
      format: "currency",
      tone: "neutral",
    });
  }

  // ── Assumptions ───────────────────────────────────────────────────────────
  const assumptions: LensAssumption[] = [
    {
      id: "balances-as-reported",
      text: "Balances are used as last reported by each account; pending activity and holds are not reflected.",
      source: "default",
    },
  ];
  if (marketable !== 0) {
    assumptions.push(
      {
        id: "marketable-before-costs",
        text: "Investment and crypto balances are counted at current value, before any taxes, penalties, fees, or market movement a sale would involve.",
        source: "default",
      },
      {
        id: "retirement-not-distinguished",
        text: "Retirement-restricted accounts cannot be distinguished from other investment accounts and are included in the sellable total.",
        source: "default",
      },
    );
  }
  if (creditKnown) {
    assumptions.push({
      id: "credit-not-liquidity",
      text: "Unused credit is borrowing capacity, not money you have — it is shown separately and never counted in the totals above.",
      source: "default",
    });
  }

  // ── Verdict (deterministic template — amounts only, never names) ─────────
  // MC1 QA Q1 — verdict amounts are converted into ctx.target when a context
  // is supplied; the embedded labels must match (label follows value). No
  // context ⇒ lib/format's USD default, exactly as before.
  const fmtCash = formatCurrency(cashNow, ctx?.target);
  const fmtMkt  = formatCurrency(marketable, ctx?.target);
  let verdict: string;
  if (cashNow > 0 && marketable > 0) {
    verdict = `About ${fmtCash} is available as cash now, and roughly ${fmtMkt} more could be raised by selling investments.`;
  } else if (cashNow > 0) {
    verdict = `About ${fmtCash} is available as cash now.`;
  } else if (marketable > 0) {
    verdict = `No cash on hand, but roughly ${fmtMkt} could be raised by selling investments.`;
  } else {
    verdict = "No readily accessible funds in this Space.";
  }

  return {
    ...base,
    status: "ok",
    verdict,
    headline,
    metrics,
    // MC1 P3 Slice 5 (D-7) — emitted only when a context was supplied, so
    // context-less results serialize byte-identically (kill switch).
    ...(ctx ? { estimated: flag.estimated } : {}),
    assumptions,
    provenance: {
      accountIds,
      tierCounts: { full, balanceOnly, summaryOnly },
      dataAsOf,
      redactions,
    },
  };
}
