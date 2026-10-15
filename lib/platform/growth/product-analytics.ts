/**
 * lib/platform/growth/product-analytics.ts  (BETA A1–A8 — THE READER)
 *
 * Reads the row sets lib/platform/growth/product-analytics-core.ts folds, on
 * fm_system (`systemDb`: an operator reading fleet activity is outside every
 * tenancy by definition; lib/platform/ is the allowlisted neighbourhood), and
 * returns the frozen ProductAnalyticsResponse. Read-only: nothing here writes.
 *
 * IDENTITY-MINIMISED SELECTS. No email, no name, no username, no Space name, no
 * token, no balance, no prompt — ids and clocks only. User ids are selected
 * because the folds join on them; the core never emits one. The privacy scan
 * (lib/platform/observability-privacy.test.ts) pins this file's selects.
 *
 * SHARED LOADERS. `loadActivityFacts`, `loadFunnelFacts` and
 * `loadLastEngagements` are exported so lib/platform/activity/activity.ts, the
 * growth funnel and the Customer Success roll-up read presence / engagement
 * through the ONE implementation of the frozen predicate, instead of each
 * restating which actions and surfaces count.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { decodeTransitions } from "@/lib/platform/plaid/usage";
import {
  ANALYTICS_AUDIT_ACTIONS, ENGAGEMENT_AI_SURFACES, ENGAGEMENT_AUDIT_ACTIONS, analysisSince, buildProductAnalytics,
  type ProductAnalyticsFacts, type UserInstant,
} from "./product-analytics-core";
import type { ProductAnalyticsResponse } from "./product-analytics-types";

export type ProductAnalyticsDb = typeof systemDb;

/** Providers that are NOT a live wallet connection (the Customer Success readers' own list). */
const NON_WALLET_PROVIDERS = ["PLAID", "MANUAL", "CSV"] as const;
const TRANSITIONS_LIMIT = 5000;

const AI_SELECT = {
  provider: true, model: true, occurredAt: true, promptTokens: true, cachedPromptTokens: true, completionTokens: true,
  reasoningTokens: true, latencyMs: true, toolCallCount: true, environment: true, correlationId: true, turnIndex: true,
  surface: true, userId: true, outcome: true,
} as const;

const instants = (rows: readonly { userId: string | null; at: Date | null }[]): UserInstant[] =>
  rows.flatMap((r) => (r.userId && r.at ? [{ userId: r.userId, at: r.at }] : []));

/** Day-grain facts inside the lookback: presence, engagement, sign-ins. */
export async function loadActivityFacts(
  client: ProductAnalyticsDb, since: Date,
): Promise<Pick<ProductAnalyticsFacts, "auditEvents" | "sessionStarts" | "aiInvocations" | "logins">> {
  const [auditRows, sessionStarts, aiInvocations, logins] = await Promise.all([
    client.auditLog.findMany({
      where: { action: { in: [...ANALYTICS_AUDIT_ACTIONS] }, createdAt: { gte: since }, userId: { not: null } },
      select: { userId: true, action: true, createdAt: true, metadata: true },
    }),
    client.userSession.findMany({ where: { createdAt: { gte: since } }, select: { userId: true, createdAt: true } }),
    client.aiInvocation.findMany({
      where: { occurredAt: { gte: since }, surface: { in: [...ENGAGEMENT_AI_SURFACES] } },
      select: AI_SELECT,
    }),
    client.auditLog.findMany({
      where: { action: AuditAction.LOGIN, createdAt: { gte: since }, userId: { not: null } },
      select: { userId: true, createdAt: true },
    }),
  ]);
  return {
    auditEvents: auditRows.map((r) => ({
      userId: r.userId, action: r.action, at: r.createdAt,
      day: typeof (r.metadata as { day?: unknown } | null)?.day === "string" ? (r.metadata as { day: string }).day : null,
    })),
    sessionStarts: sessionStarts.map((s) => ({ userId: s.userId, at: s.createdAt })),
    aiInvocations,
    logins: instants(logins.map((l) => ({ userId: l.userId, at: l.createdAt }))),
  };
}

/**
 * The newest engagement instant per user — ever — over both halves of the
 * predicate (customer-surface AI invocations with a userId; the engagement audit
 * actions). Several rows per user may come back; the core folds them by max.
 * `userIds` narrows the read (Customer Success); omitted = the fleet.
 */
