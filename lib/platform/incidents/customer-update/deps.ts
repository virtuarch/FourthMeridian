/**
 * lib/platform/incidents/customer-update/deps.ts  (Incident customer update, PR-C1 — production I/O)
 *
 * The production CustomerUpdateDeps for ./service.ts. AUTHORITY: systemDb
 * (fm_system) — the CommsDelivery ledger and AuditLog are fm_system-only, and an
 * operator acts outside their own tenancy by definition (the CS refresh route's
 * reasoning). Every read is bounded:
 *   deliveries  recipientUserId + createdAt (CommsDelivery_recipientUserId_createdAt_idx)
 *               first, then incidentId + definitionKey — no incidentId index (S2 09gh);
 *   reauth      action + createdAt (AuditLog_action_createdAt_idx) over the last
 *               24 h, then the row's own connectionId (metadata JSON path);
 *   recipient   one User row by id.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { env } from "@/lib/env";
import { recordOperatorAction } from "@/lib/audit";
import { AuditAction } from "@/lib/audit-actions";
import { createNotification } from "@/lib/notifications/create";
import { opaqueUserRef } from "@/lib/platform/opaque-user-ref";
import { incidentAccessors } from "../intelligence";
import type { CsIncidentVerdict, IncidentInvestigation } from "../intelligence/types";
import { INCIDENT_CUSTOMER_UPDATE_TYPE } from "./core";
import type { CustomerUpdateDeps } from "./service";

/** At most this many ledger rows are read for one incident (one message, a handful of rows). */
const DELIVERY_READ_CAP = 50;
/** At most this many reconnect-request rows for one connection in 24 h (the route allows 3 per item per day). */
const REAUTH_READ_CAP = 20;

export const productionCustomerUpdateDeps: CustomerUpdateDeps = {
  now: () => new Date(),
  sendEnabled: () => env.isIncidentCustomerMessageSendEnabled,
  investigate: async (token, id, now) =>
    (await incidentAccessors.investigate(token, id, { now })) as IncidentInvestigation<CsIncidentVerdict> | null,
  readDeliveries: async ({ incidentId, recipientUserId, since }) => {
    const rows = await systemDb.commsDelivery.findMany({
      where: { recipientUserId, createdAt: { gte: since }, incidentId, definitionKey: INCIDENT_CUSTOMER_UPDATE_TYPE },
      select: { channel: true, status: true, reason: true, errorCode: true, attempt: true, mode: true, createdAt: true, acceptedAt: true },
      orderBy: { createdAt: "desc" },
      take: DELIVERY_READ_CAP,
    });
    return rows;
  },
  readReauthNotices: async ({ plaidItemId, since }) => {
    const rows = await systemDb.auditLog.findMany({
      where: { action: AuditAction.CONNECTION_REAUTH_REQUESTED, createdAt: { gte: since }, metadata: { path: ["connectionId"], equals: plaidItemId } },
      select: { createdAt: true, metadata: true },
      orderBy: { createdAt: "desc" },
      take: REAUTH_READ_CAP,
    });
    return rows.map((r) => {
      const m = r.metadata as { outcome?: unknown } | null;
      return { at: r.createdAt, outcome: typeof m?.outcome === "string" ? m.outcome : null };
    });
  },
  recipientActive: async (userId) => {
    const u = await systemDb.user.findUnique({ where: { id: userId }, select: { deactivatedAt: true, deletionScheduledAt: true } });
    return !!u && u.deactivatedAt === null && u.deletionScheduledAt === null;
  },
  privRef: (userId) => opaqueUserRef(userId),
  recordApproval: (input) => recordOperatorAction(systemDb, input),
  createNotification: (input, ctx) => createNotification(input, ctx),
};
