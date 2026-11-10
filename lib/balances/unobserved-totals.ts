/**
 * lib/balances/unobserved-totals.ts
 *
 * Mortgage F8 (S2 ruling) — a TOTAL that excludes an account of unknown balance
 * is PARTIAL, and says which WAY the truth lies.
 *
 * FIN-A2 / FM-AUDIT-022 already exclude such an account from every total
 * (`balanceObserved === false`, or an unpriced / never-observed wallet: a
 * structural 0 flagged `valuationUnknown`, counted in `unvaluedCount`). That is
 * right — we never invent its balance — but the exclusion was disclosed only on
 * the account row ("Balance unavailable"), so a household whose $300k mortgage
 * was never observed saw a clean net worth $300k too HIGH. This module is the
 * ONE place that turns the exclusions into a statement AT THE TOTAL:
 *
 *   excluded DEBT  → net worth / liquid net worth: "Excludes a debt of unknown
 *                    balance — the true total is lower"
 *                  → total debt: "… — the true amount owed is higher" (the debt
 *                    total itself understates; "lower" would be false there)
 *   excluded ASSET → "Excludes an account of unknown balance — the true total
 *                    may be higher" (net worth, total assets; liquid figures only
 *                    when the excluded account is checking / savings)
 *
 * Status reuses the F3 typed-coverage vocabulary (lib/debt/aggregates.ts
 * TermCoverageStatus): COMPLETE when nothing this total depends on was excluded,
 * PARTIAL otherwise. The excluded balance stays excluded — no number is invented
 * ("partial, never $0, never silently omitted").
 *
 * Pure: no DB, no server-only imports (client components import it).
 */

import type { TermCoverageStatus } from "@/lib/debt/aggregates";
import { inSentence, isExcludedFromLiquidNetWorth } from "@/lib/debt/liquid-net-worth";
import {
  debtLabelAccess, liabilityKind, viewerDebtLabel, viewerDebtType,
  type DebtLabelViewer, type DebtType, type LiabilityKind, type LiabilityKindInput,
} from "@/lib/debt/liability-kind";

/** Which total a coverage statement describes. */
export type ExclusionTotal =
  | "NET_WORTH"
  | "LIQUID_NET_WORTH"
  | "TOTAL_DEBT"
  | "TOTAL_ASSETS"
  /** Unrestricted cash (checking + savings) — the AI snapshot's `liquid`. */
  | "LIQUID_CASH";

/**
 * Which way the true figure lies relative to the one shown.
 *   TRUE_TOTAL_LOWER         an excluded debt was not subtracted
 *   TRUE_TOTAL_MAY_BE_HIGHER an excluded account (asset) was not added — it may hold nothing
 *   TRUE_TOTAL_HIGHER        an excluded debt is missing from a DEBT total
 */
export type ExclusionDirection = "TRUE_TOTAL_LOWER" | "TRUE_TOTAL_MAY_BE_HIGHER" | "TRUE_TOTAL_HIGHER";

/** How many accounts of each kind the totals classification excluded as unvalued. */
export interface ExcludedAccountCounts {
  /** type === "debt" rows (or members of a debt aggregate). */
  debt:   number;
  /** every non-debt row (or aggregate member). */
  asset:  number;
  /** the subset of `asset` that is checking / savings (feeds the liquid figures). */
  liquid: number;
  /**
   * Mortgage F1 — the subset of `debt` that is an INSTALLMENT loan
   * (isExcludedFromLiquidNetWorth): it moves net worth and total debt, never
   * liquid net worth. Optional — absent ⇒ 0 (every excluded debt counts, the
   * conservative reading).
   */
  installmentDebt?: number;
}

export interface UnobservedTotalCoverage {
  total:              ExclusionTotal;
  /** F3 vocabulary, narrowed: an exclusion makes the total PARTIAL; none ⇒ COMPLETE. */
  status:             Extract<TermCoverageStatus, "COMPLETE" | "PARTIAL">;
  /** Excluded debts this total depends on. */
  excludedDebtCount:  number;
  /** Excluded assets this total depends on. */
  excludedAssetCount: number;
  /** One per kind of exclusion, debt first. Empty when COMPLETE. */
  directions:         ExclusionDirection[];
  /** The sentence per direction (same order), quotable as-is. Empty when COMPLETE. */
  notes:              string[];
}

const NONE: ExcludedAccountCounts = { debt: 0, asset: 0, liquid: 0 };