export async function loadLastEngagements(client: ProductAnalyticsDb, userIds?: readonly string[]): Promise<UserInstant[]> {
  const scope = userIds ? { in: [...userIds] } : { not: null };
  const [ai, audit] = await Promise.all([
    client.aiInvocation.groupBy({
      by: ["userId"], where: { userId: scope, surface: { in: [...ENGAGEMENT_AI_SURFACES] } }, _max: { occurredAt: true },
    }),
    client.auditLog.groupBy({
      by: ["userId"], where: { userId: scope, action: { in: [...ENGAGEMENT_AUDIT_ACTIONS] } }, _max: { createdAt: true },
    }),
  ]);
  return [
    ...instants(ai.map((r) => ({ userId: r.userId, at: r._max.occurredAt }))),
    ...instants(audit.map((r) => ({ userId: r.userId, at: r._max.createdAt }))),
  ];
}

/** "Ever" facts for the funnel and the cohorts: who exists, first visit, first connection, first AI turn, first Brief view, last engagement. */
export async function loadFunnelFacts(client: ProductAnalyticsDb): Promise<Pick<ProductAnalyticsFacts,
  "users" | "firstSessions" | "firstAiTurns" | "firstBriefViews" | "lastEngagements" | "plaidItems" | "walletConnections" | "manualAssets">> {
  const [users, firstSessions, firstAiTurns, firstBriefViews, lastEngagements, plaidItems, walletConnections, manualAssets] = await Promise.all([
    client.user.findMany({ select: { id: true, createdAt: true, emailVerifiedAt: true, acceptedTermsAt: true, deactivatedAt: true } }),
    client.userSession.groupBy({ by: ["userId"], _min: { createdAt: true } }),
    client.aiInvocation.groupBy({ by: ["userId"], where: { userId: { not: null }, surface: "chat" }, _min: { occurredAt: true } }),
    client.auditLog.groupBy({ by: ["userId"], where: { userId: { not: null }, action: AuditAction.BRIEF_VIEWED }, _min: { createdAt: true } }),
    loadLastEngagements(client),
    client.plaidItem.findMany({
      select: { id: true, userId: true, externalItemId: true, createdAt: true, status: true, investmentsConsent: true, environment: true, plaidEnvironment: true },
    }),
    client.connection.findMany({
      where: { provider: { notIn: [...NON_WALLET_PROVIDERS] } }, select: { userId: true, createdAt: true, status: true },
    }),
    client.financialAccount.findMany({
      where: { syncStatus: "manual", deletedAt: null }, select: { createdByUserId: true, ownerUserId: true, createdAt: true },
    }),
  ]);
  return {
    users,
    firstSessions: instants(firstSessions.map((r) => ({ userId: r.userId, at: r._min.createdAt }))),
    firstAiTurns: instants(firstAiTurns.map((r) => ({ userId: r.userId, at: r._min.occurredAt }))),
    firstBriefViews: instants(firstBriefViews.map((r) => ({ userId: r.userId, at: r._min.createdAt }))),
    lastEngagements,
    plaidItems: plaidItems.map((p) => ({
      ...p, status: String(p.status), investmentsConsent: p.investmentsConsent ? String(p.investmentsConsent) : null,
    })),
    walletConnections: walletConnections.map((w) => ({ userId: w.userId, createdAt: w.createdAt, status: String(w.status) })),
    manualAssets: manualAssets.map((m) => ({ userId: m.createdByUserId ?? m.ownerUserId, createdAt: m.createdAt })),
  };
}

export async function loadProductAnalyticsFacts(client: ProductAnalyticsDb, now: Date): Promise<ProductAnalyticsFacts> {
  const [activity, funnel, transitionRows] = await Promise.all([
    loadActivityFacts(client, analysisSince(now)),
    loadFunnelFacts(client),
    client.auditLog.findMany({
      where: { action: AuditAction.PLAID_ITEM_STATUS_CHANGED }, orderBy: { createdAt: "asc" }, take: TRANSITIONS_LIMIT,
      select: { createdAt: true, metadata: true },
    }),
  ]);
  return { ...activity, ...funnel, plaidTransitions: decodeTransitions(transitionRows) };
}

export async function getProductAnalytics(
  deps: { now?: Date; client?: ProductAnalyticsDb; facts?: (now: Date) => Promise<ProductAnalyticsFacts> } = {},
): Promise<ProductAnalyticsResponse> {
  const now = deps.now ?? new Date();
  const facts = await (deps.facts ? deps.facts(now) : loadProductAnalyticsFacts(deps.client ?? systemDb, now));
  return buildProductAnalytics(facts, now);
}
