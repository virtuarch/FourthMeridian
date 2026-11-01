/**
 * lib/platform/connections/operator-removal.ts  (PB-5)
 *
 * AN OPERATOR REMOVES ONE CUSTOMER CONNECTION — through the customer's own
 * engine, recorded, and told to the customer.
 *
 * ══ NO SECOND ENGINE ═══════════════════════════════════════════════════════
 * The removal IS `disconnectAccounts` (lib/accounts/disconnect.ts), the ONE
 * disconnect primitive the customer's Disconnect button and account-remove
 * already share: soft-delete the accounts and their connections, revoke every
 * SpaceAccountLink, regenerate today's snapshots, then the orphan-gated
 * `disconnectPlaidItemIfOrphaned` — classified itemRemove, token scrub on a
 * confirmed removal, durable CONFIRMED / UNCONFIRMED marker. Nothing here calls
 * Plaid, writes PlaidItem.status or touches a token; an owed cleanup lands on
 * the same marker the Provider cleanup widget and plaid-removal-retry read.
 *
 * ⚠️ THE ACTOR HANDED TO THE PRIMITIVE IS THE OWNER, AND THAT IS THE POINT.
 * `disconnectAccounts(ids, actorUserId)` re-proves on the TENANT role that
 * `actorUserId` owns every id before its deployment-wide phase runs. An operator
 * owns none of them, so passing the operator would (correctly) raise
 * UnauthorizedDisconnectError. The owner's id comes from the connection row
 * read here on fm_system (PlaidItem.userId / Connection.userId) — server state,
 * never a body field — and the ids are that owner's LIVE accounts on that one
 * connection, so the primitive's proof still holds exactly: these accounts
 * belong to this owner. The operator's authority is the route's
 * requireFreshSystemAdmin gate, and the operator is recorded HERE, in the
 * operator-action row. (A consequence worth stating: SpaceAccountLink
 * .revokedByUserId records the owner, as on the customer path; the operator is
 * on the audit row, not on the link.)
 *
 * ══ ORDER ══════════════════════════════════════════════════════════════════
 *   1. resolve the connection, its owner and the owner's live accounts on it
 *   2. disconnectAccounts (the primitive)
 *   3. RE-READ the provider outcome off the marker (never PlaidItem.status)
 *   4. the operator-action row (reason required), success or failure
 *   5. the customer notification, through createNotification — after the audit
 *      row, which it references; non-throwing, so a notification problem can
 *      never fail or undo a completed removal
 *
 * ══ THE NOTIFICATION IS NEVER SENT AROUND A GATE ═══════════════════════════
 * createNotification is the single chokepoint: the registry type, the user's
 * FINANCIAL preferences, the EMAIL channel adapter → sendEmail with its
 * non-production recipient guard and storm limit, and the delivery ledger.
 * This module imports none of sendEmail, the channel adapter or a provider, and
 * passes no option that skips a leg (pinned by operator-removal.test.ts).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { ProviderType } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorActionInput } from "@/lib/audit";
import { disconnectAccounts } from "@/lib/accounts/disconnect";
import { createNotification } from "@/lib/notifications/create";
import { readCleanupMarkers, cleanupVerdicts } from "@/lib/platform/plaid/provider-cleanup";
import { redactedErrorForLog } from "@/lib/plaid/errors";
import { outcomeOf, walletLabel, type RemovedOutcome, type RemovedProvider } from "./removed-connections.core";
import { REMOVAL_REASON_ENVELOPE_CODE, type RemovalRequest } from "./removal-reasons";

export { parseRemovalRequest, REMOVAL_REASONS, type RemovalReason, type RemovalRequest } from "./removal-reasons";

// ── The action ───────────────────────────────────────────────────────────────

export type RemovalOutcome =
  | { kind: "not_found" }
  | { kind: "nothing_live" }
  | { kind: "failed"; auditId: string }
  | {
      kind: "removed";
      connectionId: string;
      provider: RemovedProvider;
      institution: string;
      accountCount: number;
      /** The provider question as the marker answers it after the attempt. */
      outcome: RemovedOutcome;
      auditId: string;
      notification: "created" | "suppressed" | "skipped" | "error";
    };

/** Injection seam — the real singletons by default, so production is byte-identical. */
export interface OperatorRemovalDeps {
  db?: typeof systemDb;
  disconnect?: typeof disconnectAccounts;
  record?: typeof recordOperatorAction;
  notify?: typeof createNotification;
  readMarkers?: typeof readCleanupMarkers;
}

