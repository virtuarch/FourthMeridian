/**
 * lib/plaid/syncIssues.ts
 *
 * D2.x Financial Data Integrity Gate (M1) — best-effort recorder for
 * transaction-sync integrity issues. A SyncIssue write must NEVER fail a sync:
 * every call is wrapped so a persistence error degrades to a console log.
 *
 * Purely additive/observational — writing a SyncIssue changes no balance,
 * transaction, snapshot, or sync result.
 */

// ⚠️ RLS-P-3a — fm_system IS THE DEFAULT AUTHORITY FOR THE INCIDENT PAIR.
//
// `SyncIssue` and `SyncIssueOccurrence` are REVOKED FROM fm_app outright
// (…_rls_roles_and_policies §4), so the tenant role cannot write either one and
// the migration principal wrote them only because that is what this module
// happened to import. There is no tenant arm to preserve: an incident is
// operator-facing forensic evidence that deliberately survives deletion of what
// it observed, which is exactly the case a tenant-keyed policy would break.
//
// ⚠️ AND THE FLIP IS TWO PLACES FOR THESE TWO TABLES, NOT ONE. The client stays
// a PARAMETER, because the injection seam is what keeps a unit test from writing
// a real row — the eight `stage: "opening-position-repair"` rows in the local dev
// database are the documented cost of this function once resolving `db` from
// module scope unconditionally. So the default below covers every producer that
// does not thread a client, and the producers that DO thread one (three sites in
// syncTransactions.ts and five under lib/investments/) still decide for
// themselves. That residue is named in the P-3a report rather than hidden.
import { systemDb } from "@/lib/db";
import type { LedgerWriteObserver } from "@/lib/monitoring/capture";
import type { SyncIssueKind, Prisma } from "@prisma/client";
import { recordIncidentObservation, resolveByAutomaticRecovery, type IncidentClient } from "@/lib/platform/incidents/lifecycle";

export interface SyncIssueInput {
  kind:                SyncIssueKind;
  /** OPS-2D-5A-2 — non-Plaid producers (WALLET) name their provider. */
  provider?:           string | null;
  plaidItemId?:        string | null;
  financialAccountId?: string | null;
  plaidTransactionId?: string | null;
  plaidAccountId?:     string | null;
  detail?:             Prisma.InputJsonValue;
}

/**
 * Records a SyncIssue. Never throws.
 *
 * @param client PRE-V26-PLAID-CLOSE Phase 2 — the Prisma client to write
 * through, defaulting to `systemDb` (RLS-P-3a — it was the migration principal
 * until then). Callers that already thread an injected client through their
 * operation MUST pass it here.
 *
 * Why this parameter exists: this function used to resolve `db` from module
 * scope unconditionally, so it escaped every caller's injected client. A unit
 * test that passed a mocked client and hit an error path wrote a REAL row into
 * the developer's database — that is the documented origin of the eight
 * `stage: "opening-position-repair"` rows sitting in the local dev DB, whose
 * `financialAccountId` is the test fixture id `"fa1"`. The leak was invisible
 * because this function swallows its own failures by design.
 *
 * Injection is preferred over a `NODE_ENV === "test"` no-op precisely so sync
 * tests can still ASSERT that an issue was recorded (Phase 1B needs exactly
 * that) rather than having the behaviour disabled underneath them.
 *
 * ── OPS-2D-TX-1 — WHAT THE CLIENT MAY BE ─────────────────────────────────────
 * `IncidentClient` requires `$transaction`, so a `Prisma.TransactionClient` no
 * longer type-checks here. Injection is unchanged and still mandatory; what is
 * now forbidden is threading the CALLER'S OPEN TRANSACTION into telemetry.
 *
 * A losing convergence race raises P2002, which aborts the surrounding Postgres
 * transaction (25P02). Every later statement then fails, COMMIT silently
 * degrades to ROLLBACK, and the financial writes vanish while the caller is told
 * it succeeded — reproduced on real PostgreSQL in
 * scripts/test-incident-transaction-safety.ts.
 *
 * A test fake therefore declares a `$transaction` stub: it is standing in for a
 * root client, and saying so is what keeps the type honest.
 */
/**
 * PRE-V26-PLAID-CLOSE Phase 4 — close the cursor-blocking issues for one item
 * after a sync run has provably persisted everything. Returns how many rows were
 * resolved. Never throws (mirrors `recordSyncIssue`).
 *
 * ── WHY THIS IS SOUND, AND WHY IT IS SO NARROW ───────────────────────────────
 * Under the Phase 1 invariant a Plaid cursor advances past a page ONLY when
 * every canonical persistence obligation for that page succeeded. So a completed
 * `syncTransactionsForItem` is PROOF that the previously-held page replayed and
 * its rows landed. That proof is what licenses resolving those issues — not the
 * passage of time, and not the absence of a new failure.
 *
 * The proof covers EXACTLY the rows Phase 1 created, which is why the filter
 * requires `detail.cursorBlocking = true`:
 *
 *   • A PRE-Phase-1 failure advanced its cursor at the time. Plaid will never
 *     re-deliver that row, so a later successful sync says NOTHING about whether
 *     its data ever landed. Auto-resolving it would produce a "resolved" issue
 *     that still represents missing canonical financial data — the exact thing
 *     this initiative forbids. Those rows stay open for manual triage.
 *   • Non-cursor-blocking kinds (REMOVED_TOMBSTONE, BALANCE_TX_MISMATCH) are
 *     point-in-time EVENTS with no lifecycle; they are never "resolved" at all.
 *
 * Scoped to ONE plaidItemId — a successful Chase sync says nothing about Amex.
 */
