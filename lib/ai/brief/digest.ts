/**
 * lib/ai/brief/digest.ts
 *
 * THE MATERIAL DIGEST — "does this Brief deserve reconsideration?"
 *
 * ⚠️ NOT A HASH OF THE PACKAGE. The package carries timestamps, ages, window
 * dates and cent-level figures that move without anything worth saying having
 * happened; hashing it would regenerate a Brief every time a sync touched a row.
 * This hashes a MATERIAL PROJECTION: money in buckets, verdicts as codes, the
 * signatures of material recent movements, and the exact sets a Brief would
 * mention (plans, knowledge gaps, ungraded sections). Nothing here is prose, a
 * clock, or an identifier of a generation.
 *
 * ⚠️ STATELESS BY CONSTRUCTION. Buckets encode the materiality policy
 * (policy.ts) without needing the previous package: equal digests mean every
 * material quantity sits in the same bucket as before. The honest cost is the
 * bucket edge — a balance oscillating across one flips the digest. Hysteresis
 * would need the prior projection stored; not worth it until it is measured.
 *
 * ⚠️ VERSIONED. A policy change changes DIGEST_VERSION, so no old digest can
 * compare equal to a projection built under different rules.
 */

import { createHash } from 'node:crypto';
import { MATERIALITY } from './policy';
import type { BriefActivityRow, BriefChangeWindow, BriefDelta, BriefPackage } from './types';

export const DIGEST_VERSION = 'brief-material-v3';

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A balance, as a materiality bucket. $1,000 steps below $50,000, 2% steps above;
 * zero and "not established" are their own buckets.
 */
export function moneyBucket(v: number | null | undefined): string {
  if (!finite(v)) return 'NA';
  const a = Math.abs(v);
  if (a < 0.005) return '0';
  const sign = v < 0 ? '-' : '+';
  const { ABSOLUTE_STEP, RELATIVE_STEP } = MATERIALITY;
  const knee = ABSOLUTE_STEP / RELATIVE_STEP;
  if (a < knee) return `${sign}L${Math.floor(a / ABSOLUTE_STEP)}`;
  return `${sign}G${Math.floor(Math.log(a / knee) / Math.log(1 + RELATIVE_STEP))}`;
}

/** A movement, as a bucket: anything under the absolute step is no movement. */
export function changeBucket(d: BriefDelta | undefined): string {
  if (!d || !finite(d.abs)) return 'NA';
  return Math.abs(d.abs) < MATERIALITY.ABSOLUTE_STEP ? '0' : moneyBucket(d.abs);
}

/** Is this recent movement one a Brief could reasonably mention? */
export function isMaterialActivity(row: BriefActivityRow, monthlyExpenses: number | null | undefined): boolean {
  const size = Math.abs(row.amount);
  const { LARGE_TRANSACTION_FLOOR, LARGE_TRANSACTION_SHARE, SIGNAL_FLOWS } = MATERIALITY;
  const large = Math.max(LARGE_TRANSACTION_FLOOR, LARGE_TRANSACTION_SHARE * (finite(monthlyExpenses) ? monthlyExpenses : 0));
  return size >= large || (SIGNAL_FLOWS.includes(row.flow) && size >= LARGE_TRANSACTION_FLOOR);
}

const sorted = (xs: string[]) => [...xs].sort();

function windowProjection(w: BriefChangeWindow | undefined) {
  if (!w) return null;
  return {
    netWorth: changeBucket(w.netWorth), liquid: changeBucket(w.liquid), debt: changeBucket(w.debt),
    investments: changeBucket(w.investments), digitalAssets: changeBucket(w.digitalAssets),
  };
}

/** The material projection of a package. Exported so tests can pin its shape. */
export function materialProjection(pkg: BriefPackage) {
  const cs = pkg.currentState;
  const b = pkg.behavior;
  const q = pkg.dataQuality;
  const f = pkg.freshness;
  const activity = pkg.recentActivity;
  return {
    v: DIGEST_VERSION,
    basis: pkg.identity.basis,
    currency: pkg.identity.currency,
    state: {
      netWorth: moneyBucket(cs.netWorth), liquid: moneyBucket(cs.liquid), debt: moneyBucket(cs.debt),
      traditional: moneyBucket(cs.investments?.traditional), digital: moneyBucket(cs.investments?.digital),
      investmentsWithheld: cs.investments?.withheld === true,
      hiddenAccounts: cs.hiddenAccounts ?? 0,
      concentration: cs.concentration ? {
        classification: cs.concentration.classification, topSymbol: cs.concentration.topSymbol,
        populationIsComplete: cs.concentration.populationIsComplete,
      } : null,
    },
    changes: {
      d1: windowProjection(pkg.recentChanges.d1),
      w1: windowProjection(pkg.recentChanges.w1),
      m1: windowProjection(pkg.recentChanges.m1),
    },
    activity: activity ? {
      complete: activity.complete,
      material: sorted(activity.top
        .filter((r) => isMaterialActivity(r, b?.monthlyExpenses))
        .map((r) => `${r.date}|${r.flow}|${Math.round(r.amount)}`)),
    } : null,
    behavior: b ? {
      income: moneyBucket(b.monthlyIncome), expenses: moneyBucket(b.monthlyExpenses),
      debtPayments: moneyBucket(b.monthlyDebtPayments),
      reliability: b.cashFlowReliability, incomeConfidence: b.incomeConfidence, deficitCause: b.deficitCause,
      liquidity: b.liquidity?.classification ?? null,
      debt: b.debt?.classification ?? null, aprCompleteness: b.debt?.aprCompleteness ?? null,
    } : null,
    plans: {
      goals: sorted((pkg.plans?.goals ?? []).map((g) => `${g.metric}|${g.targetAmount}|${g.byDate}`)),
      planned: sorted((pkg.plans?.planned ?? []).map((p) => `${p.label}|${p.amount}`)),
      nextCheckpoint: pkg.plans?.nextCheckpoint?.horizon ?? null,
    },
    quality: {
      band: f?.band ?? null,
      needsReauth: f?.needsReauth ?? false,
      staleAccounts: f?.staleAccounts ?? 0,
      unknownFreshnessAccounts: f?.unknownFreshnessAccounts ?? 0,
      // A source changing state (reconnected, fell behind, recovered) changes what
      // the Brief must qualify; its date alone does not (the band carries age).
      sources: sorted((f?.staleSources ?? []).map((s) => `${s.label}|${s.state}`)),
      transactionHistory: q.transactionHistory,
      knowledgeGaps: sorted(q.knowledgeGaps.map((g) => `${g.account}|${g.missing}`)),
      ungraded: sorted(q.ungraded.map((u) => `${u.section}|${u.reason}`)),
      unidentifiedIncomeBand: finite(q.unidentifiedIncomeSharePct) ? Math.floor(q.unidentifiedIncomeSharePct / 10) : null,
      unvaluedPositions: q.unvaluedPositions,
      totalsEstimated: q.totalsEstimated,
      totalsUnconverted: q.totalsUnconverted,
    },
  };
}

/** JSON with object keys sorted at every depth, so field order cannot move a hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function materialDigest(pkg: BriefPackage): string {
  return `${DIGEST_VERSION}:${createHash('sha256').update(canonicalJson(materialProjection(pkg))).digest('hex').slice(0, 40)}`;
}