export interface OperatorRemovalInput {
  connectionId: string;
  actor: OperatorActionInput["actor"];
  request: RemovalRequest;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function removeConnectionAsOperator(input: OperatorRemovalInput, deps: OperatorRemovalDeps = {}): Promise<RemovalOutcome> {
  const database = deps.db ?? systemDb;
  const disconnect = deps.disconnect ?? disconnectAccounts;
  const record = deps.record ?? recordOperatorAction;
  const notify = deps.notify ?? createNotification;
  const readMarkers = deps.readMarkers ?? readCleanupMarkers;
  const { connectionId: id } = input;

  // 1. RESOLVE — Plaid first (its id space is PlaidItem), then a wallet Connection.
  const item = await database.plaidItem.findUnique({ where: { id }, select: { id: true, userId: true, institutionName: true } });
  const wallet = item ? null : await database.connection.findFirst({
    where:  { id, provider: ProviderType.WALLET },
    select: { id: true, userId: true, externalConnectionId: true },
  });
  if (!item && !wallet) return { kind: "not_found" };

  const provider: RemovedProvider = item ? "PLAID" : "WALLET";
  const ownerUserId = (item ?? wallet)!.userId;
  const institution = item ? item.institutionName : walletLabel(wallet!.externalConnectionId);

  // The owner's LIVE accounts on THIS connection — the same predicate the
  // customer route resolves (live link, live account), plus ownership.
  const links = await database.accountConnection.findMany({
    where: {
      deletedAt: null,
      financialAccount: { deletedAt: null, ownerUserId },
      ...(item ? { plaidItemDbId: id } : { connectionId: id }),
    },
    select: { financialAccountId: true },
  });
  const faIds = [...new Set(links.map((l) => l.financialAccountId))];
  // Already removed (or never had an account): nothing to do, nothing recorded.
  if (faIds.length === 0) return { kind: "nothing_live" };

  const target = { kind: item ? "PLAID_ITEM" as const : "CONNECTION" as const, id };
  const reason = { code: REMOVAL_REASON_ENVELOPE_CODE[input.request.reason], ...(input.request.note ? { note: input.request.note } : {}) };
  const baseDetail = {
    connectionId: id, provider, institution, ownerUserId,
    requestedAccountCount: faIds.length, removalReason: input.request.reason,
  };

  // 2. THE PRIMITIVE.
  let disconnected: number;
  try {
    const result = await disconnect(faIds, ownerUserId);
    disconnected = result.disconnectedAccountIds.length;
  } catch (e) {
    console.error(`[platform-ops] operator removal failed for connection ${id}:`, redactedErrorForLog(e));
    const { id: auditId } = await record(database, {
      actor: input.actor, action: AuditAction.CONNECTION_REMOVED_BY_OPERATOR, target, reason, result: "FAILURE",
      detail: { ...baseDetail, outcome: "DISCONNECT_FAILED" },
      ipAddress: input.ipAddress ?? null, userAgent: input.userAgent ?? null,
    });
    return { kind: "failed", auditId };
  }

  // 3. RE-READ the provider outcome off the durable marker — the same verdict
  //    the Provider cleanup widget counts. Never PlaidItem.status, which the
  //    primitive writes REVOKED whatever Plaid answered.
  const outcome = provider === "PLAID"
    ? outcomeOf("PLAID", cleanupVerdicts(await readMarkers(database)).get(id))
    : outcomeOf("WALLET", undefined);

  // 4. THE OPERATOR-ACTION ROW.
  const { id: auditId } = await record(database, {
    actor: input.actor, action: AuditAction.CONNECTION_REMOVED_BY_OPERATOR, target, reason, result: "SUCCESS",
    detail: { ...baseDetail, accountCount: disconnected, outcome },
    ipAddress: input.ipAddress ?? null, userAgent: input.userAgent ?? null,
  });

  // 5. THE CUSTOMER — through the chokepoint, every gate intact.
  const sent = await notify({
    type: "CONNECTION_REMOVED_BY_SUPPORT",
    userId: ownerUserId,
    data: { connectionId: id, institutionName: institution, provider },
    auditLogId: auditId || null,
  }).catch((e: unknown) => {
    console.error(`[platform-ops] operator-removal notification failed for connection ${id}:`, redactedErrorForLog(e));
    return { status: "error" as const };
  });

  return { kind: "removed", connectionId: id, provider, institution, accountCount: disconnected, outcome, auditId, notification: sent.status };
}
