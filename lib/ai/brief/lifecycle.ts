/**
 * lib/ai/brief/lifecycle.ts
 *
 * THE DAILY BRIEF ARTIFACT LIFECYCLE — inspect it cheaply, or ensure it exists.
 *
 * inspectDailyBrief — what GET needs, and never more:
 *   read today's row + newest earlier Brief, compute the source watermark,
 *   classify. No claim, no package, no model call.
 *
 * ensureDailyBrief — what POST runs:
 *   no linked accounts                   → NO_DATA                      nothing generated for an empty Space
 *   today's Brief, same watermark        → FRESH (CACHED)              nothing assembled, no model
 *   today's Brief, watermark moved       → assemble package, digest it
 *       digest unchanged                 → FRESH (WATERMARK_REFRESHED)  no model
 *       digest changed                   → (cooldown?) → claim ─┐
 *   no successful Brief today            → (cooldown?) → claim ─┤
 *       failed within the cooldown       → COOLING_DOWN + fallback      no model
 *       lost                             → IN_PROGRESS + the best fallback
 *       won                              → (assemble) → generate once → persist → GENERATED
 *       generation failed                → release claim, keep old content → FAILED + fallback
 *
 * ⚠️ NO HTTP, NO POLLING, NO WAITING. A loser returns immediately with what can be
 * shown; the client polls.
 *
 * ⚠️ CURRENT DAY ONLY. The watermark is the sources' present state and the Brief
 * day is today's UTC day; there is no `asOf`. Retrospective Briefs stay with the
 * unpersisted one-shot `generateDailyBrief` (Slice 1).
 *
 * ⚠️ THE WATERMARK STORED IS THE ONE READ BEFORE ASSEMBLY. If a source moves while
 * the package is being built, the stored watermark is already behind it and the
 * next visit checks again — never the reverse.
 *
 * ⚠️ NO PROVIDER REFRESH. This observes Fourth Meridian's current truth; the
 * package already carries freshness and data-quality state when that truth is old.
 */

import { createHash } from 'node:crypto';
import { todayUTCISO } from '@/lib/time/clock';
import type { SpaceContext } from '@/lib/space';
import { BRIEF_SCHEMA } from './contract';
import { canonicalJson, materialDigest } from './digest';
import { BriefScopeError } from './errors';
import type { BriefGenerationResult } from './generate';
import type { LoadedBriefPackage } from './load';
import { GENERATION_FAILURE_COOLDOWN_MS } from './policy';
import { BRIEF_SYSTEM_PROMPT } from './prompt';
import { applyRelevance, readStandingFacts, standingFactsOf } from './relevance';
import { decideArtifactState, type ArtifactDecision, type BriefFallback, type BriefRow } from './state';
import type { BriefScope, BriefStore } from './store';
import type { BriefPackage, DailyBrief } from './types';

export type GenerationReason = 'daily' | 'change';

/** Changes whenever the instruction or the output schema does. */
export const BRIEF_PROMPT_VERSION = `brief-prompt-${createHash('sha256')
  .update(BRIEF_SYSTEM_PROMPT).update(canonicalJson(BRIEF_SCHEMA)).digest('hex').slice(0, 12)}`;

export interface LifecycleDeps {
  store: BriefStore;
  resolveSpace(ownerUserId: string, spaceId: string): Promise<SpaceContext>;
  watermark(scope: BriefScope, now: Date): Promise<string>;
  loadPackage(spaceCtx: SpaceContext, now: Date): Promise<LoadedBriefPackage>;
  /**
   * `reason` is what the lifecycle genuinely knows about why it is generating:
   * `daily` — no successful Brief for today yet; `change` — today's Brief exists
   * and the evidence digest moved. (It cannot know WHY the evidence moved — a
   * reconnect, a sync or a new transaction all look the same here — and says so.)
   */
  generate(pkg: BriefPackage, now: Date, reason?: GenerationReason): Promise<BriefGenerationResult>;
  /**
   * Whether the Space holds any active account link. A Space with nothing in it
   * has nothing to brief, so no model call is spent on it. Optional only so pure
   * tests may omit it; production always supplies it (defaultDeps).
   */
  hasFinancialData?(scope: BriefScope): Promise<boolean>;
}

const CORE_DEPS: (keyof LifecycleDeps)[] = ['store', 'resolveSpace', 'watermark', 'loadPackage', 'generate'];

