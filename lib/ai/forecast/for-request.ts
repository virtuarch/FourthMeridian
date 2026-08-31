/**
 * lib/ai/forecast/for-request.ts
 *
 * FORECAST-10 — ONE CALL FOR THE CHAT ROUTE.
 *
 * ⚠️ EXTRACTED, NOT INLINED, AND THE GUARD DECIDED IT. `route-authority.aiarch`
 * caps the chat route at 700 lines — the standing result of the AI-ARCH
 * decomposition that took it from 2,199 — and the forecast block pushed it to
 * 723. Raising the ceiling would have been the easy repair and the wrong one:
 * the route's job is to sequence request handling, and horizon resolution,
 * a bounded ledger read and substrate assembly are none of that.
 *
 * So the route asks one question — "is there a forecast for this turn?" — and
 * this answers it or returns undefined.
 */

import { todayUTCISO } from '@/lib/time/clock';
import { addMonths } from '@/lib/perspectives/time-range';
import type { SpaceContext_AI } from '@/lib/ai/types';
import { AssumptionOrigin, type ForecastHorizon } from '@/lib/forecast/policy';
import { resolveForecastHorizon } from './horizon';
import { loadForecastIncomeStreams } from './streams';
import { assembleForecast, type AssembledForecast } from './assemble';
import { detectPayDateAsk, resolvePayDates, type PayDateResult } from './pay-dates';
import { explainForecast } from '@/lib/forecast/engine';
import { guardForecastReply, resolveForecastGuardMode } from './numerical-guard';
import { db } from '@/lib/db';
import { AuditAction } from '@/lib/audit-actions';
import type { Prisma } from '@prisma/client';
import type { MasterCapabilities } from '@/lib/ai/prompts/system-prompt';

/**
 * The horizon a forecast question with no stated period gets.
 *
 * ⚠️ A DISCLOSED POLICY CHOICE, and the only default in the forecast path. It
 * bounds a QUESTION and asserts nothing about money, which is the test
 * FORECAST-8 set for a system default. It travels with `SYSTEM_POLICY` origin
 * and a sentence saying no period was named, so a reader can always tell these
 * three months from three months the user asked for.
 */
export const DEFAULT_HORIZON_MONTHS = 3;

/**
 * Build the forecast for this turn, or nothing.
 *
 * ⚠️ FAILS CLOSED AND LOUDLY. A throw returns undefined and the prompt simply
 * has no forecast section; an assembly that runs but cannot reach account
 * balances returns an explicit UNAVAILABLE that the section renders. Neither
 * path falls back to historical averages, which is the entire reason the
 * section exists.
 */
export async function buildForecastForRequest(args: {
  spaceId: string;
  ctx: SpaceContext_AI;
  question: string;
  /** The conversation, for FORECAST-13 fact continuity. */
  messages?: readonly { role: string; content: string }[];
}): Promise<AssembledForecast | undefined> {
  const { spaceId, ctx, question, messages } = args;
  try {
    const asOfISO = todayUTCISO();
    const horizon: ForecastHorizon = resolveForecastHorizon(question, asOfISO) ?? {
      fromISO: asOfISO, toISO: addMonths(asOfISO, DEFAULT_HORIZON_MONTHS),
      origin: AssumptionOrigin.SYSTEM_POLICY,
      statedAs: `no period was named; the default ${DEFAULT_HORIZON_MONTHS}-month horizon applies`,
    };
    const streams = await loadForecastIncomeStreams(spaceId, asOfISO);
    return assembleForecast({ ctx, streams, horizon, asOfISO, question, messages });
  } catch (err) {
    console.error('[ai/forecast] assembly failed (non-fatal):', err);
    return undefined;
  }
}

/**
 * FORECAST-14 — apply the numerical boundary to a generated reply.
 *
 * ⚠️ HERE RATHER THAN IN THE ROUTE, for the reason FORECAST-10 already learned:
 * `route-authority.aiarch` caps the chat route at 700 lines, and the answer to
 * a guard that pushes it over is to move the guard, not the ceiling. The route
 * asks one question and gets a reply plus an outcome to log.
 *
 * Returns the reply unchanged, and outcome 'none', for every non-forecast turn.
 */
