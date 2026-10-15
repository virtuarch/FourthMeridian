/**
 * lib/platform/ai/customer-spend-today.ts  (BETA C7 — one customer's ledger rows, today)
 *
 * THE ONE READ BEHIND THE DAILY ALLOWANCE. `aiDailyUsdAllowance` is judged over
 * the AiInvocation ledger, and the ledger is REVOKED from fm_app (…000100 §4):
 * written and read by fm_system only, with no tenant column by design. A
 * product route therefore cannot read it inside its tenant phase, and the read
 * lives HERE — under lib/platform/ with the other fm_system readers of the same
 * table (spend-by-surface.ts, spend-health.ts) — rather than beside the
 * verdict in lib/ai/, where every delegate read is classified as AI *evidence*
 * under tenant authority (lib/ai/evidence-authorities.ts). This is not
 * evidence the model reads; it is a safeguard's measurement.
 *
 * ── The boundary ────────────────────────────────────────────────────────────
 * ONE grouped query, bounded by (provider, model), selecting ONLY:
 *   · the given user's rows — the caller passes the AUTHENTICATED session's id
 *     and nothing else (lib/ai/allowance.ts; the routes hand it `user.id`);
 *   · RETURNED outcomes (a failure costs nothing);
 *   · customer surfaces (chat, brief) — harness traffic has no customer;
 *   · since the start of the current UTC day.
 * No email, name, Space, conversation or content column is selected. Nothing
 * about another customer can come back, because the predicate is the id.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { CUSTOMER_SURFACES, type ModelUsageGroup } from "@/lib/platform/ai/spend-by-surface-core";

/** The narrow client shape the read needs. Injectable for tests; defaults to fm_system. */
export interface CustomerSpendReadClient {
  aiInvocation: {
    groupBy(args: {
      by: ["provider", "model"];
      where: { userId: string; outcome: "RETURNED"; surface: { in: string[] }; occurredAt: { gte: Date } };
      _count: { _all: true };
      _sum: { promptTokens: true; cachedPromptTokens: true; completionTokens: true };
    }): Promise<{
      provider: string; model: string;
      _count: { _all: number };
      _sum: { promptTokens: number | null; cachedPromptTokens: number | null; completionTokens: number | null };
    }[]>;
  };
}

const DEFAULT_CLIENT = (): CustomerSpendReadClient => systemDb as unknown as CustomerSpendReadClient;

/** The start of the current UTC day for the given instant. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** This customer's RETURNED customer-surface rows since midnight UTC, grouped by (provider, model). */
export async function readCustomerSpendGroupsToday(
  userId: string,
  now: Date = new Date(),
  client: CustomerSpendReadClient = DEFAULT_CLIENT(),
): Promise<ModelUsageGroup[]> {
  const rows = await client.aiInvocation.groupBy({
    by: ["provider", "model"],
    where: { userId, outcome: "RETURNED", surface: { in: [...CUSTOMER_SURFACES] }, occurredAt: { gte: utcDayStart(now) } },
    _count: { _all: true },
    _sum: { promptTokens: true, cachedPromptTokens: true, completionTokens: true },
  });
  return rows.map((r) => ({
    provider: r.provider, model: r.model, invocations: r._count._all,
    promptTokens: r._sum.promptTokens ?? 0, cachedPromptTokens: r._sum.cachedPromptTokens ?? 0, completionTokens: r._sum.completionTokens ?? 0,
  }));
}
