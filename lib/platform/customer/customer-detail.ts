/**
 * lib/platform/customer/customer-detail.ts  (P1 — CUSTOMER SUCCESS SPINE, detail)
 *
 * ONE customer, every question the spine answers, from the ledgers that exist:
 *
 *   who                      User
 *   cohort / policy          CustomerCohort, CustomerPolicyAssignment → resolver
 *   beta lifecycle           BetaAccessRequest(+Event), AuditLog emailStatus
 *   Spaces                   SpaceMember × Space
 *   last active              UserSession.lastActiveAt (LOGIN audit as fallback)
 *   connections + health     PlaidItem, Connection → deriveConnectionHealthState
 *   incidents                SyncIssue, RefreshExecution, PlaidWebhookEvent (by item)
 *   AI usage / failures      AiInvocation where userId (P0 attribution)
 *   operator actions         AuditLog where userId = customer, performedByAdminId
 *
 * Selections are ALLOWLISTS: no encryptedToken, credential, cursor, balance,
 * amount, prompt or answer is ever selected. fm_system throughout.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { loadEffectiveEntitlements } from "@/lib/entitlements/resolve";
import { loadRefreshPolicies } from "@/lib/platform/refresh-policy";
import { staleWindowMs } from "@/lib/connections/health";
import {
  actionTouchesItems, firstConnectedAt, projectActivity, projectAiUsage, projectCohorts, projectConnections, projectIdentity,
  projectIncidents, projectLifecycle, projectOperatorAction, projectPolicy, projectSpaces,
  type ActivityView, type AiUsageView, type CustomerConnectionView, type CustomerCohortView, type CustomerIdentity,
  type CustomerPolicyView, type CustomerSpaceView, type IncidentsView, type LifecycleView, type OperatorActionView,
} from "./customer-core";

export const AI_WINDOW_DAYS = 30;
const RECENT_EXECUTIONS = 20;
const RECENT_WEBHOOKS = 20;
const OPERATOR_ACTIONS = 50;

export interface CustomerActionsView {
  assignPolicy: boolean;
  assignCohort: boolean;
  refreshAll: boolean;
  /** Existing routes on other areas, offered as links — their own gates apply. */
  deactivate: { url: string; method: "POST"; currently: "ACTIVE" | "DEACTIVATED" } | null;
  resendInvite: { url: string; method: "POST" } | null;
}

export interface CustomerDetail {
  identity: CustomerIdentity;
  cohorts: CustomerCohortView[];
  policy: CustomerPolicyView;
  lifecycle: LifecycleView;
  spaces: CustomerSpaceView[];
  activity: ActivityView;
  connections: CustomerConnectionView[];
  incidents: IncidentsView;
  ai: AiUsageView;
  operatorActions: OperatorActionView[];
  actions: CustomerActionsView;
  checkedAt: string;
}

const CONNECTION_ACTIONS = [
  AuditAction.CONNECTION_RESYNC_TRIGGERED, AuditAction.CONNECTION_REAUTH_REQUESTED, AuditAction.PLAID_ITEM_REVOCATION_RETRY_REQUESTED,
  AuditAction.OPERATOR_REFRESH_ALL,
];

