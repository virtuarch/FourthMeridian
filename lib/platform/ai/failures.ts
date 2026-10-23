/**
 * lib/platform/ai/failures.ts  (OPERATIONALIZATION P0 — AI failure facts)
 *
 * THE AI PROVIDER FAILURE AUTHORITY, read from the AiInvocation ledger's
 * `outcome` dimension. Before this slice the ledger held billed, returned calls
 * only, so AI health was unobservable and the alert engine had nothing to read;
 * the Oct 4 Daily Brief outage (`insufficient_quota`) was discovered by a user.
 * Now the provider chokepoint (lib/ai/provider.ts → lib/ai/invocation.ts) writes
 * a zero-token FAILURE ROW for every call that did not return usage, and this
 * module folds those rows into one small health report.
 *
 * CONTRACT shared with lib/alerts (the `ai-provider-failing` rule) and the
 * Platform Ops overview (AI domain). Counts and timestamps only — no user,
 * Space, prompt or monetary value crosses this boundary.
 *
 * ── WHAT THE FOLD READS (OBS-006) ────────────────────────────────────────────
 * Only rows that describe THE PROVIDER, for THIS deployment, on a CUSTOMER
 * surface. Three kinds of row are on the same table and were polluting the
 * "every AI call failed" signal:
 *   · kill-switch refusals (errorCode AI_PAUSED) — a deliberate pause wrote a
 *     FAILED row per refused call, so pausing the platform paged "critical";
 *   · harness / script traffic (surface ≠ chat | brief) — operator runs against
 *     a mock or a clone are not customer-facing provider health;
 *   · other environments — one provider account spans local, preview and
 *     production and a shared database would mix them; the fold reads the
 *     rows this deployment wrote (`environment = deploymentEnvironment()`).
 * The pure `aiFailureWhere` builds that predicate so a test can pin it.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { deploymentEnvironment, type DeploymentEnvironment } from "@/lib/env";
import { AI_PAUSED_CODE } from "@/lib/platform/ai/paid-requests-admission";
import { CUSTOMER_SURFACES } from "@/lib/platform/ai/spend-by-surface-core";

export interface AiFailureHealth {
  windowHours: number;
  /** Billed round-trips that returned usage (outcome RETURNED). */
  returned: number;
  /** Provider/transport errors (outcome FAILED). */
  failed: number;
  /** Abandoned at the caller's deadline (outcome TIMEOUT). */
  timeouts: number;
  /** 429s the caller retried (outcome RATE_LIMITED) — one row per attempt. */
  rateLimited: number;
  /** insufficient_quota — waiting cannot cure it (outcome QUOTA). */
  quota: number;
  lastFailureAt: string | null;
  lastQuotaAt: string | null;
  checkedAt: string;
}

/** One (outcome) group over the window, as read from the ledger. */
export interface AiOutcomeGroup {
  outcome: string;
  count: number;
  lastAt: Date | null;
}

/** Pure fold of outcome groups into the health report. */
export function buildAiFailureHealth(groups: readonly AiOutcomeGroup[], windowHours: number, now: Date): AiFailureHealth {
  const by = (o: string) => groups.find((g) => g.outcome === o);
  const n = (o: string) => by(o)?.count ?? 0;
  const failures = groups.filter((g) => g.outcome !== "RETURNED" && g.lastAt);
  const lastFailure = failures.reduce<Date | null>((acc, g) => (!acc || (g.lastAt && g.lastAt > acc) ? g.lastAt : acc), null);
  return {
    windowHours,
    returned: n("RETURNED"),
    failed: n("FAILED"),
    timeouts: n("TIMEOUT"),
    rateLimited: n("RATE_LIMITED"),
    quota: n("QUOTA"),
    lastFailureAt: lastFailure?.toISOString() ?? null,
    lastQuotaAt: by("QUOTA")?.lastAt?.toISOString() ?? null,
    checkedAt: now.toISOString(),
  };
}

/** The ledger predicate the fold reads — PURE (OBS-006). */
export function aiFailureWhere(since: Date, environment: DeploymentEnvironment): {
  occurredAt: { gte: Date };
  environment: DeploymentEnvironment;
  surface: { in: string[] };
  OR: [{ errorCode: null }, { errorCode: { not: string } }];
} {
  return {
    occurredAt: { gte: since },
    environment,
    surface: { in: [...CUSTOMER_SURFACES] },
    // A kill-switch refusal is not a provider failure. `errorCode` is null on
    // RETURNED rows, and Prisma's `not` excludes nulls, hence the OR.
    OR: [{ errorCode: null }, { errorCode: { not: AI_PAUSED_CODE } }],
  };
}

/** The real reader: one grouped query over the window. fm_system only. */
export async function getAiFailureHealth(windowHours = 24, now: Date = new Date()): Promise<AiFailureHealth> {
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const rows = await systemDb.aiInvocation.groupBy({
    by: ["outcome"],
    where: aiFailureWhere(since, deploymentEnvironment()),
    _count: { _all: true },
    _max: { occurredAt: true },
  });
  return buildAiFailureHealth(
    rows.map((r) => ({ outcome: r.outcome, count: r._count._all, lastAt: r._max.occurredAt })),
    windowHours,
    now,
  );
}
