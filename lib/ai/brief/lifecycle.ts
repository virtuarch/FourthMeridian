/**
 * lib/ai/brief/lifecycle.ts
 *
 * ensureDailyBrief({ spaceId, ownerUserId }) — today's Brief, generated at most once.
 *
 *   read today's row + newest earlier Brief   ─┐ in parallel
 *   compute the source watermark               ─┘
 *   today's Brief, same watermark        → FRESH (CACHED)              nothing assembled, no model
 *   today's Brief, watermark moved       → assemble package, digest it
 *       digest unchanged                 → FRESH (WATERMARK_REFRESHED)  no model
 *       digest changed                   → claim ─┐
 *   no successful Brief today            → claim ─┤
 *       lost                             → IN_PROGRESS + the best fallback
 *       won                              → (assemble) → generate once → persist → GENERATED
 *       generation failed                → release claim, keep old content → FAILED + fallback
 *
 * ⚠️ NO HTTP, NO POLLING, NO WAITING. A loser returns immediately with what can be
 * shown; waiting for another caller's generation is the future route's job.
 *
 * ⚠️ CURRENT DAY ONLY. The watermark is the sources' present state and the Brief
 * day is today's UTC day; there is no `asOf`. Retrospective Briefs stay with the
 * unpersisted one-shot `generateDailyBrief` (Slice 1), so no future clock can leak
 * into a persisted artifact.
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
import { BRIEF_SYSTEM_PROMPT } from './prompt';
import { decideArtifactState, type BriefFallback, type BriefRow } from './state';
import type { BriefScope, BriefStore } from './store';
import type { BriefPackage, DailyBrief } from './types';

/** Changes whenever the instruction or the output schema does. */
export const BRIEF_PROMPT_VERSION = `brief-prompt-${createHash('sha256')
  .update(BRIEF_SYSTEM_PROMPT).update(canonicalJson(BRIEF_SCHEMA)).digest('hex').slice(0, 12)}`;

export interface LifecycleDeps {
  store: BriefStore;
  resolveSpace(ownerUserId: string, spaceId: string): Promise<SpaceContext>;
  watermark(scope: BriefScope, now: Date): Promise<string>;
  loadPackage(spaceCtx: SpaceContext, now: Date): Promise<LoadedBriefPackage>;
  generate(pkg: BriefPackage, now: Date): Promise<BriefGenerationResult>;
}

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
    generate: (pkg, now) => generateBriefFromPackage(pkg, { model: CHAT_MODEL, now, surface: 'brief' }),
  };
}

export interface LifecycleTimings { [step: string]: number }

export type EnsureResult =
  | { status: 'FRESH'; path: 'CACHED' | 'WATERMARK_REFRESHED'; brief: DailyBrief; row: BriefRow; timings: LifecycleTimings }
  | { status: 'GENERATED'; brief: DailyBrief; persisted: boolean; correlationId: string; timings: LifecycleTimings }
  | { status: 'IN_PROGRESS'; fallback: BriefFallback | null; timings: LifecycleTimings }
  | { status: 'FAILED'; reason: string; fallback: BriefFallback | null; timings: LifecycleTimings };

/** A stored Brief, exactly as it was persisted — never rewritten to look current. */
export const briefFromRow = (row: BriefRow): DailyBrief => row.content as DailyBrief;

export async function ensureDailyBrief(
  args: { spaceId: string; ownerUserId: string },
  options: { now?: Date; deps?: Partial<LifecycleDeps> } = {},
): Promise<EnsureResult> {
  const t0 = Date.now();
  const timings: LifecycleTimings = {};
  const lap = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const s = Date.now();
    try { return await fn(); } finally { timings[name] = Date.now() - s; }
  };
  const done = <R extends EnsureResult>(r: R): R => { timings.total = Date.now() - t0; return r; };

  const now = options.now ?? new Date();
  const today = todayUTCISO(now);
  const needed: (keyof LifecycleDeps)[] = ['store', 'resolveSpace', 'watermark', 'loadPackage', 'generate'];
  const deps = { ...(needed.every((k) => options.deps?.[k]) ? {} : await defaultDeps()), ...options.deps } as LifecycleDeps;

  const spaceCtx = await lap('resolveSpace', () => deps.resolveSpace(args.ownerUserId, args.spaceId));
  if (spaceCtx.spaceId !== args.spaceId) throw new BriefScopeError(args.spaceId);
  const scope: BriefScope = { spaceId: args.spaceId, ownerUserId: spaceCtx.userId };
  const key = { ...scope, briefDay: today };

  const [stored, watermark] = await Promise.all([
    lap('read', () => deps.store.read(scope, today)),
    lap('watermark', () => deps.watermark(scope, now)),
  ]);
  const { state } = decideArtifactState({ today, now, todayRow: stored.todayRow, latestPrior: stored.latestPrior, watermark });

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

  const claim = await lap('claim', () => deps.store.claim(key, now));
  if (!claim.won) return done({ status: 'IN_PROGRESS', fallback, timings });

  try {
    if (!loaded) {
      loaded = await lap('package', () => deps.loadPackage(spaceCtx, now));
      digest = materialDigest(loaded.package);
    }
    const pkg = loaded.package;
    const result = await lap('generate', () => deps.generate(pkg, now));
    if (!result.ok) {
      await lap('release', () => deps.store.fail(key, claim.token, result.reason, new Date()));
      return done({ status: 'FAILED', reason: result.reason, fallback, timings });
    }
    const anchor = pkg.freshness?.oldestBalanceObservedAt;
    const persisted = await lap('persist', () => deps.store.complete(key, claim.token, {
      content: result.brief,
      generatedAt: new Date(result.brief.generatedAt),
      balancesAsOf: anchor ? new Date(anchor) : null,
      historyThrough: loaded?.historyThrough ?? null,
      sourceWatermark: watermark,
      materialDigest: digest as string,
      model: result.meta.model,
      promptVersion: BRIEF_PROMPT_VERSION,
      correlationId: result.meta.correlationId,
    }));
    return done({ status: 'GENERATED', brief: result.brief, persisted, correlationId: result.meta.correlationId, timings });
  } catch (err) {
    // An assembly or persistence error must not strand the claim for a full lease.
    await deps.store.fail(key, claim.token, 'INTERNAL_ERROR', new Date()).catch(() => false);
    console.error('[brief] lifecycle failed after claiming:', err);
    return done({ status: 'FAILED', reason: 'INTERNAL_ERROR', fallback, timings });
  }
}
