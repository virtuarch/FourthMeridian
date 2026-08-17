/**
 * GET /api/brief
 *
 * Returns a BriefPayload for the Daily Brief page.
 *
 * D4 Slice 6 — Context Builder integration.
 * Financial data now flows exclusively through buildContext() / the AI Context
 * Builder. The route no longer queries SpaceAccountLink, SpaceSnapshot, or
 * any financial table directly.
 *
 * ── Space eligibility ─────────────────────────────────────────────────────────
 * Context is built for every Space where the user is OWNER, ADMIN, or MEMBER.
 * VIEWER Spaces are excluded — they contribute read-only access to shared data
 * but should not drive the user's personal financial brief.
 *
 * ── Aggregation model ────────────────────────────────────────────────────────
 * Each eligible Space assembles its own Context independently (via buildContext
 * with scopeHint='brief'). The brief then:
 *   - Uses the primary Space (PERSONAL or first eligible) for headline metrics
 *     (net worth, account health) to avoid double-counting shared accounts.
 *   - Aggregates signals from ALL eligible Spaces; signals from non-primary
 *     Spaces carry the Space name in their metadata for attribution.
 *   - Reports the total account count across all eligible Spaces.
 *
 * ── What is still queried directly ───────────────────────────────────────────
 * Non-financial tables only:
 *   db.user          — display name, lastBriefViewedAt
 *   db.spaceMember   — eligible Space membership enumeration
 *   db.spaceInvite   — pending invite count
 *   db.aiAdvice      — cached AI-generated advice text (AI output, not source data)
 */

import { NextResponse }       from "next/server";
import { db }                 from "@/lib/db";
import { requireUser }        from "@/lib/session";
import { SpaceMemberRole }    from "@prisma/client";
import {
  buildContext,
  FinanceDomains,
  SignalType,
  MATERIAL_UNIDENTIFIED_INFLOW_SHARE,
} from "@/lib/ai";
// v2.6-BRIEF-1 — THE deterministic financial assessment. The Brief no longer
// answers "how am I doing?" itself; it reads the same authority the AI reads.
import { computeAssessment } from "@/lib/ai/intelligence";
import type { FinancialAssessment } from "@/lib/ai/intelligence";
import type {
  SpaceContext_AI,
  AccountsSectionData,
  SnapshotSectionData,
  TransactionsSummaryData,
  ContextSignal,
} from "@/lib/ai";
import type {
  BriefPayload,
  BriefSection,
  BriefItem,
  BriefTone,
  VisitState,
  TrackedAccount,
} from "@/lib/brief-types";
// REVIEW-3 C-6 — the ONE symbol/formatting source; no hard-coded `$` remains.
import { currencySymbol, DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

// ── Formatting helpers ────────────────────────────────────────────────────────

// REVIEW-3 C-6 — the Brief renders money in the primary Space's REPORTING
// currency, threaded from the context (ctx.space.reportingCurrency). The
// previous helpers hard-coded `$` on every figure; a non-USD Space would have
// had its entire Brief silently dollar-signed. The symbol comes from
// lib/currency's currencySymbol (USD ⇒ "$", so all-USD output is unchanged).
function fmtCurrency(n: number, currency: string): string {
  const abs = Math.abs(n);
  const sym = currencySymbol(currency);
  if (abs >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${sym}${(n / 1_000).toFixed(1)}K`;
  return `${sym}${n.toFixed(0)}`;
}

function fmtDelta(delta: number, currency: string): string {
  const sign = delta >= 0 ? "+" : "−";
  return `${sign}${fmtCurrency(Math.abs(delta), currency)}`;
}

/**
 * v2.6-WINDOW-1 — a window's opening date, as a user reads it ("Jul 7").
 *
 * Parsed as UTC (the `T00:00:00Z` suffix) because `canonicalChange.fromDate` is
 * a plain YYYY-MM-DD from the canonical window authority. `new Date("2026-07-07")`
 * is already UTC-midnight, but formatting it without an explicit timeZone renders
 * it in the server's local zone — which shows "Jul 6" anywhere west of UTC. A
 * date that shifts by one day depending on where the server runs is exactly the
 * class of quiet wrongness this slice exists to remove.
 */
function fmtDay(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });
}

// ── Visit state helpers (unchanged) ───────────────────────────────────────────

function visitState(lastViewedAt: Date | null, hasData: boolean): VisitState {
  if (!hasData) return "new_user";
  if (!lastViewedAt) return "away";
  const diffMs = Date.now() - lastViewedAt.getTime();
  const diffH  = diffMs / (1000 * 60 * 60);
  if (diffH <  1) return "immediate";
  if (diffH <  6) return "short";
  if (diffH < 24) return "day";
  return "away";
}

function contextLine(state: VisitState, name: string | null): string {
  const displayName = name ? `, ${name.split(" ")[0]}` : "";
  switch (state) {
    case "new_user":   return `Welcome to Fourth Meridian${displayName}. Let's build your financial picture.`;
    case "immediate":  return `You're up to date${displayName}.`;
    case "short":      return `Here's where things stand${displayName}.`;
    case "day":        return `Good to see you${displayName}. Here's your daily check-in.`;
    case "away":       return `Welcome back${displayName}. Here's what changed while you were away.`;
  }
}

function sinceLabel(lastViewedAt: Date | null): string {
  if (!lastViewedAt) return "Your financial snapshot";
  const diffMs = Date.now() - lastViewedAt.getTime();
  const diffH  = diffMs / (1000 * 60 * 60);
  if (diffH < 1)    return "In the last hour";
  if (diffH < 24)   return "Since earlier today";
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1)  return "Since yesterday";
  if (diffD <  7)   return `Since ${diffD} days ago`;
  return "Since your last visit";
}

