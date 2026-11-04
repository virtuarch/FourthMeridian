/**
 * lib/platform/incidents/lifecycle.ts  (OPS-2D-5A-1)
 *
 * The two lifecycle authorities: DETECTION and AUTOMATIC RESOLUTION.
 *
 * Producers hand this module typed facts. They never query for an active
 * episode, never build a key, never decide recurrence, never write an
 * occurrence, and never touch a lifecycle field — because every one of those
 * decisions has exactly one correct answer and twelve call sites cannot each be
 * trusted to reach it.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not classify. `lib/platform/sync-issue-semantics.ts` is the shipped
 * authority for domain, severity, nature and the active/recovered/evidence/
 * superseded/orphaned state, consumed by six surfaces. This module ASKS it for
 * domain and nature and stores neither. A second classifier here would be the
 * duplication that authority exists to prevent.
 *
 * EVENTS ARE NOT CONDITIONS
 * -------------------------
 * `nature === "event"` (REMOVED_TOMBSTONE, BALANCE_TX_MISMATCH,
 * INSTRUMENT_IDENTITY_CONFLICT) records that something happened. It is never
 * active and never resolvable: a later clean run does not prove an earlier
 * observation false. Events therefore get an episode row and an occurrence for
 * evidence, but are recorded RESOLVED-inert — they never enter the active
 * lifecycle and the resolver refuses to touch them. Using one shape keeps the
 * occurrence history uniform; the semantics authority already renders them as
 * "evidence" rather than as open problems.
 */

import "server-only";
// ⚠️ RLS-P-3a — fm_system. `SyncIssue` / `SyncIssueOccurrence` are revoked from
// fm_app outright (…_rls_roles_and_policies §4), and this module is the only
// thing in the product tree permitted to touch either row
// (incident-boundary.test.ts §4). The client stays a PARAMETER for the reason
// lib/plaid/syncIssues.ts gives — the injection seam is what keeps a unit test's
// error path from writing a real row — so what moves here is the DEFAULT. Used
// as a type (`Pick<typeof systemDb, …>`) as well as a value, which keeps the
// structural accessor set anchored to a real client rather than hand-listed.
import { systemDb } from "@/lib/db";
import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";
import type { Prisma, SyncIssueKind } from "@prisma/client";
import {
  captureLedgerWriteFailure,
  type LedgerWriteObserver,
  type LedgerWritePhase,
  type OperationalLedger,
} from "@/lib/monitoring/capture";
import { redactedErrorForLog } from "@/lib/plaid/errors";
import { classifySyncIssue } from "@/lib/platform/sync-issue-semantics";
import { buildIncidentKey, INCIDENT_KEY_VERSION, type ConnectionScope } from "./identity";
import { lifecycleViolation, RESOLUTION_KINDS, type ResolutionKindValue } from "./invariant";
import { subjectVerdict } from "./subjects-core";
import { loadOccurrenceAccounts, loadSubjectFacts, ownerOf } from "./subjects";
import { buildOccurrenceEvidenceSummary, buildResolutionEvidence, mayAdvanceRecovery, type StageFact } from "./evidence";
import { isOperatorResolutionReasonCode, isRegistryCode, type IncidentEventType, type OperatorResolutionReasonCode, type ResolutionReasonCode } from "./codes";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import { resolveOperationKey } from "./operation-key";
// The ledger is reached through the canonical row seam — never directly. The
// OPS-2B read-boundary ratchet enforces this, and caught an earlier version of
// this module reading RefreshExecution itself.
import { getExecutionIdByRunId } from "@/lib/platform/refresh/execution-query";

/**
 * The resolution kinds (PB-1 S2). Each has exactly one writer:
 *   AUTOMATIC_RECOVERY  resolveByAutomaticRecovery (evidence of the same operation succeeding)
 *   SUBJECT_REMOVED     resolveBySubjectRemoval (S3) — the subject is gone; NEVER a recovery
 *   OPERATOR_RESOLVED   applyOperatorTransition (S6) — an operator closed it, with a reason and an audit row
 */
export const RESOLUTION_KIND_AUTOMATIC = "AUTOMATIC_RECOVERY" as const;
export const RESOLUTION_KIND_OPERATOR = "OPERATOR_RESOLVED" as const;
export const RESOLUTION_KIND_SUBJECT_REMOVED = "SUBJECT_REMOVED" as const;
/** AUTOMATIC_RECOVERY evidence rules (`resolutionEvidence.rule`), one per proven domain. */
export const RECOVERY_RULE_TRANSACTIONS_SYNCED = "TRANSACTIONS_SYNC_SUCCEEDED_V1" as const;
export const RECOVERY_RULE_BALANCE_OBSERVED = "BALANCE_OBSERVED_V1" as const;
/** OPERATOR_RESOLVED evidence rule (`resolutionEvidence.rule`) — a reference to the audit row, never proof. */
export const OPERATOR_RESOLVED_RULE = "OPERATOR_RESOLVED_V1" as const;
export { RESOLUTION_KINDS };
export type ResolutionKind = ResolutionKindValue;

/** Typed failure evidence a producer submits. */
export interface IncidentObservation {
  kind: SyncIssueKind;
  provider?: string | null;
  plaidItemId?: string | null;
  financialAccountId?: string | null;
  plaidTransactionId?: string | null;
  plaidAccountId?: string | null;
  /**
   * The owning RefreshExecution's run correlator, when the producer has one.
   *
   * NOT trusted as a relation. `runId` is `RefreshExecution.runId` when a caller
   * threaded one — but `syncTransactionsForItem` mints a standalone UUID when
   * nobody did (exchangeToken still calls it that way), so the same field is
   * sometimes a real correlator and sometimes an orphan. This module LOOKS IT UP
   * and stores the FK only if an execution actually exists.
   */
  runId?: string | null;
  /**
   * OPS-2D-5A-2 — wallet scope for non-Plaid providers (BTC). Only consulted
   * when there is no item and no account.
   */
  walletId?: string | null;
  detail?: Prisma.InputJsonValue;
  // ── PB-1 Phase 1 — typed facts, resolved by the facade, never parsed here ──
  /** The subject's authoritative owner (PlaidItem.userId / FinancialAccount owner). Set on a NEW episode only. */
  subjectUserId?: string | null;
  /** Structured occurrence subjects (soft refs). */
  subjectAccountId?: string | null;
  securityId?: string | null;
  /** The JobRun this observation ran under (ambient), when any. */
  jobRunId?: string | null;
  jobName?: string | null;
}

