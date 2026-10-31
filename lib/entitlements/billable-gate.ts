/**
 * lib/entitlements/billable-gate.ts  (BETA LIFECYCLE L1 — the billable gate API)
 *
 * The ONE question every new billable / metered operation asks before it
 * starts: is this customer's policy group frozen, paused or ended, is the
 * policy readable, and are they entitled to it at all? The decision itself is
 * pure (billable-gate-core.ts — read it for the order); this module does the
 * reads:
 *
 *   · the policy-group catalogue through `loadFreshPolicyGroupCatalogue` — a
 *     successful read at most 30 s old, NEVER the last-good copy or the code
 *     fallback; anything else ⇒ POLICY_UNAVAILABLE (fail closed for billable,
 *     while sign-in and reads keep using the ordinary cached loader);
 *   · the customer's CustomerPolicyAssignment (one row, or one query for a batch);
 *   · for Space-scoped work with no user, the Space's ACTIVE OWNER members.
 *
 * SCOPE. Per customer. `userId` wins when given (the actor causes and is billed
 * for the operation — AI chat in a shared Space bills the asker). With only a
 * `spaceId`, the bill goes to the Space's single ACTIVE OWNER (billedOwnerOf);
 * a Space with none or several ⇒ NO_OWNER for metered work.
 *
 * NEVER THROWS. A failed read is POLICY_UNAVAILABLE for metered work and
 * allowed for data access. The rollout switch (env.isPolicyAssignmentFailClosed)
 * applies exactly as in resolve.ts.
 *
 * WIRED (L2 enforcement): the Plaid exchange, the shared deferred-sync choke
 * point (webhook / connect follow-on / resume-sync / resume-stale-imports),
 * sync-banks, the wallet sweep, the history-backfill worker, wallet re-add, the
 * operator resync / Expand History routes and price-history rebuilds. Batch
 * jobs use `createBillableBatchGate` (one policy read per batch, re-read at
 * most every BILLABLE_BATCH_MAX_AGE_MS so a mid-run freeze still lands within
 * the 30 s propagation bound).
 */

import "server-only";
import { env } from "@/lib/env";
import { loadFreshPolicyGroupCatalogue } from "@/lib/platform/policies/policy-group-catalogue";
import {
  billedOwnerOf, decideBillable, OPERATION_CLASS,
  type BillableDecision, type BillableOperation,
} from "./billable-gate-core";
import type { AssignmentFacts } from "./resolve";
import type { PolicyGroupCatalogue } from "./policy-groups";

export type { BillableDecision, BillableDenialReason, BillableOperation, BillableDenialTally } from "./billable-gate-core";
export { billableSkipCode, isBillableSkipCode, tallyBillableDenial } from "./billable-gate-core";

interface AssignmentRow {
  userId: string;
  policyGroup: string;
  overlay: string | null;
  assignedAt: Date;
  assignedById: string | null;
  aiDailyUsdAllowanceOverride?: number | null;
}

/** The gate's reads (systemDb, a tenant transaction or a test fake satisfies it). */
export interface BillableGateReadClient {
  customerPolicyAssignment: {
    findUnique(args: { where: { userId: string } }): Promise<AssignmentRow | null>;
    findMany(args: { where: { userId: { in: string[] } } }): Promise<AssignmentRow[]>;
  };
  spaceMember: {
    findMany(args: { where: { spaceId: string; role: "OWNER"; status: "ACTIVE" }; select: { userId: true }; take: number }): Promise<{ userId: string }[]>;
  };
}

/** Test seams (production passes none). */
export interface BillableGateDeps {
  loadCatalogue?: () => Promise<PolicyGroupCatalogue | null>;
  now?: () => number;
  failClosed?: boolean;
}

async function defaultClient(): Promise<BillableGateReadClient> {
  const { billableGateSystemClient } = await import("@/lib/platform/policies/billable-gate-authority");
  return billableGateSystemClient();
}

const toFacts = (r: AssignmentRow | null | undefined): AssignmentFacts | null => r ? {
  policyGroup: r.policyGroup, overlay: r.overlay, assignedAt: r.assignedAt, assignedById: r.assignedById,
  aiDailyUsdAllowanceOverride: r.aiDailyUsdAllowanceOverride ?? null,
} : null;

