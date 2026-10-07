/**
 * lib/platform/customer/customer-core.ts  (P1 — CUSTOMER SUCCESS SPINE, pure)
 *
 * THE PURE PROJECTIONS behind the Customer Success customer spine. Every function
 * here takes ALREADY-FETCHED rows from the ledgers that exist (User, SpaceMember,
 * BetaAccessRequest(+Event), AuditLog, UserSession, PlaidItem, Connection,
 * SyncIssue, RefreshExecution, PlaidWebhookEvent, AiInvocation) and folds them
 * into the answers an authorized Customer Success operator needs. No I/O, no
 * clock of its own, no new store.
 *
 * IDENTITY-RESOLVING BY RULING. CUSTOMER_SUCCESS is the one Platform area the
 * owner ruled may resolve customer identity (email, name). PLATFORM_OPS readers
 * stay identity-minimised and are not touched by this module.
 *
 * WHAT NEVER CROSSES: tokens, credentials, cursors, raw provider payloads,
 * balances or amounts, prompts or answers. Projections are ALLOWLIST mappings —
 * a field reaches the payload only by being named here — and the privacy test
 * feeds rows carrying forbidden fields to prove they do not.
 */

import {
  COHORTS, ENTITLEMENT_DIMENSIONS, OVERLAYS, POLICY_GROUPS, DIMENSION_KEYS,
} from "@/lib/entitlements/catalogue";
import { explainEntitlement, type EffectiveEntitlements } from "@/lib/entitlements/resolve";
import { deriveConnectionHealthState, type HealthState } from "@/lib/connections/health";
import { priceAiUsage, type UsageRowLike } from "@/lib/usage/pricing";

// ── Identity ──────────────────────────────────────────────────────────────────

export interface CustomerIdentityRow {
  id: string; email: string; name: string | null; username: string | null; role: string;
  createdAt: Date; emailVerifiedAt: Date | null; deactivatedAt: Date | null;
  deletionRequestedAt: Date | null; deletionScheduledAt: Date | null;
}
export interface CustomerIdentity {
  id: string; email: string; name: string | null; username: string | null; role: string;
  createdAt: string; emailVerifiedAt: string | null; deactivatedAt: string | null;
  deletionRequestedAt: string | null; deletionScheduledAt: string | null;
}
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function projectIdentity(u: CustomerIdentityRow): CustomerIdentity {
  return {
    id: u.id, email: u.email, name: u.name, username: u.username, role: u.role,
    createdAt: u.createdAt.toISOString(), emailVerifiedAt: iso(u.emailVerifiedAt), deactivatedAt: iso(u.deactivatedAt),
    deletionRequestedAt: iso(u.deletionRequestedAt), deletionScheduledAt: iso(u.deletionScheduledAt),
  };
}

// ── Cohort & policy ───────────────────────────────────────────────────────────

export interface CohortRow { cohort: string; joinedAt: Date; source: string }
export interface CustomerCohortView { cohort: string; label: string; known: boolean; joinedAt: string; source: string }

export function projectCohorts(rows: readonly CohortRow[]): CustomerCohortView[] {
  return rows.map((r) => ({
    cohort: r.cohort, label: COHORTS[r.cohort]?.label ?? r.cohort, known: r.cohort in COHORTS,
    joinedAt: r.joinedAt.toISOString(), source: r.source,
  }));
}

export interface EffectiveDimensionView {
  key: string; label: string; value: boolean | number; source: string; ceiling: boolean | number;
  policyValue: boolean | number; overlayValue: boolean | number | null; clamped: boolean; explanation: string;
}
export interface CustomerPolicyView {
  assigned: boolean; policyGroup: string; policyGroupLabel: string; policyGroupKnown: boolean; unknownPolicyGroup: string | null;
  overlay: string | null; overlayLabel: string | null; overlayKnown: boolean;
  assignedAt: string | null; assignedById: string | null;
  dimensions: EffectiveDimensionView[];
}

export function projectPolicy(e: EffectiveEntitlements): CustomerPolicyView {
  return {
    assigned: e.assigned, policyGroup: e.policyGroup, policyGroupLabel: POLICY_GROUPS[e.policyGroup]?.label ?? e.policyGroup,
    policyGroupKnown: e.policyGroupKnown, unknownPolicyGroup: e.unknownPolicyGroup,
    overlay: e.overlay, overlayLabel: e.overlay ? OVERLAYS[e.overlay]?.label ?? e.overlay : null, overlayKnown: e.overlayKnown,
    assignedAt: e.assignedAt, assignedById: e.assignedById,
    dimensions: DIMENSION_KEYS.map((k) => {
      const d = e.dimensions[k];
      return { key: k, label: ENTITLEMENT_DIMENSIONS[k].label, value: d.value, source: d.source, ceiling: d.ceiling,
        policyValue: d.policyValue, overlayValue: d.overlayValue, clamped: d.clamped, explanation: explainEntitlement(d) };
    }),
  };
}

