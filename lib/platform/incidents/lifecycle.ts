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
import type { Prisma, SyncIssueKind } from "@prisma/client";
import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";
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
import { buildOccurrenceEvidenceSummary, buildResolutionEvidence } from "./evidence";
import { isRegistryCode, type IncidentEventType, type ResolutionReasonCode } from "./codes";
import { resolveOperationKey } from "./operation-key";
// The ledger is reached through the canonical row seam — never directly. The
// OPS-2B read-boundary ratchet enforces this, and caught an earlier version of
// this module reading RefreshExecution itself.
import { getExecutionIdByRunId } from "@/lib/platform/refresh/execution-query";

/**
 * The resolution kinds (PB-1 S2). Each has exactly one writer:
 *   AUTOMATIC_RECOVERY  resolveByAutomaticRecovery (evidence of the same operation succeeding)
 *   SUBJECT_REMOVED     resolveBySubjectRemoval (S3) — the subject is gone; NEVER a recovery
 *   OPERATOR_RESOLVED   declared for the invariant; its writer (applyOperatorTransition) is S6
 */
export const RESOLUTION_KIND_AUTOMATIC = "AUTOMATIC_RECOVERY" as const;
export const RESOLUTION_KIND_OPERATOR = "OPERATOR_RESOLVED" as const;
export const RESOLUTION_KIND_SUBJECT_REMOVED = "SUBJECT_REMOVED" as const;
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

export interface AutomaticRecoveryScope {
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
 * and the ZERO-OR-PARTIAL update is checked against the rows this very call
 * observed moments earlier under the same authority — the escape clause of the
 * indeterminate-write rule, used deliberately (lib/db/conditional-write.ts). The
 * `findMany` above is therefore THE GUARD and not an optimisation to be hoisted
 * away: delete it and a refused resolution becomes indistinguishable from a
 * clean item again.
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
      where: { plaidItemId: scope.plaidItemId, resolved: false },
      select: { id: true, kind: true, provider: true, detail: true, plaidTransactionId: true },
    });

    // Ask the semantics authority which of these this success actually proves.
    const matching = candidates.filter((c) => {
      const cls = classifySyncIssue({
        kind: c.kind,
        provider: c.provider,
        detail: c.detail,
        plaidTransactionId: c.plaidTransactionId,
      });
      return cls.nature === "condition" && cls.domain === scope.domain && cls.cursorBlocking;
    });
    if (matching.length === 0) return { resolved: 0, resolvingExecutionId };

    const now = new Date();
    const resolution = {
      resolved: true, resolvedAt: now,
      resolutionKind: RESOLUTION_KIND_AUTOMATIC as string,
      resolvingExecutionId,
    };
    // The resolver only ever sees CONDITIONS — events are stored terminal and so
    // never appear in the unresolved set above. Asserted anyway: this is the
    // write that would turn evidence into a fabricated recovery.
    const bad = lifecycleViolation("condition", { ...resolution, incidentKey: null });
    if (bad) {
      console.error(`[incidents] refusing invalid resolution write: ${bad}`);
      // An INVARIANT refusal, deliberately NOT reported as a write failure: the
      // write was correctly prevented, nothing is missing from the ledger, and
      // alerting on it would train an operator to ignore the channel.
      return { resolved: 0, resolvingExecutionId };
    }
    const { count } = await client.syncIssue.updateMany({
      where: { id: { in: matching.map((m) => m.id) } },
      // For a CONDITION these move together — see invariant.ts for why that is
      // NOT a universal rule about the `resolved` column.
      data: resolution,
    });
    // THE ROWS WERE OBSERVED ONE STATEMENT AGO, UNDER THIS AUTHORITY. So a
    // shortfall is neither contention nor idempotence — a row already resolved
    // was never in `matching`, because `matching` came from `resolved: false`.
    // What is left is a row that WAS eligible and WAS NOT written, and the
    // caller is not entitled to call that "nothing to do". Raises into the
    // catch below, which swallows it as the contract requires and now reports
    // it. On fm_system the policy is USING(true), so a disagreement can only
    // come from concurrent modification — which is exactly why it is an alarm.
    assertEveryObservedRowWasWritten(
      { table: "SyncIssue", operation: "update", scope: `${matching.length} matching active condition(s)` },
      matching.length,
      count,
    );
    if (count > 0) {
      console.log(
        `[incidents] item ${scope.plaidItemId} — resolved ${count} ${scope.domain} incident(s) by automatic recovery` +
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
