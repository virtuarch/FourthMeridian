/**
 * lib/ai/prompts/context-serializer.ts
 *
 * Serializes a single assembled SpaceContext_AI into the === SPACE CONTEXT ===
 * system-prompt text block: currency presentation, transaction analysis window,
 * attribution disclosure, per-liability debt payments, spending aggregates,
 * monthly breakdown, merchants, income sources, drilldown, domains JSON,
 * signals, and knowledge gaps.
 *
 * Pure function: context in, text out. No DB reads, no LLM call, no financial
 * computation of its own — every figure is read from the pre-assembled context
 * and the deterministic intelligence helpers. Extracted verbatim from
 * app/api/ai/chat/route.ts (AI-ARCH). Wording is pinned by the KD-17/KD-18/MC1
 * serializer tripwire tests.
 */

import { displaySpaceName } from '@/lib/format';
import type {
  SpaceContext_AI,
  TransactionsSummaryData,
  AccountsSectionData,
  KnowledgeGap,
} from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';
import { computeAverageMonthlySpending, reliableMonths } from '@/lib/ai/intelligence';
import { checkSpendingCategoryInvariant } from '@/lib/ai/assemblers/transactions';
import { NON_SPENDING_CATEGORY_NAMES } from '@/lib/ai/spending-categories';
import { ATTRIBUTION_DISCLOSURE, GAP_IMPACT } from './doctrine';
import { fmtMoney, fmtMonthYear, approxMonths, getTransactionsSummary } from './format';

/** One debt account's received payments within the serialized window. */
export type DebtPaymentLine = { name: string; total: number; count: number };

/**
 * TI2-W2 — the one-line needs-classification disclosure for the transaction
 * summary block, following the refundTotal one-liner pattern. Exported so its
 * exact wording is pinned by test (KD-17/KD-18 wording-pinned precedent). Returns
 * null when nothing needs classification. DISCLOSURE ONLY — the amounts are
 * already included in the totals above; only their source/purpose is unresolved.
 */
export function needsClassificationSummaryLine(
  nc: TransactionsSummaryData['needsClassification'] | undefined | null,
): string | null {
  if (!nc || nc.count <= 0) return null;
  const bits: string[] = [];
  if (nc.unknownInflowCount > 0) {
    bits.push(`${fmtMoney(nc.unknownInflowTotal)} of income has no identified source`);
  }
  if (nc.unknownPaymentAppCount > 0) {
    bits.push(`${fmtMoney(nc.unknownPaymentAppTotal)} moved via payment apps, purpose unknown`);
  }
  const detail = bits.length ? ` (${bits.join('; ')})` : '';
  return (
    `  NEEDS CLASSIFICATION: ${nc.count} transaction${nc.count > 1 ? 's' : ''} need classification${detail}. ` +
    'These amounts are already included in the totals above — do not subtract them; only their ' +
    'source/purpose is unresolved, so do not present any income figure that depends on them as fully verified.'
  );
}

/**
 * Extract knowledge gaps from the assembled accounts domain, if present.
 * Returns an empty array when the accounts domain is absent or has no gaps.
 * Type-narrows via a minimal structural check to avoid importing AccountsSectionData.
 */
export function extractKnowledgeGaps(ctx: SpaceContext_AI): KnowledgeGap[] {
  const section = ctx.domains['accounts'];
  if (!section?.data) return [];
  const data = section.data as { knowledgeGaps?: KnowledgeGap[] };
  return Array.isArray(data.knowledgeGaps) ? data.knowledgeGaps : [];
}

/**
 * Serialize a single SpaceContext_AI into a compact text block.
 * Domain data is rendered as compact JSON; signals as a structured list;
 * knowledge gaps as a human-readable list with impact annotations.
 * The prompt explicitly constrains the model to this data only.
 */
