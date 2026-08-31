/**
 * lib/ai/chat/master-surfaces.ts
 *
 * PARITY-2 — MASTER MODE RESOLVES THE SAME SURFACES AS A NAMED SPACE.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * `AnalyzeClient` opens on `spaceId: "master"`, so master is the entry most
 * turns use — and it had been assembling a DIFFERENT, thinner context than the
 * named-Space path for as long as both existed. PARITY-1 wired in the two
 * capabilities it had watched fail; the next real conversation found two more.
 * The pattern is the defect: master reproduced a fraction of the named-Space
 * pipeline, so every capability that pipeline gained had to be remembered twice.
 *
 * So the ORDER is reproduced here in full, and it is the order that matters:
 *
 *   envelope (CF-5)  →  plan (CF-8)  →  context (CF-6 needs the envelope to
 *   license a domain)  →  forecast surfaces (FORECAST-10/16, gated on the plan)
 *
 * Master previously called `buildContext` with neither an envelope nor a plan.
 * That single omission is why `holdings_summary` was never assembled on ANY
 * master turn — CF-6 could not license a domain whose evidence it had not been
 * shown — and why the model answered "I do not have access to your portfolio
 * holdings" perfectly truthfully about a context that does hold them.
 *
 * ⚠️ WHAT IS STILL REFUSED, DELIBERATELY. A cash forecast is not a per-Space
 * statement that composes: it runs off account balances, and an account shared
 * into two Spaces appears in both, so summing them would be a new aggregation
 * authority over knowingly overlapping inputs. PARITY-1 declined to build one
 * and that decision stands. What changes is that the refusal is now EXPLICIT
 * (see `renderForecastScopeRefusal`) instead of a silent hole — and when there
 * is exactly ONE eligible Space there is nothing to aggregate, so the ordinary
 * deterministic forecast runs and master answers exactly as that Space would.
 */

import { buildContext, type BuildContextOptions } from '@/lib/ai/context-builder';
import { loadCoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { planRetrieval, Concepts } from '@/lib/ai/retrieval-plan';
import { buildForecastSurfaces } from '@/lib/ai/forecast/for-request';
import type { SpaceSurfaces } from '@/lib/ai/prompts/system-prompt';
import type { SpaceContext_AI } from '@/lib/ai/types';
import type { AssembledForecast } from '@/lib/ai/forecast/assemble';

export interface ResolvedMasterSpace {
  spaceId:  string;
  ctx:      SpaceContext_AI;
  surfaces: SpaceSurfaces;
}

export interface MasterSurfaces {
  /** One entry per Space whose assembly SUCCEEDED, in membership order. */
  resolved:     ResolvedMasterSpace[];
  /** Space ids whose assembly threw — surfaced so the prompt can name them. */
  failedIds:    string[];
  /** True when CF-8 resolved FORECAST for this turn. */
  forecastAsked: boolean;
  /**
   * The forecast, and the Space it belongs to — present ONLY when exactly one
   * Space was eligible. Returned so the route can hand the SAME object to
   * FORECAST-14's numerical guard, which master never reached before.
   */
  forecast?:      AssembledForecast;
  forecastSpaceId?: string;
}

/**
 * Resolve every per-Space surface a master turn needs.
 *
 * Fails per Space rather than globally: one Space throwing costs that Space its
 * block and is reported, which is the coverage-honesty contract REVIEW-3 C-9
 * already established for master contexts.
 */
export async function resolveMasterSurfaces(args: {
  userId:   string;
  spaceIds: readonly string[];
  messages: readonly { role: string; content: string }[];
  question: string;
  transactionWindow?: BuildContextOptions['transactionWindow'];
  drilldown?:         BuildContextOptions['drilldown'];
}): Promise<MasterSurfaces> {
  const { userId, spaceIds, messages, question, transactionWindow, drilldown } = args;

  // ⚠️ SINGLE-SPACE IS NOT AN AGGREGATION. With one eligible Space, "all my
  // spaces" and that Space name the same money, so the forecast is licensed on
  // exactly the evidence the named-Space path would use. With two or more there
  // is no deduplicated balance to project from, and the caller renders the
  // scope refusal instead.
  const forecastable = spaceIds.length === 1;

  const settled = await Promise.allSettled(spaceIds.map(async (spaceId) => {
    const envelope = await loadCoverageEnvelope(spaceId);
    // CF-9 — planning FAILS OPEN: no plan means nothing is omitted.
    let plan;
    try {
      plan = planRetrieval({ messages, envelope, now: new Date() });
    } catch (planErr) {
      console.error(`[ai/master] retrieval planning failed for ${spaceId} (non-fatal):`, planErr);
    }
    const ctx = await buildContext(spaceId, userId, {
      scopeHint: 'full', transactionWindow, drilldown, evidence: envelope, question,
    });
    const { forecast, payDates } = await buildForecastSurfaces({
      spaceId, ctx, question, messages,
      wantsForecast: forecastable && (plan?.concepts.includes(Concepts.FORECAST) ?? false),
      wantsPayDates: plan?.concepts.includes(Concepts.PAY_DATES) ?? false,
    });
    return { spaceId, ctx, surfaces: { envelope, plan, forecast, payDates } };
  }));

  const resolved: ResolvedMasterSpace[] = [];
  const failedIds: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') resolved.push(r.value);
    else {
      failedIds.push(spaceIds[i]!);
      console.error(`[ai/master] surface resolution failed for ${spaceIds[i]}:`, r.reason);
    }
  });

  // ⚠️ ASKED, NOT ANSWERED. Read from the plans that actually resolved, so a
  // Space that failed to assemble cannot silently turn a forecast question into
  // a non-forecast one — the refusal must still render.
  const forecastAsked = resolved.some(
    (r) => r.surfaces.plan?.concepts.includes(Concepts.FORECAST) ?? false);
  const withForecast = resolved.find((r) => r.surfaces.forecast !== undefined);

  return {
    resolved, failedIds, forecastAsked,
    forecast: withForecast?.surfaces.forecast,
    forecastSpaceId: withForecast?.spaceId,
  };
}