// ── Context domain extractors ─────────────────────────────────────────────────

function accounts(ctx: SpaceContext_AI): AccountsSectionData | null {
  const s = ctx.domains[FinanceDomains.ACCOUNTS];
  return s ? (s.data as AccountsSectionData) : null;
}

function snapshot(ctx: SpaceContext_AI): SnapshotSectionData | null {
  const s = ctx.domains[FinanceDomains.SNAPSHOT_HISTORY];
  return s ? (s.data as SnapshotSectionData) : null;
}

function transactions(ctx: SpaceContext_AI): TransactionsSummaryData | null {
  const s = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY];
  return s ? (s.data as TransactionsSummaryData) : null;
}

// ── Onboarding (unchanged) ────────────────────────────────────────────────────

function buildOnboarding(): BriefSection {
  return {
    id:       "onboarding",
    type:     "onboarding",
    priority: 5,
    title:    "Get started",
    items: [
      // Connect-intent onboarding → the Connections hub, where the actual
      // connect/Plaid flow lives (AccountsPerspective is management-only). The
      // standalone /dashboard/accounts page is retired.
      { id: "ob_bank",    label: "Connect your first bank account",                            tone: "neutral", href: "/dashboard/connections" },
      { id: "ob_invest",  label: "Add an investment account",                                  tone: "neutral", href: "/dashboard/connections" },
      { id: "ob_crypto",  label: "Import a crypto wallet",                                     tone: "neutral", href: "/dashboard/connections" },
      { id: "ob_manual",  label: "Add manual assets — home, vehicle, equipment, or valuables", tone: "neutral", href: "/dashboard/connections" },
    ],
  };
}

// ── Since Last Visit — now sourced from Context ───────────────────────────────

/**
 * Net worth and account count come from the primary Space's accounts domain.
 * Trend (delta) comes from the snapshot domain's netWorthTrend, which covers
 * the full snapshot history window rather than exact since-last-visit.
 * When no trend data exists, only the current value is shown.
 */