export function serializeContextBlock(ctx: SpaceContext_AI, debtPayments?: DebtPaymentLine[]): string {
  const lines: string[] = [];

  lines.push(`Space: ${displaySpaceName(ctx.space.name)}`);
  lines.push(`Your role: ${ctx.role}`);

  // ── MC1 Phase 4 Slice 7 (plan D-9) — currency presentation ─────────────────
  // ONE label line, always (totals have converted at read time since MC1
  // Phase 3), and ONE estimation disclosure emitted only when any section's
  // estimated flag is true. Deliberately never per-number and never repeated —
  // same single-insertion doctrine as the KD-18 attribution disclosure.
  const reportingCur = ctx.space.reportingCurrency ?? 'USD';
  lines.push(
    `All totals are in ${reportingCur} (this Space's reporting currency); ` +
    `per-account values are shown in their native currency.`
  );
  const accountsData = ctx.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined;
  const accountsEstimated = accountsData?.totalsEstimated === true;
  const txnEstimated = getTransactionsSummary(ctx)?.estimated === true;
  const holdingsEstimated =
    (ctx.domains[FinanceDomains.HOLDINGS_SUMMARY]?.data as { totalsEstimated?: boolean } | undefined)
      ?.totalsEstimated === true;
  // V25-FINAL-1 — an UNAVAILABLE conversion is stronger than "approximate": the
  // affected balances could not be converted at all, so they are EXCLUDED from
  // the totals (never relabeled at their native magnitude). Disclose that
  // honestly so the model treats the totals as incomplete, not merely fuzzy.
  const accountsUnconverted = accountsData?.totalsUnconverted === true;
  if (accountsEstimated || txnEstimated || holdingsEstimated) {
    lines.push(
      'Some converted totals are approximate (missing or dated exchange rates); ' +
      'treat affected figures as estimates.'
    );
  }
  if (accountsUnconverted) {
    lines.push(
      `Some balances could not be converted to ${reportingCur} (no exchange rate) and are ` +
      'EXCLUDED from the account totals above — those totals are therefore incomplete. The ' +
      'affected accounts appear with their native balance and currency; do not treat their ' +
      'reporting value as 0.'
    );
  }
  // V25-SIDE-1 — liability sign convention. Debt rows carry `balance` in the
  // PROVIDER convention, where a negative value means the ISSUER OWES THE USER.
  // Stated only when such an account is actually present, and always alongside
  // the derived `amountOwed` / `creditBalance` / `liabilityState` fields the
  // assembler emits, so the model reads meaning rather than inferring a sign.
  const hasCreditBalanceAccount = (accountsData?.accounts ?? []).some(
    (a) => a.type === 'debt' && a.liabilityState === 'credit',
  );
  if (hasCreditBalanceAccount) {
    lines.push(
      'One or more credit/loan accounts carry a CREDIT BALANCE: the issuer owes the user ' +
      '(overpayment, refund, or statement credit). For every debt account use the derived ' +
      '`amountOwed`, `creditBalance`, and `liabilityState` fields — NEVER the raw signed ' +
      '`balance`. A credit balance is ZERO debt: never describe it as negative debt, never ' +
      'count it toward total debt, never recommend paying it off, and never attribute ' +
      'interest to it. Total debt figures already exclude it.',
    );
  }
  lines.push('');

  // ── Analysis window (D6 provenance) ─────────────────────────────────────────
  // Every aggregate derived from transactions is bounded by this window.
  // Surfaced explicitly so the model states the period, month count, and
  // transaction denominator instead of an unqualified "monthly average", and
  // never answers a longer-period question ("this year", "YTD") using it
  // without saying only this window is available.
  const txn = getTransactionsSummary(ctx);
  if (txn) {
    lines.push(
      'Transaction analysis window (use this exact period whenever presenting any ' +
      'average, total, or cash-flow figure derived from spending, income, or category data):',
    );
    lines.push(`  Period: ${fmtMonthYear(txn.startDate)} – ${fmtMonthYear(txn.endDate)}`);
    lines.push(`  Months analyzed: ~${approxMonths(txn.windowDays)} (${txn.windowDays}-day window)`);
    lines.push(`  Transactions in window: ${txn.transactionCount}`);
    lines.push(
      '  This is the ONLY period for which transaction data exists in this Space. ' +
      'Do not describe it as "this year", "YTD", or any longer span unless the dates match. ' +
      'If the user asks about a longer period, state plainly that only this window is available.',
    );

    // ── Attribution limit (KD-18) ────────────────────────────────────────────
    // Every flow figure below (window totals AND per-month debt payments,
    // transfers, income, spending) is an aggregate with the account/card/source/
    // destination dimension stripped. Disclose once, up front, that these totals
    // are not attributed — so a per-account question is answered with totals plus
    // an explicit "attribution unavailable", never a fabricated per-account split.
    lines.push(`  ${ATTRIBUTION_DISCLOSURE}`);

    // ── Per-liability debt payments (Slice 6 — the ONE attributed dimension) ─
    // Deterministic destination-side rollup (Slice 3), same window as above.
    // Absent (no lines) when the Space has no debt-payment legs in the window —
    // the disclosure above then covers the dimension unqualified.
    if (debtPayments && debtPayments.length > 0) {
      lines.push(
        '  PER-LIABILITY DEBT PAYMENTS (deterministic — settled debt-payment legs ' +
        'recorded on each debt account itself, same window as above): ' +
        debtPayments
          .map((d) => `${d.name}: ${fmtMoney(d.total)} across ${d.count} payment(s)`)
          .join('; ') + '.',
      );
      lines.push(
        '  Use these exact figures for any per-card debt-payment question. They are ' +
        'destination-side records and may differ from the aggregate debtPaymentTotal ' +
        '(source-side) by timing or external payments — do not force them to reconcile ' +
        'exactly. Every OTHER per-account dimension (per-card spending, per-card ' +
        'interest, per-account transfers/income) remains unattributed — the attribution ' +
        'limit above still applies to those.',
      );
    }

    // ── Fetch-cap coverage caveat (KD-7) ─────────────────────────────────────
    // When the summary was truncated, the totals/rollups/monthly figures below
    // cover only [coverageStartDate, endDate]. Tell the model the data is
    // incomplete before that date so it never presents truncated historical
    // figures as exact or compares the clipped earliest month like a full one.
    if (txn.truncated) {
      lines.push(
        `  COVERAGE LIMIT (data cap): this Space has more transactions in the requested window ` +
        `than the ${txn.fetchLimit}-row fetch cap allows, so only the most recent ${txn.fetchLimit} ` +
        `were analyzed. Every total, category, merchant, income, and monthly figure below covers ONLY ` +
        `${txn.coverageStartDate} – ${txn.endDate}; data before ${txn.coverageStartDate} is NOT included. ` +
        'Do NOT present these figures as exact or as covering the full requested window, and treat the ' +
        'earliest included month as incomplete. If the user asks about the full period, say plainly ' +
        'that the older portion exceeds the current data limit.',
      );
    }

    // ── Needs classification (TE-2B disclosure; TI2-W2) ──────────────────────
    // One honesty line: how much of the window is semantically ambiguous. The
    // amounts stay INCLUDED in the totals above (disclosure, never subtracted) —
    // the model must not present income that depends on them as fully verified.
    const ncLine = needsClassificationSummaryLine(txn.needsClassification);
    if (ncLine) lines.push(ncLine);

    // ── Spending aggregates: single source of truth (D6.3 Part B) ────────────
    // Average monthly spending, month-by-month spending, and category averages
    // ALL derive from the same deterministic monthlyBreakdown rows. Averages are
    // taken over COMPLETE calendar months only (partial/clipped/in-progress
    // months are excluded) so a January-through-June average never gets diluted
    // by a partial July. The prior window-normalized estimate (total ÷ windowDays
    // × 30) is gone — it could diverge from the monthly rows and let the model
    // treat the two as separate data sources.
    // Categories that are NOT discretionary spending. Excluded from every
    // "spending" figure (monthly category lines AND category averages) so that
    // per-month category totals always reconcile to that month's expenseTotal
    // and can never exceed it. Slice 6: flow-derived (see the module-level
    // definition) — identical membership for legacy categories; Dividend now
    // excluded, Fee still included.
    const NON_SPENDING = NON_SPENDING_CATEGORY_NAMES;

    // KD-7: exclude fetch-cap truncated months from averages, same as partial.
    // KD-10: reliableMonths is the shared predicate the assessment also uses.
    const completeMonths = reliableMonths(txn);
    const completeCount   = completeMonths.length;

    if (completeCount > 0) {
      const firstM = completeMonths[0].month;
      const lastM  = completeMonths[completeCount - 1].month;
      const monthsLabel = firstM === lastM
        ? fmtMonthYear(`${firstM}-01`)
        : `${fmtMonthYear(`${firstM}-01`)} – ${fmtMonthYear(`${lastM}-01`)}`;

      // KD-10: single authoritative value shared with the assessment block.
      // Non-null here because completeCount > 0.
      const avgSpend   = computeAverageMonthlySpending(txn) ?? 0;

      lines.push(
        `  AVERAGE MONTHLY SPENDING (deterministic — total spending across the ${completeCount} ` +
        `complete month(s) ${monthsLabel}, divided by ${completeCount}): ${fmtMoney(avgSpend)}/month. ` +
        'Use this exact figure for "average monthly spending". Do NOT recompute it from a window ' +
        'total, and do NOT include partial months unless the user explicitly asks for a month-to-date figure.',
      );

      // Per-category spending averages over the SAME complete months, summed from
      // each month's byCategory (the same rows the monthly section prints), so
      // category averages reconcile with both the overall average and the monthly
      // rows. Non-spending categories are excluded so nothing is mislabeled as
      // spending. These are AVERAGES — never a substitute for a single month's value.
      const catTotals = new Map<string, number>();
      for (const m of completeMonths) {
        for (const c of m.byCategory) {
          if (NON_SPENDING.has(c.category)) continue;
          catTotals.set(c.category, (catTotals.get(c.category) ?? 0) + c.total);
        }
      }

      const catAverages = Array.from(catTotals.entries())
        .map(([category, total]) => ({
          category,
          total,
          avg: Math.round((total / completeCount) * 100) / 100,
        }))
        .sort((a, b) => b.avg - a.avg)
        .slice(0, 8);

      if (catAverages.length > 0) {
        lines.push(
          `  AVERAGE MONTHLY CATEGORY SPENDING (each category's total across the ${completeCount} ` +
          'complete month(s) ÷ month count — these are AVERAGES, valid ONLY when the user asks for ' +
          'a typical/average month; NEVER use them as any single month\'s value):',
        );
        for (const c of catAverages) {
          lines.push(
            `    ${c.category}: ${fmtMoney(c.avg)}/month ` +
            `(${fmtMoney(Math.round(c.total * 100) / 100)} across ${completeCount} mo)`,
          );
        }
      }
    } else if (txn.byCategory.length > 0) {
      // No complete calendar month in the window: present exact window totals and
      // decline to assert a monthly average rather than fabricate one from a
      // partial window.
      lines.push(
        '  Category totals for this window (exact debit-only sums; the window contains no complete ' +
        'calendar month, so no monthly average is asserted — do not divide these by a month count):',
      );
      // KD-17: totals are debit-only; zero-total entries (pure-credit or
      // count-only categories such as Income, whose inflow is reported via the
      // income figures above) are not printed as spending. Credits disclosed.
      for (const cat of txn.byCategory.filter((c) => c.total > 0).slice(0, 8)) {
        lines.push(
          `    ${cat.category}: ${fmtMoney(cat.total)} total (${cat.count} txn(s))` +
          (cat.creditTotal
            ? ` (excludes ${fmtMoney(cat.creditTotal)} in credits/refunds — NOT spending)`
            : ''),
        );
      }

      // KD-17 checked invariant (window scope): same rule as the monthly lines.
      const windowViolation = checkSpendingCategoryInvariant(
        txn.byCategory.filter((c) => !NON_SPENDING.has(c.category)),
        txn.expenseTotal, NON_SPENDING, 'window',
      );
      if (windowViolation) {
        const msg =
          `KD-17 invariant violated for window: spending categories sum to ` +
          `${windowViolation.spendingCategorySum} > expenseTotal ${windowViolation.expenseTotal} ` +
          `(excess ${windowViolation.excess}).`;
        if (process.env.NODE_ENV !== 'production') throw new Error(msg);
        console.error(msg);
        lines.push('    [DATA INCONSISTENCY — category figures under review; do not present as exact]');
      }
    }

    // ── Monthly breakdown (D6 deterministic rollups) ─────────────────────────
    // Authoritative per-calendar-month figures. The model must read these for
    // any month-by-month question instead of inferring buckets from window
    // totals or averages (which previously produced inconsistent, invented
    // monthly numbers). Only months inside the requested window appear here.
    if (txn.monthlyBreakdown.length > 0) {
      lines.push('');
      lines.push(
        'MONTHLY SPENDING BY MONTH (deterministic per-calendar-month rollup — these are the ONLY ' +
        'valid month-by-month figures; each line is summed directly from that month\'s transactions). ' +
        'For every month the listed categories are that month\'s OWN spending and always sum to ≤ ' +
        'that month\'s "spending" total:',
      );
      for (const m of txn.monthlyBreakdown) {
        // KD-7: a truncated boundary month had older rows dropped by the fetch
        // cap — mark it incomplete so it is never compared as a full month.
        const flag = m.truncated
          ? ' [INCOMPLETE month — older transactions exceed the data cap; figure understated]'
          : m.partial
            ? ' [PARTIAL month — window does not fully cover it]'
            : '';
        // Per-month category line: SPENDING categories only (income, interest,
        // transfers, debt payments excluded). Category totals are debit-only
        // (KD-17) — the same population as expenseTotal — so the categories
        // reconcile to, and never exceed, this month's expenseTotal. Credits
        // in a spending category (refunds, misclassified payment credits) are
        // disclosed inline, never netted or summed as spending.
        const spendingCats = (m.byCategory ?? []).filter((c) => !NON_SPENDING.has(c.category));
        const catsStr = spendingCats.length > 0
          ? spendingCats
              .map((c) =>
                `${c.category} ${fmtMoney(c.total)}` +
                (c.creditTotal
                  ? ` (excludes ${fmtMoney(c.creditTotal)} in credits/refunds — NOT spending)`
                  : ''),
              )
              .join(', ')
          : '(no categorized spending this month)';

        // KD-17 checked invariant: Σ spending-category totals ≤ expenseTotal.
        // Previously asserted as prose only, which let a sign-asymmetry defect
        // serialize mathematically impossible figures as authoritative. Fail
        // loud in dev/test; in prod log and annotate the line so the model
        // never presents inconsistent figures as exact.
        const violation = checkSpendingCategoryInvariant(
          spendingCats, m.expenseTotal, NON_SPENDING, m.month,
        );
        let invariantFlag = '';
        if (violation) {
          const msg =
            `KD-17 invariant violated for ${violation.scope}: spending categories sum to ` +
            `${violation.spendingCategorySum} > expenseTotal ${violation.expenseTotal} ` +
            `(excess ${violation.excess}). Category totals and expenseTotal aggregate ` +
            'different populations — see docs/investigations/KD17_TRANSACTION_LEVEL_PROOF.md.';
          if (process.env.NODE_ENV !== 'production') throw new Error(msg);
          console.error(msg);
          invariantFlag = ' [DATA INCONSISTENCY — category figures under review; do not present as exact]';
        }

        lines.push(
          `  - ${m.month}${flag}${invariantFlag}: spending ${fmtMoney(m.expenseTotal)}; categories: ${catsStr}`,
        );
        // Non-spending flows for the same month, bracketed separately so they can
        // never be misread as spending categories.
        lines.push(
          `      [other flows this month — NOT spending: income ${fmtMoney(m.incomeTotal)}, ` +
          `debt payments ${fmtMoney(m.debtPaymentTotal)}, transfers ${fmtMoney(m.transferTotal)}` +
          // Slice 6: surface the Slice 4 refundTotal when present — refunds are
          // reversals of spending, never income, and are not netted anywhere.
          (m.refundTotal > 0 ? `, refunds received ${fmtMoney(m.refundTotal)} (reversals of spending — NOT income, already excluded from the spending figure)` : '') +
          `; ${m.transactionCount} txn(s)]`,
        );
      }
      lines.push(
        '  Rules for month-by-month questions: use these exact per-month values. For a month-by-month ' +
        'table, each category value MUST come only from that same month\'s "categories:" line. NEVER ' +
        'use an AVERAGE MONTHLY CATEGORY SPENDING value, a window total, or another month\'s value as a ' +
        'monthly value. Do NOT divide a window total by a month count, and do NOT report a month not ' +
        'listed above — it has no data in the requested window. Describe any month flagged PARTIAL as incomplete.',
      );
      lines.push(
        '  Category rule (month-by-month category tables): the "categories:" line for each month is the ' +
        'COMPLETE deterministic list of that month\'s classified spending, and its entries sum to ≤ that ' +
        'month\'s "spending" total. Use ONLY these values. If a category is not listed for a month, it had ' +
        'no matching classified spending that month — leave the cell blank, write "—", or omit the column. ' +
        'NEVER render an unlisted category as $0, and NEVER infer or fill a category figure from an average, ' +
        'another month, or a window total. A single category can never exceed that month\'s spending total.',
      );
    }

    // ── Merchant summary (D6.3A-1 + D6.3 — top SPENDING merchants only) ──────
    // Canonicalized per-merchant SPENDING totals over the same window. Settled
    // expense rows only — income/payroll, transfers, and debt payments are
    // excluded upstream, so this answers "who did I spend the most with" without
    // ever surfacing payroll or a Chase/Amex payment as a merchant.
    if (txn.merchants && txn.merchants.length > 0) {
      lines.push('');
      lines.push(
        'MERCHANT SUMMARY — TOP SPENDING MERCHANTS (settled expenses only in the window above; ' +
        'grouped by canonical merchant name; totals are exact absolute settled spend). ' +
        'Income/payroll, internal transfers, and debt payments are already EXCLUDED here:',
      );
      for (const mrc of txn.merchants.slice(0, 8)) {
        lines.push(
          `  ${mrc.canonicalName}: ${fmtMoney(mrc.total)} across ${mrc.occurrences} txn(s), ` +
          `mostly ${mrc.category}, ${mrc.firstSeen} → ${mrc.lastSeen}`,
        );
      }
      lines.push(
        '  Use these exact totals for "who did I spend the most with / top merchants" questions. ' +
        'These are SPENDING merchants only — never describe an income source, transfer, or debt ' +
        'payment as a spending merchant, and never pull a payroll/employer name into this list.',
      );
    }

    // ── Income sources (D6.3 — inflow rollup, kept separate from merchants) ──
    // Payroll and other inflows live here, NOT in the merchant summary above.
    if (txn.incomeSources && txn.incomeSources.length > 0) {
      lines.push('');
      lines.push(
        'INCOME SOURCES (settled inflows only — Income + Interest — in the window above; grouped ' +
        'by canonical name; totals are exact settled sums). This is a SEPARATE list from spending merchants:',
      );
      for (const src of txn.incomeSources.slice(0, 8)) {
        lines.push(
          `  ${src.canonicalName}: ${fmtMoney(src.total)} across ${src.occurrences} txn(s), ` +
          `${src.firstSeen} → ${src.lastSeen}`,
        );
      }
      lines.push(
        '  Use these for "top income sources / where does my money come from" questions. ' +
        'Do NOT describe these as spending merchants and do NOT include them in spending totals or averages.',
      );
    }

    // ── Transaction drilldown (D6 — evidence for a follow-up; only when present) ─
    // The actual line items behind a resolved category/merchant/period. Attached
    // only for explicit drilldown follow-ups, so it appears here rarely and never
    // on ordinary prompts. Rows are FULL-visibility only.
    if (txn.drilldown && txn.drilldown.transactions.length > 0) {
      const d = txn.drilldown;
      const scope = d.label
        ? d.label
        : d.category ?? d.merchant ?? 'largest transactions';
      lines.push('');
      lines.push(
        `TRANSACTION DRILLDOWN — evidence for "${scope}" (${d.startDate} → ${d.endDate}; actual ` +
        'transactions, FULL-visibility accounts only, sorted by amount, largest first):',
      );
      for (const t of d.transactions) {
        const desc = t.description ? ` — ${t.description}` : '';
        const acct = t.accountName ? ` · ${t.accountName}` : '';
        lines.push(
          `  ${t.date}  ${t.merchant}  ${fmtMoney(t.amount)}  (${t.category})${desc}${acct}`,
        );
      }
      const coverage = d.truncated
        ? `Showing the ${d.shownCount} largest of ${d.totalCount} matching transactions ` +
          `(${d.totalCount - d.shownCount} more not shown).`
        : `Showing all ${d.shownCount} matching transaction(s).`;
      lines.push(
        `  ${coverage} Shown total: ${fmtMoney(d.shownTotal)}. ` +
        `Total for "${scope}" this period: ${fmtMoney(d.matchedTotal)}.`,
      );
      lines.push(
        '  Use these exact rows to explain what the category/merchant is made up of. They are the ' +
        'evidence behind the aggregate — do NOT invent transactions beyond this list, and if rows ' +
        'were omitted by the cap, say so rather than implying the list is exhaustive.',
      );
    }

    lines.push('');
  }

  // ── Domains ───────────────────────────────────────────────────────────────
  const domainKeys = Object.keys(ctx.domains);
  if (domainKeys.length > 0) {
    lines.push('Financial context:');
    for (const key of domainKeys) {
      const section = ctx.domains[key];
      if (section?.data) {
        lines.push(`  [${key}]`);
        lines.push(`  ${JSON.stringify(section.data)}`);
      }
    }
  } else {
    lines.push('Financial context: none assembled for this Space.');
  }

  lines.push('');

  // ── Signals ───────────────────────────────────────────────────────────────
  if (ctx.signals.length > 0) {
    lines.push('Active signals:');
    for (const sig of ctx.signals) {
      const detail = sig.body ? ` — ${sig.body}` : '';
      lines.push(`  [${sig.severity.toUpperCase()}] ${sig.title}${detail}`);
    }
  } else {
    lines.push('Active signals: none.');
  }

  // ── Knowledge gaps ────────────────────────────────────────────────────────
  // Surfaced as a human-readable list so the AI can reference them by account
  // name and field label without parsing the raw accounts JSON blob.
  // Only populated for FULL-visibility debt accounts (enforced by the assembler).
  const gaps = extractKnowledgeGaps(ctx);
  if (gaps.length > 0) {
    lines.push('');
    lines.push('Knowledge gaps (missing verified metadata — do not invent these values):');
    for (const gap of gaps) {
      const impact = GAP_IMPACT[gap.field] ?? 'affects related calculations';
      lines.push(`  [${gap.accountName}] ${gap.label} not set — ${impact}`);
    }
  }

  return lines.join('\n');
}
