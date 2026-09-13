/**
 * lib/ai/brief/load.ts
 *
 * THE READS BEHIND ONE DAILY BRIEF PACKAGE — for one resolved Space and its owner.
 *
 * ⚠️ AUTHORITIES CALLED DIRECTLY, NOT THROUGH THE CONTEXT BUILDER. `buildContext`
 * requires an AiAgent row and writes an AuditLog row per call; the chat runtime's
 * `assembleFullContext` already established that assembling the domains directly
 * is the sanctioned way to read them without either. The same assemblers run here,
 * with the same options the chat tools pass, and nothing is re-decided.
 *
 * ⚠️ THE CEILING IS APPLIED TO EVERY READ THAT HAS A DATE. The snapshot series is
 * cut at `asOf` before it is projected, so no change window can see a later day;
 * the transaction window ends at `asOf`; recent activity ends at `asOf`; memory is
 * judged in force as of `asOf`. The accounts and holdings assemblers have no
 * ceiling — they are today — so a retrospective package does not use their
 * balances (package.ts).
 *
 * ⚠️ A FAILED READ DEGRADES THE PACKAGE, IT DOES NOT FAIL THE BRIEF. Each domain
 * is attempted independently, as `assembleFullContext` does; what failed is
 * returned in `degraded` so a caller can see what the Brief was written without.
 * Memory in particular is a nicety: the AI page treats its failure as "no
 * starters", and so does this.
 */

import { FinanceDomains } from '@/lib/ai/types';
import type {
  AccountsSectionData, AssemblerOptions, ContextDomainSection, HoldingsSummaryData,
  SnapshotSectionData, SpaceContext_AI, TransactionsSummaryData,
} from '@/lib/ai/types';
import type { FinancialAssessment } from '@/lib/ai/intelligence';
import type { MemoryScope, RecalledMemory } from '@/lib/ai/conversation/memory-store';
import type { SpaceContext } from '@/lib/space';
import type { Snapshot } from '@/types';
import { todayUTCISO } from '@/lib/time/clock';
import { projectBriefPackage } from './package';
import { loadRecentActivity } from './recent-activity';
import type { BriefPackage, BriefRecentActivity } from './types';

/** The bound `lib/history/exploration` and the chat history tools use. */
const SNAPSHOT_READ_ROWS = 1100;
/** W4's assessment window, which the default transactions read already uses. */
const RETROSPECTIVE_WINDOW_DAYS = 90;

export interface BriefLoadDeps {
  assemble(domain: string, spaceCtx: SpaceContext, options: AssemblerOptions): Promise<ContextDomainSection | null>;
  readSnapshots(spaceId: string): Promise<Snapshot[]>;
  projectSnapshots(rows: Snapshot[]): SnapshotSectionData | null;
  recall(scope: MemoryScope): Promise<RecalledMemory[]>;
  recentActivity(spaceId: string, asOf: string): Promise<BriefRecentActivity>;
  assess(ctx: SpaceContext_AI): FinancialAssessment;
}

async function defaultDeps(): Promise<BriefLoadDeps> {
  await import('@/lib/ai/assemblers'); // registers every assembler
  const { getAssembler } = await import('@/lib/ai/assembler-registry');
  const { getRecentSnapshots } = await import('@/lib/data/snapshots');
  const { projectSnapshotSection } = await import('@/lib/ai/assemblers/snapshot');
  const { recallMemories } = await import('@/lib/ai/conversation/memory-store');
  const { computeAssessment } = await import('@/lib/ai/intelligence');
  return {
    assemble: async (domain, spaceCtx, options) => {
      const assembler = getAssembler(domain);
      return assembler ? (await assembler(spaceCtx, options as never)) ?? null : null;
    },
    readSnapshots: (spaceId) => getRecentSnapshots({ rows: SNAPSHOT_READ_ROWS }, { spaceId }),
    projectSnapshots: (rows) => projectSnapshotSection(rows, 'full'),
    recall: (scope) => recallMemories(scope, { limit: 50 }),
    recentActivity: (spaceId, asOf) => loadRecentActivity(spaceId, asOf),
    assess: computeAssessment,
  };
}

export interface LoadedBriefPackage {
  package: BriefPackage;
  /** The reads that failed, by name. Empty on a complete package. */
  degraded: string[];
  /** Milliseconds per read, for the report. */
  timings: Record<string, number>;
}

const shiftDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function loadBriefPackage(args: {
  spaceCtx: SpaceContext;
  asOf?: string;
  now?: Date;
  deps?: Partial<BriefLoadDeps>;
}): Promise<LoadedBriefPackage> {
  const now = args.now ?? new Date();
  const today = todayUTCISO(now);
  // A ceiling in the future is today: nothing after today exists to be read.
  const asOf = args.asOf && args.asOf < today ? args.asOf : today;
  const retrospective = asOf < today;
  const { spaceCtx } = args;
  const { spaceId } = spaceCtx;

  const needsDefaults = !args.deps || ['assemble', 'readSnapshots', 'projectSnapshots', 'recall',
    'recentActivity', 'assess'].some((k) => !(k in (args.deps as object)));
  const deps: BriefLoadDeps = { ...(needsDefaults ? await defaultDeps() : {}), ...args.deps } as BriefLoadDeps;

  const degraded: string[] = [];
  const timings: Record<string, number> = {};
  const attempt = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } catch (err) {
      degraded.push(name);
      console.error(`[brief] ${name} failed:`, err);
      return fallback;
    } finally {
      timings[name] = Date.now() - t0;
    }
  };

  const transactionOptions: AssemblerOptions = retrospective
    ? { scopeHint: 'brief', transactionWindow: {
        startDate: shiftDays(asOf, -RETROSPECTIVE_WINDOW_DAYS), endDate: asOf,
        label: `daily brief as of ${asOf}` } }
    : { scopeHint: 'brief' };

  const [accounts, transactions, holdings, rows, memories, recentActivity] = await Promise.all([
    attempt('accounts', () => deps.assemble(FinanceDomains.ACCOUNTS, spaceCtx,
      { scopeHint: 'full', positionClass: 'ALL' }), null),
    attempt('transactions', () => deps.assemble(FinanceDomains.TRANSACTIONS_SUMMARY, spaceCtx,
      transactionOptions), null),
    retrospective ? Promise.resolve(null)
      : attempt('holdings', () => deps.assemble(FinanceDomains.HOLDINGS_SUMMARY, spaceCtx,
          { scopeHint: 'full', positionClass: 'ALL' }), null),
    attempt('snapshots', () => deps.readSnapshots(spaceId), [] as Snapshot[]),
    // ⚠️ THE OWNER IS THE RESOLVED CONTEXT'S USER — never a parameter a caller
    // could point at another member. `recallMemories` takes both halves of the
    // scope as one argument, so no other member's rows can be returned.
    attempt('memory', () => deps.recall({ spaceId, ownerUserId: spaceCtx.userId }), [] as RecalledMemory[]),
    attempt('recentActivity', () => deps.recentActivity(spaceId, asOf), null),
  ]);

  const t0 = Date.now();
  const snapshot = rows.length > 0
    ? deps.projectSnapshots(rows.filter((r) => r.date.slice(0, 10) <= asOf))
    : null;
  timings.projectSnapshots = Date.now() - t0;

  const domains: Record<string, ContextDomainSection> = {};
  if (accounts) domains[FinanceDomains.ACCOUNTS] = accounts;
  if (transactions) domains[FinanceDomains.TRANSACTIONS_SUMMARY] = transactions;
  if (holdings) domains[FinanceDomains.HOLDINGS_SUMMARY] = holdings;
  if (snapshot) domains[FinanceDomains.SNAPSHOT_HISTORY] = {
    domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: now.toISOString(), data: snapshot };

  const ctx: SpaceContext_AI = {
    requestedAt: now.toISOString(),
    spaceId, userId: spaceCtx.userId, role: spaceCtx.role,
    agentId: 'daily-brief', resolvedDomains: Object.keys(domains),
    space: {
      id: spaceCtx.space.id, name: spaceCtx.space.name, type: spaceCtx.space.type,
      category: spaceCtx.space.category, reportingCurrency: spaceCtx.space.reportingCurrency,
    },
    domains, signals: [], auditLogId: 'daily-brief',
  };

  let assessment: FinancialAssessment | null = null;
  if (accounts || transactions) {
    const ta = Date.now();
    try { assessment = deps.assess(ctx); }
    catch (err) { degraded.push('assessment'); console.error('[brief] assessment failed:', err); }
    timings.assessment = Date.now() - ta;
  }

  const pkg = projectBriefPackage({
    asOf, today, now,
    currency: spaceCtx.space.reportingCurrency ?? 'USD',
    accounts:     (accounts?.data as AccountsSectionData | undefined) ?? null,
    transactions: (transactions?.data as TransactionsSummaryData | undefined) ?? null,
    snapshot,
    holdings:     (holdings?.data as HoldingsSummaryData | undefined) ?? null,
    assessment,
    memories,
    recentActivity,
  });

  return { package: pkg, degraded, timings };
}