function buildSinceLastVisit(
  primaryCtx:      SpaceContext_AI,
  totalAccounts:   number,
  lastViewedAt:    Date | null,
  pendingInvites:  number,
  trackedAccounts: TrackedAccount[],
  cur:             string,
): BriefSection | null {
  const acct = accounts(primaryCtx);
  const snap  = snapshot(primaryCtx);

  if (!acct) return null;

  const items: BriefItem[] = [];
  const netWorth = acct.netWorth;

  // Net worth — the CANONICAL windowed change, named by its window.
  //
  // v2.6-WINDOW-1 — this rendered `snap.netWorthTrend`: oldest→newest of
  // whatever rows were fetched (89 days on the live corpus, +$3.6K) under a
  // heading that says "In the last hour". The section's own header comment
  // admitted the delta "covers the full snapshot history window rather than
  // exact since-last-visit", but nothing on screen said so, and the figure sat
  // directly above an insight quoting a DIFFERENT net-worth change — +$3.6K and
  // +26.8% ($5,920), one screen, same account, both unlabelled.
  //
  // Both now read the same canonical month, and the item carries its window in
  // the detail line, so the number cannot be misread as "since your last visit".
  // A delta that does not match its heading is not a smaller lie than a wrong
  // one; it is the same lie with a friendlier tone.
  const nwChange = snap?.canonicalChange ?? null;
  if (nwChange && nwChange.abs !== 0) {
    const tone: BriefTone = nwChange.abs > 0 ? "positive" : "warning";
    items.push({
      id:     "nw_delta",
      label:  "Net worth",
      value:  fmtDelta(nwChange.abs, cur),
      // REVIEW-3 C-4c — ONE population per sentence. `now` is the canonical
      // window's own endpoint (the same snapshot series the delta is computed
      // over), not the live classifier's figure: the previous mix put a
      // snapshot-window change beside a live total whose population differs
      // (e.g. consent-gated investments), so the two numbers in one line could
      // not be reconciled with each other.
      detail: `since ${fmtDay(nwChange.fromDate)} · now ${fmtCurrency(nwChange.toValue, cur)} (as of ${fmtDay(nwChange.toDate)})`,
      tone,
    });
  } else {
    // Single figure, single population (the live accounts-domain total).
    items.push({
      id:    "nw_current",
      label: "Net worth",
      value: fmtCurrency(netWorth, cur),
      tone:  "neutral",
    });
  }

  if (totalAccounts > 0) {
    items.push({
      id:    "account_count",
      label: "Accounts tracked",
      value: String(totalAccounts),
      tone:  "neutral",
    });
  }

  if (pendingInvites > 0) {
    items.push({
      id:    "pending_invites",
      label: pendingInvites === 1 ? "Space invite" : "Space invites",
      value: String(pendingInvites),
      tone:  "info",
      href:  "/dashboard/spaces",
    });
  }

  if (items.length === 0) return null;

  return {
    id:       "since_last_visit",
    type:     "since_last_visit",
    priority: 10,
    title:    sinceLabel(lastViewedAt),
    items,
    trackedAccounts,
  };
}

// ── Needs Attention — driven by signals and account health ────────────────────

/**
 * Priority order within the section:
 *   1. NEEDS_REAUTH signals (danger — account syncing is blocked)
 *   2. Sync error accounts (danger — from accounts health summary)
 *   3. STALE_CONNECTION signals (warning)
 *   4. NET_WORTH_DECLINED signal (warning)
 *   5. Low liquidity from accounts domain (warning)
 *
 * Capped at 5 items to match the previous implementation.
 */
