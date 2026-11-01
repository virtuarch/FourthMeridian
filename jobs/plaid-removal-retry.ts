/**
 * jobs/plaid-removal-retry.ts  (BETA C4 — scheduled retry of UNCONFIRMED Plaid removals)
 *
 * WHY THIS JOB EXISTS. `lib/plaid/disconnect.ts` sets the PRODUCT status
 * REVOKED unconditionally (the user removed the connection; it must not come
 * back as a ghost card) and records, separately, whether Plaid CONFIRMED the
 * removal. When it did not — a 500, a rate limit, a network failure — the Item
 * still exists at Plaid with a valid access_token, and Plaid bills a
 * subscription "as long as a valid access_token exists for the Item". Until
 * now the only retry was an operator pressing Retry on the Provider cleanup
 * widget; nothing scheduled it (AI-PLAID-COST-ECONOMICS-ASSESSMENT §6.2,
 * growth vector 2). This job is that schedule. Daily, fixed cadence
 * (lib/jobs/registry.core.ts), executed through the dispatcher + runJob(),
 * which writes the returned result into the JobRun ledger as the run summary —
 * the same way sweep-rate-limits and evaluate-alerts record theirs.
 *
 * ══ WHAT IT REUSES, AND WHAT IT REFUSES TO RE-IMPLEMENT ═════════════════════
 *
 *   · The OWED population is the provider-cleanup reader's fold
 *     (lib/platform/plaid/provider-cleanup.ts): newest marker per item wins.
 *     No second fold, no JSON-path query, no `status === REVOKED` inference.
 *   · The REMOVAL is `disconnectPlaidItemIfOrphaned` — the ONE `itemRemove`
 *     site for revocations. It re-counts live connections itself (a relinked
 *     item correctly declines), classifies the provider's answer with the one
 *     classifier, and writes the CONFIRMED / UNCONFIRMED marker. This job
 *     never calls Plaid and never writes a marker.
 *   · The VERDICT is the reader re-read after the attempts — durable state,
 *     never the action's return value (it returns void by design).
 *
 * ══ SELECTION ═══════════════════════════════════════════════════════════════
 * Owed AND not an operator removal still in flight AND product status REVOKED
 * AND the row still exists. PB-5 (S2): an owed item whose newest marker is a
 * PRE_PROVIDER marker younger than PRE_PROVIDER_GRACE_MS (`inProgress`) is an
 * operator removal whose own provider call may be running right now; a second
 * itemRemove must not be started beside it, so it is SKIPPED (counted in
 * `skipped.inProgress`) and retried on a later run once the window has passed. The status filter
 * is a SELECTION, not proof of anything: an owed item whose product status is
 * ACTIVE has been relinked since (lifecycle case 5 in provider-cleanup.test.ts)
 * and must not be revoked by a background job — the operator lever remains for
 * that judgement. A marker whose item is gone has nothing to revoke. Oldest
 * obligation first, bounded per run so one bad day cannot turn into a burst of
 * provider calls.
 *
 * ══ AUTHORITY ═══════════════════════════════════════════════════════════════
 * `systemDb` through the reader and the disconnect path (both already run on
 * fm_system — this is a platform-wide job with no tenant to bind). The job
 * holds no client of its own. It is a JOB, not an operator action: there is no
 * actor, so nothing goes through recordOperatorAction; the JobRun row is its
 * audit, and the per-item markers are the per-item audit.
 *
 * ══ PRIVACY ═════════════════════════════════════════════════════════════════
 * The summary is counts only. No item ids, institutions or owner refs reach
 * the JobRun ledger; the Provider cleanup widget already shows the per-item
 * view to an authorised operator.
 */

import { getProviderCleanupStatus, type ProviderCleanupStatus } from "@/lib/platform/plaid/provider-cleanup";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";
import { redactedErrorForLog } from "@/lib/plaid/errors";

/** The per-run ceiling on provider attempts. */
export const PLAID_REMOVAL_RETRY_LIMIT = 50;

