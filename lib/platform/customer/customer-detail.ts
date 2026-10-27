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
 *   first connection         min(PlaidItem, wallet Connection, MANUAL FinancialAccount).createdAt (BETA: manual included)
 *   roll-up (BETA §8)        AI turns + est. USD 30 d · Items · last engaged · funnel stage (customer-core projectRollup)
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
import { detailAccountLabel } from "@/lib/platform/incidents/account-label";
import { loadEffectiveEntitlements } from "@/lib/entitlements/resolve";
import { loadRefreshPolicies } from "@/lib/platform/refresh-policy";
import { staleWindowMs } from "@/lib/connections/health";
import { ENGAGEMENT_AI_SURFACES } from "@/lib/platform/growth/product-analytics-core";
import { loadLastEngagements } from "@/lib/platform/growth/product-analytics";
import {
  actionTouchesItems, firstConnectedAt, projectActivity, projectAiUsage, projectCohorts, projectConnections, projectIdentity,
  projectIncidents, projectLifecycle, projectOperatorAction, projectPolicy, projectRollup, projectSpaces,
  type ActivityView, type AiUsageView, type CustomerConnectionView, type CustomerCohortView, type CustomerIdentity,
  type CustomerPolicyView, type CustomerRollup, type CustomerSpaceView, type IncidentsView, type LifecycleView, type OperatorActionView,
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
  /** BETA — the same five fields the list row carries (design §8). */
  rollup: CustomerRollup;
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

  const [entitlements, cohorts, request, memberships, sessions, lastLogin, activeSessions, plaid, wallets, policies, manualAssets, lastEngagements, firstAiTurn, firstBriefView] = await Promise.all([
    loadEffectiveEntitlements(client, userId),
    client.customerCohort.findMany({ where: { userId }, orderBy: { joinedAt: "asc" }, select: { cohort: true, joinedAt: true, source: true } }),
    client.betaAccessRequest.findUnique({ where: { email: user.email },
      select: { id: true, status: true, createdAt: true, decidedAt: true, invitedAt: true, inviteExpiresAt: true, redeemedAt: true } }),
    client.spaceMember.findMany({ where: { userId },
      select: { role: true, status: true, joinedAt: true, space: { select: { id: true, name: true, type: true, category: true, archivedAt: true, deletedAt: true } } } }),
    client.userSession.aggregate({ where: { userId }, _max: { lastActiveAt: true }, _min: { createdAt: true } }),
    client.auditLog.findFirst({ where: { userId, action: AuditAction.LOGIN }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    client.userSession.count({ where: { userId, revokedAt: null } }),
    client.plaidItem.findMany({ where: { userId }, orderBy: { createdAt: "asc" },
      select: { id: true, institutionName: true, status: true, errorCode: true, lastSyncedAt: true, createdAt: true, investmentsConsent: true } }),
    client.connection.findMany({ where: { userId, provider: { notIn: ["PLAID", "MANUAL", "CSV"] } }, orderBy: { createdAt: "asc" },
      select: { id: true, provider: true, externalConnectionId: true, status: true, errorCode: true, lastSyncedAt: true, createdAt: true } }),
    loadRefreshPolicies(client),
    // BETA — manual assets are a first connection too (design §6); created-by first, owner as the fallback.
    client.financialAccount.findMany({
      where: { OR: [{ createdByUserId: userId }, { ownerUserId: userId }], syncStatus: "manual", deletedAt: null }, select: { createdAt: true },
    }),
    loadLastEngagements(client, [userId]),
    client.aiInvocation.findFirst({ where: { userId, surface: "chat" }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    client.auditLog.findFirst({ where: { userId, action: AuditAction.BRIEF_VIEWED }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
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
        promptTokens: true, cachedPromptTokens: true, completionTokens: true, latencyMs: true, correlationId: true, turnIndex: true },
    }),
    client.auditLog.findMany({
      // SEC-PLAT-3 — profile VIEWS are audited but are not changes; they never
      // crowd the operator-action list off its OPERATOR_ACTIONS window.
      where: { userId, performedByAdminId: { not: null }, action: { not: AuditAction.CUSTOMER_PROFILE_VIEWED } }, orderBy: { createdAt: "desc" }, take: OPERATOR_ACTIONS,
      select: { id: true, action: true, createdAt: true, performedByAdminId: true, metadata: true },
    }),
    itemIds.length === 0 ? Promise.resolve([]) : client.auditLog.findMany({
      where: { action: { in: CONNECTION_ACTIONS }, performedByAdminId: { not: null } }, orderBy: { createdAt: "desc" }, take: 200,
      select: { id: true, action: true, createdAt: true, performedByAdminId: true, metadata: true },
    }),
  ]);

  // SEC-PLAT-3 (owner ruling P-4) — this profile is the authorized, AUDITED
  // detail (the route records CUSTOMER_PROFILE_VIEWED before returning it), so
  // the customer's own open incidents may name the affected account in full.
  // Scoped to THIS customer's open-incident accounts only.
  const incidentAccountIds = [...new Set(issues.map((i) => i.financialAccountId).filter((x): x is string => !!x && accountIds.includes(x)))];
  const incidentAccounts = incidentAccountIds.length === 0 ? [] : await client.financialAccount.findMany({
    where: { id: { in: incidentAccountIds } },
    select: { id: true, name: true, institution: true, type: true, mask: true },
  });
  const accountLabels = new Map(incidentAccounts.map((a) => [a.id, detailAccountLabel(a)] as const));

  const itemSet = new Set(itemIds);
  const seen = new Set(userActions.map((a) => a.id));
  const operatorActions = [
    ...userActions,
    ...connectionActions.filter((a) => !seen.has(a.id) && actionTouchesItems(a, itemSet)),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, OPERATOR_ACTIONS).map(projectOperatorAction);

  const inviteMeta = (inviteAudit?.metadata ?? null) as { emailStatus?: unknown } | null;
  const connected = firstConnectedAt(plaid, wallets, manualAssets);
  const lastEngagedAt = lastEngagements.reduce<Date | null>((best, r) => (!best || r.at > best ? r.at : best), null);

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
    incidents: projectIncidents(issues, executions, webhooks, accountLabels),
    ai: projectAiUsage(invocations, AI_WINDOW_DAYS),
    rollup: projectRollup({
      invocations30d: invocations.filter((i) => i.surface !== null && ENGAGEMENT_AI_SURFACES.includes(i.surface)),
      plaidItemCount: plaid.filter((p) => String(p.status) !== "REVOKED").length,
      lastEngagedAt,
      stage: {
        createdAt: user.createdAt, emailVerifiedAt: user.emailVerifiedAt,
        firstSession: sessions._min.createdAt, firstConnection: connected,
        firstAiTurn: firstAiTurn?.occurredAt ?? null, firstBriefView: firstBriefView?.createdAt ?? null,
      },
    }),
    operatorActions,
    actions: {
      assignPolicy: true, assignCohort: true, refreshAll: user.deactivatedAt === null,
      // SEC-PLAT-4 — account access is a Customer Success action (fresh CS WRITE).
      deactivate: { url: `/api/platform/customer-success/customers/${user.id}/access`, method: "POST", currently: user.deactivatedAt ? "DEACTIVATED" : "ACTIVE" },
      resendInvite: request && request.status === "APPROVED" ? { url: `/api/platform/growth-revenue/requests/${request.id}/resend`, method: "POST" } : null,
    },
    checkedAt: now.toISOString(),
  };
}