export async function guardForecastAnswer(args: {
  reply: string;
  forecast: AssembledForecast | undefined;
  userId: string;
  spaceId: string;
}): Promise<{ reply: string; outcome: string }> {
  const { reply, forecast } = args;
  if (!forecast || 'refused' in forecast.forecast) return { reply, outcome: 'none' };
  const fc = forecast.forecast;
  const mode = resolveForecastGuardMode(process.env.AI_FORECAST_GUARD_MODE);
  const g = guardForecastReply(reply, fc, mode, () => explainForecast(fc));

  if (g.findings.length > 0) {
    // ⚠️ OBSERVABLE BEFORE IT IS ENFORCING. Written in 'shadow' too, which is
    // how the rate gets measured on real traffic before anything is rewritten.
    // Finding kinds and offending values only — no balances, no user prose.
    await db.auditLog.create({
      data: {
        action: AuditAction.AI_OUTPUT_VALIDATION_FLAGGED,
        userId: args.userId, spaceId: args.spaceId,
        metadata: {
          guard: 'forecast-numerical', mode, outcome: g.outcome,
          status: fc.fullCashPath.status,
          findings: g.findings.map((f) => ({ kind: f.kind, value: f.value })),
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    }).catch(() => undefined);
  }
  return { reply: g.reply, outcome: g.outcome };
}

/**
 * FORECAST-16 — the pay-date capability, answered on its own terms.
 *
 * ⚠️ IT NEVER CONSTRUCTS A FORECAST. The one shared step with
 * `buildForecastForRequest` is `loadForecastIncomeStreams`, which is where the
 * cadence and the activity licence come from; after that this reaches
 * FORECAST-2's occurrence generator directly. No operating state, no policy, no
 * engine, no accounts payload — none of which contains a pay date.
 *
 * Fails closed like its sibling: a throw returns undefined and the section is
 * simply absent, which is better than a section built from a partial read.
 */
export async function buildPayDatesForRequest(args: {
  spaceId: string;
  question: string;
  /** Skips the read entirely when the plan did not ask for this capability. */
  wanted: boolean;
}): Promise<PayDateResult | undefined> {
  if (!args.wanted) return undefined;
  try {
    const asOfISO = todayUTCISO();
    const streams = await loadForecastIncomeStreams(args.spaceId, asOfISO);
    return resolvePayDates(streams, asOfISO, args.question);
  } catch (err) {
    console.error('[ai/pay-dates] resolution failed (non-fatal):', err);
    return undefined;
  }
}

/**
 * FORECAST-16 — every forecast-derived surface this turn needs, in one call.
 *
 * ⚠️ ONE SEAM BECAUSE THERE ARE NOW TWO CAPABILITIES, and the route's job is to
 * sequence a request rather than to know which forecast surfaces exist. It also
 * keeps the route under the 700-line ceiling `route-authority.aiarch` enforces,
 * which is the third time that guard has usefully pushed logic out of it.
 *
 * The two are mutually exclusive in practice: a pay-date question does not
 * resolve FORECAST, and a cash-forecast question does not resolve PAY_DATES.
 * Both being absent is the ordinary case and costs one comparison.
 */
export async function buildForecastSurfaces(args: {
  spaceId: string;
  ctx: SpaceContext_AI;
  question: string;
  messages: readonly { role: string; content: string }[];
  wantsForecast: boolean;
  wantsPayDates: boolean;
}): Promise<{ forecast?: AssembledForecast; payDates?: PayDateResult }> {
  const { spaceId, ctx, question, messages } = args;
  return {
    forecast: args.wantsForecast
      ? await buildForecastForRequest({ spaceId, ctx, question, messages })
      : undefined,
    payDates: await buildPayDatesForRequest({ spaceId, question, wanted: args.wantsPayDates }),
  };
}

/**
 * PARITY-1 — every question-scoped capability a MASTER turn needs, in one call.
 *
 * ⚠️ N PER-SPACE ANSWERS, NEVER ONE MERGED ONE. Each Space resolves its own
 * streams against its own ledger and keeps its own verdict, aligned by index
 * with the contexts the prompt renders. Merging them would need a rule for
 * whose cadence wins when the same employer pays into two Spaces, and there is
 * no such rule — the honest cross-Space answer is "here are the dates, per
 * Space", which is what the per-Space blocks say.
 *
 * ⚠️ THE GATE IS THE CAPABILITY'S OWN DETECTOR. Master mode builds no CF-8
 * plan (the retrieval planner is envelope-scoped and an envelope is per Space),
 * so `detectPayDateAsk` — the same predicate `resolvePayDates` uses to choose
 * NEXT_ONE vs UPCOMING — decides whether the read happens at all. A non-pay
 * question pays nothing: no gate, no query, N times.
 *
 * Fails closed per Space, like its siblings: one Space throwing leaves that
 * Space without a block instead of removing everyone's.
 */
export async function buildMasterCapabilities(
  contexts: readonly { space: { id: string } }[], question: string,
): Promise<MasterCapabilities> {
  if (detectPayDateAsk(question) === null) return { question };
  const asOfISO = todayUTCISO();
  const payDatesList = await Promise.all(contexts.map(async (c) => {
    try {
      const streams = await loadForecastIncomeStreams(c.space.id, asOfISO);
      return resolvePayDates(streams, asOfISO, question);
    } catch (err) {
      console.error(`[ai/pay-dates] master resolution failed for ${c.space.id}:`, err);
      return undefined;
    }
  }));
  return { question, payDatesList };
}
