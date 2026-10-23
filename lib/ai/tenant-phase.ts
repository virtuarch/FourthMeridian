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
/**
 * ONE DOMAIN of the prologue: an assembler, or one evidence arm.
 *
 * ⚠️ THE PROLOGUE IS NOT ONE TRANSACTION, AND THAT DECISION WAS MEASURED RATHER
 * THAN ARGUED. It was built as one — four domains, the census, the memory line,
 * the corpus span and the activity frame in a single `phase.run` — on the
 * reasoning that the prologue makes no model call, so one transaction costs
 * nothing and buys a single snapshot. The acceptance suite then produced
 *
 *     Transaction already closed … timeout 5000 ms, however 5906 ms passed
 *
 * on 34 reads of a FIXTURE corpus. Reads inside a phase SERIALISE (Prisma does not
 * run a `Promise.all` inside an interactive transaction concurrently), so one
 * transaction turned four concurrent chains into one chain and blew the default.
 *
 * The two ways out were: raise this phase's budget to cover ~90 serialised reads
 * at a cold-connection cost, which means holding a pooled connection for ten-plus
 * seconds on the FIRST turn of every conversation; or give each domain its own
 * short phase and let them run concurrently again. The second is chosen, because
 * the thing the single transaction bought was a CROSS-DOMAIN SNAPSHOT that the
 * prologue never had in the first place — before this programme the four
 * assemblers ran as four concurrent chains against the migration principal with no
 * transaction at all. So the multi-phase shape preserves today's consistency
 * exactly and fixes only the authority, while a long transaction would have traded
 * a user-visible failure ("Something went wrong", no answer) for a guarantee
 * nobody had asked for.
 *
 * ⚠️ STATED PLAINLY, BECAUSE IT IS A REAL LIMIT: the orientation's domains are
 * read in SEPARATE snapshots, microseconds apart, exactly as they always were. A
 * balance that changes mid-prologue can be reflected in one domain and not
 * another. What is now guaranteed is the thing the slice is for — every one of
 * those reads ran under the authenticated caller's tenant authority.
 */
const PROLOGUE_DOMAIN_QUERIES = 24;

const ceilSeconds = (ms: number) => Math.ceil(ms / 1000) * 1000;

export const PHASE_BUDGET_MS = {
  /** Prisma's own default. Named so a reader can see it is a CHOICE here. */
  DEFAULT:   5_000,
  RECONCILE: ceilSeconds(RECONCILE_QUERIES * PESSIMISTIC_MS_PER_QUERY),
  RETROSPECTIVE_PROJECTION:
             ceilSeconds(RETROSPECTIVE_PROJECTION_QUERIES * PESSIMISTIC_MS_PER_QUERY),
  /**
   * ⚠️ `max(default, derived)` AND NOT THE DERIVATION ALONE. The heaviest single
   * prologue domain is the transactions summary at ~24 reads, which is 0.96 s —
   * so the derivation sits BELOW Prisma's 5 s default and a tighter budget would
   * be a new P2028 on a slow machine for no gain. The derivation therefore only
   * ever pushes this UP, which is the direction that matters: when one domain
   * grows past ~125 reads this number moves and somebody has to notice.
   */
  PROLOGUE:  Math.max(5_000, ceilSeconds(PROLOGUE_DOMAIN_QUERIES * PESSIMISTIC_MS_PER_QUERY)),
} as const;

/** Reads one prologue DOMAIN may make. Asserted against a measurement by the suite. */
export const PROLOGUE_DOMAIN_QUERY_BASIS = PROLOGUE_DOMAIN_QUERIES;

/**
 * The phase-name PREFIX every prologue read runs under.
 *
 * ⚠️ A PREFIX, NOT A PHASE, because there are several: one per assembled domain
 * and one per evidence arm, concurrent and short. The suffix names which, so a
 * slow or failing arm is identifiable in a log rather than hidden inside
 * "the prologue". See PROLOGUE_DOMAIN_QUERIES for why it is not one transaction.
 */
export const PROLOGUE_PHASE = 'ai_prologue';
export const prologuePhase = (part: string) => `${PROLOGUE_PHASE}:${part}`;

/** The phase name a durable projection checkpoint is WRITTEN under. */
export const CHECKPOINT_PHASE = 'ai_checkpoint';

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
  // Every prologue part shares one budget, whatever its suffix.
  if (toolName.startsWith(`${PROLOGUE_PHASE}:`) || toolName === PROLOGUE_PHASE) {
    return PHASE_BUDGET_MS.PROLOGUE;
  }
  return TOOL_PHASE_BUDGET_MS[toolName] ?? PHASE_BUDGET_MS.DEFAULT;
}

/**
 * How ONE prologue read obtains its authority.
 *
 * ⚠️ A FUNCTION, NOT A CLIENT, AND THAT IS THE WHOLE POINT OF THE SHAPE. A bare
 * `ReadClient` parameter would have forced the prologue to be one transaction (a
 * client IS a transaction), which is what blew the 5 s default. Handing the
 * assembly layer a RUNNER instead lets each domain open and close its own short
 * phase while still being STRUCTURALLY unable to choose an authority: there is no
 * argument here through which a caller could supply a client, and no default.
 *
 * ⚠️ AND THE NO-PHASE PATH IS STILL EXPRESSIBLE, which is what keeps the dogfood
 * harnesses working: `onClient(db)` below is a runner that opens no transaction at
 * all and hands out the client it was built with, VISIBLY.
 */
export type PhasedRead =
  <T>(part: string, fn: (client: TenantClient) => Promise<T>) => Promise<T>;

/** A runner that opens NO transaction and uses the client it was given. */
export function onClient(client: TenantClient): PhasedRead {
  return (_part, fn) => fn(client);
}

/** A runner that opens ONE short tenant phase per read, concurrently. */
export function phasedReads(phase: AiPhaseRunner): PhasedRead {
  return (part, fn) => phase.run(prologuePhase(part), fn);
}

/**
 * How ONE prologue MEMORY read obtains its authority.
 *
 * ⚠️ IT IS SEPARATE FROM `PhasedRead` BECAUSE THE MEMORY CLIENT IS NARROWER AND
 * MUST STAY THAT WAY. `MemoryClient` is a `Pick<…, 'spaceMemory'>`: it cannot
 * reach a financial table even by accident, and collapsing the two runners into
 * one would hand the memory layer a full read client for no reason. A tenant
 * transaction satisfies both, so a phase runner feeds them both — but the TYPES
 * stay apart, which is the only thing keeping that narrowing real.
 */
export type MemoryPhasedRead =
  <T>(fn: (client: TenantClient) => Promise<T>) => Promise<T>;

export function phasedMemoryRead(phase: AiPhaseRunner): MemoryPhasedRead {
  return (fn) => phase.run(prologuePhase('memory_line'), fn);
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