export async function resolveCursorBlockingIssues(
  plaidItemId: string,
  client: IncidentClient = systemDb,
  /**
   * OPS-2D-5A-1 — the run that proved recovery. Threaded by callers that have
   * one; null stays null and is stored honestly rather than fabricated.
   */
  runId?: string | null,
  deps: SyncIssueDeps = {},
): Promise<number> {
  // FACADE over the canonical resolution authority. This no longer mutates
  // lifecycle fields itself — it names the semantic scope that recovered and
  // lets the authority decide which active conditions that success actually
  // proves. The matching rule (cursor-blocking transaction conditions only)
  // lives there, derived from sync-issue-semantics, not duplicated here.
  const { resolved } = await resolveByAutomaticRecovery(
    { plaidItemId, domain: "transactions", runId: runId ?? null },
    client,
    deps.getExecutionIdByRunId,
    // RLS-P-2 — forwarded, never interpreted here. The facade does not decide
    // what a failed resolution means; it only makes sure somebody can hear it.
    { onWriteFailure: deps.onWriteFailure },
  );
  return resolved;
}

/**
 * OPS-2D-5A-2 — the execution-lookup seam, forwarded.
 *
 * Exists so a disposable-database harness can exercise the REAL lifecycle path
 * with only the backing datasource substituted. Without it the module-level
 * seam reads the primary database, a harness cannot see the execution it just
 * created, and the FK path silently reads null — which is exactly how a
 * correlation bug would hide behind a passing test.
 *
 * Production never passes this. It is not an environment switch, not an HTTP
 * option, and not a second lookup: it is the same `getExecutionIdByRunId`
 * contract, resolved against a different client.
 */
export interface SyncIssueDeps {
  getExecutionIdByRunId?: (runId: string) => Promise<string | null>;
  /**
   * RLS-P-2 — THE FACADE STILL NEVER THROWS, BUT IT NO LONGER STAYS SILENT.
   *
   * Both functions here swallow everything, because fourteen producers call them
   * from inside their own catch blocks and a telemetry failure must never become
   * a second, louder failure (OPS-2D-TX-1). That contract is unchanged. What it
   * cost was that a REFUSED lifecycle write — and under the authority flip these
   * two tables are revoked from `fm_app` outright, so a refusal is a real
   * possibility — was indistinguishable from a successful one at every call
   * site. The refresh ledger's `degradations` list reported a complete ledger
   * while the episode had not been recorded.
   *
   * This is the listen-only channel that closes it. It carries a table and a
   * phase and nothing else: no row, no message, no error object. It is forwarded
   * straight to the lifecycle authority, which is the only code that knows which
   * of its statements failed.
   *
   * ⚠️ A LISTENER, NOT A RESULT. It cannot change what either function returns
   * or what the producer does next — observation must never control the observed
   * operation.
   */
  onWriteFailure?: LedgerWriteObserver;
}

export async function recordSyncIssue(
  input: SyncIssueInput,
  client: IncidentClient = systemDb,
  deps: SyncIssueDeps = {},
): Promise<void> {
  // OPS-2D-5A-1 — FACADE. The name and signature stay (14 call sites depend on
  // them), but the decision-making moved to lib/platform/incidents/lifecycle.ts.
  // This function no longer creates rows: it forwards typed evidence, and the
  // lifecycle authority decides identity, convergence and recurrence. Keeping
  // one entry point avoids two competing detection paths during 5A-2's
  // migration of the remaining unenveloped producers.
  //
  // `detail.runId` is forwarded as a CORRELATOR, not a relation — the authority
  // looks it up and stores an FK only when a matching execution exists.
  const detailObj = (input.detail ?? {}) as Record<string, unknown>;
  const runId = typeof detailObj.runId === "string" ? detailObj.runId : null;
  await recordIncidentObservation(
    {
      kind:               input.kind,
      provider:           input.provider ?? null,
      plaidItemId:        input.plaidItemId ?? null,
      financialAccountId: input.financialAccountId ?? null,
      plaidTransactionId: input.plaidTransactionId ?? null,
      plaidAccountId:     input.plaidAccountId ?? null,
      runId,
      detail:             input.detail,
    },
    client,
    deps.getExecutionIdByRunId,
    { onWriteFailure: deps.onWriteFailure },
  );
}
