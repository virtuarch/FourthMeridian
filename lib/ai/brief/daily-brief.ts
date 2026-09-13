/**
 * lib/ai/brief/daily-brief.ts
 *
 * generateDailyBrief({ spaceId, ownerUserId, asOf }) — the one server entry.
 *
 * ⚠️ NO ROUTE CALLS THIS YET. Persistence, freshness state and the page are later
 * slices; this proves the intelligence and nothing else.
 *
 * ⚠️ THE SPACE IS NAMED, AND A MISMATCH IS REFUSED. `resolveSpaceContext` falls
 * back to the user's PERSONAL Space BY DESIGN when the named Space is not theirs
 * — the right behaviour for a page and the wrong one here, where a Brief quietly
 * written about a different Space would be a Brief about the wrong money. The
 * production chat route refuses the same mismatch with a 403.
 *
 * ⚠️ THE MODEL IS THE CHAT'S. The Brief runs on the configuration every
 * conversation gate measured; changing it is a measurement, not a setting.
 */

import 'server-only';
import { resolveSpaceContext } from '@/lib/space';
import { CHAT_MODEL } from '@/lib/ai/conversation/engine';
import { loadBriefPackage, type BriefLoadDeps, type LoadedBriefPackage } from './load';
import { generateBriefFromPackage, type BriefGenerationResult, type GenerateBriefOptions } from './generate';
import { BriefScopeError } from './errors';

export const BRIEF_MODEL = CHAT_MODEL;

export { BriefScopeError };

export interface DailyBriefRun {
  evidence: LoadedBriefPackage;
  result: BriefGenerationResult;
}

export async function generateDailyBrief(
  args: { spaceId: string; ownerUserId: string; asOf?: string },
  options: {
    now?: Date;
    timeoutMs?: number;
    surface?: string;
    loadDeps?: Partial<BriefLoadDeps>;
    generateDeps?: GenerateBriefOptions['deps'];
  } = {},
): Promise<DailyBriefRun> {
  const spaceCtx = await resolveSpaceContext(args.ownerUserId, args.spaceId);
  if (spaceCtx.spaceId !== args.spaceId) throw new BriefScopeError(args.spaceId);

  const now = options.now ?? new Date();
  const evidence = await loadBriefPackage({ spaceCtx, asOf: args.asOf, now, deps: options.loadDeps });
  const result = await generateBriefFromPackage(evidence.package, {
    model: BRIEF_MODEL, now,
    surface: options.surface ?? 'brief',
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    deps: options.generateDeps,
  });
  return { evidence, result };
}