async function defaultDeps(): Promise<LifecycleDeps> {
  const { db } = await import('@/lib/db');
  const { resolveSpaceContext } = await import('@/lib/space');
  const { CHAT_MODEL } = await import('@/lib/ai/conversation/engine');
  const { prismaBriefStore } = await import('./store');
  const { sourceWatermark } = await import('./watermark');
  const { loadBriefPackage } = await import('./load');
  const { generateBriefFromPackage } = await import('./generate');
  return {
    store: prismaBriefStore(db),
    resolveSpace: resolveSpaceContext,
    watermark: async (scope, now) => (await sourceWatermark(db, scope, now)).watermark,
    loadPackage: (spaceCtx, now) => loadBriefPackage({ spaceCtx, now }),
    generate: (pkg, now, reason) => generateBriefFromPackage(pkg, { model: CHAT_MODEL, now, surface: 'brief', reason }),
    hasFinancialData: async (scope) =>
      (await db.spaceAccountLink.count({ where: { spaceId: scope.spaceId, status: 'ACTIVE' } })) > 0,
  };
}

async function resolveDeps(partial?: Partial<LifecycleDeps>): Promise<LifecycleDeps> {
  const complete = CORE_DEPS.every((k) => partial?.[k]);
  return { ...(complete ? {} : await defaultDeps()), ...partial } as LifecycleDeps;
}

export interface LifecycleTimings { [step: string]: number }

export type EnsureResult =
  | { status: 'FRESH'; path: 'CACHED' | 'WATERMARK_REFRESHED'; brief: DailyBrief; row: BriefRow; timings: LifecycleTimings }
  | { status: 'GENERATED'; brief: DailyBrief; persisted: boolean; correlationId: string;
      balancesAsOf: Date | null; historyThrough: string | null; timings: LifecycleTimings }
  | { status: 'IN_PROGRESS'; fallback: BriefFallback | null; timings: LifecycleTimings }
  | { status: 'COOLING_DOWN'; retryAfterMs: number; fallback: BriefFallback | null; timings: LifecycleTimings }
  | { status: 'FAILED'; reason: string; retryAfterMs: number; fallback: BriefFallback | null; timings: LifecycleTimings }
  | { status: 'NO_DATA'; timings: LifecycleTimings };

/** A stored Brief, exactly as it was persisted — never rewritten to look current. */
export const briefFromRow = (row: BriefRow): DailyBrief => row.content as DailyBrief;

/** Milliseconds until a generation may be attempted again after a failure; 0 when it may now. */
export function cooldownRemainingMs(lastFailure: { at: Date } | null, now: Date): number {
  if (!lastFailure) return 0;
  const remaining = GENERATION_FAILURE_COOLDOWN_MS - (now.getTime() - lastFailure.at.getTime());
  return remaining > 0 ? remaining : 0;
}

interface Prepared {
  deps: LifecycleDeps;
  spaceCtx: SpaceContext;
  scope: BriefScope;
  today: string;
  watermark: string;
  hasData: boolean;
  decision: ArtifactDecision;
  /** The newest successful Brief from an EARLIER day — the relevance baseline. */
  latestPrior: BriefRow | null;
}

async function prepare(
  args: { spaceId: string; ownerUserId: string },
  now: Date,
  partial: Partial<LifecycleDeps> | undefined,
  lap: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
): Promise<Prepared> {
  const deps = await resolveDeps(partial);
  const today = todayUTCISO(now);
  const spaceCtx = await lap('resolveSpace', () => deps.resolveSpace(args.ownerUserId, args.spaceId));
  if (spaceCtx.spaceId !== args.spaceId) throw new BriefScopeError(args.spaceId);
  const scope: BriefScope = { spaceId: args.spaceId, ownerUserId: spaceCtx.userId };

  const [stored, watermark, hasData] = await Promise.all([
    lap('read', () => deps.store.read(scope, today)),
    lap('watermark', () => deps.watermark(scope, now)),
    deps.hasFinancialData ? lap('hasData', () => deps.hasFinancialData!(scope)) : Promise.resolve(true),
  ]);
  const decision = decideArtifactState({ today, now, todayRow: stored.todayRow, latestPrior: stored.latestPrior, watermark });
  return { deps, spaceCtx, scope, today, watermark, hasData, decision, latestPrior: stored.latestPrior };
}

function timer() {
  const t0 = Date.now();
  const timings: LifecycleTimings = {};
  const lap = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const s = Date.now();
    try { return await fn(); } finally { timings[name] = Date.now() - s; }
  };
  const total = () => { timings.total = Date.now() - t0; };
  return { t0, timings, lap, total };
}

export interface BriefInspection {
  today: string;
  hasData: boolean;
  decision: ArtifactDecision;
  /** Milliseconds until a failed generation may be retried; 0 when it may now. */
  retryAfterMs: number;
  timings: LifecycleTimings;
}

/**
 * The artifact's state, cheaply. The read and the watermark only — this function
 * holds no claim, assembles no package and calls no model, by construction.
 */
export async function inspectDailyBrief(
  args: { spaceId: string; ownerUserId: string },
  options: { now?: Date; deps?: Partial<LifecycleDeps> } = {},
): Promise<BriefInspection> {
  const now = options.now ?? new Date();
  const { timings, lap, total } = timer();
  const p = await prepare(args, now, options.deps, lap);
  total();
  return {
    today: p.today, hasData: p.hasData, decision: p.decision,
    retryAfterMs: cooldownRemainingMs(p.decision.lastFailure, now), timings,
  };
}

