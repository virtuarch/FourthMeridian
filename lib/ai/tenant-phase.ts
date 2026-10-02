/**
 * lib/ai/tenant-phase.ts  (RLS-AI-S2)
 *
 * ONE TOOL CALL IS ONE TRANSACTION — BY CONSTRUCTION, NOT BY CONVENTION.
 *
 * ── THE SHAPE THIS ENFORCES ─────────────────────────────────────────────────
 *     authenticated server identity
 *       → model selects a tool
 *         → SHORT tenant-scoped financial operation
 *         → transaction ENDS
 *       → result returned to the model
 *       → model continues
 *
 * ⚠️ NO DB TRANSACTION MAY SPAN A MODEL CALL. A chat turn makes up to six
 * (`MAX_TOOL_ROUNDTRIPS`), each of which is 5–70 s of provider latency plus the
 * user's think time between turns. Wrapping a turn in `withTenantDb` would hold a
 * pooled connection and an open snapshot across all of it; on the Supabase
 * Transaction Pooler that is a connection the rest of the deployment cannot have.
 * The phase boundary is therefore the TOOL CALL, opened in the DISPATCHER rather
 * than in twenty tool bodies — so the property holds for the next tool somebody
 * writes without that author having to know about it.
 *
 * ── WHY THE DEFAULT TIMEOUT IS A GIFT, AND WHY TWO PATHS NEED MORE ──────────
 * Prisma's interactive-transaction defaults (`maxWait` 2 s, `timeout` 5 s) are
 * nowhere overridden in this repository. That is load-bearing in the right
 * direction: a whole-turn transaction cannot ship by accident, because it dies
 * P2028. Two tool paths legitimately exceed 5 s and are given an EXPLICIT,
 * DERIVED budget below — never a raised global default, and never a number
 * chosen because it felt roomy on this laptop. (The parent has just fixed a CI
 * flake caused by an inherited default that encoded an assumption about machine
 * speed; the derivation is the point.)
 *
 * ── THE COST OF A PHASE, STATED ─────────────────────────────────────────────
 * ⚠️ READS INSIDE A PHASE SERIALISE. Prisma does not run a `Promise.all` inside an
 * interactive transaction concurrently, so a phase's queries become a serial
 * chain. For the prologue (24 queries, today ~4 concurrent chains) that is
 * roughly +100 ms on a 5–70 s turn, and it is accepted deliberately.
 *
 * ⚠️ AND IT IS THE OPPOSITE TRADE FROM `lib/ai/brief/view.ts:28-30`, WHICH IS NOT
 * AN INCONSISTENCY. The Brief makes NO model call: its whole run is short, so one
 * transaction around the lot costs nothing and buys atomicity. A chat turn is
 * mostly waiting on a model, so the same choice would cost a connection for a
 * minute. Same primitive, opposite latency profile, opposite answer — recorded
 * here so the two do not read as drift.
 */

import "server-only";

import { withTenantDb, type TenantClient } from "@/lib/db/tenant-context";

/**
 * How long ONE phase may take.
 *
 * ⚠️ DERIVED FROM THE QUERY COUNT AND A MEASURED PER-QUERY CEILING, not picked.
 * `reconcile_projection` with settled checkpoints is statically ≈650 queries
 * (`MAX_RECONCILED` × the spine rebuild it performs per checkpoint) and a
 * retrospective `project_cash` ≈117–132. At a deliberately pessimistic 40 ms per
 * round trip — several times what an indexed read costs on the measured corpus,
 * so the budget survives a slow machine without encoding this one — that is
 * 26 s and 5.3 s. The two budgets below are those numbers, rounded up to the
 * next whole second, and the DERIVATION is the thing to edit if a path's query
 * count changes.
 */
const PESSIMISTIC_MS_PER_QUERY = 40;
/** `MAX_RECONCILED` checkpoints, each rebuilding the cash spine. */
const RECONCILE_QUERIES = 650;
/** A retrospective projection: the snapshot authority plus the forecast reads. */
const RETROSPECTIVE_PROJECTION_QUERIES = 132;

const ceilSeconds = (ms: number) => Math.ceil(ms / 1000) * 1000;

export const PHASE_BUDGET_MS = {
  /** Prisma's own default. Named so a reader can see it is a CHOICE here. */
  DEFAULT:   5_000,
  RECONCILE: ceilSeconds(RECONCILE_QUERIES * PESSIMISTIC_MS_PER_QUERY),
  RETROSPECTIVE_PROJECTION:
             ceilSeconds(RETROSPECTIVE_PROJECTION_QUERIES * PESSIMISTIC_MS_PER_QUERY),
} as const;

/**
 * Tools whose phase needs more than the default, by name.
 *
 * ⚠️ AN ALLOWLIST, NOT A RAISED DEFAULT. Everything absent from this map keeps
 * Prisma's 5 s, which is what makes a new long-running tool fail loudly in CI
 * rather than quietly hold a connection in production.
 */
export const TOOL_PHASE_BUDGET_MS: Readonly<Record<string, number>> = {
  reconcile_projection: PHASE_BUDGET_MS.RECONCILE,
  project_cash:         PHASE_BUDGET_MS.RETROSPECTIVE_PROJECTION,
  scenario_projection:  PHASE_BUDGET_MS.RETROSPECTIVE_PROJECTION,
  goal_seek:            PHASE_BUDGET_MS.RETROSPECTIVE_PROJECTION,
};

export function phaseBudgetFor(toolName: string): number {
  return TOOL_PHASE_BUDGET_MS[toolName] ?? PHASE_BUDGET_MS.DEFAULT;
}

/**
 * Run ONE phase of AI work as the tenant.
 *
 * ⚠️ THE IDENTITY IS THE CALLER'S AUTHENTICATED ONE AND NOTHING ELSE. It comes
 * from `SpaceContext.userId`, which `resolveSpaceContext` derived from the
 * server-side session; a model argument, a request body, a header and the
 * active-Space cookie are all incapable of reaching this parameter. Space scope is
 * NOT passed at all — the policies derive it from `SpaceMember`, so a tampered
 * cookie cannot widen what the phase can see.
 *
 * ⚠️ `fn` RECEIVES THE CLIENT; IT MAY NOT CHOOSE ONE. `TenantClient` has no
 * `$transaction`, so nothing inside a phase can open a second one or escape to a
 * wider authority — the compiler refuses it.
 */
export async function runAiPhase<T>(
  userId: string, timeoutMs: number, fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  return withTenantDb(userId, fn, { timeout: timeoutMs });
}

/**
 * What a surface hands the turn loop to make its tool calls tenant-scoped.
 *
 * ⚠️ A CAPABILITY, AND OPTIONAL BY DESIGN. A context without one behaves exactly
 * as it did before this module existed, which is what lets the authority move
 * surface by surface — the dogfood harnesses and the batch runners read a clone
 * as the migration principal and must keep doing so. What it must never be is a
 * value a MODEL can supply: it is set where the session is known and nowhere else.
 */
export interface AiPhaseRunner {
  /** The authenticated user the phase binds as. Server-side session state only. */
  readonly userId: string;
  run<T>(toolName: string, fn: (tx: TenantClient) => Promise<T>): Promise<T>;
}

export function aiPhaseRunner(userId: string): AiPhaseRunner {
  return {
    userId,
    run: (toolName, fn) => runAiPhase(userId, phaseBudgetFor(toolName), fn),
  };
}
