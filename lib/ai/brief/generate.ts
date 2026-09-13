/**
 * lib/ai/brief/generate.ts
 *
 * ONE PACKAGE, ONE MODEL CALL, ONE VALIDATED BRIEF — or a typed refusal.
 *
 * ⚠️ NO TOOL LOOP AND NO SECOND ATTEMPT. The model receives the deterministic
 * package and returns a structured narration, once. Whatever it returns is then
 * accepted, reduced, or refused by code:
 *
 *   shape or size broken         → refused (MALFORMED_OUTPUT) — never trimmed
 *   headline states an unlicensed figure → refused (UNLICENSED_HEADLINE)
 *   an observation states one    → that observation is dropped (UNLICENSED_FIGURE)
 *   an observation cites nothing real → dropped (NO_EVIDENCE); bad paths stripped
 *   SPENDING citing a debt payment or own-account transfer → dropped (MISLABELED_MOVEMENT)
 *   an observation resting only on data freshness → dropped (SHOWN_ON_PAGE): the
 *     page shows freshness and connection problems itself, every day they last
 *   `quiet` contradicting the kept observations' importance → reconciled to them
 *     (quietCorrected) — quiet means "nothing NOTABLE", so it is derived, not trusted
 *
 * Dropping rather than regenerating is FORECAST-14's measured result: redaction
 * held where regeneration did not, and a loop that asks again until the numbers
 * look right is a loop that eventually accepts a wrong one.
 *
 * ⚠️ ACCOUNTING IS THE PROVIDER'S. The call runs inside an AI invocation context
 * with `surface: 'brief'`, so the one AiInvocation row the provider writes is
 * attributable. Nothing here counts tokens for itself; the figures returned in
 * `meta` are the provider's own report of the same call, priced at read time.
 */

import { randomUUID } from 'node:crypto';
import {
  generateStructuredWithUsage,
  StructuredOutputRefusalError, StructuredOutputTimeoutError,
  type ChatMessage, type StructuredClient, type StructuredOptions,
  type StructuredResult, type UsageSinks,
} from '@/lib/ai/provider';
import { runWithAiInvocationContext } from '@/lib/ai/invocation-context';
import { rateAt } from '@/lib/usage/pricing';
import { todayUTCISO } from '@/lib/time/clock';
import {
  BRIEF_SCHEMA, MAX_EVIDENCE_PATHS,
  citesNonSpendingAsSpending, onlyReportsFreshness, resolveEvidencePath, validateNarration,
} from './contract';
import { licenceFromPackage, unlicensedFigures } from './licence';
import { BRIEF_SYSTEM_PROMPT, approxTokens, briefUserMessage, serializePackage } from './prompt';
import type { BriefNarration, BriefObservation, BriefPackage, DailyBrief } from './types';

export type StructuredCall = <T>(
  systemPrompt: string,
  messages: ChatMessage[],
  schema: { name: string; schema: Record<string, unknown> },
  options?: StructuredOptions,
  deps?: { client?: StructuredClient; sinks?: UsageSinks },
) => Promise<StructuredResult<T>>;

export interface DroppedObservation {
  index:  number;
  kind:   string;
  reason: 'NO_EVIDENCE' | 'UNLICENSED_FIGURE' | 'MISLABELED_MOVEMENT' | 'SHOWN_ON_PAGE';
  figures?: string[];
}

export interface BriefValidationReport {
  droppedObservations: DroppedObservation[];
  strippedEvidence:    string[];
  /** The model's `quiet` contradicted its own importance marks and was reconciled. */
  quietCorrected:      boolean;
}

export type AcceptanceResult =
  | { ok: true; narration: BriefNarration; validation: BriefValidationReport }
  | { ok: false; reason: 'MALFORMED_OUTPUT' | 'UNLICENSED_HEADLINE'; detail: string[] };

/**
 * Pure: the model's raw narration against the package it was given.
 * Everything a Brief must satisfy that the provider cannot enforce is here.
 */
export function acceptNarration(pkg: BriefPackage, raw: unknown): AcceptanceResult {
  const shape = validateNarration(raw);
  if (!shape.ok) return { ok: false, reason: 'MALFORMED_OUTPUT', detail: shape.problems };

  const licence = licenceFromPackage(pkg);
  const headlineFigures = unlicensedFigures(shape.value.headline, licence);
  if (headlineFigures.length > 0) {
    return { ok: false, reason: 'UNLICENSED_HEADLINE', detail: headlineFigures.map((f) => f.text) };
  }

  const validation: BriefValidationReport = { droppedObservations: [], strippedEvidence: [], quietCorrected: false };
  const kept: BriefObservation[] = [];

  shape.value.observations.forEach((ob, index) => {
    const evidence: string[] = [];
    for (const path of ob.evidence) {
      const p = path.trim();
      if (evidence.length < MAX_EVIDENCE_PATHS && resolveEvidencePath(pkg, p) !== undefined
        && !evidence.includes(p)) evidence.push(p);
      else validation.strippedEvidence.push(path);
    }
    if (evidence.length === 0) {
      validation.droppedObservations.push({ index, kind: ob.kind, reason: 'NO_EVIDENCE' });
      return;
    }
    if (onlyReportsFreshness({ ...ob, evidence })) {
      validation.droppedObservations.push({ index, kind: ob.kind, reason: 'SHOWN_ON_PAGE' });
      return;
    }
    const figures = unlicensedFigures(`${ob.title}\n${ob.body}`, licence);
    if (figures.length > 0) {
      validation.droppedObservations.push({ index, kind: ob.kind, reason: 'UNLICENSED_FIGURE',
        figures: figures.map((f) => f.text) });
      return;
    }
    const candidate: BriefObservation = { ...ob, evidence };
    if (citesNonSpendingAsSpending(candidate, pkg)) {
      validation.droppedObservations.push({ index, kind: ob.kind, reason: 'MISLABELED_MOVEMENT' });
      return;
    }
    kept.push(candidate);
  });

  // ⚠️ ONE JUDGMENT, NOT TWO. The first live goldens returned quiet days marked
  // NOTABLE and "quiet" Briefs over a 1.1-month cash buffer: two correlated
  // judgments made inconsistently. Importance is the judgment; quiet follows from
  // what survived validation, and a contradiction is recorded rather than hidden.
  const quiet = !kept.some((o) => o.importance === 'NOTABLE');
  if (quiet !== shape.value.quiet) validation.quietCorrected = true;

  return {
    ok: true,
    narration: { headline: shape.value.headline, quiet, observations: kept },
    validation,
  };
}