// ── Beta lifecycle ────────────────────────────────────────────────────────────

export type LifecycleStage = "NO_REQUEST" | "REQUESTED" | "INVITED" | "DENIED" | "REGISTERED" | "CONNECTED";

export interface BetaRequestFacts {
  id: string; status: string; createdAt: Date; decidedAt: Date | null; invitedAt: Date | null;
  inviteExpiresAt: Date | null; redeemedAt: Date | null;
}
export interface InviteEmailFacts { status: string | null; at: Date | null }
export interface LifecycleView {
  stage: LifecycleStage;
  request: {
    id: string; status: string; createdAt: string; decidedAt: string | null; invitedAt: string | null;
    inviteExpiresAt: string | null; redeemedAt: string | null; requestCount: number; firstSource: Record<string, unknown> | null;
  } | null;
  inviteEmail: { status: string | null; at: string | null } | null;
  registeredAt: string;
  firstConnectedAt: string | null;
}

export function projectLifecycle(args: {
  request: BetaRequestFacts | null; requestCount: number; firstSource: Record<string, unknown> | null;
  inviteEmail: InviteEmailFacts | null; registeredAt: Date; firstConnectedAt: Date | null;
}): LifecycleView {
  const r = args.request;
  const stage: LifecycleStage = args.firstConnectedAt ? "CONNECTED" : "REGISTERED";
  return {
    stage,
    request: r ? {
      id: r.id, status: r.status, createdAt: r.createdAt.toISOString(), decidedAt: iso(r.decidedAt), invitedAt: iso(r.invitedAt),
      inviteExpiresAt: iso(r.inviteExpiresAt), redeemedAt: iso(r.redeemedAt), requestCount: args.requestCount, firstSource: args.firstSource,
    } : null,
    inviteEmail: args.inviteEmail ? { status: args.inviteEmail.status, at: iso(args.inviteEmail.at) } : null,
    registeredAt: args.registeredAt.toISOString(),
    firstConnectedAt: iso(args.firstConnectedAt),
  };
}

/** The lifecycle stage of an ADDRESS that may not have a user yet (list/search of requests is not this spine's job; kept for completeness). */
export function requestStage(status: string | null): LifecycleStage {
  switch (status) {
    case null: return "NO_REQUEST";
    case "PENDING": return "REQUESTED";
    case "APPROVED": return "INVITED";
    case "DENIED": return "DENIED";
    case "REDEEMED": return "REGISTERED";
    default: return "REQUESTED";
  }
}

// ── Spaces ────────────────────────────────────────────────────────────────────

export interface MembershipRow {
  role: string; status: string; joinedAt: Date;
  space: { id: string; name: string; type: string; category: string; archivedAt: Date | null; deletedAt: Date | null };
}
export interface CustomerSpaceView { id: string; name: string; type: string; category: string; role: string; status: string; joinedAt: string; archived: boolean }

export function projectSpaces(rows: readonly MembershipRow[]): CustomerSpaceView[] {
  return rows.filter((m) => !m.space.deletedAt).map((m) => ({
    id: m.space.id, name: m.space.name, type: m.space.type, category: m.space.category, role: String(m.role), status: String(m.status),
    joinedAt: m.joinedAt.toISOString(), archived: m.space.archivedAt !== null,
  }));
}

// ── Activity ──────────────────────────────────────────────────────────────────

export interface ActivityView {
  lastActiveAt: string | null;
  /** Which authority answered: the throttled session clock, the LOGIN audit row, or nothing. */
  lastActiveSource: "SESSION" | "LOGIN" | "NONE";
  lastLoginAt: string | null;
  activeSessions: number;
}

export function projectActivity(args: { lastSessionActiveAt: Date | null; lastLoginAt: Date | null; activeSessions: number }): ActivityView {
  const session = args.lastSessionActiveAt; const login = args.lastLoginAt;
  const best = session && (!login || session >= login) ? { at: session, src: "SESSION" as const }
    : login ? { at: login, src: "LOGIN" as const } : null;
  return { lastActiveAt: iso(best?.at ?? null), lastActiveSource: best?.src ?? "NONE", lastLoginAt: iso(login), activeSessions: args.activeSessions };
}

// ── Connections & health ──────────────────────────────────────────────────────

export interface PlaidItemFacts { id: string; institutionName: string; status: string; errorCode: string | null; lastSyncedAt: Date | null; createdAt: Date; investmentsConsent: string | null }
export interface WalletConnectionFacts { id: string; provider: string; externalConnectionId: string | null; status: string; errorCode: string | null; lastSyncedAt: Date | null; createdAt: Date }