async function safeCatalogue(load: () => Promise<PolicyGroupCatalogue | null>): Promise<PolicyGroupCatalogue | null> {
  try { return await load(); } catch { return null; }
}

function logReadFailure(what: string, error: unknown): void {
  console.error(`[billable-gate] ${what} read failed; metered work fails closed —`,
    error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "unknown error");
}

const UNAVAILABLE: BillableDecision = Object.freeze({ allowed: false as const, reason: "POLICY_UNAVAILABLE" as const });
const ALLOWED: BillableDecision = Object.freeze({ allowed: true as const });

/**
 * May this NEW billable operation start? `{ allowed: true }` or the reason it
 * may not. See billable-gate-core.ts for the order.
 */
export async function assertBillableAllowed(
  input: { userId?: string; spaceId?: string; operation: BillableOperation; client?: BillableGateReadClient },
  deps: BillableGateDeps = {},
): Promise<BillableDecision> {
  const onReadFailure = OPERATION_CLASS[input.operation] === "METERED" ? UNAVAILABLE : ALLOWED;
  const failClosed = deps.failClosed ?? env.isPolicyAssignmentFailClosed;
  const now = deps.now ?? Date.now;
  let client: BillableGateReadClient;
  try { client = input.client ?? await defaultClient(); }
  catch (e) { logReadFailure("authority", e); return onReadFailure; }

  let billedUserId: string | null = input.userId ?? null;
  if (billedUserId === null && input.spaceId) {
    try {
      const owners = await client.spaceMember.findMany({ where: { spaceId: input.spaceId, role: "OWNER", status: "ACTIVE" }, select: { userId: true }, take: 2 });
      billedUserId = billedOwnerOf(owners.map((o) => o.userId));
    } catch (e) { logReadFailure("space owner", e); return onReadFailure; }
  }

  const catalogue = await safeCatalogue(deps.loadCatalogue ?? loadFreshPolicyGroupCatalogue);
  let assignment: AssignmentFacts | null = null;
  if (billedUserId !== null) {
    try { assignment = toFacts(await client.customerPolicyAssignment.findUnique({ where: { userId: billedUserId } })); }
    catch (e) { logReadFailure("assignment", e); return onReadFailure; }
  }
  return decideBillable({ operation: input.operation, billedUserId, assignment, catalogue, failClosed, nowMs: now() });
}

/**
 * BATCH (jobs) — the decision for each user, with ONE catalogue read and ONE
 * assignment query. Every requested id is in the map. Never throws: a failed
 * assignment read decides every user as POLICY_UNAVAILABLE (metered).
 */
export async function billableAllowedForUsers(
  userIds: readonly string[],
  operation: BillableOperation,
  client?: BillableGateReadClient,
  deps: BillableGateDeps = {},
): Promise<Map<string, BillableDecision>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, BillableDecision>();
  if (ids.length === 0) return out;
  const onReadFailure = OPERATION_CLASS[operation] === "METERED" ? UNAVAILABLE : ALLOWED;
  const read = await readPolicyFactsForUsers(ids, client, deps);
  if (read === null) {
    for (const id of ids) out.set(id, onReadFailure);
    return out;
  }
  for (const id of ids) {
    out.set(id, decideBillable({ operation, billedUserId: id, assignment: read.assignments.get(id) ?? null, catalogue: read.catalogue, failClosed: read.failClosed, nowMs: read.nowMs }));
  }
  return out;
}

/** The policy facts for a batch of users: ONE catalogue read and ONE assignment query. */
export interface UserPolicyFacts {
  catalogue: PolicyGroupCatalogue | null;
  assignments: Map<string, AssignmentFacts>;
  failClosed: boolean;
  nowMs: number;
}

/**
 * The shared batch read (the billable batch and the per-user lifecycle state,
 * lib/entitlements/beta-lifecycle.ts, read the SAME facts the same way). Null
 * when the assignment read failed — the caller fails closed. A failed or stale
 * catalogue comes back as `catalogue: null` / unusable, which the pure
 * deciders turn into POLICY_UNAVAILABLE / UNKNOWN. Never throws.
 */
