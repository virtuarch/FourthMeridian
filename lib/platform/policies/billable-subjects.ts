/**
 * lib/platform/policies/billable-subjects.ts  (BETA LIFECYCLE L2 — who is billed?)
 *
 * The billable gate (lib/entitlements/billable-gate.ts) decides for a CUSTOMER.
 * Background work starts from a Plaid Item or a wallet account, so this module
 * names the customer that work bills to and asks the gate — owner rulings
 * 2026-10-31:
 *
 *   · Plaid Item work bills the user who CONNECTED the Item (PlaidItem.userId),
 *     whatever Spaces its accounts are shared into.
 *   · Wallet / account work bills the account owner (FinancialAccount.ownerUserId).
 *     An account with NO owner has no billing owner ⇒ NO_OWNER ⇒ refused: no
 *     paid background work at all (sweep, continuation, backfill, price
 *     lookups). Never the earliest Space owner, never a guess.
 *   · A DEACTIVATED owner ⇒ NOT_ENTITLED (their connections stop accruing
 *     provider calls, as the sweeps already promised).
 *   · Space-scoped work with no account (billable-gate `spaceId`) uses
 *     billedOwnerOf — exactly one ACTIVE OWNER, else NO_OWNER.
 *
 * fm_system: jobs and webhooks have no tenant phase, and the read is the
 * owner id + deactivation stamp only. NEVER THROWS: a failed read is
 * POLICY_UNAVAILABLE (metered work fails closed).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import {
  assertBillableAllowed, billableAllowedForUsers,
  type BillableDecision, type BillableOperation,
} from "@/lib/entitlements/billable-gate";

const deny = (reason: "NO_OWNER" | "NOT_ENTITLED" | "POLICY_UNAVAILABLE"): BillableDecision => ({ allowed: false, reason });

function logFailure(what: string, e: unknown): void {
  console.error(`[billable-subjects] ${what} read failed; metered work fails closed —`,
    e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "unknown error");
}

/** The narrow reads (systemDb satisfies them; tests pass a fake). */
export interface BillableSubjectClient {
  plaidItem: {
    findUnique(args: { where: { id: string }; select: { userId: true; user: { select: { deactivatedAt: true } } } }): Promise<{ userId: string; user: { deactivatedAt: Date | null } | null } | null>;
  };
  financialAccount: {
    findMany(args: { where: { id: { in: string[] } }; select: { id: true; ownerUserId: true; ownerUser: { select: { deactivatedAt: true } } } }): Promise<{ id: string; ownerUserId: string | null; ownerUser: { deactivatedAt: Date | null } | null }[]>;
  };
}

export interface BillableSubjectDeps {
  client?: BillableSubjectClient;
  /** The per-user decision (default: the billable gate). */
  decideUser?: (userId: string, operation: BillableOperation) => Promise<BillableDecision>;
  /** The batch decision (default: billableAllowedForUsers). */
  decideUsers?: (userIds: readonly string[], operation: BillableOperation) => Promise<Map<string, BillableDecision>>;
}

const defaultClient = (): BillableSubjectClient => systemDb as unknown as BillableSubjectClient;

/** The billed user of a Plaid Item (the connector), or the refusal when there is none. */
export async function billableForPlaidItem(itemId: string, operation: BillableOperation, deps: BillableSubjectDeps = {}): Promise<BillableDecision> {
  let row: Awaited<ReturnType<BillableSubjectClient["plaidItem"]["findUnique"]>>;
  try {
    row = await (deps.client ?? defaultClient()).plaidItem.findUnique({ where: { id: itemId }, select: { userId: true, user: { select: { deactivatedAt: true } } } });
  } catch (e) { logFailure("plaid item owner", e); return deny("POLICY_UNAVAILABLE"); }
  if (!row) return deny("NO_OWNER");
  if (row.user?.deactivatedAt) return deny("NOT_ENTITLED");
  return (deps.decideUser ?? ((userId, op) => assertBillableAllowed({ userId, operation: op })))(row.userId, operation);
}

/**
 * BATCH — each account's decision by its OWNER (one owner read, one policy
 * read). Every requested id is in the map; an unknown or ownerless account is
 * NO_OWNER.
 */
export async function billableForAccounts(accountIds: readonly string[], operation: BillableOperation, deps: BillableSubjectDeps = {}): Promise<Map<string, BillableDecision>> {
  const ids = [...new Set(accountIds)];
  const out = new Map<string, BillableDecision>();
  if (ids.length === 0) return out;
  let rows: Awaited<ReturnType<BillableSubjectClient["financialAccount"]["findMany"]>>;
  try {
    rows = await (deps.client ?? defaultClient()).financialAccount.findMany({ where: { id: { in: ids } }, select: { id: true, ownerUserId: true, ownerUser: { select: { deactivatedAt: true } } } });
  } catch (e) {
    logFailure("account owner", e);
    for (const id of ids) out.set(id, deny("POLICY_UNAVAILABLE"));
    return out;
  }
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const owners = [...new Set(rows.filter((r) => r.ownerUserId && !r.ownerUser?.deactivatedAt).map((r) => r.ownerUserId!))];
  const decisions = owners.length > 0 ? await (deps.decideUsers ?? billableAllowedForUsers)(owners, operation) : new Map<string, BillableDecision>();
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || !r.ownerUserId) out.set(id, deny("NO_OWNER"));
    else if (r.ownerUser?.deactivatedAt) out.set(id, deny("NOT_ENTITLED"));
    else out.set(id, decisions.get(r.ownerUserId) ?? deny("POLICY_UNAVAILABLE"));
  }
  return out;
}

/**
 * Only the accounts whose billed owner may cause `operation` now — the filter
 * price-history work applies to the accounts that triggered it.
 */
export async function billableAccountIds(accountIds: readonly string[], operation: BillableOperation, deps: BillableSubjectDeps = {}): Promise<{ allowed: string[]; refused: Map<string, BillableDecision> }> {
  const decisions = await billableForAccounts(accountIds, operation, deps);
  const allowed: string[] = [];
  const refused = new Map<string, BillableDecision>();
  for (const [id, d] of decisions) { if (d.allowed) allowed.push(id); else refused.set(id, d); }
  return { allowed, refused };
}