function buildAttention(
  allSignals:  ContextSignal[],
  primaryCtx:  SpaceContext_AI,
  assessment:  FinancialAssessment,
  cur:         string,
): BriefSection | null {
  const items: BriefItem[] = [];
  const acct  = accounts(primaryCtx);

  // ── Signals → items ───────────────────────────────────────────────────────
  // Only warning/critical signals belong in the Attention section.

  for (const sig of allSignals) {
    if (sig.severity === 'info') continue;

    switch (sig.type) {
      case SignalType.NEEDS_REAUTH:
        items.push({
          id:    sig.id,
          label: sig.title,
          tone:  "danger",
          href:  "/dashboard?tab=accounts",
        });
        break;

      case SignalType.STALE_CONNECTION:
        items.push({
          id:    sig.id,
          label: sig.title,
          detail: "Manual assets may be out of date",
          tone:  "warning",
          href:  "/dashboard?tab=accounts",
        });
        break;

      case SignalType.NET_WORTH_DECLINED:
        items.push({
          id:    sig.id,
          label: sig.title,
          tone:  "warning",
        });
        break;

      // TI2-W2 — surfaces only at `warning` severity (material unidentified
      // inflow); the info-severity flag is skipped above like every other info
      // signal. Deep-links to the Transactions Tab, where the needs-review filter
      // lives (established convention; no dedicated needs-review URL param exists).
      case SignalType.NEEDS_CLASSIFICATION:
        items.push({
          id:     sig.id,
          label:  sig.title,
          ...(typeof sig.metadata?.detail === "string" && sig.metadata.detail
            ? { detail: sig.metadata.detail }
            : {}),
          tone:   "warning",
          href:   "/dashboard?tab=transactions",
        });
        break;
    }
  }

  // ── Account sync errors (from health summary, primary Space only) ─────────
  // Not a Slice 5 signal yet, but available in the accounts domain health.

  if (acct && acct.health.errorCount > 0) {
    const names = acct.health.errorAccountNames;
    if (names.length > 0) {
      for (const name of names) {
        items.push({
          id:   `sync_error_${name}`,
          label: `Sync issue — ${name}`,
          tone:  "danger",
          href:  "/dashboard?tab=accounts",
        });
      }
    } else {
      items.push({
        id:    "sync_error_accounts",
        label: `${acct.health.errorCount} account${acct.health.errorCount > 1 ? "s" : ""} have sync errors`,
        tone:  "danger",
        href:  "/dashboard?tab=accounts",
      });
    }
  }

  // ── Low liquidity — v2.6-BRIEF-1: the canonical verdict, not a second one ──
  //
  // This was `totalLiquid / netWorth < 0.05` — a BALANCE-SHEET RATIO, which is
  // not a liquidity measure and disagreed with the authority in both directions.
  // Someone holding $80,000 in cash against a $2M net worth was told they had a
  // "Low cash position" while `computeAssessment` classified their coverage
  // EXCELLENT; someone with three weeks of expenses in cash and a small net
  // worth passed the ratio and was told nothing while the authority said
  // CRITICAL. Liquidity is coverage — cash measured against what it has to
  // cover — and `liquidity.classification` is where that is decided
  // (LIQUIDITY_CRITICAL_MONTHS / LIQUIDITY_WARNING_MONTHS).
  //
  // UNKNOWN means the authority cannot compute coverage (no liquid accounts, or
  // no complete calendar month in the window — which is the normal state of a
  // 30-day brief window). The Brief then says NOTHING. Refusing is the point:
  // the ratio rule was a way of appearing to know when the input for knowing
  // was absent.
  const liq = assessment.liquidity;
  if (liq.classification === "CRITICAL" || liq.classification === "WARNING") {
    items.push({
      id:     "low_liquidity",
      label:  "Low cash position",
      value:  fmtCurrency(liq.liquidCashTotal, cur),
      ...(liq.coverageMonths !== null
        ? { detail: `About ${liq.coverageMonths.toFixed(1)} months of expenses covered` }
        : {}),
      tone:   liq.classification === "CRITICAL" ? "danger" : "warning",
    });
  }

  if (items.length === 0) return null;

  return {
    id:       "attention",
    type:     "attention",
    priority: 15,
    title:    "Needs Attention",
    items:    items.slice(0, 5),
    tone:     "warning",
  };
}

// ── Insight — driven by signals, context data, and cached AI advice ───────────

/**
 * Prefers cached AI advice when present.
 * Otherwise synthesizes a rule-based insight using:
 *   - NET_WORTH_INCREASED signal (positive trend)
 *   - GOAL_COMPLETED signal (achievement)
 *   - Transaction summary (income vs expense picture)
 *   - Accounts domain (debt ratio, cash ratio)
 */