export async function ensureDailyBrief(
  args: { spaceId: string; ownerUserId: string },
  options: { now?: Date; deps?: Partial<LifecycleDeps> } = {},
): Promise<EnsureResult> {
  const now = options.now ?? new Date();
  const { t0, timings, lap, total } = timer();
  const done = <R extends EnsureResult>(r: R): R => { total(); return r; };
  // A failure is stamped on the request's clock plus the time it actually took,
  // so an injected clock and the cooldown it is measured against always agree.
  const failedAt = () => new Date(now.getTime() + (Date.now() - t0));

  const { deps, spaceCtx, scope, today, watermark, hasData, decision, latestPrior } = await prepare(args, now, options.deps, lap);
  const { state } = decision;
  const key = { ...scope, briefDay: today };

  if (!hasData) return done({ status: 'NO_DATA', timings });

  if (state.kind === 'FRESH') {
    return done({ status: 'FRESH', path: 'CACHED', brief: briefFromRow(state.row), row: state.row, timings });
  }

  let loaded: LoadedBriefPackage | null = null;
  let digest: string | null = null;
  if (state.kind === 'CHECK_MATERIAL') {
    loaded = await lap('package', () => deps.loadPackage(spaceCtx, now));
    digest = materialDigest(loaded.package);
    if (digest === state.row.materialDigest) {
      await lap('refreshWatermark', () => deps.store.refreshWatermark(key, digest as string, watermark));
      return done({ status: 'FRESH', path: 'WATERMARK_REFRESHED', brief: briefFromRow(state.row),
        row: { ...state.row, sourceWatermark: watermark }, timings });
    }
  }
  const fallback = state.fallback;

  // ⚠️ THE COOLDOWN GUARDS THE MODEL CALL, AND ONLY THE MODEL CALL. The digest
  // check above still runs during it — it spends nothing and can prove the old
  // Brief is still current.
  const retryAfterMs = cooldownRemainingMs(decision.lastFailure, now);
  if (retryAfterMs > 0) return done({ status: 'COOLING_DOWN', retryAfterMs, fallback, timings });

  const claim = await lap('claim', () => deps.store.claim(key, now));
  if (!claim.won) return done({ status: 'IN_PROGRESS', fallback, timings });

  try {
    if (!loaded) {
      loaded = await lap('package', () => deps.loadPackage(spaceCtx, now));
      digest = materialDigest(loaded.package);
    }
    const pkg = loaded.package;
    // The model sees today's facts minus standing facts that are neither new,
    // changed nor needed to explain today's movement — judged against the previous
    // DAY's Brief. The digest above was computed on the full package.
    const { pkg: modelPkg } = applyRelevance(pkg, latestPrior
      ? { facts: readStandingFacts(latestPrior.content), briefDay: latestPrior.briefDay } : null);
    const reason: GenerationReason = state.kind === 'CHECK_MATERIAL' ? 'change' : 'daily';
    const result = await lap('generate', () => deps.generate(modelPkg, now, reason));
    if (!result.ok) {
      await lap('release', () => deps.store.fail(key, claim.token, result.reason, failedAt()));
      return done({ status: 'FAILED', reason: result.reason, retryAfterMs: GENERATION_FAILURE_COOLDOWN_MS, fallback, timings });
    }
    const anchor = pkg.freshness?.oldestBalanceObservedAt;
    const balancesAsOf = anchor ? new Date(anchor) : null;
    const historyThrough = loaded?.historyThrough ?? null;
    const persisted = await lap('persist', () => deps.store.complete(key, claim.token, {
      // The narration, plus the standing facts the NEXT day's relevance compares
      // against. Stored inside the artifact; the view model never copies them out.
      content: { ...result.brief, standingFacts: standingFactsOf(pkg) },
      generatedAt: new Date(result.brief.generatedAt),
      balancesAsOf,
      historyThrough,
      sourceWatermark: watermark,
      materialDigest: digest as string,
      model: result.meta.model,
      promptVersion: BRIEF_PROMPT_VERSION,
      correlationId: result.meta.correlationId,
    }));
    return done({ status: 'GENERATED', brief: result.brief, persisted, correlationId: result.meta.correlationId,
      balancesAsOf, historyThrough, timings });
  } catch (err) {
    // An assembly or persistence error must not strand the claim for a full lease.
    await deps.store.fail(key, claim.token, 'INTERNAL_ERROR', failedAt()).catch(() => false);
    console.error('[brief] lifecycle failed after claiming:', err);
    return done({ status: 'FAILED', reason: 'INTERNAL_ERROR', retryAfterMs: GENERATION_FAILURE_COOLDOWN_MS, fallback, timings });
  }
}