export interface CustomerConnectionView {
  kind: "PLAID" | "CONNECTION";
  id: string; provider: string; label: string; status: string; errorCode: string | null;
  lastSyncedAt: string | null; createdAt: string; healthState: HealthState; investmentsConsent: string | null;
}

/** A non-PII wallet label: provider + opaque tail (the Connection Health widget's own idiom). */
function connectionLabel(provider: string, externalConnectionId: string | null): string {
  const base = provider === "WALLET" ? "Wallet" : provider.charAt(0) + provider.slice(1).toLowerCase();
  return externalConnectionId ? `${base} …${externalConnectionId.slice(-6)}` : base;
}

export function projectConnections(
  plaid: readonly PlaidItemFacts[], wallets: readonly WalletConnectionFacts[],
  staleMs: { bank: number; wallet: number }, now: number,
): CustomerConnectionView[] {
  const rows: CustomerConnectionView[] = plaid.map((it) => ({
    kind: "PLAID", id: it.id, provider: "PLAID", label: it.institutionName, status: it.status, errorCode: it.errorCode,
    lastSyncedAt: iso(it.lastSyncedAt), createdAt: it.createdAt.toISOString(),
    healthState: deriveConnectionHealthState(it.status, it.errorCode, it.lastSyncedAt, staleMs.bank, now),
    investmentsConsent: it.investmentsConsent,
  }));
  for (const c of wallets) {
    rows.push({
      kind: "CONNECTION", id: c.id, provider: c.provider, label: connectionLabel(c.provider, c.externalConnectionId), status: c.status,
      errorCode: c.errorCode, lastSyncedAt: iso(c.lastSyncedAt), createdAt: c.createdAt.toISOString(),
      healthState: deriveConnectionHealthState(c.status, c.errorCode, c.lastSyncedAt, staleMs.wallet, now), investmentsConsent: null,
    });
  }
  return rows;
}

export function firstConnectedAt(plaid: readonly { createdAt: Date }[], wallets: readonly { createdAt: Date }[]): Date | null {
  let best: Date | null = null;
  for (const r of [...plaid, ...wallets]) if (!best || r.createdAt < best) best = r.createdAt;
  return best;
}

// ── Incidents ─────────────────────────────────────────────────────────────────

export interface SyncIssueFacts { id: string; provider: string; kind: string; plaidItemId: string | null; financialAccountId: string | null; firstOccurredAt: Date | null; lastOccurredAt: Date | null; createdAt: Date; resolved: boolean }
export interface ExecutionFacts { id: string; sourceKind: string; plaidItemId: string | null; sourceRef: string | null; trigger: string; profile: string; overallStatus: string; startedAt: Date; durationMs: number | null; failureCategory: string | null }
export interface WebhookFacts { receivedAt: Date; webhookType: string; webhookCode: string; handling: string; plaidItemId: string | null; errorCode: string | null }

export interface IncidentsView {
  open: { id: string; provider: string; kind: string; plaidItemId: string | null; financialAccountId: string | null; firstOccurredAt: string | null; lastOccurredAt: string | null }[];
  recentExecutions: { id: string; sourceKind: string; plaidItemId: string | null; sourceRef: string | null; trigger: string; profile: string; overallStatus: string; startedAt: string; durationMs: number | null; failureCategory: string | null }[];
  recentWebhooks: { receivedAt: string; webhookType: string; webhookCode: string; handling: string; plaidItemId: string | null; errorCode: string | null }[];
}

export function projectIncidents(issues: readonly SyncIssueFacts[], executions: readonly ExecutionFacts[], webhooks: readonly WebhookFacts[]): IncidentsView {
  return {
    open: issues.filter((i) => !i.resolved).map((i) => ({
      id: i.id, provider: i.provider, kind: i.kind, plaidItemId: i.plaidItemId, financialAccountId: i.financialAccountId,
      firstOccurredAt: iso(i.firstOccurredAt ?? i.createdAt), lastOccurredAt: iso(i.lastOccurredAt ?? i.createdAt),
    })),
    recentExecutions: executions.map((e) => ({
      id: e.id, sourceKind: e.sourceKind, plaidItemId: e.plaidItemId, sourceRef: e.sourceRef, trigger: e.trigger, profile: e.profile,
      overallStatus: e.overallStatus, startedAt: e.startedAt.toISOString(), durationMs: e.durationMs, failureCategory: e.failureCategory,
    })),
    recentWebhooks: webhooks.map((w) => ({
      receivedAt: w.receivedAt.toISOString(), webhookType: w.webhookType, webhookCode: w.webhookCode, handling: w.handling,
      plaidItemId: w.plaidItemId, errorCode: w.errorCode,
    })),
  };
}