function buildInsight(
  allSignals:   ContextSignal[],
  primaryCtx:   SpaceContext_AI,
  advice:       { summary: string; adviceText: string } | null,
  assessment:   FinancialAssessment,
  cur:          string,
): BriefSection | null {
  // Prefer cached AI advice.
  //
  // REVIEW-3 — DORMANT-VALID, not dead (do not delete): no current code path
  // writes AiAdvice rows, so this branch never fires TODAY, but the AiAdvice
  // writer is a tracked open issue (KD-14, milestoned v2.6b). When that writer
  // lands, this branch is the consumption path.
  if (advice?.summary) {
    return {
      id:          "insight",
      type:        "insight",
      priority:    20,
      title:       "Today's Insight",
      body:        advice.summary,
      actionLabel: "View full analysis",
      actionHref:  "/dashboard/analyze",
      tone:        "info",
    };
  }

  const acct  = accounts(primaryCtx);
  const txn   = transactions(primaryCtx);
  const snap  = snapshot(primaryCtx);

  // v2.6-BRIEF-1 — these three remain because the fallback still needs to know
  // whether there is a balance sheet at all, and the net-worth figure is quoted
  // verbatim. `cash` is gone with the cashRatio rule: the liquid total is now
  // read from `assessment.liquidity.liquidCashTotal`, beside the coverage
  // classification that gives it meaning.
  const netWorth    = acct?.netWorth    ?? 0;
  const totalAssets = acct?.totalAssets ?? 0;
  const totalDebt   = acct?.totalLiabilities ?? 0;

  // ── Signal-driven insights (highest priority) ─────────────────────────────

  // Recently completed goal
  const completedGoalSig = allSignals.find(s => s.type === SignalType.GOAL_COMPLETED);
  if (completedGoalSig) {
    const name = (completedGoalSig.metadata?.goalName as string | undefined) ?? "a goal";
    return {
      id:       "insight",
      type:     "insight",
      priority: 20,
      title:    "Today's Insight",
      body:     `You completed "${name}" — great work. Review your remaining goals and consider setting a new target.`,
      tone:     "positive",
    };
  }

  // Positive net worth trend
  //
  // v2.6-WINDOW-1 — the CANONICAL window, named by its actual dates.
  //
  // This read `${snap.netWorthTrendPct}% over the last ${snap.snapshotCount}
  // days`. Both halves were wrong. `snapshotCount` is a ROW COUNT, printed as a
  // duration; and the percentage spanned oldest→newest of whatever rows were
  // fetched, which is not a window the product defines. On the live corpus that
  // put the baseline on 2026-05-10 — 89 days back, three days from the canonical
  // 2026-05-07 — with a $4,985 debt paydown sitting between them. The Brief said
  // "up 14.9% over the last 90 days" while the Space, for the same words on the
  // same day, said 47.4%.
  //
  // `canonicalChange` comes from `compareToForPreset`, the same authority behind
  // the Space launcher's figure and the inside-Space selector, so the three now
  // state one number. The window is rendered as the date it actually opens on
  // rather than a day count, because "since Jul 7" cannot be silently wrong the
  // way "over the last 90 days" was.
  //
  // No canonicalChange means history does not reach back a month — the authority
  // refuses rather than comparing against the earliest point it happens to hold,
  // and so does this sentence.
  // REVIEW-3 C-5 — ONE window, sign-correct verbs. The gate used to be the
  // NET_WORTH_INCREASED signal (computed, pre-migration, over the ACCIDENTAL
  // fetched-row window) while the sentence printed the canonical percentage
  // with NO sign check — so "up" could gate on one window's sign and print
  // another window's negative number ("Net worth is up -3.2%"). The signal now
  // derives from canonicalChange too, and this sentence additionally checks
  // the sign of the exact figure it prints, so gate, figure, and verb agree by
  // construction. The quoted total is the canonical window's own endpoint —
  // the same series as the percentage, never the live classifier's total.
  const trendUpSig = allSignals.find(s => s.type === SignalType.NET_WORTH_INCREASED);
  const change = snap?.canonicalChange ?? null;
  if (trendUpSig && change && change.pct !== null && change.pct > 0 && change.abs > 0) {
    return {
      id:       "insight",
      type:     "insight",
      priority: 20,
      title:    "Today's Insight",
      body:     `Net worth is up ${change.pct.toFixed(1)}% since ${fmtDay(change.fromDate)} — ` +
                `${fmtCurrency(change.toValue, cur)} as of ${fmtDay(change.toDate)}. Stay consistent.`,
      tone:     "positive",
    };
  }

  // ── Transaction picture: spending vs income ───────────────────────────────
  //
  // v2.6-BRIEF-1 — the rate itself is a window statistic the Brief may state,
  // but ONLY when the authority says the income figure behind it is worth
  // stating. `cashFlow.reliability` is UNRELIABLE exactly when income confidence
  // is LOW, and this sentence is entirely a claim about income: quoting a
  // savings rate off an income total the assessment will not stand behind is how
  // the Brief and the AI ended up telling a user two different things about the
  // same 30 days.
  if (txn && txn.incomeTotal > 0 && assessment.cashFlow.reliability !== "UNRELIABLE") {
    // REVIEW-3 C-3 — the rate is derived from the CANONICAL net (income −
    // clamped spend), the same figure the Cash Flow workspace headlines — never
    // recomputed here from gross expenseTotal, which overstated spending by the
    // window's refunds. The sentence still DISCLOSES gross expenses, but names
    // them as gross.
    const savingsRate = Math.round((txn.netCashFlow / txn.incomeTotal) * 100);
    if (savingsRate > 0) {
      // TI2-W2 — honesty caveat: when a material share of that income is
      // sign-default inflow with no resolved source, the savings rate rests on
      // income we cannot fully identify. Read from the assessment's own
      // dataQuality rather than re-derived here — the route used to call
      // deriveUnidentifiedInflowShare(txn) itself, computing a second time what
      // computeAssessment had already computed from the same input.
      const share = assessment.dataQuality.unidentifiedInflowShare;
      const caveat = share !== null && share >= MATERIAL_UNIDENTIFIED_INFLOW_SHARE
        ? ` Note: ${fmtCurrency(txn.needsClassification.unknownInflowTotal, cur)} of that income has no identified source, so this rate is provisional.`
        : "";
      return {
        id:       "insight",
        type:     "insight",
        priority: 20,
        title:    "Today's Insight",
        body:     `You kept ${savingsRate}% of income over the last ${txn.windowDays} days. Gross expenses were ${fmtCurrency(txn.expenseTotal, cur)} against ${fmtCurrency(txn.incomeTotal, cur)} in income${txn.refundTotal > 0 ? ` (${fmtCurrency(txn.refundTotal, cur)} came back as refunds)` : ""}.${caveat}`,
        tone:     "info",
      };
    }
  }

  // ── Fallback — v2.6-BRIEF-1: the authority's priority, not a second ladder ─
  //
  // This was four inline balance-sheet rules that competed with
  // `computeAssessment` and lost. `debtRatio > 0.5` announced "debt makes up
  // more than half your total assets" on a mortgage the authority classified
  // HEALTHY (its APR is fine and liabilities are declining) — a ratio is a
  // shape, not a verdict. `cashRatio > 0.4` told a user with two months of
  // expenses in cash that too much was "sitting in cash" while the liquidity
  // authority classified their coverage WARNING and wanted MORE.
  //
  // `currentStatePriority` is the engine's own answer to the question an insight
  // asks — what matters most right now — computed from confidence-gated sections
  // in a fixed order. The Brief reads it and narrates the matching section. It
  // decides nothing.
  if (totalAssets === 0 && totalDebt === 0) return null;

  const { debt, liquidity, cashFlow, currentStatePriority } = assessment;

  let body: string | null = (() => {
    switch (currentStatePriority) {
      case "DATA_QUALITY":
        // The honest answer when the window cannot support a verdict. It replaces
        // a net-worth platitude that was shown in precisely this state.
        return "There isn't enough recent activity to read your cash flow with confidence yet. " +
               "Connecting or refreshing your accounts will sharpen the picture.";

      // REVIEW-3 C-7 — there is deliberately NO `case "DEBT"` arm. Under the
      // Brief's own scope the per-account list is withheld (scopeHint 'brief'),
      // debt is forced INSUFFICIENT_DATA, and currentStatePriority can never be
      // DEBT — the arm that lived here was statically unreachable (audit E3).
      // The withheld grade is consumed HONESTLY below via assessment.ungraded
      // instead. Whether Brief scope should ever carry per-account debt detail
      // is an open product decision recorded in the REVIEW-3 report.

      case "LIQUIDITY":
        if (liquidity.classification === "CRITICAL" || liquidity.classification === "WARNING") {
          return `Your cash covers about ${liquidity.coverageMonths?.toFixed(1) ?? "under one"} months of expenses. ` +
                 "Building that buffer is the highest-value move available right now.";
        }
        if (liquidity.classification === "EXCELLENT") {
          return `You have ${fmtCurrency(liquidity.liquidCashTotal, cur)} in cash — comfortably more than ` +
                 "your expenses require. Consider whether some of it could be working harder.";
        }
        // SAFE or UNKNOWN — nothing worth escalating, and nothing worth inventing.
        return debt.classification === "NO_DEBT" && netWorth > 0
          ? "You're carrying no debt and your cash position is sound. Keep the allocations aligned with your goals."
          : null;

      case "CASH_FLOW":
        if (cashFlow.deficitCause === "POSSIBLE_OVERSPENDING") {
          // REVIEW-3 C-3 — this claim now rests on the CANONICAL economic net
          // (negative), so it can never contradict the Cash Flow workspace.
          return "You spent more than you took in over this window, and it isn't explained by debt payoff. " +
                 "Worth a look at where it went.";
        }
        if (cashFlow.deficitCause === "INTENTIONAL_DEBT_PAYOFF" || cashFlow.deficitCause === "MIXED") {
          return "You ran a deficit this window, but it's driven by debt payments against an active payoff goal — " +
                 "that's the plan working, not a problem.";
        }
        if (cashFlow.deficitCause === "DEBT_DRIVEN") {
          // Debt payments fully explain the cash deficit and the canonical net
          // is non-negative — never framed as overspending.
          return "Your cash went down this window, but the gap is debt payments, not overspending. " +
                 "If that paydown is deliberate, consider recording it as a goal so it reads as strategy.";
        }
        return null;

      default:
        // GOALS / GOALS_GOOD — the goals domain owns those, and the Brief has no
        // goals section. Silence beats a manufactured sentence.
        return null;
    }
  })();

  // REVIEW-3 C-7 — consume the DECLARED insufficiency: when real liabilities
  // exist but their grade was withheld by this surface's own scope, say so
  // rather than letting silence imply health. ("Say so or say nothing
  // knowingly" — this is the say-so arm; every other withheld grade stays
  // knowingly silent because no figure of its section is on screen.)
  if (body === null && totalDebt > 0) {
    const debtWithheld = assessment.ungraded.find(
      (u) => u.section === "debt" && u.reason === "ACCOUNT_LIST_WITHHELD_BY_SCOPE",
    );
    if (debtWithheld) {
      body = `You're carrying ${fmtCurrency(totalDebt, cur)} of debt. The Brief's summary view doesn't ` +
             "carry the per-account detail needed to grade it — open your Space's Debt view for the full picture.";
    }
  }

  if (body === null) return null;

  return {
    id:       "insight",
    type:     "insight",
    priority: 20,
    title:    "Today's Insight",
    body,
    // DEBT is unreachable at this surface (see above); LIQUIDITY is the only
    // priority whose insight warrants the warning tone here.
    tone:     currentStatePriority === "LIQUIDITY" ? "warning" : "info",
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  // ── User metadata (non-financial) ──────────────────────────────────────────
  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: { lastBriefViewedAt: true, firstName: true, name: true },
  });
  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const lastViewedAt = dbUser.lastBriefViewedAt;
  const displayName  = dbUser.firstName ?? dbUser.name ?? null;

  // ── Eligible Space memberships ─────────────────────────────────────────────
  // OWNER, ADMIN, MEMBER roles only — VIEWER Spaces are excluded from the brief.

  const memberships = await db.spaceMember.findMany({
    where: {
      userId: user.id,
      status: "ACTIVE",
      role:   { in: [SpaceMemberRole.OWNER, SpaceMemberRole.ADMIN, SpaceMemberRole.MEMBER] },
      space:  { archivedAt: null, deletedAt: null },
    },
    select: {
      spaceId: true,
      role:    true,
      space:   { select: { type: true } },
    },
  });

  if (memberships.length === 0) {
    return NextResponse.json({ error: "No space" }, { status: 404 });
  }

  // Primary Space: personal Space preferred; first eligible as fallback.
  // role check is defense in depth — PERSONAL Spaces are enforced single-owner
  // at every mutation entry point, so no ADMIN/MEMBER row on one should exist;
  // this just means that invariant holding is what makes "personal" here mean
  // MY personal Space, not merely a personal-type Space I happen to be in.
  const primaryMembership =
    memberships.find((m) => m.space.type === "PERSONAL" && m.role === SpaceMemberRole.OWNER) ?? memberships[0];

  // ── Build context for every eligible Space in parallel ─────────────────────
  // scopeHint='brief' keeps each context lean (no per-account list, no raw
  // transaction history, no full snapshot series).

  const contextResults = await Promise.allSettled(
    memberships.map((m) =>
      buildContext(m.spaceId, user.id, { scopeHint: "brief" }),
    ),
  );

  const successfulContexts: SpaceContext_AI[] = contextResults
    .filter((r): r is PromiseFulfilledResult<SpaceContext_AI> => r.status === "fulfilled")
    .map((r) => r.value);

  // Log failures so they are visible without crashing the brief.
  // A missing AiAgent is an expected, self-correcting data-integrity gap
  // (auto-created on Space creation; backfilled by scripts/backfill-ai-agents.ts).
  // It degrades gracefully here, so aggregate it into a single warn rather than
  // one error per Space per load. Any other rejection is unexpected — surface it.
  const missingAgentSpaceIds: string[] = [];
  contextResults.forEach((r, i) => {
    if (r.status !== "rejected") return;
    const spaceId = memberships[i]?.spaceId;
    const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
    if (message.includes("No AiAgent found")) {
      if (spaceId) missingAgentSpaceIds.push(spaceId);
    } else {
      console.error(`[brief] buildContext failed for Space ${spaceId}:`, r.reason);
    }
  });
  if (missingAgentSpaceIds.length > 0) {
    console.warn(
      `[brief] Skipped ${missingAgentSpaceIds.length} Space(s) with no AiAgent ` +
      `(run scripts/backfill-ai-agents.ts to backfill): ${missingAgentSpaceIds.join(", ")}`,
    );
  }

  // ── Primary context ────────────────────────────────────────────────────────
  const primaryCtx =
    successfulContexts.find((c) => c.spaceId === primaryMembership.spaceId) ??
    successfulContexts[0] ??
    null;

  const hasData = primaryCtx !== null && accounts(primaryCtx) !== null;

  // ── Aggregated signals (all eligible Spaces, sorted by severity) ───────────
  // Signals from each context are already sorted by the registry.
  // Merge and re-sort across all Spaces.
  const SEVERITY_ORDER: Record<ContextSignal["severity"], number> = {
    critical: 0, warning: 1, info: 2,
  };
  const allSignals: ContextSignal[] = successfulContexts
    .flatMap((c) => c.signals)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.detectedAt.localeCompare(b.detectedAt),
    );

  // ── Cross-Space distinct account count ─────────────────────────────────────
  // "Accounts tracked" counts distinct real FinancialAccounts visible to the
  // user, not SpaceAccountLink placements. Each Space's accounts domain reports
  // the FinancialAccount ids it can see (accountIds); deduplicating across
  // Spaces via a Set means an account shared into multiple Spaces counts once.
  const totalAccountCount = new Set(
    successfulContexts.flatMap((c) => accounts(c)?.accountIds ?? []),
  ).size;

  // ── Cross-Space distinct account roster ("Accounts Tracked" tab) ───────────
  // Flatten each Space's privacy-safe roster and deduplicate by
  // FinancialAccount.id so an account shared into multiple Spaces appears once.
  // When the same account is visible at different levels across Spaces, keep the
  // highest-visibility copy (FULL > BALANCE_ONLY > SUMMARY_ONLY). The resulting
  // length equals totalAccountCount by construction (same ids, deduped).
  const VISIBILITY_RANK: Record<TrackedAccount["visibility"], number> = {
    FULL: 3, BALANCE_ONLY: 2, SUMMARY_ONLY: 1,
  };
  const trackedById = new Map<string, TrackedAccount>();
  for (const c of successfulContexts) {
    for (const a of accounts(c)?.trackedAccounts ?? []) {
      const existing = trackedById.get(a.id);
      if (!existing || VISIBILITY_RANK[a.visibility] > VISIBILITY_RANK[existing.visibility]) {
        trackedById.set(a.id, a);
      }
    }
  }
  const trackedAccounts: TrackedAccount[] = [...trackedById.values()];

  // ── Pending Space invites (non-financial query) ────────────────────────────
  const pendingInviteCount = await db.spaceInvite.count({
    where: { invitedUserId: user.id, status: "PENDING" },
  });

  // ── Cached AI advice (primary Space) ──────────────────────────────────────
  const advice = hasData && primaryCtx
    ? await db.aiAdvice.findFirst({
        where:   { spaceId: primaryCtx.spaceId },
        orderBy: { generatedAt: "desc" },
        select:  { summary: true, adviceText: true },
      })
    : null;

  // ── Visit state ───────────────────────────────────────────────────────────
  const state   = visitState(lastViewedAt, hasData);
  const context = contextLine(state, displayName);

  // ── Build sections ─────────────────────────────────────────────────────────
  const sections: BriefSection[] = [];

  if (!hasData || !primaryCtx) {
    sections.push(buildOnboarding());
  } else {
    // REVIEW-3 C-6 — the primary Space's reporting currency, threaded through
    // every money string the Brief renders. USD output is byte-identical.
    const cur = primaryCtx.space.reportingCurrency ?? DEFAULT_DISPLAY_CURRENCY;

    const sinceSection = buildSinceLastVisit(
      primaryCtx,
      totalAccountCount,
      lastViewedAt,
      pendingInviteCount,
      trackedAccounts,
      cur,
    );
    if (sinceSection) sections.push(sinceSection);

    // v2.6-BRIEF-1 — computed ONCE, from the primary Space's context, and passed
    // to both section builders. Two calls would be two assessments of the same
    // context, which is the duplication this slice exists to remove, in miniature.
    const assessment = computeAssessment(primaryCtx);

    const attentionSection = buildAttention(allSignals, primaryCtx, assessment, cur);
    if (attentionSection) sections.push(attentionSection);

    const insightSection = buildInsight(allSignals, primaryCtx, advice, assessment, cur);
    if (insightSection) sections.push(insightSection);
  }

  sections.sort((a, b) => a.priority - b.priority);

  const payload: BriefPayload = {
    visitState:  state,
    contextLine: context,
    hasData,
    sections,
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(payload);
}
