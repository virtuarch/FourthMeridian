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
import { db } from "@/lib/db";
import type { Prisma, SyncIssueKind } from "@prisma/client";
import { redactedErrorForLog } from "@/lib/plaid/errors";
import { classifySyncIssue } from "@/lib/platform/sync-issue-semantics";
import { buildIncidentKey, INCIDENT_KEY_VERSION, type ConnectionScope } from "./identity";
import { lifecycleViolation } from "./invariant";
import { resolveOperationKey } from "./operation-key";
// The ledger is reached through the canonical row seam — never directly. The
// OPS-2B read-boundary ratchet enforces this, and caught an earlier version of
// this module reading RefreshExecution itself.
import { getExecutionIdByRunId } from "@/lib/platform/refresh/execution-query";

/** The ONLY resolution kind any current code path can produce. */
export const RESOLUTION_KIND_AUTOMATIC = "AUTOMATIC_RECOVERY" as const;
export type ResolutionKind = typeof RESOLUTION_KIND_AUTOMATIC;

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
}

/**
 * The accessors this authority needs. STRUCTURAL, not `typeof db`, because most
 * producers thread a narrow transaction client — the same reason recordSyncIssue
 * has always taken a Pick. `refreshExecution` is read-only here (correlator
 * lookup); the ledger is never written from this module.
 */
export type IncidentClient = Pick<typeof db, "syncIssue" | "syncIssueOccurrence">;
type Client = IncidentClient;

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
  client: Client = db,
  /** Injection seam — production uses the canonical row seam. */
  lookupExecutionId: LookupExecutionId | undefined = getExecutionIdByRunId,
): Promise<DetectionResult | null> {
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
      const occ = await client.syncIssueOccurrence.create({
        data: {
          syncIssueId: incidentId,
          refreshExecutionId: executionId,
          runId: obs.runId ?? null,
          observedAt: now,
          detail: obs.detail,
        },
        select: { id: true },
      });
      return occ.id;
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
        data: { ...baseData, ...fields, previousIncidentId: prior?.id ?? null },
        select: { id: true },
      });
      return {
        incidentId: incident.id,
        occurrenceId: await appendOccurrence(incident.id),
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
 */
export async function resolveByAutomaticRecovery(
  scope: AutomaticRecoveryScope,
  client: Client = db,
  /** Injection seam — production uses the canonical row seam. */
  lookupExecutionId: LookupExecutionId | undefined = getExecutionIdByRunId,
): Promise<{ resolved: number; resolvingExecutionId: string | null }> {
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
    if (bad) { console.error(`[incidents] refusing invalid resolution write: ${bad}`); return { resolved: 0, resolvingExecutionId }; }
    const { count } = await client.syncIssue.updateMany({
      where: { id: { in: matching.map((m) => m.id) } },
      // For a CONDITION these move together — see invariant.ts for why that is
      // NOT a universal rule about the `resolved` column.
      data: resolution,
    });
    if (count > 0) {
      console.log(
        `[incidents] item ${scope.plaidItemId} — resolved ${count} ${scope.domain} incident(s) by automatic recovery` +
          (resolvingExecutionId ? ` (execution ${resolvingExecutionId})` : " (no execution correlator)"),
      );
    }
    return { resolved: count, resolvingExecutionId };
  } catch (e) {
    console.error("[incidents] automatic resolution failed (non-fatal):", redactedErrorForLog(e));
    return { resolved: 0, resolvingExecutionId: null };
  }
}