// ─────────────────────────────────────────────────────────────────────────────
// Mortgage F8c — THE excluded-accounts detector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why an account is not in a total.
 *   UNOBSERVED   FIN-A2: the provider balance was never observed (any type — a
 *                Plaid mortgage too). Structural 0, flagged `valuationUnknown`.
 *   UNVALUED     FM-AUDIT-022: a crypto wallet with no price / no observation.
 *   UNCONVERTED  V25-FINAL-1: a known foreign currency with no rate.
 *   REDACTED     REVIEW-3 C-4: a sharing tier that discloses no balance.
 * Only UNOBSERVED / UNVALUED feed the PARTIAL-with-direction totals below; the
 * other two have their own channels (`unconverted`, `redactedCount`) and are
 * typed here so every surface names the same reasons.
 */
export type ExclusionReason = "UNOBSERVED" | "UNVALUED" | "UNCONVERTED" | "REDACTED";

/**
 * The class of total an excluded account belongs to — the attribution F8a was
 * missing (an unobserved mortgage was read as "a crypto wallet not yet valued").
 * UNKNOWN only for legacy AI payloads that carried a bare count.
 */
export type ExcludedAccountClass = "DEBT" | "CASH" | "INVESTMENT" | "DIGITAL_ASSET" | "OTHER_ASSET" | "UNKNOWN";

/** One input row: any account shape carrying the exclusion evidence + its type. */
export interface ExclusionDetectorRow extends LiabilityKindInput, DebtLabelViewer {
  id?:   string;
  type:  string;
  /** FinancialAccount.balanceObserved (FIN-A2). Only `false` means unobserved. */
  balanceObserved?:     boolean | null;
  /** FM-AUDIT-022 / FIN-A2 structural-0 flag set by resolveWalletBalance. */
  valuationUnknown?:    boolean;
  /** A privacy fold's excluded members (counted, typed by the fold's type). */
  unvaluedMemberCount?: number;
  /** The caller found no FX rate for this row. */
  unconverted?:         boolean;
  /** The caller's tier disclosed no balance for this row. */
  redacted?:            boolean;
}

/** One excluded account (or fold of `count` accounts), typed. */
export interface ExcludedAccount {
  id?:          string;
  count:        number;
  reason:       ExclusionReason;
  accountClass: ExcludedAccountClass;
  /** In-sentence name: "mortgage", "credit card", "crypto wallet", "checking account". */
  label:        string;
  /** DEBT only — the fine-grained type (lib/debt/liability-kind.ts). */
  debtType?:      DebtType;
  liabilityKind?: LiabilityKind;
  /** DEBT only — Mortgage F1: an installment loan never moves liquid net worth. */
  excludedFromLiquidNetWorth?: true;
}

/** THE reading of FIN-A2's flag. Every surface asks this, never `=== false` itself. */
export function isBalanceUnobserved(a: { balanceObserved?: boolean | null }): boolean {
  return a.balanceObserved === false;
}

const TOTALS_REASONS: ReadonlySet<ExclusionReason> = new Set<ExclusionReason>(["UNOBSERVED", "UNVALUED"]);

function classOfType(type: string): ExcludedAccountClass {
  switch (type) {
    case "debt":       return "DEBT";
    case "checking":
    case "savings":    return "CASH";
    case "investment": return "INVESTMENT";
    case "crypto":     return "DIGITAL_ASSET";
    case "other":      return "OTHER_ASSET";
    default:           return "UNKNOWN";
  }
}

const NON_DEBT_LABEL: Readonly<Record<string, string>> = {
  checking:   "checking account",
  savings:    "savings account",
  investment: "investment account",
  crypto:     "crypto wallet",
  other:      "asset",
};

/**
 * The in-sentence name of an account's type ("mortgage", "crypto wallet", …).
 * S2 PRIVACY P1 — a debt is named finely only for its owner / a FULL viewer;
 * any other row (BALANCE_ONLY, or a row that does not say) reads "loan" /
 * "credit line" / "debt".
 */
export function excludedAccountLabel(a: { type: string } & LiabilityKindInput & DebtLabelViewer): string {
  if (a.type === "debt") return inSentence(viewerDebtLabel(a, debtLabelAccess(a)));
  return NON_DEBT_LABEL[a.type] ?? "account";
}

/**
 * THE excluded-accounts detector (Mortgage F8c). Decides, for every surface —
 * debt lens, wealth envelope / hero, liquidity lens, Brief, economic concepts,
 * AI assemblers — WHICH rows are excluded from the totals, WHY, and AS WHAT
 * TYPE. Nothing else interprets `balanceObserved === false` or a bare unvalued
 * count (pinned by excluded-accounts-detector.test.ts).
 */
