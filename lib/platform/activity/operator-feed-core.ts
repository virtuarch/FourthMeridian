/**
 * lib/platform/activity/operator-feed-core.ts  (UX-P1 · D6 — the Platform Operations activity feed)
 *
 * THE PURE HALF of the narrow operator-activity feed the Overview shows under
 * "Recent operator activity". Owner decision D6: Platform Operations may see
 * operator actions whose TARGETS are platform-operations objects — jobs,
 * connections (resync / request-reauth / provider cleanup), platform settings
 * (refresh policy + job cadence) and the operator Refresh All — and nothing
 * else. Grants, sessions, 2FA, break-glass, beta decisions, product status and
 * customer policy / cohort assignment stay under Security Operations and
 * Customer Success. The allowlist below IS that ruling; a row outside it never
 * reaches the projection, whatever the Security feed would show.
 *
 * PRIVACY (D4 / D5 applied to a feed). The projection reuses the Security feed's
 * `projectOperatorActionEvent` for the operator label, the action, the reason
 * CODE, the result and the execution references — and deliberately hands it NO
 * subject username, so a target is always the opaque `<kind> …<last 6>` form.
 * A customer is never named on a PLATFORM_OPS surface, even when the action
 * (Refresh All) was taken on a customer's behalf. The reason NOTE, email, IP and
 * user-agent never cross; metadata is never forwarded verbatim.
 *
 * No I/O, no clock: `nowISO` is handed in by the loader.
 */

import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import { projectOperatorActionEvent, type OperatorAuditRowLike } from "@/lib/platform/security/operator-actions-core";

// ── The ruling, as a table ───────────────────────────────────────────────────

/** Which envelope target kinds each admitted action may carry. `LEGACY_OK` admits pre-envelope rows (no target). */
export interface FeedActionRule {
  label: string;
  kinds: readonly string[];
  /** Pre-P1 rows for this action have no envelope target; admit them on the action alone. */
  legacyOk: boolean;
  /** The platform workspace that holds the target's detail. */
  workspace: "platform-jobs" | "platform-policies" | "platform-providers" | "platform-refresh";
}

export const PLATFORM_OPS_FEED_RULES: Readonly<Record<string, FeedActionRule>> = {
  [AuditAction.PLATFORM_OPERATION_EXECUTED]:  { label: "Ran a manual operation",    kinds: ["JOB"], legacyOk: true,  workspace: "platform-jobs" },
  [AuditAction.PLATFORM_OPERATION_DRY_RUN]:   { label: "Dry-ran an operation",      kinds: ["JOB"], legacyOk: true,  workspace: "platform-jobs" },
  [AuditAction.JOB_CADENCE_CHANGED]:          { label: "Changed a job cadence",     kinds: ["JOB"], legacyOk: false, workspace: "platform-policies" },
  [AuditAction.JOB_CADENCE_RESET]:            { label: "Reset a job cadence",       kinds: ["JOB"], legacyOk: false, workspace: "platform-policies" },
  [AuditAction.PLATFORM_POLICY_CHANGED]:      { label: "Changed a platform policy",  kinds: ["PLATFORM_SETTING"], legacyOk: true, workspace: "platform-policies" },
  [AuditAction.PLATFORM_POLICY_RESET]:        { label: "Reset a platform policy",    kinds: ["PLATFORM_SETTING"], legacyOk: true, workspace: "platform-policies" },
  [AuditAction.CONNECTION_RESYNC_TRIGGERED]:  { label: "Resynced a connection",     kinds: ["PLAID_ITEM", "CONNECTION"], legacyOk: true, workspace: "platform-providers" },
  [AuditAction.CONNECTION_REAUTH_REQUESTED]:  { label: "Requested reauthorization", kinds: ["PLAID_ITEM", "CONNECTION"], legacyOk: true, workspace: "platform-providers" },
  [AuditAction.PLAID_ITEM_WEBHOOK_UPDATED]:   { label: "Repointed a connection webhook", kinds: ["PLAID_ITEM"], legacyOk: false, workspace: "platform-providers" },
  [AuditAction.WALLET_HISTORY_RESUMED]:       { label: "Resumed wallet history",   kinds: ["CONNECTION"], legacyOk: false, workspace: "platform-providers" },
  [AuditAction.PLAID_ITEM_REVOCATION_RETRY_REQUESTED]: { label: "Retried provider cleanup", kinds: ["PLAID_ITEM"], legacyOk: true, workspace: "platform-providers" },
  // Refresh All targets a USER in the envelope (the customer whose authorities
  // were refreshed). Admitted because the action is a platform operation; the
  // target renders opaque (`user …last6`), never a username — see the header.
  [AuditAction.OPERATOR_REFRESH_ALL]:         { label: "Refreshed a customer's authorities", kinds: ["USER"], legacyOk: false, workspace: "platform-refresh" },
};

/** The actions the loader queries for — derived from the table so the two can never disagree. */
export const PLATFORM_OPS_FEED_ACTIONS: readonly AuditActionType[] =
  Object.keys(PLATFORM_OPS_FEED_RULES) as AuditActionType[];