export interface BriefGenerationMeta {
  correlationId: string;
  surface: string;
  model: string;
  packageBytes: number;
  packageApproxTokens: number;
  latencyMs?: number;
  finishReason?: string | null;
  usage?: StructuredResult<unknown>['usage'];
  /** Derived at read time from the effective-dated rate. Never stored. */
  costUsd?: number | null;
}

export type BriefGenerationResult =
  | { ok: true; brief: DailyBrief; validation: BriefValidationReport; meta: BriefGenerationMeta }
  | {
      ok: false;
      reason: 'TIMEOUT' | 'REFUSED' | 'PROVIDER_ERROR' | 'MALFORMED_OUTPUT' | 'UNLICENSED_HEADLINE';
      detail: string[];
      meta: BriefGenerationMeta;
      /** The model's narration when one arrived — for diagnosis, never for display. */
      raw?: unknown;
    };

export interface GenerateBriefOptions {
  model: string;
  /** Where the invocation is attributed. 'brief' for product traffic. */
  surface?: string;
  /**
   * Why the lifecycle is generating, carried in the correlation id so AiInvocation
   * rows can be told apart at read time (brief_daily_… / brief_change_…). No
   * second cost ledger: AiInvocation stays the accounting authority.
   */
  reason?: 'daily' | 'change';
  timeoutMs?: number;
  now?: Date;
  deps?: { structured?: StructuredCall; client?: StructuredClient; sinks?: UsageSinks };
}

function costOf(model: string, day: string, usage: StructuredResult<unknown>['usage']): number | null {
  if (!usage) return null;
  const rate = rateAt('OPENAI', model, day);
  if (!rate) return null;
  const uncached = Math.max(usage.promptTokens - usage.cachedPromptTokens, 0);
  return (uncached * rate.usdPerMillion.input
    + usage.cachedPromptTokens * rate.usdPerMillion.cachedInput
    + usage.completionTokens * rate.usdPerMillion.output) / 1_000_000;
}

/** Generate one Brief from one package. Never throws for a model or validation failure. */
export async function generateBriefFromPackage(
  pkg: BriefPackage, options: GenerateBriefOptions,
): Promise<BriefGenerationResult> {
  const now = options.now ?? new Date();
  const surface = options.surface ?? 'brief';
  const correlationId = options.reason ? `brief_${options.reason}_${randomUUID()}` : `brief_${randomUUID()}`;
  const serialized = serializePackage(pkg);
  const meta: BriefGenerationMeta = {
    correlationId, surface, model: options.model,
    packageBytes: Buffer.byteLength(serialized, 'utf8'),
    packageApproxTokens: approxTokens(serialized),
  };
  const structured: StructuredCall = options.deps?.structured ?? generateStructuredWithUsage;

  let result: StructuredResult<unknown>;
  try {
    result = await runWithAiInvocationContext({ correlationId, turnIndex: 0, surface }, () =>
      structured<unknown>(
        BRIEF_SYSTEM_PROMPT,
        [{ role: 'user', content: briefUserMessage(pkg) }],
        BRIEF_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
        { model: options.model, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
        { client: options.deps?.client, sinks: options.deps?.sinks },
      ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof StructuredOutputTimeoutError) return { ok: false, reason: 'TIMEOUT', detail: [message], meta };
    if (err instanceof StructuredOutputRefusalError) return { ok: false, reason: 'REFUSED', detail: [err.refusal], meta };
    if (/not JSON|empty structured/.test(message)) return { ok: false, reason: 'MALFORMED_OUTPUT', detail: [message], meta };
    return { ok: false, reason: 'PROVIDER_ERROR', detail: [message], meta };
  }

  meta.latencyMs = result.latencyMs;
  meta.finishReason = result.finishReason;
  meta.usage = result.usage;
  meta.costUsd = costOf(result.model, todayUTCISO(now), result.usage);

  const accepted = acceptNarration(pkg, result.value);
  if (!accepted.ok) return { ok: false, reason: accepted.reason, detail: accepted.detail, meta, raw: result.value };

  return {
    ok: true,
    brief: {
      ...accepted.narration,
      briefDay: pkg.identity.briefDay,
      generatedAt: now.toISOString(),
      evidenceAsOf: pkg.identity.asOf,
    },
    validation: accepted.validation,
    meta,
  };
}