export async function getCustomerDetail(userId: string, client = systemDb, now: Date = new Date()): Promise<CustomerDetail | null> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, username: true, role: true, createdAt: true, emailVerifiedAt: true, deactivatedAt: true,
      deletionRequestedAt: true, deletionScheduledAt: true },
  });
  if (!user) return null;

  const [entitlements, cohorts, request, memberships, sessions, lastLogin, activeSessions, plaid, wallets, policies] = await Promise.all([
    loadEffectiveEntitlements(client, userId),
    client.customerCohort.findMany({ where: { userId }, orderBy: { joinedAt: "asc" }, select: { cohort: true, joinedAt: true, source: true } }),
    client.betaAccessRequest.findUnique({ where: { email: user.email },
      select: { id: true, status: true, createdAt: true, decidedAt: true, invitedAt: true, inviteExpiresAt: true, redeemedAt: true } }),
    client.spaceMember.findMany({ where: { userId },
      select: { role: true, status: true, joinedAt: true, space: { select: { id: true, name: true, type: true, category: true, archivedAt: true, deletedAt: true } } } }),
    client.userSession.aggregate({ where: { userId }, _max: { lastActiveAt: true } }),
    client.auditLog.findFirst({ where: { userId, action: AuditAction.LOGIN }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    client.userSession.count({ where: { userId, revokedAt: null } }),
    client.plaidItem.findMany({ where: { userId }, orderBy: { createdAt: "asc" },
      select: { id: true, institutionName: true, status: true, errorCode: true, lastSyncedAt: true, createdAt: true, investmentsConsent: true } }),
    client.connection.findMany({ where: { userId, provider: { notIn: ["PLAID", "MANUAL", "CSV"] } }, orderBy: { createdAt: "asc" },
      select: { id: true, provider: true, externalConnectionId: true, status: true, errorCode: true, lastSyncedAt: true, createdAt: true } }),
    loadRefreshPolicies(client),
  ]);

  const itemIds = plaid.map((p) => p.id);
  const accountIds = (await client.accountConnection.findMany({
    where: { OR: [{ plaidItemDbId: { in: itemIds } }, { connectionId: { in: wallets.map((w) => w.id) } }], deletedAt: null },
    select: { financialAccountId: true },
  })).map((a) => a.financialAccountId);

  const since = new Date(now.getTime() - AI_WINDOW_DAYS * 86_400_000);
  const [events, inviteAudit, issues, executions, webhooks, invocations, userActions, connectionActions] = await Promise.all([
    client.betaAccessRequestEvent.findMany({ where: { email: user.email }, orderBy: { receivedAt: "asc" }, select: { receivedAt: true, source: true } }),
    request ? client.auditLog.findFirst({
      where: { action: { in: [AuditAction.BETA_ACCESS_APPROVED, AuditAction.BETA_INVITATION_CREATED, AuditAction.BETA_INVITATION_RESENT] },
        metadata: { path: ["betaRequestId"], equals: request.id } },
      orderBy: { createdAt: "desc" }, select: { createdAt: true, metadata: true },
    }) : Promise.resolve(null),
    client.syncIssue.findMany({
      where: { resolved: false, OR: [{ plaidItemId: { in: itemIds } }, { financialAccountId: { in: accountIds } }] },
      orderBy: { lastOccurredAt: "desc" }, take: 50,
      select: { id: true, provider: true, kind: true, plaidItemId: true, financialAccountId: true, firstOccurredAt: true, lastOccurredAt: true, createdAt: true, resolved: true },
    }),
    client.refreshExecution.findMany({
      where: { OR: [{ plaidItemId: { in: itemIds } }, { sourceRef: { in: accountIds } }] },
      orderBy: { startedAt: "desc" }, take: RECENT_EXECUTIONS,
      select: { id: true, sourceKind: true, plaidItemId: true, sourceRef: true, trigger: true, profile: true, overallStatus: true, startedAt: true, durationMs: true, failureCategory: true },
    }),
    client.plaidWebhookEvent.findMany({
      where: { plaidItemId: { in: itemIds } }, orderBy: { receivedAt: "desc" }, take: RECENT_WEBHOOKS,
      select: { receivedAt: true, webhookType: true, webhookCode: true, handling: true, plaidItemId: true, errorCode: true },
    }),
    client.aiInvocation.findMany({
      where: { userId, occurredAt: { gte: since } },
      select: { provider: true, model: true, occurredAt: true, outcome: true, conversationId: true, surface: true,
        promptTokens: true, cachedPromptTokens: true, completionTokens: true, latencyMs: true },
    }),
    client.auditLog.findMany({
      where: { userId, performedByAdminId: { not: null } }, orderBy: { createdAt: "desc" }, take: OPERATOR_ACTIONS,
      select: { id: true, action: true, createdAt: true, performedByAdminId: true, metadata: true },
    }),
    itemIds.length === 0 ? Promise.resolve([]) : client.auditLog.findMany({
      where: { action: { in: CONNECTION_ACTIONS }, performedByAdminId: { not: null } }, orderBy: { createdAt: "desc" }, take: 200,
      select: { id: true, action: true, createdAt: true, performedByAdminId: true, metadata: true },
    }),
  ]);

  const itemSet = new Set(itemIds);
  const seen = new Set(userActions.map((a) => a.id));
  const operatorActions = [
    ...userActions,
    ...connectionActions.filter((a) => !seen.has(a.id) && actionTouchesItems(a, itemSet)),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, OPERATOR_ACTIONS).map(projectOperatorAction);

  const inviteMeta = (inviteAudit?.metadata ?? null) as { emailStatus?: unknown } | null;
  const connected = firstConnectedAt(plaid, wallets);

  return {
    identity: projectIdentity(user),
    cohorts: projectCohorts(cohorts),
    policy: projectPolicy(entitlements),
    lifecycle: projectLifecycle({
      request, requestCount: events.length,
      firstSource: (events[0]?.source as Record<string, unknown> | null) ?? null,
      inviteEmail: inviteAudit ? { status: typeof inviteMeta?.emailStatus === "string" ? inviteMeta.emailStatus : null, at: inviteAudit.createdAt } : null,
      registeredAt: user.createdAt, firstConnectedAt: connected,
    }),
    spaces: projectSpaces(memberships),
    activity: projectActivity({ lastSessionActiveAt: sessions._max.lastActiveAt, lastLoginAt: lastLogin?.createdAt ?? null, activeSessions }),
    connections: projectConnections(plaid, wallets, { bank: staleWindowMs(policies.BANK), wallet: staleWindowMs(policies.WALLET) }, now.getTime()),
    incidents: projectIncidents(issues, executions, webhooks),
    ai: projectAiUsage(invocations, AI_WINDOW_DAYS),
    operatorActions,
    actions: {
      assignPolicy: true, assignCohort: true, refreshAll: user.deactivatedAt === null,
      deactivate: { url: `/api/platform/growth-revenue/users/${user.id}`, method: "POST", currently: user.deactivatedAt ? "DEACTIVATED" : "ACTIVE" },
      resendInvite: request && request.status === "APPROVED" ? { url: `/api/platform/growth-revenue/requests/${request.id}/resend`, method: "POST" } : null,
    },
    checkedAt: now.toISOString(),
  };
}
