/**
 * lib/platform/ai/spend-health.ts  (BETA C7 — the AI spend authority the alert engine reads)
 *
 * ONE small report over the trailing window: estimated USD the FLEET's customer
 * surfaces caused, the LARGEST estimated USD any one customer caused, and how
 * many invocations could not be priced. The `ai-spend-fleet-high` / `ai-spend-user-high` rules
 * (lib/alerts) classifies it against the two operator thresholds; nothing here
 * decides a breach.
 *
 * ── Fail closed on an unpriceable model ─────────────────────────────────────
 * A group whose model has no rate in force on its day contributes to
 * `unpricedInvocations` and `unpricedModels`, never to a dollar figure. The
 * rule fires on that count alone, because a spend figure that quietly omits
 * part of the spend is the kind of safeguard that reports "fine" while the
 * bill grows (owner rule, 2026-10-15).
 *
 * ── Identity minimisation ───────────────────────────────────────────────────
 * The per-user maximum carries an OPAQUE reference (`user …` + the id's last
 * six characters) — enough for a dedupe key and for Customer Success to find
 * the account, never an email, a name or a full id. Customer surfaces only:
 * harness traffic has no customer and is overhead by definition.
 *
 * fm_system: AiInvocation is REVOKED from fm_app.
 */

import "server-only";
import { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { AI_RATES, type AiRate } from "@/lib/usage/pricing";
import { CUSTOMER_SURFACES, priceSpendGroup, type SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import { loadAiSpendThresholds, type AiSpendThresholds } from "@/lib/platform/ai/spend-thresholds";

/** One (userId, provider, model, UTC day) group of RETURNED customer-surface rows. */
export interface UserSpendGroup extends SpendGroup {
  /** Null for a customer-surface row recorded without a signed-in user (should not occur; counted fleet-side only). */
  userId: string | null;
}

export interface AiSpendHealth {
  windowHours: number;
  /** Estimated USD across customer surfaces, or null when nothing in the window could be priced. */
  fleetUsd: number | null;
  /** The largest estimated USD one customer caused, or null when no per-user figure could be priced. */
  maxUserUsd: number | null;
  /** Opaque reference to that customer — "user …abc123" — never an email or full id. */
  maxUserRef: string | null;
  /** Distinct customers with at least one priced invocation in the window. */
  customers: number;
  /** Of those, how many are at or above the per-customer threshold. The rule names the largest; this says it is not alone. */
  customersAtOrOverThreshold: number;
  customerInvocations: number;
  /** Invocations on customer surfaces whose model had no rate on their day. NOT counted in any USD. */
  unpricedInvocations: number;
  unpricedModels: string[];
  /** The thresholds in force when the report was built — the rule judges against these. */
  thresholds: { fleetUsd: number; userUsd: number };
  checkedAt: string;
}

/** The opaque per-user reference every operator surface uses for a customer. */
export function opaqueUserRef(userId: string): string {
  return `user …${userId.slice(-6)}`;
}

/** Pure: fold per-user groups into the health report. */
export function buildAiSpendHealth(
  groups: readonly UserSpendGroup[],
  thresholds: { fleetUsd: number; userUsd: number },
  windowHours: number,
  now: Date,
  rates: readonly AiRate[] = AI_RATES,
): AiSpendHealth {
  let fleetUsd: number | null = null;
  let invocations = 0, unpricedInvocations = 0;
  const unpricedModels = new Set<string>();
  const perUser = new Map<string, number>();

  for (const g of groups) {
    invocations += g.invocations;
    const priced = priceSpendGroup(g, rates);
    if (priced.unpriced) {
      unpricedInvocations += g.invocations;
      unpricedModels.add(`${g.provider}:${g.model}`);
      continue;
    }
    if (priced.usd === null) continue;
    fleetUsd = (fleetUsd ?? 0) + priced.usd;
    if (g.userId) perUser.set(g.userId, (perUser.get(g.userId) ?? 0) + priced.usd);
  }

  let maxUserUsd: number | null = null, maxUserId: string | null = null, customersAtOrOverThreshold = 0;
  for (const [userId, usd] of perUser) {
    if (maxUserUsd === null || usd > maxUserUsd) { maxUserUsd = usd; maxUserId = userId; }
    if (usd >= thresholds.userUsd) customersAtOrOverThreshold++;
  }

  return {
    windowHours,
    fleetUsd,
    maxUserUsd,
    maxUserRef: maxUserId ? opaqueUserRef(maxUserId) : null,
    customers: perUser.size,
    customersAtOrOverThreshold,
    customerInvocations: invocations,
    unpricedInvocations,
    unpricedModels: [...unpricedModels].sort(),
    thresholds,
    checkedAt: now.toISOString(),
  };
}

interface RawGroup {
  userId: string | null; provider: string; model: string; surface: string | null; day: string;
  invocations: bigint | number; prompt: bigint | number; cached: bigint | number; completion: bigint | number;
}

/** The real grouped read: customer surfaces, RETURNED rows, per (userId, provider, model, day). */
export async function readUserSpendGroups(since: Date, until: Date): Promise<UserSpendGroup[]> {
  const rows = await systemDb.$queryRaw<RawGroup[]>`
    SELECT "userId", "provider", "model", "surface",
           to_char(("occurredAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS "day",
           count(*)::bigint AS "invocations",
           sum("promptTokens")::bigint AS "prompt",
           sum("cachedPromptTokens")::bigint AS "cached",
           sum("completionTokens")::bigint AS "completion"
    FROM "AiInvocation"
    WHERE "occurredAt" >= ${since} AND "occurredAt" <= ${until}
      AND "outcome" = 'RETURNED'
      AND "surface" IN (${Prisma.join([...CUSTOMER_SURFACES])})
    GROUP BY 1, 2, 3, 4, 5`;
  return rows.map((r) => ({
    userId: r.userId, provider: r.provider, model: r.model, surface: r.surface, day: r.day,
    invocations: Number(r.invocations), promptTokens: Number(r.prompt),
    cachedPromptTokens: Number(r.cached), completionTokens: Number(r.completion),
  }));
}

export interface AiSpendHealthDeps {
  now?: Date;
  groups?: (since: Date, until: Date) => Promise<UserSpendGroup[]>;
  thresholds?: () => Promise<AiSpendThresholds>;
}

/** The authority read: one grouped query + the two thresholds. */
export async function getAiSpendHealth(windowHours = 24, deps: AiSpendHealthDeps = {}): Promise<AiSpendHealth> {
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const [groups, thresholds] = await Promise.all([
    (deps.groups ?? readUserSpendGroups)(since, now),
    (deps.thresholds ?? loadAiSpendThresholds)(),
  ]);
  return buildAiSpendHealth(groups, { fleetUsd: thresholds.fleet.usd, userUsd: thresholds.user.usd }, windowHours, now);
}