export function detectExcludedAccounts(rows: ReadonlyArray<ExclusionDetectorRow>): ExcludedAccount[] {
  const out: ExcludedAccount[] = [];
  for (const a of rows) {
    const flagged = a.valuationUnknown === true || isBalanceUnobserved(a);
    const members = a.unvaluedMemberCount ?? 0;
    const reason: ExclusionReason | null =
      a.redacted === true    ? "REDACTED"
      : a.unconverted === true ? "UNCONVERTED"
      : isBalanceUnobserved(a) ? "UNOBSERVED"
      : flagged || members > 0 ? (a.type === "crypto" ? "UNVALUED" : "UNOBSERVED")
      : null;
    if (reason === null) continue;
    const count = reason === "REDACTED" || reason === "UNCONVERTED" ? 1 : (flagged ? 1 : 0) + members;
    if (count === 0) continue;
    const accountClass = classOfType(a.type);
    const debt = accountClass === "DEBT"
      ? {
          // S2 PRIVACY P1 — the TYPE the viewer may be told (kind-preserving
          // generic at COARSE); the liquid-NW decision below reads full evidence.
          debtType: viewerDebtType(a, debtLabelAccess(a)),
          liabilityKind: liabilityKind(a),
          ...(isExcludedFromLiquidNetWorth(a) ? { excludedFromLiquidNetWorth: true as const } : {}),
        }
      : {};
    out.push({
      ...(a.id !== undefined ? { id: a.id } : {}),
      count, reason, accountClass, label: excludedAccountLabel(a), ...debt,
    });
  }
  return out;
}

/** The F8 counts over already-detected exclusions (UNOBSERVED / UNVALUED only). */
export function countsOfExcluded(excluded: ReadonlyArray<ExcludedAccount>): ExcludedAccountCounts {
  const c = { debt: 0, asset: 0, liquid: 0 };
  let installmentDebt = 0;
  for (const e of excluded) {
    if (!TOTALS_REASONS.has(e.reason)) continue;
    if (e.accountClass === "DEBT") {
      c.debt += e.count;
      // Mortgage F1 — an unobserved mortgage leaves liquid NW complete.
      if (e.excludedFromLiquidNetWorth) installmentDebt += e.count;
    } else {
      c.asset += e.count;
      if (e.accountClass === "CASH") c.liquid += e.count;
    }
  }
  // OMITTED when 0, so a count with no installment exclusion is unchanged.
  return installmentDebt > 0 ? { ...c, installmentDebt } : c;
}

/**
 * Count the excluded accounts by kind over the SAME rows a total was classified
 * from (rows carrying `valuationUnknown` / `unvaluedMemberCount`). Through the
 * detector — one decision.
 */
export function excludedAccountCounts(
  accounts: ReadonlyArray<ExclusionDetectorRow>,
): ExcludedAccountCounts {
  return countsOfExcluded(detectExcludedAccounts(accounts));
}

/** Does this exclusion move this total? (Same rule as `unobservedTotalCoverage`.) */
function movesTotal(total: ExclusionTotal, e: ExcludedAccount): boolean {
  if (!TOTALS_REASONS.has(e.reason)) return false;
  const debt = e.accountClass === "DEBT";
  switch (total) {
    case "NET_WORTH":        return true;
    case "TOTAL_DEBT":       return debt;
    case "TOTAL_ASSETS":     return !debt;
    case "LIQUID_CASH":      return e.accountClass === "CASH";
    case "LIQUID_NET_WORTH": return debt ? e.excludedFromLiquidNetWorth !== true : e.accountClass === "CASH";
  }
}

function pluralLabel(n: number, label: string): string {
  return n === 1 ? `1 ${label}` : `${n} ${label}${/s$/.test(label) ? "" : "s"}`;
}