export interface PlaidRemovalRetryResult {
  /** Items the job ran the canonical removal path for this run. */
  attempted: number;
  /** Of those, items whose newest marker is CONFIRMED after the run. */
  confirmed: number;
  /** Of those, items still owed after the run (a fresh UNCONFIRMED marker, or a throw). */
  stillUnconfirmed: number;
  /** Owed items NOT attempted, by reason — reported so a zero attempt is explainable. */
  skipped: { inProgress: number; notRevoked: number; itemGone: number; overLimit: number };
  /** The owed population before the run, for the ledger. */
  owedBefore: number;
  limit: number;
}

/** Everything the job touches, injectable so the whole run is forceable without a database or Plaid. */
export interface PlaidRemovalRetryDeps {
  status?: () => Promise<ProviderCleanupStatus>;
  disconnect?: (plaidItemId: string) => Promise<void>;
  limit?: number;
}

/**
 * THE PURE SELECTION. Which owed items this run may attempt, in order, and why
 * the rest were left alone. Exported so the policy is pinned directly.
 */
export function selectRetryCandidates(
  status: Pick<ProviderCleanupStatus, "owed">,
  limit: number = PLAID_REMOVAL_RETRY_LIMIT,
): { candidates: string[]; skipped: PlaidRemovalRetryResult["skipped"] } {
  const skipped = { inProgress: 0, notRevoked: 0, itemGone: 0, overLimit: 0 };
  const eligible: string[] = [];
  // `owed` is already oldest-obligation-first (the reader sorts by owedSinceISO).
  for (const o of status.owed) {
    // PB-5 (S2) — FIRST: never race an operator removal inside its grace window.
    if (o.inProgress) { skipped.inProgress++; continue; }
    if (o.itemGone) { skipped.itemGone++; continue; }
    if (o.productStatus !== "REVOKED") { skipped.notRevoked++; continue; }
    eligible.push(o.plaidItemId);
  }
  const bound = Math.max(0, Math.floor(limit));
  skipped.overLimit = Math.max(0, eligible.length - bound);
  return { candidates: eligible.slice(0, bound), skipped };
}

export async function retryPlaidRemovals(deps: PlaidRemovalRetryDeps = {}): Promise<PlaidRemovalRetryResult> {
  const readStatus = deps.status ?? (() => getProviderCleanupStatus());
  const disconnect = deps.disconnect ?? ((id: string) => disconnectPlaidItemIfOrphaned(id));
  const limit = deps.limit ?? PLAID_REMOVAL_RETRY_LIMIT;

  const before = await readStatus();
  const { candidates, skipped } = selectRetryCandidates(before, limit);

  for (const plaidItemId of candidates) {
    try {
      await disconnect(plaidItemId);
    } catch (e) {
      // A throw here is a DB / decrypt failure, not a provider refusal (those
      // are classified and recorded inside the canonical path). The obligation
      // stands; the re-read below says so. Keep going: one item's failure must
      // not strand the rest of the day's list.
      console.error(`[plaid-removal-retry] canonical removal threw for item ${plaidItemId} (continuing):`, redactedErrorForLog(e));
    }
  }

  // ⚠️ THE VERDICT IS DURABLE STATE, RE-READ. Not the action's return, and
  // never PlaidItem.status (written REVOKED whatever Plaid answered).
  const after = candidates.length === 0 ? before : await readStatus();
  const stillOwed = new Set(after.owed.map((o) => o.plaidItemId));
  let confirmed = 0, stillUnconfirmed = 0;
  for (const id of candidates) {
    if (stillOwed.has(id)) stillUnconfirmed++;
    else confirmed++;
  }

  const result: PlaidRemovalRetryResult = {
    attempted: candidates.length, confirmed, stillUnconfirmed, skipped, owedBefore: before.owedCount, limit,
  };
  if (candidates.length > 0 || before.owedCount > 0) {
    console.log(`[plaid-removal-retry] ${JSON.stringify(result)}`);
  }
  return result;
}