/**
 * The accessors this authority needs. STRUCTURAL, not `typeof db`, so a test can
 * substitute a fake — but it REQUIRES `$transaction`, and that requirement is
 * the whole of OPS-2D-TX-1.
 *
 * ── WHY `$transaction` IS IN THIS TYPE ───────────────────────────────────────
 * A `Prisma.TransactionClient` is `Omit<PrismaClient, ITXClientDenyList>` and
 * `ITXClientDenyList` contains `$transaction`. Naming it here therefore makes a
 * caller's transaction client FAIL TO TYPE-CHECK at every incident call site.
 * That is deliberate, and it is a compile-time prohibition rather than a comment
 * because the runtime consequence of getting it wrong is silent financial data
 * loss. Reproduced against real PostgreSQL 16 (scripts/test-incident-
 * transaction-safety.ts):
 *
 *   caller opens a transaction, writes a financial row
 *     → records an incident through the SAME transaction client
 *     → loses the partial-unique-index race
 *     → Postgres raises 23505, Prisma surfaces P2002
 *     → THE CALLER'S TRANSACTION IS NOW ABORTED (SQLSTATE 25P02)
 *     → the convergence retry below queries with that same client and fails
 *     → this module's outer catch swallows it and returns null
 *     → every later statement in the caller's transaction fails
 *     → COMMIT silently degrades to ROLLBACK — the caller is told it succeeded
 *     → the financial rows are gone, and nothing anywhere reports an error
 *
 * Observation must never control the observed operation. An incident is
 * telemetry about an operation that ALREADY FAILED; it cannot be allowed to
 * decide whether the surrounding financial mutation lives. So incident writes
 * run on their own connection, outside any caller transaction, always.
 *
 * This also isolates every OTHER failure mode, not just P2002: a check
 * constraint, an FK violation or a statement timeout inside the incident write
 * would abort a caller's transaction exactly the same way. Excluding the
 * transaction client closes all of them at once, which is why this is preferred
 * over making the P2002 path alone conflict-free.
 *
 * `refreshExecution` is read-only here (correlator lookup); the ledger is never
 * written from this module.
 */
export type IncidentClient = Pick<typeof systemDb, "syncIssue" | "syncIssueOccurrence" | "$transaction">
  /**
   * PB-1 Phase 1 — the append-only chronology. OPTIONAL in the type only so the
   * pre-existing test fakes need not model it; the real client always has it.
   * A client without it writes no event (and says so in the log).
   */
  & Partial<Pick<typeof systemDb, "syncIssueEvent">>;
type Client = IncidentClient;

/**
 * Runtime backstop for the type above.
 *
 * Unreachable from type-checked code — which is the point: this catches the
 * `as never` cast, the JS caller and the `any` that the compiler cannot. It
 * REFUSES rather than falling back to the module-level `db`, because silently
 * redirecting an injected client to the real database is the exact defect that
 * put eight test rows in a developer's database (see lib/plaid/syncIssues.ts).
 * Losing one telemetry row loudly beats writing it somewhere nobody asked for.
 */
function isTransactionScoped(client: Client): boolean {
  return typeof (client as { $transaction?: unknown }).$transaction !== "function";
}

/**
 * Refuse, loudly, and tell the operator which contract was broken. Telemetry
 * loss must be observable — that is the third rule of the safety hierarchy,
 * after "never corrupt the mutation" and "preserve evidence when safe".
 */
function refuseTransactionScopedClient(operation: string): void {
  console.error(
    `[incidents] REFUSED ${operation}: the client has no $transaction, so it is a ` +
      "caller's transaction client. Incident recording never runs inside a caller " +
      "transaction — a convergence race would abort it and silently discard the " +
      "financial mutation being observed (OPS-2D-TX-1). Telemetry dropped.",
  );
}

/** Postgres unique-violation — the partial index doing its job. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/**
 * Resolve `runId` to a real RefreshExecution.id, or null.
 *
 * A LOOKUP, never an assumption. Returning null when the correlator names no
 * execution is the honest answer and is common — several producers have no
 * envelope at all, and this is exactly the fabrication the slice forbids.
 */
type LookupExecutionId = (runId: string) => Promise<string | null>;

async function resolveExecutionId(
  runId: string | null | undefined,
  lookup: LookupExecutionId,
): Promise<string | null> {
  if (!runId) return null;
  return lookup(runId);
}

export interface DetectionResult {
  incidentId: string;
  occurrenceId: string;
  incidentKey: string;
  /** True when this observation opened a new episode rather than joining one. */
  created: boolean;
  /** The resolved execution FK, or null when the correlator named none. */
  refreshExecutionId: string | null;
}

/**
 * ── RLS-P-2 — THE OBSERVER, AND WHY `null` WAS NOT ENOUGH ────────────────────
 *
 * Both functions below swallow every failure and return a calm value: `null`
 * from detection, `{resolved: 0}` from resolution. Those values are also what a
 * perfectly healthy call returns when there was nothing to do — a refused
 * lifecycle write, an invariant refusal and "no active episode matched" are
 * indistinguishable to every caller. That is the silent-refusal defect
 * (docs/architecture/SECURITY_MODEL.md §The silent-refusal hazard, Writes) sitting on two tables `fm_app`
 * is revoked from outright, so under the authority flip a grant refusal here
 * would have reported health.
 *
 * The swallow is NOT removed — fourteen producers call this from inside their
 * own catch blocks, and OPS-2D-TX-1 is the whole reason observation may never
 * control the observed operation. What changes is that the failure is now
 * ANNOUNCED on a side channel that cannot affect control flow: an optional,
 * synchronous callback carrying a table and a phase and nothing else.
 *
 * ⚠️ IT IS NOT A RETURN VALUE ON PURPOSE. `DetectionResult | null` is consumed
 * by three operator harnesses and the facade; widening it would have rippled
 * into files this slice does not own, and more importantly a caller that
 * BRANCHED on the failure would be letting telemetry decide what happens to the
 * financial operation. A callback can only be listened to.
 */
export interface LifecycleObservers {
  /** Called at most once per invocation, with the statement that failed. */
  onWriteFailure?: LedgerWriteObserver;
}

/** Fire an observer without letting it become the failure it reports. */
function reportWriteFailure(
  observers: LifecycleObservers | undefined,
  ledger: OperationalLedger,
  phase: LedgerWritePhase,
): void {
  try { observers?.onWriteFailure?.(ledger, phase); }
  catch { /* an observer that throws must not take the swallow with it */ }
}

/**
 * Record one failure occurrence, converging on the active episode.
 *
 * NEVER THROWS — the same contract `recordSyncIssue` has always had. Telemetry
 * must not turn a provider failure into a second, louder failure.
 *
 * The find-or-create is guarded by the partial unique index rather than by a
 * read-then-write, because two concurrent failures on one item would otherwise
 * both observe "no active episode" and both insert. The loser of that race gets
 * P2002 and retries into the winner's episode, so the invariant holds under
 * concurrency: ONE active episode, N occurrences.
 */