// ── AI usage ──────────────────────────────────────────────────────────────────

export interface AiInvocationFacts {
  provider: string; model: string; occurredAt: Date; outcome: string; conversationId: string | null; surface: string | null;
  promptTokens: number; cachedPromptTokens: number; completionTokens: number; latencyMs: number;
}
export interface AiUsageView {
  windowDays: number;
  invocations: number;
  byOutcome: Record<string, number>;
  bySurface: Record<string, number>;
  conversations: number;
  promptTokens: number; cachedPromptTokens: number; completionTokens: number;
  /** Rate-card ESTIMATE in USD; null when nothing could be priced. Never provider billing truth. */
  estimatedUsd: number | null;
  unpricedTokens: number;
  lastCallAt: string | null;
  lastFailureAt: string | null;
  estimateNote: string;
}

export function projectAiUsage(rows: readonly AiInvocationFacts[], windowDays: number): AiUsageView {
  const byOutcome: Record<string, number> = {}; const bySurface: Record<string, number> = {};
  const conversations = new Set<string>();
  let prompt = 0, cached = 0, completion = 0; let last: Date | null = null; let lastFailure: Date | null = null;
  const usage: UsageRowLike[] = [];
  for (const r of rows) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    const s = r.surface ?? "unknown"; bySurface[s] = (bySurface[s] ?? 0) + 1;
    if (r.conversationId) conversations.add(r.conversationId);
    if (!last || r.occurredAt > last) last = r.occurredAt;
    if (r.outcome !== "RETURNED" && (!lastFailure || r.occurredAt > lastFailure)) lastFailure = r.occurredAt;
    if (r.outcome === "RETURNED") {
      prompt += r.promptTokens; cached += r.cachedPromptTokens; completion += r.completionTokens;
      const metric = `chat.completions:${r.model}`;
      usage.push(
        { provider: r.provider, metric, unit: "prompt_tokens", day: r.occurredAt, count: r.promptTokens },
        { provider: r.provider, metric, unit: "cached_prompt_tokens", day: r.occurredAt, count: r.cachedPromptTokens },
        { provider: r.provider, metric, unit: "completion_tokens", day: r.occurredAt, count: r.completionTokens },
      );
    }
  }
  const priced = priceAiUsage(usage);
  return {
    windowDays, invocations: rows.length, byOutcome, bySurface, conversations: conversations.size,
    promptTokens: prompt, cachedPromptTokens: cached, completionTokens: completion,
    estimatedUsd: priced.usd, unpricedTokens: priced.unpricedTokens,
    lastCallAt: iso(last), lastFailureAt: iso(lastFailure),
    estimateNote: "Estimated from the code-owned rate card over returned calls; not the provider invoice.",
  };
}

// ── Operator actions ──────────────────────────────────────────────────────────

export interface AuditRowFacts { id: string; action: string; createdAt: Date; performedByAdminId: string | null; metadata: unknown }
export interface OperatorActionView {
  id: string; action: string; at: string; actorId: string | null;
  reasonCode: string | null; note: string | null;
  result: string | null; change: unknown | null; execution: unknown | null; target: { kind: string; id: string } | null;
}

/** Project an operator row's envelope (P1 shape) or a legacy row's bare facts. Never emails. */
export function projectOperatorAction(r: AuditRowFacts): OperatorActionView {
  const m = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>;
  const reason = m.reason && typeof m.reason === "object" ? (m.reason as { code?: unknown; note?: unknown }) : null;
  const target = m.target && typeof m.target === "object" ? (m.target as { kind?: unknown; id?: unknown; type?: unknown }) : null;
  return {
    id: r.id, action: r.action, at: r.createdAt.toISOString(), actorId: r.performedByAdminId,
    reasonCode: typeof reason?.code === "string" ? reason.code : null,
    note: typeof reason?.note === "string" ? reason.note : null,
    result: typeof m.result === "string" ? m.result : null,
    change: m.change ?? null,
    execution: m.execution ?? null,
    target: target && typeof target.id === "string" ? { kind: String(target.kind ?? target.type ?? "?"), id: target.id } : null,
  };
}

/** Legacy connection-ops rows carry the item id under ad-hoc keys; keep those that name one of the customer's items. */
export function actionTouchesItems(r: AuditRowFacts, itemIds: ReadonlySet<string>): boolean {
  const m = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>;
  const candidates = [m.connectionId, m.plaidItemId, (m.target as { id?: unknown } | undefined)?.id];
  return candidates.some((c) => typeof c === "string" && itemIds.has(c));
}