/** "1 mortgage", "1 mortgage and 2 credit cards", "1 mortgage, 1 HELOC and 1 checking account". */
export function describeExcludedTypes(
  excluded: ReadonlyArray<ExcludedAccount>,
  /** true ⇒ a single account of a type is named without its "1" ("mortgage"), for use after a count. */
  bareSingles = false,
): string {
  const byLabel = new Map<string, number>();
  const ordered = [...excluded].sort((x, y) => (x.accountClass === "DEBT" ? 0 : 1) - (y.accountClass === "DEBT" ? 0 : 1));
  for (const e of ordered) byLabel.set(e.label, (byLabel.get(e.label) ?? 0) + e.count);
  const parts = [...byLabel].map(([label, n]) => (bareSingles && n === 1 ? label : pluralLabel(n, label)));
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What a person calls each total. */
export const EXCLUSION_TOTAL_LABEL: Readonly<Record<ExclusionTotal, string>> = {
  NET_WORTH:        "Net worth",
  LIQUID_NET_WORTH: "Liquid net worth",
  TOTAL_DEBT:       "Total debt",
  TOTAL_ASSETS:     "Total assets",
  LIQUID_CASH:      "Cash",
};

/** A PARTIAL total, typed and worded: the same coverage + which accounts, by type. */
export interface PartialTotalStatement {
  total:     ExclusionTotal;
  coverage:  UnobservedTotalCoverage;
  /** The exclusions this total depends on. */
  excluded:  ExcludedAccount[];
  /** "1 balance unavailable (mortgage); may be understated" — no total name. */
  detail:    string;
  /** "Total debt — partial: 1 balance unavailable (mortgage); may be understated". */
  text:      string;
}

/**
 * The statement for ONE total over detected exclusions, or null when COMPLETE.
 * Direction words: an excluded debt makes a NET figure "may be overstated" and
 * a DEBT total "may be understated"; an excluded asset "may be understated".
 */
export function partialTotalStatement(
  total: ExclusionTotal,
  excluded: ReadonlyArray<ExcludedAccount>,
): PartialTotalStatement | null {
  const relevant = excluded.filter((e) => movesTotal(total, e));
  const coverage = unobservedTotalCoverage(total, countsOfExcluded(relevant));
  if (coverage.status === "COMPLETE") return null;
  const n = relevant.reduce((s, e) => s + e.count, 0);
  const over  = coverage.directions.includes("TRUE_TOTAL_LOWER");
  const under = coverage.directions.includes("TRUE_TOTAL_HIGHER") || coverage.directions.includes("TRUE_TOTAL_MAY_BE_HIGHER");
  const direction = over && under
    ? "may be overstated (an excluded debt) or understated (an excluded asset)"
    : over ? "may be overstated" : "may be understated";
  const detail = `${n} balance${n === 1 ? "" : "s"} unavailable (${describeExcludedTypes(relevant, true)}); ${direction}`;
  return { total, coverage, excluded: relevant, detail, text: `${EXCLUSION_TOTAL_LABEL[total]} — partial: ${detail}` };
}

/**
 * The AI payload's typed exclusions (no ids, no names — type + reason + count),
 * grouped so the model reads "1 mortgage, never observed", never a bare count.
 */
export interface AiExcludedAccountGroup {
  accountClass: ExcludedAccountClass;
  reason:       ExclusionReason;
  label:        string;
  count:        number;
  debtType?:    DebtType;
  excludedFromLiquidNetWorth?: true;
}

export function aiExcludedAccountGroups(rows: ReadonlyArray<ExclusionDetectorRow>): AiExcludedAccountGroup[] {
  const groups = new Map<string, AiExcludedAccountGroup>();
  for (const e of detectExcludedAccounts(rows)) {
    if (!TOTALS_REASONS.has(e.reason)) continue;
    const key = `${e.accountClass}|${e.reason}|${e.label}|${e.debtType ?? ""}|${e.excludedFromLiquidNetWorth ? 1 : 0}`;
    const g = groups.get(key);
    if (g) { g.count += e.count; continue; }
    groups.set(key, {
      accountClass: e.accountClass, reason: e.reason, label: e.label, count: e.count,
      ...(e.debtType ? { debtType: e.debtType } : {}),
      ...(e.excludedFromLiquidNetWorth ? { excludedFromLiquidNetWorth: true as const } : {}),
    });
  }
  return [...groups.values()];
}

/**
 * The exclusions an AI accounts payload carries, typed. A payload predating
 * F8c carried only `totalsUnvaluedCount`: that count is UNATTRIBUTABLE (it
 * included unobserved non-wallet accounts), so it reads as class UNKNOWN —
 * never as "crypto wallets" (the F8a misattribution).
 */
export function excludedFromAiAccounts(acc: {
  totalsExcluded?: ReadonlyArray<AiExcludedAccountGroup>;
  totalsUnvaluedCount?: number;
} | null | undefined): ExcludedAccount[] {
  if (!acc) return [];
  if (acc.totalsExcluded) {
    return acc.totalsExcluded.map((g) => ({
      count: g.count, reason: g.reason, accountClass: g.accountClass, label: g.label,
      ...(g.debtType ? { debtType: g.debtType } : {}),
      ...(g.excludedFromLiquidNetWorth ? { excludedFromLiquidNetWorth: true as const } : {}),
    }));
  }
  const n = acc.totalsUnvaluedCount ?? 0;
  return n > 0 ? [{ count: n, reason: "UNOBSERVED", accountClass: "UNKNOWN", label: "account" }] : [];
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

/** The debt-exclusion sentence for a NET figure (net worth / liquid net worth). */
export function excludedDebtNote(n: number): string {
  return `Excludes ${plural(n, "a debt", "debts")} of unknown balance — the true total is lower`;
}
/** The debt-exclusion sentence for a DEBT total. */
export function excludedDebtFromDebtTotalNote(n: number): string {
  return `Excludes ${plural(n, "a debt", "debts")} of unknown balance — the true amount owed is higher`;
}
/** The asset-exclusion sentence (net worth / assets / liquid). */
export function excludedAssetNote(n: number): string {
  return `Excludes ${plural(n, "an account", "accounts")} of unknown balance — the true total may be higher`;
}

/**
 * The coverage of ONE total. Which exclusions matter depends on the total:
 * an excluded house never makes the debt total partial; an excluded brokerage
 * account never makes liquid cash partial.
 */
export function unobservedTotalCoverage(
  total: ExclusionTotal,
  counts: ExcludedAccountCounts = NONE,
): UnobservedTotalCoverage {
  const debt = total === "TOTAL_ASSETS" || total === "LIQUID_CASH" ? 0
    : total === "LIQUID_NET_WORTH" ? Math.max(counts.debt - (counts.installmentDebt ?? 0), 0)
    : counts.debt;
  const asset =
    total === "TOTAL_DEBT" ? 0
    : total === "LIQUID_NET_WORTH" || total === "LIQUID_CASH" ? counts.liquid
    : counts.asset;

  const directions: ExclusionDirection[] = [];
  const notes: string[] = [];
  if (debt > 0) {
    if (total === "TOTAL_DEBT") {
      directions.push("TRUE_TOTAL_HIGHER");
      notes.push(excludedDebtFromDebtTotalNote(debt));
    } else {
      directions.push("TRUE_TOTAL_LOWER");
      notes.push(excludedDebtNote(debt));
    }
  }
  if (asset > 0) {
    directions.push("TRUE_TOTAL_MAY_BE_HIGHER");
    notes.push(excludedAssetNote(asset));
  }
  return {
    total,
    status: directions.length > 0 ? "PARTIAL" : "COMPLETE",
    excludedDebtCount: debt,
    excludedAssetCount: asset,
    directions,
    notes,
  };
}

/** The short badge text for one direction — what a chip beside the total says. */
export function exclusionBadge(d: ExclusionDirection): string {
  switch (d) {
    case "TRUE_TOTAL_LOWER":         return "Partial — true total is lower";
    case "TRUE_TOTAL_HIGHER":        return "Partial — true amount owed is higher";
    case "TRUE_TOTAL_MAY_BE_HIGHER": return "Partial — true total may be higher";
  }
}

/**
 * The AI tool contract's projection: status + direction BESIDE each total.
 * Returns null when every total is COMPLETE, so a fully observed Space's payload
 * is unchanged.
 */
export interface AiTotalsCoverage {
  netWorth:         UnobservedTotalCoverage;
  totalAssets:      UnobservedTotalCoverage;
  totalLiabilities: UnobservedTotalCoverage;
  liquid:           UnobservedTotalCoverage;
  /** How to read the PARTIAL totals, in words the model can quote. */
  meaning:          string;
}

export function aiTotalsCoverage(counts: ExcludedAccountCounts): AiTotalsCoverage | null {
  const netWorth = unobservedTotalCoverage("NET_WORTH", counts);
  if (netWorth.status === "COMPLETE") return null; // every exclusion moves net worth
  return {
    netWorth,
    totalAssets:      unobservedTotalCoverage("TOTAL_ASSETS", counts),
    totalLiabilities: unobservedTotalCoverage("TOTAL_DEBT", counts),
    liquid:           unobservedTotalCoverage("LIQUID_CASH", counts),
    meaning:
      "A PARTIAL total leaves out an account whose balance is unknown (never observed or not yet valued) — it is NOT counted as 0. "
      + "State the total as partial with its direction: an excluded debt means the true net worth is LOWER (and the true debt higher); "
      + "an excluded asset means the true total MAY BE HIGHER. Never present a partial total as complete, and never estimate the missing balance.",
  };
}