export async function recordIncidentObservation(
  obs: IncidentObservation,
  client: Client = systemDb,
  /** Injection seam — production uses the canonical row seam. */
  lookupExecutionId: LookupExecutionId | undefined = getExecutionIdByRunId,
  /** RLS-P-2 — listen-only; see LifecycleObservers. Optional everywhere. */
  observers?: LifecycleObservers,
): Promise<DetectionResult | null> {
  if (isTransactionScoped(client)) {
    refuseTransactionScopedClient("recordIncidentObservation");
    // A refused client is a DROPPED telemetry row, not a no-op, so it is
    // reported on the same channel as a failed write. Without this the one
    // failure mode with a dedicated console message was also the one the
    // degradation list could not see.
    reportWriteFailure(observers, "SyncIssue", "incident");
    return null;
  }
  /** True once the occurrence insert has named itself; see the outer catch. */
  let occurrenceReported = false;
  try {
    const provider = obs.provider ?? "PLAID";
    const { domain, nature } = classifySyncIssue({
      kind: obs.kind,
      provider,
      detail: obs.detail,
      plaidTransactionId: obs.plaidTransactionId ?? null,
    });

    const detailObj = (obs.detail ?? {}) as Record<string, unknown>;
    // OPS-2D-5B-0 — identity reads a REGISTERED operation key, not the raw
    // stage a producer typed. The two are equal for every current producer, so
    // no existing incidentKey moves; what changes is the contract — a stage may
    // now be reworded through the alias table without orphaning live episodes.
    const rawStage = typeof detailObj.stage === "string" ? detailObj.stage : null;
    const stage = resolveOperationKey(rawStage);

    // Scope precedence: the provider connection when there is one, else the
    // account, else the wallet, else explicitly unscoped. Chosen HERE so no
    // producer decides its own identity shape.
    const scope: ConnectionScope =
      obs.plaidItemId ? { kind: "PLAID_ITEM", id: obs.plaidItemId }
      : obs.financialAccountId ? { kind: "FINANCIAL_ACCOUNT", id: obs.financialAccountId }
      : obs.walletId ? { kind: "WALLET", id: obs.walletId }
      : { kind: "LEGACY_UNSCOPED" };

    const incidentKey = buildIncidentKey({
      provider,
      plaidItemId: obs.plaidItemId ?? null,
      scope,
      domain,
      stage,
    });

    const executionId = await resolveExecutionId(obs.runId, lookupExecutionId ?? getExecutionIdByRunId);
    const now = new Date();

    // An EVENT is evidence, not an open problem. It is stored resolved-inert so
    // it can never appear in an active projection or be "recovered" later.
    const isEvent = nature === "event";

    const baseData = {
      provider,
      plaidItemId: obs.plaidItemId ?? null,
      financialAccountId: obs.financialAccountId ?? null,
      kind: obs.kind,
      plaidTransactionId: obs.plaidTransactionId ?? null,
      plaidAccountId: obs.plaidAccountId ?? null,
      detail: obs.detail,
      incidentKeyVersion: INCIDENT_KEY_VERSION,
      firstOccurredAt: now,
      lastOccurredAt: now,
    };

    const appendOccurrence = async (incidentId: string) => {
      try {
        const occ = await client.syncIssueOccurrence.create({
          data: {
            syncIssueId: incidentId,
            refreshExecutionId: executionId,
            runId: obs.runId ?? null,
            observedAt: now,
            detail: obs.detail,
            // PB-1 Phase 1 — structured subjects + job link, from typed facts.
            subjectAccountId: obs.subjectAccountId ?? null,
            securityId: obs.securityId ?? null,
            jobRunId: obs.jobRunId ?? null,
            jobName: obs.jobName ?? null,
            evidenceSummary: buildOccurrenceEvidenceSummary({
              executionId, runId: obs.runId ?? null, jobRunId: obs.jobRunId ?? null,
              jobName: obs.jobName ?? null, stage,
            }) as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        return occ.id;
      } catch (e) {
        // RLS-P-2 — ATTRIBUTION ONLY. The rethrow is unchanged, so the outer
        // catch still swallows and still returns null and the control flow is
        // byte-identical; what this adds is that the degradation names
        // SyncIssueOccurrence rather than being folded into SyncIssue. The two
        // have different causes: an occurrence insert cannot lose the
        // convergence race, so a failure here is a grant, an FK or a drift and
        // never contention.
        occurrenceReported = true;
        reportWriteFailure(observers, "SyncIssueOccurrence", "incident");
        throw e;
      }
    };

    if (isEvent) {
      // Events never converge — each observation is its own evidence record, and
      // there is no active episode for it to join.
      const fields = {
        resolved: true, resolvedAt: null, resolutionKind: null,
        resolvingExecutionId: null, incidentKey: null,
      };
      const bad = lifecycleViolation("event", fields);
      if (bad) { console.error(`[incidents] refusing invalid event write: ${bad}`); return null; }
      const incident = await client.syncIssue.create({
        data: { ...baseData, ...fields },
        select: { id: true },
      });
      return {
        incidentId: incident.id,
        occurrenceId: await appendOccurrence(incident.id),
        incidentKey,
        created: true,
        refreshExecutionId: executionId,
      };
    }

    // CONDITION — converge on the active episode for this identity.
    const existing = await client.syncIssue.findFirst({
      where: { incidentKey, resolved: false },
      select: { id: true },
    });

    if (existing) {
      await client.syncIssue.update({
        where: { id: existing.id },
        data: { lastOccurredAt: now },
      });
      return {
        incidentId: existing.id,
        occurrenceId: await appendOccurrence(existing.id),
        incidentKey,
        created: false,
        refreshExecutionId: executionId,
      };
    }

    // Recurrence: link the most recent resolved episode for this identity.
    const prior = await client.syncIssue.findFirst({
      where: { incidentKey, resolved: true },
      orderBy: { resolvedAt: "desc" },
      select: { id: true },
    });

    try {
      const fields = {
        resolved: false, resolvedAt: null, resolutionKind: null,
        resolvingExecutionId: null, incidentKey,
      };
      const bad = lifecycleViolation("condition", fields);
      if (bad) { console.error(`[incidents] refusing invalid condition write: ${bad}`); return null; }
      const incident = await client.syncIssue.create({
        data: {
          ...baseData, ...fields, previousIncidentId: prior?.id ?? null,
          // PB-1 Phase 1 — the owner at observation, and how the episode opened.
          // lifecycleState stays NULL (derived from `resolved`) until the state
          // machine lands; no reader depends on it yet.
          subjectUserId: obs.subjectUserId ?? null,
          openedBy: prior ? "RECURRENCE" : "OBSERVATION",
        },
        select: { id: true },
      });
      const occurrenceId = await appendOccurrence(incident.id);
      // OBSERVED — once, at episode open; occurrences are never mirrored.
      await appendEvent(client, {
        incidentId: incident.id, type: "OBSERVED", actorKind: "SYSTEM",
        occurrenceId, refreshExecutionId: executionId, jobRunId: obs.jobRunId ?? null,
      }, observers);
      return {
        incidentId: incident.id,
        occurrenceId,
        incidentKey,
        created: true,
        refreshExecutionId: executionId,
      };
    } catch (e) {
      // The partial unique index rejected a concurrent duplicate. Someone else
      // opened the episode first; join theirs rather than failing the caller.
      if (!isUniqueViolation(e)) throw e;
      const winner = await client.syncIssue.findFirst({
        where: { incidentKey, resolved: false },
        select: { id: true },
      });
      if (!winner) throw e;
      await client.syncIssue.update({ where: { id: winner.id }, data: { lastOccurredAt: now } });
      return {
        incidentId: winner.id,
        occurrenceId: await appendOccurrence(winner.id),
        incidentKey,
        created: false,
        refreshExecutionId: executionId,
      };
    }
  } catch (e) {
    console.error("[incidents] failed to record observation (non-fatal):", redactedErrorForLog(e));
    // RLS-P-2 — ESCALATED, NOT ONLY LOGGED, and reported to the caller's
    // observer. `return null` is the contract and stays the contract; what it
    // must stop being is the ONLY trace. `occurrenceReported` keeps the
    // attribution precise: when the occurrence insert is what failed it has
    // already named itself, and reporting SyncIssue on top would turn one
    // failure into two.
    captureLedgerWriteFailure("SyncIssue", "incident", e);
    if (!occurrenceReported) reportWriteFailure(observers, "SyncIssue", "incident");
    return null;
  }
}

// ── Automatic resolution ─────────────────────────────────────────────────────

export type AutomaticRecoveryScope =
  | {
      /** The connection whose work succeeded. */
      plaidItemId: string;
      /**
       * The semantic scope that recovered. Only incidents whose own scope MATCHES
       * are resolved — an investments stage succeeding says nothing about a held
       * transaction page, and item health turning ACTIVE says nothing about either.
       */
      domain: "transactions";
      /** The run that proved recovery. Null stays null; never invented. */
      runId?: string | null;
    }
  | {
      /**
       * FIN-A2 — the ACCOUNT whose first observed balance just landed. The proof
       * is exactly that write, so the scope is the account, never its item: a
       * balance on one account says nothing about another's.
       */
      financialAccountId: string;
      domain: "balances";
      runId?: string | null;
    };

/**
 * Which unresolved candidates a success in `scope` actually proves. ONE rule
 * per domain, derived from the semantics authority:
 *   transactions  a held (cursor-blocking) transaction condition — a completed
 *                 sync proves the held page replayed;
 *   balances      the account's BALANCE_UNOBSERVED condition — an observed
 *                 balance written for that account is the evidence.
 */
function provenByRecovery(
  scope: AutomaticRecoveryScope,
  cls: { nature: string; domain: string; cursorBlocking: boolean },
  kind: string,
): boolean {
  if (cls.nature !== "condition" || cls.domain !== scope.domain) return false;
  return scope.domain === "transactions" ? cls.cursorBlocking : kind === "BALANCE_UNOBSERVED";
}

/**
 * Resolve the active CONDITION episodes that this success actually remediates.
 *
 * MATCHING IS THE WHOLE CONTRACT. The only recovery current code can prove is
 * the cursor-blocking one: a later successful sync means the held page replayed
 * and every row persisted. A pre-cursor-safety failure has no such proof — its
 * cursor already advanced — so it must never auto-resolve, and
 * `classifySyncIssue().cursorBlocking` is what separates the two.
 *
 * Events are excluded structurally: they are stored resolved-inert and so can
 * never appear in the active set this queries.
 *
 * ── ⚠️ RLS-P-2 — `{resolved: 0}` MEANT THREE DIFFERENT THINGS ────────────────
 * It meant "this item had no open cursor-blocking episode" (the common, healthy
 * case), "an invariant refused the write", and "the write failed or was refused
 * by a policy" — and a caller reading the number could not tell them apart. The
 * third is the serious one: the episode stays OPEN, the recovery that genuinely
 * happened is never recorded, and the item reads as permanently broken while
 * every log line says zero.
 *
 * The count stays the count. The failure now travels on the observer channel,
 * and each row's compare-and-set is checked against the state this very call
 * observed moments earlier under the same authority — the escape clause of the
 * indeterminate-write rule, used deliberately (lib/db/conditional-write.ts). The
 * `findMany` above is therefore THE GUARD and not an optimisation to be hoisted
 * away: delete it and a refused resolution becomes indistinguishable from a
 * clean item again.
 *
 * ── P8 #1 — A RECOVERY IS A TRANSITION, WITH ITS PROOF ───────────────────────
 * Same shape as resolveBySubjectRemoval, ONE small transaction PER ROW (a lost
 * CAS skips only that row, reported as a conflict; the return counts
 * successes): the CAS (`lifecycleState` as read, `resolved: false`), `lifecycleState: RESOLVED`
 * with `resolved`, the typed `resolutionEvidence` (the SUCCEEDED transactions
 * stage, or the observed balance) and a SYSTEM `STATE_CHANGED → RESOLVED`
 * event. Forward-only: closures written before this change carry neither.
 *
 * ── ⚠️ THE PROOF IS SYNTHESISED HERE — ITS LEGITIMACY IS THE CALL SITES ─────
 * The stage fact (SUCCEEDED, completedAt = now) is built by this resolver, not
 * read from the ledger. It is true only because of WHO calls it, so the callers
 * are pinned (lib/platform/incidents/auto-recovery-callers.test.ts):
 *   - the ONLY production callers are the two facades in lib/plaid/syncIssues.ts:
 *     resolveCursorBlockingIssues (transactions) and
 *     resolveBalanceUnobservedIssue (balances);
 *   - resolveCursorBlockingIssues is reached only after a COMPLETED transactions
 *     sync (syncTransactionsForItem, after the success health flip — directly,
 *     or through the refresh ledger door's resolveIncidentsByRecovery);
 *   - resolveBalanceUnobservedIssue is reached only on an OBSERVED balance write
 *     (refreshBalancesForItem after the update, guarded by `plan.observed`;
 *     re-exchange guarded by `balanceStamp.balanceObserved`).
 * A new caller must hold the same success condition, or it fabricates proof.
 * `executionId` is the looked-up correlator: null when there is no run, and it
 * STAYS null — never filled in.
 */
export async function resolveByAutomaticRecovery(
  scope: AutomaticRecoveryScope,
  client: Client = systemDb,
  /** Injection seam — production uses the canonical row seam. */
  lookupExecutionId: LookupExecutionId | undefined = getExecutionIdByRunId,
  /** RLS-P-2 — listen-only; see LifecycleObservers. Optional everywhere. */
  observers?: LifecycleObservers,
): Promise<{ resolved: number; resolvingExecutionId: string | null }> {
  if (isTransactionScoped(client)) {
    refuseTransactionScopedClient("resolveByAutomaticRecovery");
    reportWriteFailure(observers, "SyncIssue", "resolution");
    return { resolved: 0, resolvingExecutionId: null };
  }
  try {
    const resolvingExecutionId = await resolveExecutionId(scope.runId, lookupExecutionId ?? getExecutionIdByRunId);

    const candidates = await client.syncIssue.findMany({
      where: scope.domain === "balances"
        ? { financialAccountId: scope.financialAccountId, resolved: false }
        : { plaidItemId: scope.plaidItemId, resolved: false },
      select: { id: true, kind: true, provider: true, detail: true, plaidTransactionId: true, lifecycleState: true },
    });

    // Ask the semantics authority which of these this success actually proves.
    const matching = candidates.filter((c) => {
      const cls = classifySyncIssue({
        kind: c.kind,
        provider: c.provider,
        detail: c.detail,
        plaidTransactionId: c.plaidTransactionId,
      });
      return provenByRecovery(scope, cls, c.kind);
    });
    if (matching.length === 0) return { resolved: 0, resolvingExecutionId };

    const now = new Date();
    // The proof, as a typed stage fact: the operation that just SUCCEEDED for
    // this subject. Ids, an endpoint and an instant only — no amount, no
    // provider text. `executionId` is the looked-up correlator or null.
    const proof: StageFact = scope.domain === "balances"
      ? { source: "BalanceObservation", executionId: resolvingExecutionId, endpoint: "BALANCES", status: "SUCCEEDED", completedAt: now.toISOString() }
      : { source: "RefreshEndpointResult", executionId: resolvingExecutionId, endpoint: "TRANSACTIONS", status: "SUCCEEDED", completedAt: now.toISOString() };
    const evidence = buildResolutionEvidence({
      rule: scope.domain === "balances" ? RECOVERY_RULE_BALANCE_OBSERVED : RECOVERY_RULE_TRANSACTIONS_SYNCED,
      facts: [proof],
    });
    // §12 P2.1 — the one gate every resolver passes. Always true for the fact
    // above; asserted so a future edit that records a non-proof cannot close.
    if (!mayAdvanceRecovery(evidence)) {
      console.error("[incidents] refusing automatic resolution without SUCCEEDED proof");
      return { resolved: 0, resolvingExecutionId };
    }
    const data = {
      resolved: true, resolvedAt: now,
      resolutionKind: RESOLUTION_KIND_AUTOMATIC as string,
      resolvingExecutionId,
      lifecycleState: "RESOLVED",
      // The DB CHECK: a RESOLVED lifecycleState names its reason (registry code).
      resolutionReasonCode: (scope.domain === "balances" ? "BALANCE_OBSERVED" : "TRANSACTIONS_SYNC_SUCCEEDED") satisfies ResolutionReasonCode,
      resolutionEvidence: evidence as unknown as Prisma.InputJsonValue,
    };
    // The resolver only ever sees CONDITIONS — events are stored terminal and so
    // never appear in the unresolved set above. Asserted anyway: this is the
    // write that would turn evidence into a fabricated recovery.
    const bad = lifecycleViolation("condition", { ...data, incidentKey: null });
    if (bad) {
      console.error(`[incidents] refusing invalid resolution write: ${bad}`);
      // An INVARIANT refusal, deliberately NOT reported as a write failure: the
      // write was correctly prevented, nothing is missing from the ledger, and
      // alerting on it would train an operator to ignore the channel.
      return { resolved: 0, resolvingExecutionId };
    }
    // THE SUBJECT-REMOVAL SHAPE (P8 #1), PER ROW (S2): each matching row gets
    // its OWN small transaction — compare-and-set on the state this call READ,
    // then its STATE_CHANGED event — so the append-only timeline is never silent
    // about the most common closure. Rows are independent incidents: a
    // contended row must never starve its siblings, so a lost CAS (0 rows: the
    // row moved between the read and the write) rolls back ONLY that row, is
    // logged as a CONFLICT and reported, and is retried by the next success.
    // Any other failure (e.g. the event insert) also rolls back only its row.
    let written = 0;
    let conflicts = 0;
    let failed = 0;
    for (const c of matching) {
      // The state AS READ, captured before the write: it is both the CAS
      // expectation and the event's fromState (NULL = legacy, derived ACTIVE).
      const asRead = c.lifecycleState ?? null;
      try {
        await client.$transaction(async (tx) => {
          const { count: n } = await tx.syncIssue.updateMany({
            where: { id: c.id, resolved: false, lifecycleState: asRead },
            data,
          });
          if (n !== 1) throw new IncidentTransitionConflictError(c.id, asRead);
          await tx.syncIssueEvent.create({
            data: eventData({
              incidentId: c.id, type: "STATE_CHANGED", actorKind: "SYSTEM",
              fromState: asRead ?? "ACTIVE", toState: "RESOLVED", outcomeCode: null,
              refreshExecutionId: resolvingExecutionId,
            }),
            select: { id: true },
          });
        });
        written += 1;
      } catch (e) {
        if (e instanceof IncidentTransitionConflictError) {
          // Contention, not a defect: logged as a conflict, retried next sync —
          // but still REPORTED, so a shortfall is never read as "nothing to do".
          conflicts += 1;
          console.warn(`[incidents] automatic-recovery CONFLICT on ${c.id} (state moved since read; retried on the next success)`);
        } else {
          failed += 1;
          console.error(`[incidents] automatic-recovery transition for ${c.id} failed (non-fatal):`, redactedErrorForLog(e));
          captureLedgerWriteFailure("SyncIssue", "resolution", e);
        }
        reportWriteFailure(observers, "SyncIssue", "resolution");
      }
    }
    // THE ROWS WERE OBSERVED ONE STATEMENT AGO, UNDER THIS AUTHORITY — the
    // per-row tally: every observed row was either WRITTEN or REPORTED (as a
    // conflict or a failure). Nothing is silently dropped. The `findMany` above
    // stays THE GUARD (lib/db/conditional-write.ts doctrine).
    assertEveryObservedRowWasWritten(
      { table: "SyncIssue", operation: "update", scope: `${matching.length} matching active condition(s), written or reported` },
      matching.length,
      written + conflicts + failed,
    );
    const count = written;
    if (count > 0) {
      console.log(
        `[incidents] ${scope.domain === "balances" ? `account ${scope.financialAccountId}` : `item ${scope.plaidItemId}`} — resolved ${count} ${scope.domain} incident(s) by automatic recovery` +
          (resolvingExecutionId ? ` (execution ${resolvingExecutionId})` : " (no execution correlator)"),
      );
    }
    return { resolved: count, resolvingExecutionId };
  } catch (e) {
    console.error("[incidents] automatic resolution failed (non-fatal):", redactedErrorForLog(e));
    captureLedgerWriteFailure("SyncIssue", "resolution", e);
    reportWriteFailure(observers, "SyncIssue", "resolution");
    return { resolved: 0, resolvingExecutionId: null };
  }
}

// ── The chronology (PB-1 Phase 1) ────────────────────────────────────────────

/** One SyncIssueEvent. Codes and refs only — the type has no free-text field. */
export interface IncidentEventInput {
  incidentId: string;
  type: IncidentEventType;
  actorKind: "SYSTEM" | "OPERATOR";
  actorId?: string | null;
  auditId?: string | null;
  fromState?: string | null;
  toState?: string | null;
  causeCode?: string | null;
  actionCode?: string | null;
  outcomeCode?: string | null;
  refEventId?: string | null;
  occurrenceId?: string | null;
  refreshExecutionId?: string | null;
  jobRunId?: string | null;
}

type EventWriter = Partial<Pick<typeof systemDb, "syncIssueEvent">>;

/** The event row, validated against the DB CHECKs before it is sent. `at` is never sent (the DB stamps it). */
export function eventData(e: IncidentEventInput): Prisma.SyncIssueEventUncheckedCreateInput {
  for (const k of ["fromState", "toState", "causeCode", "actionCode", "outcomeCode"] as const) {
    const v = e[k];
    if (v != null && !isRegistryCode(v)) throw new Error(`SyncIssueEvent.${k} is not a registry code`);
  }
  if (e.actorKind === "OPERATOR" && (!e.actorId || !e.auditId)) throw new Error("an OPERATOR event needs actorId and auditId");
  if (e.actorKind === "SYSTEM" && e.actorId) throw new Error("a SYSTEM event carries no actorId");
  if (e.type === "CAUSE_RETRACTED" && !e.refEventId) throw new Error("CAUSE_RETRACTED must name refEventId");
  return {
    incidentId: e.incidentId, type: e.type, actorKind: e.actorKind,
    actorId: e.actorId ?? null, auditId: e.auditId ?? null,
    fromState: e.fromState ?? null, toState: e.toState ?? null,
    causeCode: e.causeCode ?? null, actionCode: e.actionCode ?? null, outcomeCode: e.outcomeCode ?? null,
    refEventId: e.refEventId ?? null, occurrenceId: e.occurrenceId ?? null,
    refreshExecutionId: e.refreshExecutionId ?? null, jobRunId: e.jobRunId ?? null,
  };
}

/**
 * Append a TELEMETRY-side event (OBSERVED). Never throws: a lost event is
 * reported on the observer and never fails the observation it describes.
 * Transition events are NOT written here — they ride the CAS transaction.
 */
async function appendEvent(client: EventWriter, e: IncidentEventInput, observers?: LifecycleObservers): Promise<void> {
  if (!client.syncIssueEvent) {
    console.warn("[incidents] client has no syncIssueEvent accessor (a test fake) — event not written");
    return;
  }
  try {
    await client.syncIssueEvent.create({ data: eventData(e), select: { id: true } });
  } catch (err) {
    console.error("[incidents] failed to append incident event (non-fatal):", redactedErrorForLog(err));
    captureLedgerWriteFailure("SyncIssue", "incident", err);
    reportWriteFailure(observers, "SyncIssue", "incident");
  }
}

/** A CAS that matched nothing — the silent-refusal hazard, raised (lib/db/conditional-write.ts doctrine). */
export class IncidentTransitionConflictError extends Error {
  constructor(readonly incidentId: string, readonly expected: string | null) {
    super(`incident ${incidentId}: the transition CAS matched 0 rows (expected lifecycleState ${expected ?? "NULL"}, resolved=false)`);
    this.name = "IncidentTransitionConflictError";
  }
}

// ── Subject removal (PB-1 S3 — design §5) ────────────────────────────────────

/**
 * The subjects a removal path just removed. Either or both; ids are CANDIDATES,
 * not verdicts — every one is re-read here, and only an incident whose subject
 * actually reads DELETED / REVOKED / MISSING is closed. A caller that names a
 * live subject closes nothing.
 */
export interface SubjectRemovalScope {
  plaidItemIds?: readonly string[];
  financialAccountIds?: readonly string[];
}

/** The incident accessors plus the two subject tables the removal rule reads. */
export type RemovalClient = IncidentClient & Pick<typeof systemDb, "financialAccount" | "plaidItem">;

/**
 * Close the open CONDITION episodes whose subject has been removed:
 * `RESOLVED / SUBJECT_REMOVED`, with `resolutionEvidence.subject`
 * `{kind, id, state: DELETED|REVOKED|MISSING, observedAt}`.
 *
 * NEVER `AUTOMATIC_RECOVERY`: a removed connection did not recover, and the UI
 * says "Closed — connection removed". Item-scoped episodes follow §12 P2.2 —
 * every account subject named across the occurrences must be removed (S3 has no
 * proof resolvers, so "proven" never applies here).
 *
 * Same contract as the other two authorities: NEVER THROWS, refuses a
 * transaction-scoped client (OPS-2D-TX-1 — the removal paths call this AFTER
 * their own transactions committed), reports a failed write on the
 * listen-only observer. A restore later does NOT reopen what this closed; the
 * next failure opens a new generation linked by previousIncidentId.
 *
 * Compare-and-set per row (`resolved: false` in the WHERE): a concurrent
 * recurrence or resolution that got there first is contention, not a defect,
 * so a zero-row write here is simply not counted.
 */
export async function resolveBySubjectRemoval(
  scope: SubjectRemovalScope,
  client: RemovalClient = systemDb,
  observers?: LifecycleObservers,
): Promise<{ resolved: number }> {
  if (isTransactionScoped(client)) {
    refuseTransactionScopedClient("resolveBySubjectRemoval");
    reportWriteFailure(observers, "SyncIssue", "resolution");
    return { resolved: 0 };
  }
  const itemIds = [...new Set(scope.plaidItemIds ?? [])].filter(Boolean);
  const accountIds = [...new Set(scope.financialAccountIds ?? [])].filter(Boolean);
  if (itemIds.length === 0 && accountIds.length === 0) return { resolved: 0 };
  try {
    const candidates = await client.syncIssue.findMany({
      where: {
        resolved: false,
        OR: [
          ...(itemIds.length ? [{ plaidItemId: { in: itemIds } }] : []),
          ...(accountIds.length ? [{ financialAccountId: { in: accountIds } }] : []),
          // §12 P2.2 — an item-scoped episode whose occurrences name a removed account.
          ...(accountIds.length ? [{ occurrences: { some: { subjectAccountId: { in: accountIds } } } }] : []),
        ],
      },
      select: {
        id: true, kind: true, provider: true, detail: true, plaidTransactionId: true,
        plaidItemId: true, financialAccountId: true, lifecycleState: true, subjectUserId: true,
      },
    });
    const conditions = candidates.filter((c) => classifySyncIssue({
      kind: c.kind, provider: c.provider, detail: c.detail, plaidTransactionId: c.plaidTransactionId,
    }).nature === "condition");
    if (conditions.length === 0) return { resolved: 0 };

    // §12 P2.2 — the persisting rule reads EVERY item-scoped episode's
    // occurrence subjects, not only the first observation's.
    const occAccounts = await loadOccurrenceAccounts(conditions.filter((c) => c.plaidItemId).map((c) => c.id), client);
    // The subjects are soft-deleted / revoked, not gone, so their owner is
    // still readable here — captured on the row BEFORE any later hard delete.
    const facts = await loadSubjectFacts(conditions, client, [...new Set([...occAccounts.values()].flat())]);

    const now = new Date();
    let resolved = 0;
    for (const c of conditions) {
      const v = subjectVerdict(c, facts, occAccounts.get(c.id) ?? []);
      if (v.verdict !== "SUBJECT_REMOVED") continue;
      const reason: ResolutionReasonCode =
        v.subject.state === "DELETED" ? "SUBJECT_DELETED" : v.subject.state === "REVOKED" ? "SUBJECT_REVOKED" : "SUBJECT_MISSING";
      const evidence = buildResolutionEvidence({
        rule: "SUBJECT_REMOVED_V1", subject: v.subject, observedAt: now,
        subjects: v.subjects.map((x) => ({ kind: x.kind, id: x.id, state: x.state })),
      });
      const data = {
        resolved: true, resolvedAt: now,
        resolutionKind: RESOLUTION_KIND_SUBJECT_REMOVED as string,
        resolvingExecutionId: null,
        lifecycleState: "RESOLVED",
        resolutionReasonCode: reason,
        resolutionEvidence: evidence as unknown as Prisma.InputJsonValue,
        // Owner captured if the row predates subjectUserId — never overwritten.
        ...(c.subjectUserId ? {} : { subjectUserId: ownerOf(c, facts.owners) }),
      };
      const bad = lifecycleViolation("condition", { ...data, incidentKey: null });
      if (bad) { console.error(`[incidents] refusing invalid subject-removal write: ${bad}`); continue; }
      try {
        // ONE transaction: compare-and-set on the state this call READ, then the
        // event. A 0-row CAS THROWS (and rolls back) — never a silent "nothing to do".
        await client.$transaction(async (tx) => {
          const { count } = await tx.syncIssue.updateMany({
            where: { id: c.id, resolved: false, lifecycleState: c.lifecycleState },
            data,
          });
          if (count !== 1) throw new IncidentTransitionConflictError(c.id, c.lifecycleState);
          await tx.syncIssueEvent.create({
            data: eventData({
              incidentId: c.id, type: "STATE_CHANGED", actorKind: "SYSTEM",
              fromState: c.lifecycleState ?? "ACTIVE", toState: "RESOLVED", outcomeCode: null,
            }),
            select: { id: true },
          });
        });
        resolved += 1;
      } catch (e) {
        // Per row: one refused transition must not strand the rest. Reported, never silent.
        console.error(`[incidents] subject-removal transition for ${c.id} refused (non-fatal):`, redactedErrorForLog(e));
        captureLedgerWriteFailure("SyncIssue", "resolution", e);
        reportWriteFailure(observers, "SyncIssue", "resolution");
      }
    }
    if (resolved > 0) {
      console.log(`[incidents] closed ${resolved} incident(s) as SUBJECT_REMOVED (connection removed — not a recovery)`);
    }
    return { resolved };
  } catch (e) {
    console.error("[incidents] subject-removal closure failed (non-fatal):", redactedErrorForLog(e));
    captureLedgerWriteFailure("SyncIssue", "resolution", e);
    reportWriteFailure(observers, "SyncIssue", "resolution");
    return { resolved: 0 };
  }
}

// ── Operator transitions (PB-1 S6 — design §6, S2 binding ruling 2026-11-04) ─

/**
 * ⚠️ B9-ROLLBACK CONSTRAINTS (S2 ruling; lift only with an owner
 * roll-forward-only decision — docs/plans/PB1-INCIDENT-LIFECYCLE.md §6.1):
 *   (a) NO writer sets a non-NULL lifecycleState other than RESOLVED. An open
 *       incident keeps lifecycleState NULL; "acknowledged" is DERIVED from the
 *       acknowledged* fields (intelligence/core.ts openStateOf). B9's
 *       automatic resolution sets resolved=true without touching
 *       lifecycleState, which satisfies `resolved = (lifecycleState =
 *       'RESOLVED')` only while open rows are NULL — so an ACKNOWLEDGED value
 *       would break a B9 rollback.
 *   (b) NOTHING writes resolved=false on an existing row. A recurrence after
 *       any closure opens a NEW episode (previousIncidentId), never a reopen.
 * Both pinned in incident-boundary.test.ts §12.
 */
export type OperatorTransition =
  | { action: "acknowledge" }
  | { action: "resolve"; resolutionReasonCode: OperatorResolutionReasonCode };

export interface OperatorTransitionInput {
  incidentId: string;
  transition: OperatorTransition;
  actor: OperatorActionInput["actor"];
  /** REQUIRED (S2): a registry code plus the optional ≤280-char scrubbed note (required by the resolve route). */
  reason: OperatorReason;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type OperatorTransitionOutcome =
  | { ok: true; changed: true; auditId: string; eventId: string; fromState: string; toState: string }
  /** Idempotent acknowledge: already acknowledged and open — nothing written, no audit. */
  | { ok: true; changed: false }
  | { ok: false; code: "NOT_FOUND" | "NOT_A_CONDITION" | "ALREADY_RESOLVED" | "CONFLICT" | "INVALID" };

/** The accessors the transition needs: a ROOT client (it opens its own transaction — F7). */
export type OperatorTransitionClient = Pick<typeof systemDb, "$transaction">;

/**
 * The ONE operator writer of SyncIssue (design §6). Opens its own transaction
 * on the root client (F7 — the operator path IS the operation, not telemetry,
 * so unlike the observers it THROWS nothing silently and returns a typed
 * refusal). Inside that transaction it:
 *   1. re-reads the row (the state AS READ is the CAS expectation);
 *   2. checks the persisted precondition — a CONDITION, not resolved;
 *      acknowledge on an already-acknowledged open row is an idempotent no-op;
 *   3. records the operator action (recordOperatorAction, reason required) and
 *      takes its AuditLog id;
 *   4. compare-and-sets on {id, resolved:false, lifecycleState, updatedAt} as
 *      read — a concurrent observation (lastOccurredAt moves ⇒ updatedAt moves),
 *      recovery or removal makes it match 0 rows, which THROWS and rolls back
 *      the audit with it (409 CONFLICT);
 *   5. appends the OPERATOR event (STATE_CHANGED, actionCode ACKNOWLEDGE |
 *      RESOLVE), stamped with the actor and the audit id.
 *
 * ACKNOWLEDGE writes acknowledgedAt + acknowledgedById + acknowledgedAuditId
 * TOGETHER (SyncIssue_acknowledged_all_or_none_check) and leaves lifecycleState
 * untouched (NULL) — constraint (a). The event records the DERIVED transition
 * (e.g. ACTIVE → ACKNOWLEDGED) for the timeline.
 *
 * RESOLVE writes lifecycleState RESOLVED with resolved=true, resolvedAt,
 * resolutionKind OPERATOR_RESOLVED, a registered operator resolutionReasonCode
 * (SyncIssue_resolved_state_reason_check), resolvedById, resolutionAuditId and
 * the typed OPERATOR_RESOLVED_V1 evidence ({auditId, via, reasonCode} only).
 *
 * REOPEN-BY-RECURRENCE. A manual resolve is a closure like any other: if the
 * subject is still failing, the next observation finds no open episode for the
 * key and opens a NEW generation (openedBy RECURRENCE, previousIncidentId = this
 * row), shown as REOPENED. This row is never mutated back open (constraint b),
 * and the alert engine sees the new open episode exactly as it sees any
 * recurrence after an automatic recovery (lib/alerts/recovery.ts).
 */
export async function applyOperatorTransition(
  input: OperatorTransitionInput,
  client: OperatorTransitionClient = systemDb,
): Promise<OperatorTransitionOutcome> {
  const t = input.transition;
  if (t.action === "resolve" && !isOperatorResolutionReasonCode(t.resolutionReasonCode)) return { ok: false, code: "INVALID" };
  try {
    return await client.$transaction(async (tx) => {
      const row = await tx.syncIssue.findUnique({
        where: { id: input.incidentId },
        select: {
          id: true, kind: true, provider: true, detail: true, plaidTransactionId: true, resolved: true,
          lifecycleState: true, updatedAt: true, acknowledgedAt: true,
        },
      });
      if (!row) return { ok: false, code: "NOT_FOUND" } as const;
      const { nature } = classifySyncIssue({ kind: row.kind, provider: row.provider, detail: row.detail, plaidTransactionId: row.plaidTransactionId });
      if (nature !== "condition") return { ok: false, code: "NOT_A_CONDITION" } as const;
      if (row.resolved) return { ok: false, code: "ALREADY_RESOLVED" } as const;
      // The DERIVED open state as read (persisted NULL ⇒ ACTIVE, or ACKNOWLEDGED by its fields).
      const asRead = row.lifecycleState ?? null;
      const fromState = asRead ?? (row.acknowledgedAt ? "ACKNOWLEDGED" : "ACTIVE");
      if (t.action === "acknowledge" && row.acknowledgedAt) return { ok: true, changed: false } as const;

      const toState = t.action === "acknowledge" ? (asRead === "RECOVERING" ? "RECOVERING" : "ACKNOWLEDGED") : "RESOLVED";
      const now = new Date();
      const audit = await recordOperatorAction(tx, {
        actor: input.actor,
        action: t.action === "acknowledge" ? AuditAction.SYNC_INCIDENT_ACKNOWLEDGED : AuditAction.SYNC_INCIDENT_RESOLVED,
        target: { kind: "SYNC_INCIDENT", id: row.id },
        reason: input.reason,
        change: { before: { state: fromState, resolved: false }, after: { state: toState, resolved: t.action === "resolve" } },
        result: "SUCCESS",
        // Ids and enums only — never `detail`, provider text or a customer id.
        detail: { kind: row.kind, provider: row.provider, ...(t.action === "resolve" ? { resolutionReasonCode: t.resolutionReasonCode } : {}) },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      });
      if (!audit.id) throw new Error("recordOperatorAction returned no AuditLog id");

      let data: Prisma.SyncIssueUpdateManyMutationInput;
      if (t.action === "acknowledge") {
        // All three together (the DB CHECK); lifecycleState deliberately NOT written (constraint a).
        data = { acknowledgedAt: now, acknowledgedById: input.actor.userId, acknowledgedAuditId: audit.id };
      } else {
        const evidence = buildResolutionEvidence({
          rule: OPERATOR_RESOLVED_RULE,
          operator: { auditId: audit.id, via: input.actor.via, reasonCode: t.resolutionReasonCode },
        });
        const fields = {
          resolved: true, resolvedAt: now,
          resolutionKind: RESOLUTION_KIND_OPERATOR as string,
          resolvingExecutionId: null,
          lifecycleState: "RESOLVED",
          resolutionReasonCode: t.resolutionReasonCode satisfies ResolutionReasonCode,
          resolvedById: input.actor.userId,
          resolutionAuditId: audit.id,
          resolutionEvidence: evidence as unknown as Prisma.InputJsonValue,
        };
        const bad = lifecycleViolation("condition", { ...fields, incidentKey: null });
        if (bad) throw new Error(`refusing invalid operator resolution write: ${bad}`);
        data = fields;
      }
      const { count } = await tx.syncIssue.updateMany({
        where: { id: row.id, resolved: false, lifecycleState: row.lifecycleState, updatedAt: row.updatedAt },
        data,
      });
      if (count !== 1) throw new IncidentTransitionConflictError(row.id, row.lifecycleState);
      const ev = await tx.syncIssueEvent.create({
        data: eventData({
          // A RECOVERING row keeps its state when acknowledged: that is an ACTION, not a state change.
          incidentId: row.id, type: fromState === toState ? "ACTION_TAKEN" : "STATE_CHANGED", actorKind: "OPERATOR",
          actorId: input.actor.userId, auditId: audit.id,
          fromState, toState, actionCode: t.action === "acknowledge" ? "ACKNOWLEDGE" : "RESOLVE",
          outcomeCode: fromState === toState ? "SUCCEEDED" : null,
        }),
        select: { id: true },
      });
      return { ok: true, changed: true, auditId: audit.id, eventId: ev.id, fromState, toState } as const;
    });
  } catch (e) {
    if (e instanceof IncidentTransitionConflictError) {
      console.warn(`[incidents] operator ${t.action} CONFLICT on ${input.incidentId} (state moved since read; nothing written)`);
      return { ok: false, code: "CONFLICT" };
    }
    throw e;
  }
}