export async function readPolicyFactsForUsers(
  userIds: readonly string[],
  client?: BillableGateReadClient,
  deps: BillableGateDeps = {},
): Promise<UserPolicyFacts | null> {
  const ids = [...new Set(userIds)];
  const failClosed = deps.failClosed ?? env.isPolicyAssignmentFailClosed;
  const now = deps.now ?? Date.now;
  try {
    const c = client ?? await defaultClient();
    const [catalogue, rows] = await Promise.all([
      safeCatalogue(deps.loadCatalogue ?? loadFreshPolicyGroupCatalogue),
      ids.length === 0 ? Promise.resolve([] as AssignmentRow[]) : c.customerPolicyAssignment.findMany({ where: { userId: { in: ids } } }),
    ]);
    const assignments = new Map<string, AssignmentFacts>();
    for (const r of rows) { const f = toFacts(r); if (f) assignments.set(r.userId, f); }
    return { catalogue, assignments, failClosed, nowMs: now() };
  } catch (e) {
    logReadFailure("batch assignment", e);
    return null;
  }
}

// ── L2 — the batch gate for long-running jobs ─────────────────────────────────

/**
 * How long a batch decision may be reused inside one run. The catalogue the
 * batch read used is itself at most CATALOGUE_TTL_MS (25 s) old, so a decision
 * acted on is at most 25 s + 5 s = 30 s behind a lifecycle write — the owner's
 * propagation bound — however long the job runs.
 */
export const BILLABLE_BATCH_MAX_AGE_MS = 5_000;

export type BillableBatchLoader = (userIds: readonly string[], operation: BillableOperation) => Promise<Map<string, BillableDecision>>;

export interface BillableBatchGate {
  /** The decision for the customer who would be billed (null ⇒ NO_OWNER). Never throws. */
  decide(userId: string | null | undefined): Promise<BillableDecision>;
  /** Add keys the run discovered later (one read for all of them, not one each). */
  prime(userIds: readonly (string | null | undefined)[]): Promise<void>;
  /** Policy reads this gate has made (tests pin "one read per batch"). */
  readonly reads: number;
}

/**
 * A job's gate: ONE batch read for every customer it knows up front (not N+1),
 * re-read when older than `maxAgeMs` or when asked about a customer the batch
 * did not include. A loader that throws decides everyone POLICY_UNAVAILABLE
 * (metered work fails closed). A missing billed user is NO_OWNER — never a guess.
 */
export function createBillableBatchGate(
  userIds: readonly (string | null | undefined)[],
  operation: BillableOperation,
  opts: { load?: BillableBatchLoader; clock?: () => number; maxAgeMs?: number } = {},
): BillableBatchGate {
  const load: BillableBatchLoader = opts.load ?? ((ids, op) => billableAllowedForUsers(ids, op));
  const clock = opts.clock ?? Date.now;
  const maxAgeMs = opts.maxAgeMs ?? BILLABLE_BATCH_MAX_AGE_MS;
  const known = new Set(userIds.filter((u): u is string => typeof u === "string" && u.length > 0));
  let decisions: Map<string, BillableDecision> | null = null;
  let loadedAt = -Infinity;
  let reads = 0;
  const refresh = async () => {
    reads++;
    const ids = [...known];
    try { decisions = await load(ids, operation); }
    catch (e) {
      logReadFailure("batch gate", e);
      decisions = new Map(ids.map((id) => [id, UNAVAILABLE] as const));
    }
    loadedAt = clock();
  };
  return {
    get reads() { return reads; },
    async prime(more) {
      const fresh = more.filter((u): u is string => typeof u === "string" && u.length > 0 && !known.has(u));
      if (fresh.length === 0) return;
      for (const u of fresh) known.add(u);
      await refresh();
    },
    async decide(userId) {
      if (!userId) return Object.freeze({ allowed: false as const, reason: "NO_OWNER" as const });
      if (!known.has(userId)) { known.add(userId); decisions = null; }
      if (decisions === null || clock() - loadedAt > maxAgeMs) await refresh();
      return decisions!.get(userId) ?? UNAVAILABLE;
    },
  };
}