/** Security-only actions that must NEVER appear, pinned by the test (a ruling, not an inference). */
export const SECURITY_ONLY_ACTIONS: readonly AuditActionType[] = [
  AuditAction.PLATFORM_GRANT_CREATED, AuditAction.PLATFORM_GRANT_LEVEL_CHANGED, AuditAction.PLATFORM_GRANT_REVOKED,
  AuditAction.PLATFORM_GRANT_REINSTATED, AuditAction.ACCOUNT_DEACTIVATED, AuditAction.ACCOUNT_REACTIVATED,
  AuditAction.BETA_ACCESS_APPROVED, AuditAction.BETA_ACCESS_DENIED, AuditAction.BETA_MODE_CHANGED,
  AuditAction.BETA_INVITATION_CREATED, AuditAction.BETA_INVITATION_RESENT, AuditAction.BETA_INVITATION_REVOKED,
  AuditAction.PRODUCT_STATUS_CHANGED, AuditAction.CUSTOMER_POLICY_ASSIGNED, AuditAction.CUSTOMER_POLICY_OVERLAY_CHANGED,
  AuditAction.CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED,
  AuditAction.CUSTOMER_COHORT_ASSIGNED, AuditAction.LOGIN, AuditAction.SESSION_REVOKED, AuditAction.TWO_FACTOR_RESET,
];

// ── The DTO ──────────────────────────────────────────────────────────────────

export const OPERATOR_FEED_DEPTH = 20;

export interface OperatorFeedItem {
  id: string;
  /** ISO instant the action was recorded. */
  at: string;
  /** The acting operator's display label (username → name → opaque), never an email. */
  operator: string;
  action: string;
  actionLabel: string;
  /** Opaque `<kind> …<last 6>` or a legacy non-PII token; never a customer identity. */
  target: string | null;
  result: "SUCCESS" | "FAILURE" | "REFUSED" | null;
  reasonCode: string | null;
  evidence: {
    refreshExecutionId?: string;
    jobRunId?: string;
    /** The platform workspace holding the target's detail. */
    workspace: FeedActionRule["workspace"];
  };
}

export interface OperatorFeedResponse {
  scope: "PLATFORM_OPS";
  /** `requested` is the query depth; `returned` what the ruling admitted of it. */
  depth: { requested: number; returned: number };
  note: string;
  items: OperatorFeedItem[];
  checkedAt: string;
}

export const OPERATOR_FEED_NOTE =
  `Last ${OPERATOR_FEED_DEPTH} recorded actions on platform objects; security events live in Security Operations.`;

// ── The ruling applied to a row ──────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function envelopeTargetKind(metadata: unknown): string | null {
  if (!isRecord(metadata) || !isRecord(metadata.target)) return null;
  return typeof metadata.target.kind === "string" ? metadata.target.kind : null;
}

/** A row the loader fetched by action — admitted by the table, then by its target kind. */
export type OperatorFeedRowLike = Omit<OperatorAuditRowLike, "subjectUsername">;

export function admitsFeedRow(row: Pick<OperatorFeedRowLike, "action" | "metadata" | "performedByAdminId">): boolean {
  const rule = PLATFORM_OPS_FEED_RULES[row.action];
  if (!rule) return false;
  if (!row.performedByAdminId) return false;
  const kind = envelopeTargetKind(row.metadata);
  if (kind === null) return rule.legacyOk;
  return rule.kinds.includes(kind);
}

/** Project one admitted row. `operatorLabel` is already username → name → opaque. */
export function projectOperatorFeedItem(row: OperatorFeedRowLike, operatorLabel: string | null): OperatorFeedItem {
  const rule = PLATFORM_OPS_FEED_RULES[row.action];
  // NO subject username: the target is always opaque on this surface.
  const e = projectOperatorActionEvent({ ...row, subjectUsername: null }, operatorLabel);
  return {
    id: e.id,
    at: e.at,
    operator: e.operator,
    action: e.action,
    actionLabel: rule?.label ?? e.action,
    target: e.target,
    result: e.result,
    reasonCode: e.reasonCode,
    evidence: {
      ...(e.execution?.refreshExecutionId ? { refreshExecutionId: e.execution.refreshExecutionId } : {}),
      ...(e.execution?.jobRunId ? { jobRunId: e.execution.jobRunId } : {}),
      workspace: rule?.workspace ?? "platform-jobs",
    },
  };
}

/** The whole feed from already-fetched rows and resolved operator labels. Pure. */
export function buildOperatorFeed(
  rows: readonly OperatorFeedRowLike[],
  operatorLabel: (operatorId: string) => string | null,
  nowISO: string,
  requested: number = OPERATOR_FEED_DEPTH,
): OperatorFeedResponse {
  const items = rows
    .filter(admitsFeedRow)
    .map((r) => projectOperatorFeedItem(r, r.performedByAdminId ? operatorLabel(r.performedByAdminId) : null));
  return {
    scope: "PLATFORM_OPS",
    depth: { requested, returned: items.length },
    note: OPERATOR_FEED_NOTE,
    items,
    checkedAt: nowISO,
  };
}
