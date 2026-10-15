/**
 * lib/platform/ai/spend-by-surface.ts  (BETA C6 — fleet AI spend by surface)
 *
 * THE READER behind the Economics headline: estimated AI spend over the
 * AiInvocation ledger, ALLOCATED by surface, so customer spend (Conversations +
 * the Daily Brief) is told from platform overhead (the evaluation harness) and
 * from what could not be priced. The counter-based trend (ai-usage.ts) stays
 * beside it as the independent cross-check of two separately written ledgers;
 * it is not replaced.
 *
 *   · ONE grouped query per read at the (provider, model, surface, UTC day)
 *     grain, RETURNED rows only (a failure costs nothing);
 *   · dollars from the one rate card through the pure fold;
 *   · no user, Space or conversation dimension is selected — this is a
 *     fleet-level PLATFORM_OPS reader. The per-user figure lives in the alert
 *     authority (spend-health.ts) as an opaque reference and in Customer Success.
 *
 * fm_system: AiInvocation is REVOKED from fm_app (…000100 §4).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { isPricingConfigured } from "@/lib/usage/pricing";
import { buildAiSpendBySurface, type AiSpendBySurface, type SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";

const DAY_MS = 86_400_000;

export interface AiSpendWindow {
  days: number;
  /** Inclusive UTC day keys. */
  from: string;
  to: string;
}

export interface AiSpendOverview extends AiSpendBySurface {
  window: AiSpendWindow;
  pricingConfigured: boolean;
  /** The sentence every dollar here carries. */
  estimateNote: string;
  checkedAt: string;
}

export const AI_SPEND_ESTIMATE_NOTE =
  "Estimated from the code-owned rate card over RETURNED invocations by surface; customer = chat + brief, overhead = harness and unattributed; unpriced invocations are counted, never priced at $0. Not a bill.";

interface RawGroup {
  provider: string; model: string; surface: string | null; day: string;
  invocations: bigint | number; prompt: bigint | number; cached: bigint | number; completion: bigint | number;
}

/** The real grouped read. Exported for the allowance and alert readers' siblings to share one SQL shape. */
export async function readSpendGroups(since: Date, until: Date): Promise<SpendGroup[]> {
  const rows = await systemDb.$queryRaw<RawGroup[]>`
    SELECT "provider", "model", "surface",
           to_char(("occurredAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS "day",
           count(*)::bigint AS "invocations",
           sum("promptTokens")::bigint AS "prompt",
           sum("cachedPromptTokens")::bigint AS "cached",
           sum("completionTokens")::bigint AS "completion"
    FROM "AiInvocation"
    WHERE "occurredAt" >= ${since} AND "occurredAt" <= ${until} AND "outcome" = 'RETURNED'
    GROUP BY 1, 2, 3, 4`;
  return rows.map((r) => ({
    provider: r.provider, model: r.model, surface: r.surface, day: r.day,
    invocations: Number(r.invocations), promptTokens: Number(r.prompt),
    cachedPromptTokens: Number(r.cached), completionTokens: Number(r.completion),
  }));
}

export interface AiSpendDeps {
  now?: Date;
  days?: number;
  groups?: (since: Date, until: Date) => Promise<SpendGroup[]>;
}

/** The read. Defaults to the last 30 UTC days, today included. */
export async function getAiSpendOverview(deps: AiSpendDeps = {}): Promise<AiSpendOverview> {
  const now = deps.now ?? new Date();
  const days = deps.days ?? 30;
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(todayStart - (days - 1) * DAY_MS);
  const groups = await (deps.groups ?? readSpendGroups)(since, now);
  return {
    ...buildAiSpendBySurface(groups),
    window: { days, from: since.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) },
    pricingConfigured: isPricingConfigured(),
    estimateNote: AI_SPEND_ESTIMATE_NOTE,
    checkedAt: now.toISOString(),
  };
}
