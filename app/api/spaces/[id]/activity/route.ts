/**
 * GET /api/spaces/[id]/activity
 *
 * Returns the latest 30 normalized space activity events for the
 * TimelineWidget, sourced from AuditLog rows scoped to this space.
 *
 * Security:
 *   - Caller must be an ACTIVE member of the space.
 *   - Raw audit metadata is never exposed verbatim; only safe fields are
 *     forwarded (names, roles, visibility level labels).
 *   - BALANCE_ONLY account names are safe to show (name only, no balance).
 *
 * Every event carries a member-facing `category` (financial / connection /
 * space / system, per lib/timeline-types.ts) so the Activity tab can filter.
 *
 * Sources merged here (all read-only, no new writes anywhere):
 *   - AuditLog rows scoped to this space (normalizeLog)
 *   - ImportBatch rows on this space's linked accounts (normalizeImportBatchEvent)
 *   - unresolved SyncIssue rows on this space's linked accounts (normalizeSyncIssueEvent)
 *
 * Filtered out (noise):
 *   - SPACE_SWITCH — internal navigation, not meaningful to members
 *   - LOGIN / LOGOUT / LOGIN_FAILED — personal auth events, not space-scoped
 *   - PASSWORD_CHANGED / 2FA events / SESSION_REVOKED — security, not activity
 *   - GOAL_UPDATED — too granular; only creation/completion/archive shown
 *   - GOAL_TRASHED / GOAL_PURGE — admin-level, low value for members
 *   - MANUAL_ASSET_UPDATE — balance edits are too frequent; shown in personal view
 *   - MANUAL_ASSET_PERMANENT_DELETE — rare, admin-level
 *
 * Connection/system events reframed IN (previously suppressed as "platform
 * noise"): PLAID_SYNC, PLAID_REFRESH, WALLET_SYNC, ACCOUNT_ADD, ACCOUNT_REMOVE,
 * IMPORT_BATCH_ROLLED_BACK. NB (verified at the write sites): PLAID_SYNC and
 * PLAID_REFRESH are written with a null spaceId, so they do not surface in this
 * space-scoped query today — the cases exist so they render correctly the day a
 * space-scoped sync write lands. WALLET_SYNC currently has no writer at all
 * (wallet routes write WALLET_ADD / ACCOUNT_RESTORE); its case is likewise
 * dormant-but-ready. ACCOUNT_ADD / ACCOUNT_REMOVE / IMPORT_BATCH_ROLLED_BACK
 * DO carry a spaceId and surface immediately.
 *
 * Supported event types (shown to members):
 *   SPACE_CREATED, SPACE_UPDATE
 *   MEMBER_INVITED, MEMBER_JOINED (inferred), MEMBER_REMOVED, MEMBER_ROLE_CHANGED, MEMBER_ROLE_CHANGE
 *   SPACE_LEAVE, SPACE_REMOVE_MEMBER
 *   ACCOUNT_SHARED, ACCOUNT_SHARE, ACCOUNT_REVOKED, ACCOUNT_SHARE_REVOKE
 *   GOAL_CREATED, GOAL_CREATE, GOAL_ARCHIVED, GOAL_RESTORED, GOAL_DELETE (completed)
 *   GOAL_CHECKED_IN (HABIT check-in)
 *   MANUAL_ASSET_ADD, MANUAL_ASSET_DELETE (archived), MANUAL_ASSET_RESTORE
 *   PLAID_SYNC, PLAID_REFRESH, WALLET_SYNC, ACCOUNT_ADD, ACCOUNT_REMOVE
 *   IMPORT_BATCH_ROLLED_BACK
 */

import { NextRequest, NextResponse }    from "next/server";
import { ShareStatus }                  from "@prisma/client";
import { db }                           from "@/lib/db";
import { requireSpaceAction }           from "@/lib/spaces/authorize";
import { possessive }                   from "@/lib/format";
import { withApiHandler }               from "@/lib/api";
import { normalizeImportBatchEvent }    from "@/lib/activity/normalize-import-batch";
import { normalizeSyncIssueEvent }      from "@/lib/activity/normalize-sync-issue";
import { displayActivityAccountName }   from "@/lib/activity/account-name-privacy";
import type { TimelineEvent, TimelineTone } from "@/lib/timeline-types";

// ─── Events we actively show ──────────────────────────────────────────────────

const ALLOWED_ACTIONS = new Set([
  // Space lifecycle
  "SPACE_CREATED", "SPACE_CREATE", "SPACE_UPDATE",
  // Members
  "MEMBER_INVITED", "MEMBER_JOINED", "MEMBER_REMOVED",
  "MEMBER_ROLE_CHANGED", "MEMBER_ROLE_CHANGE",
  "SPACE_LEAVE", "SPACE_REMOVE_MEMBER",
  // Account sharing
  "ACCOUNT_SHARED", "ACCOUNT_SHARE",
  "ACCOUNT_REVOKED", "ACCOUNT_SHARE_REVOKE",
  // Goals
  "GOAL_CREATED", "GOAL_CREATE",
  "GOAL_ARCHIVED",
  "GOAL_RESTORED",
  "GOAL_DELETE",      // used for goal completion in some routes
  "GOAL_CHECKED_IN",  // Timeline T-2 — HABIT check-in
  // Manual assets
  "MANUAL_ASSET_ADD",
  "MANUAL_ASSET_DELETE",   // soft-delete = archive
  "MANUAL_ASSET_RESTORE",
  // Connection / platform — reframed in (were suppressed as "platform noise").
  // PLAID_SYNC / PLAID_REFRESH / WALLET_SYNC are written with a null spaceId (or
  // not written at all, for WALLET_SYNC) today, so they won't surface in this
  // space-scoped query yet; their normalizer cases exist so they render the day
  // a space-scoped write lands. ACCOUNT_ADD / ACCOUNT_REMOVE carry a spaceId.
  "PLAID_SYNC", "PLAID_REFRESH", "WALLET_SYNC",
  "ACCOUNT_ADD", "ACCOUNT_REMOVE",
  // Full deferred history pipeline finished (bell + this entry share one record).
  "PLAID_HISTORY_SYNCED",
  // System — import rollback (real action, carries spaceId).
  "IMPORT_BATCH_ROLLED_BACK",
]);

// ─── Normalizer ───────────────────────────────────────────────────────────────

interface RawLog {
  id:         string;
  action:     string;
  metadata:   unknown;
  createdAt:  Date;
  user:       { firstName: string | null; lastName: string | null; email: string | null } | null;
}

function actorName(log: RawLog): string | undefined {
  const u = log.user;
  if (!u) return undefined;
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.email?.split("@")[0] || undefined;
}

type Meta = Record<string, unknown>;

function getMeta(log: RawLog): Meta {
  return (typeof log.metadata === "object" && log.metadata !== null)
    ? log.metadata as Meta
    : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function normalizeLog(log: RawLog): TimelineEvent | null {
  const meta   = getMeta(log);
  const actor  = actorName(log);
  const date   = log.createdAt.toISOString();
  const id     = log.id;

  switch (log.action) {

    // ── Space lifecycle ────────────────────────────────────────────────────
    case "SPACE_CREATED":
    case "SPACE_CREATE":
      return {
        id, date, type: log.action, icon: "LayoutDashboard", tone: "info", category: "space",
        actorName: actor,
        title:    "Space created",
        subtitle: str(meta.name) || "A new space was created",
      };

    case "SPACE_UPDATE":
      return {
        id, date, type: log.action, icon: "Settings", tone: "neutral", category: "space",
        actorName: actor,
        title:    "Space updated",
        subtitle: "Space details were edited",
      };

    // ── Members ───────────────────────────────────────────────────────────────
    case "MEMBER_INVITED": {
      const email = str(meta.invitedEmail) || "Someone";
      const role  = str(meta.role);
      return {
        id, date, type: log.action, icon: "UserPlus", tone: "info", category: "space",
        actorName: actor,
        title:    "Member invited",
        subtitle: role ? `${email} was invited as ${role}` : `${email} was invited`,
      };
    }

    case "MEMBER_JOINED":
      return {
        id, date, type: log.action, icon: "UserCheck", tone: "positive", category: "space",
        actorName: actor,
        title:    "Member joined",
        subtitle: actor ? `${actor} joined the space` : "A new member joined",
      };

    case "MEMBER_REMOVED":
    case "SPACE_REMOVE_MEMBER": {
      const removedName = str(meta.removedName) || str(meta.targetName) || "A member";
      return {
        id, date, type: log.action, icon: "UserMinus", tone: "warning", category: "space",
        actorName: actor,
        title:    "Member removed",
        subtitle: `${removedName} was removed from the space`,
      };
    }

    case "SPACE_LEAVE":
      return {
        id, date, type: log.action, icon: "LogOut", tone: "neutral", category: "space",
        actorName: actor,
        title:    "Member left",
        subtitle: actor ? `${actor} left the space` : "A member left the space",
      };

    case "MEMBER_ROLE_CHANGED":
    case "MEMBER_ROLE_CHANGE": {
      const targetName = str(meta.targetName) || str(meta.name) || "A member";
      const newRole    = str(meta.newRole) || str(meta.role);
      return {
        id, date, type: log.action, icon: "Shield", tone: "neutral", category: "space",
        actorName: actor,
        title:    "Role changed",
        subtitle: newRole ? `${possessive(targetName)} role changed to ${newRole}` : `${possessive(targetName)} role was updated`,
      };
    }

    // ── Account sharing ───────────────────────────────────────────────────────
    case "ACCOUNT_SHARED":
    case "ACCOUNT_SHARE": {
      const visibility   = str(meta.visibilityLevel) || str(meta.visibility);
      // P1-3 — display-safe name: only a FULL share surfaces the real name;
      // BALANCE_ONLY / SUMMARY_ONLY and legacy rows fall back to a generic
      // identity. The visibility label uses the SAME marker, so the two agree.
      const accountName  = displayActivityAccountName(str(meta.accountName) || str(meta.name), visibility);
      const visLabel     = visibility === "BALANCE_ONLY" ? "balance only" : visibility === "FULL" ? "full access" : "";
      return {
        id, date, type: log.action, icon: "Landmark", tone: "info", category: "space",
        actorName: actor,
        title:    "Account shared",
        subtitle: visLabel
          ? `${actor ?? "Someone"} shared ${accountName} (${visLabel})`
          : `${actor ?? "Someone"} shared ${accountName}`,
      };
    }

    case "ACCOUNT_REVOKED":
    case "ACCOUNT_SHARE_REVOKE": {
      // P1-3 — fail closed: legacy revoke rows carry no visibility marker, so a
      // persisted real name (BALANCE_ONLY account) is redacted to the generic
      // label here; only a FULL-marked revoke surfaces the real name.
      const accountName = displayActivityAccountName(str(meta.accountName) || str(meta.name), str(meta.visibilityLevel));
      return {
        id, date, type: log.action, icon: "Landmark", tone: "warning", category: "space",
        actorName: actor,
        title:    "Account unshared",
        subtitle: `${actor ?? "Someone"} removed ${accountName} from this space`,
      };
    }

    // ── Goals ─────────────────────────────────────────────────────────────────
    case "GOAL_CREATED":
    case "GOAL_CREATE": {
      const goalName = str(meta.goalName) || str(meta.name) || "A goal";
      return {
        id, date, type: log.action, icon: "Target", tone: "info", category: "space",
        actorName: actor,
        title:    "Goal created",
        subtitle: `${goalName} was added`,
      };
    }

    case "GOAL_ARCHIVED": {
      const goalName = str(meta.goalName) || str(meta.name) || "A goal";
      return {
        id, date, type: log.action, icon: "Archive", tone: "neutral", category: "space",
        actorName: actor,
        title:    "Goal archived",
        subtitle: `${goalName} was archived`,
      };
    }

    case "GOAL_RESTORED": {
      const goalName = str(meta.goalName) || str(meta.name) || "A goal";
      return {
        id, date, type: log.action, icon: "RotateCcw", tone: "positive", category: "space",
        actorName: actor,
        title:    "Goal restored",
        subtitle: `${goalName} was restored`,
      };
    }

    case "GOAL_DELETE": {
      // In some routes this action is logged for goal completion (status → COMPLETED).
      // Check meta to distinguish.
      const goalName   = str(meta.goalName) || str(meta.name) || "A goal";
      const isComplete = meta.status === "COMPLETED" || !!meta.completedAt;
      return {
        id, date, type: log.action, icon: isComplete ? "CheckCircle2" : "Archive", tone: isComplete ? "positive" : "neutral", category: "space",
        actorName: actor,
        title:    isComplete ? "Goal completed" : "Goal removed",
        subtitle: isComplete ? `${goalName} reached its target` : `${goalName} was removed`,
      };
    }

    // ── Goal check-in (Timeline T-2) ──────────────────────────────────────────
    case "GOAL_CHECKED_IN": {
      const goalName = str(meta.goalName) || str(meta.name) || "A goal";
      const streak   = typeof meta.streak === "number" ? meta.streak : 0;
      return {
        id, date, type: log.action, icon: "Flame", tone: "positive", category: "space",
        actorName: actor,
        title:    "Goal check-in",
        subtitle: streak > 1 ? `${goalName} — ${streak}-day streak` : `Checked in on ${goalName}`,
      };
    }

    // ── Manual assets ─────────────────────────────────────────────────────────
    case "MANUAL_ASSET_ADD": {
      const name = str(meta.name) || "An asset";
      return {
        id, date, type: log.action, icon: "PackagePlus", tone: "positive", category: "financial",
        actorName: actor,
        title:    "Asset added",
        subtitle: `${name} was added as a manual asset`,
      };
    }

    case "MANUAL_ASSET_DELETE": {
      const assetName = str(meta.name) || "An asset";
      return {
        id, date, type: log.action, icon: "PackageMinus", tone: "warning", category: "financial",
        actorName: actor,
        title:    "Asset archived",
        subtitle: `${assetName} was archived`,
        href:     "/dashboard/settings/archived-assets",
      };
    }

    case "MANUAL_ASSET_RESTORE": {
      const assetName = str(meta.name) || "An asset";
      return {
        id, date, type: log.action, icon: "PackageCheck", tone: "positive", category: "financial",
        actorName: actor,
        title:    "Asset restored",
        subtitle: `${assetName} was restored from the archive`,
      };
    }

    // ── Connection / sync (reframed in) ───────────────────────────────────────
    // Verified write sites (app/api/plaid/{sync,refresh}/route.ts, lib/plaid/refresh.ts):
    // metadata carries transaction/holding *counts only* — never an institution or
    // account name — and these rows are written with a null spaceId, so they don't
    // surface in this space-scoped query today. Honest generic copy: no name to show.
    case "PLAID_SYNC":
    case "PLAID_REFRESH":
      return {
        id, date, type: log.action, icon: "RefreshCw", tone: "neutral", category: "connection",
        actorName: actor,
        title:    "Account synced",
        subtitle: "Balances and transactions were refreshed",
      };

    case "WALLET_SYNC":
      // No writer exists for this action today (wallet routes write WALLET_ADD /
      // ACCOUNT_RESTORE). Kept dormant-but-ready per the plan; generic copy.
      return {
        id, date, type: log.action, icon: "RefreshCw", tone: "neutral", category: "connection",
        actorName: actor,
        title:    "Wallet synced",
        subtitle: "Wallet balances were refreshed",
      };

    case "ACCOUNT_ADD": {
      // Verified write site (lib/plaid/exchangeToken.ts): metadata.institution is
      // the Plaid institution display name; spaceId is set.
      const institution = str(meta.institution);
      return {
        id, date, type: log.action, icon: "Link2", tone: "positive", category: "connection",
        actorName: actor,
        title:    "Account connected",
        subtitle: institution ? `${institution} was connected` : "A new account was connected",
      };
    }

    case "PLAID_HISTORY_SYNCED": {
      // Verified write site (lib/plaid/sync-notifications.notifyItemSyncComplete):
      // metadata.institutionName is the Plaid institution name; spaceId is set.
      // Shares this one AuditLog row with the SYNC_COMPLETED bell notification.
      const institution = str(meta.institutionName);
      return {
        id, date, type: log.action, icon: "CheckCircle2", tone: "positive", category: "connection",
        actorName: actor,
        title:    "History ready",
        subtitle: institution
          ? `${institution} — full transaction history and 30-day balance history are ready`
          : "Full transaction history and 30-day balance history are ready",
      };
    }

    case "ACCOUNT_REMOVE": {
      // Verified write site (app/api/accounts/[id]/route.ts): metadata.accountName
      // is the FinancialAccount name; spaceId is set.
      const accountName = str(meta.accountName);
      return {
        id, date, type: log.action, icon: "Unlink", tone: "warning", category: "connection",
        actorName: actor,
        title:    "Account disconnected",
        subtitle: accountName ? `${accountName} was disconnected` : "An account was disconnected",
      };
    }

    // ── System — import rollback (reframed in) ────────────────────────────────
    case "IMPORT_BATCH_ROLLED_BACK": {
      // Verified write site (app/api/imports/[id]/rollback/route.ts): metadata carries
      // rolledBackCount (transactions soft-deleted) always; investmentEventsRolledBack
      // only for INVESTMENT_HISTORY batches. spaceId is set; no account/institution name.
      const rolledBack = num(meta.rolledBackCount);
      const invEvents  = num(meta.investmentEventsRolledBack);
      const reversed   = invEvents > 0 ? invEvents : rolledBack;
      return {
        id, date, type: log.action, icon: "Undo2", tone: "neutral", category: "system",
        actorName: actor,
        title:    "Import rolled back",
        subtitle: reversed > 0
          ? `${reversed} imported ${reversed === 1 ? "record was" : "records were"} reversed`
          : "A previous import was reversed",
      };
    }

    default:
      return null;
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

export const GET = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id: spaceId } = await params;
  if (!spaceId) return NextResponse.json({ error: "Missing space id" }, { status: 400 });

  // ── Membership guard (any ACTIVE member) ──────────────────────────────────
  const [, err] = await requireSpaceAction(spaceId, "activity:read");
  if (err) return err;

  // ── Fetch raw logs ────────────────────────────────────────────────────────
  // We fetch slightly more than 30 to account for rows that normalise to null
  const rawLogs = await db.auditLog.findMany({
    where: {
      spaceId,
      action: { in: Array.from(ALLOWED_ACTIONS) },
    },
    orderBy: { createdAt: "desc" },
    take:    100,
    select: {
      id:        true,
      action:    true,
      metadata:  true,
      createdAt: true,
      user: {
        select: {
          firstName: true,
          lastName:  true,
          email:     true,
        },
      },
    },
  });

  // ── Normalize AuditLog source ─────────────────────────────────────────────
  const auditEvents: TimelineEvent[] = rawLogs
    .map((log) => normalizeLog(log as RawLog))
    .filter((e): e is TimelineEvent => e !== null);

  // ── Resolve this space's ACTIVE-linked, non-deleted account ids ────────────
  // ImportBatch has a `financialAccount` relation, but SyncIssue is a forensic
  // side-table with only a scalar `financialAccountId` (no relation to traverse),
  // so neither can use the nested `financialAccount.spaceAccountLinks` shape for
  // both. We resolve the account-id set once via SpaceAccountLink (the shape §1.3
  // verified) — mirroring lib/data/transactions.ts's ACTIVE + deletedAt:null
  // filter — then scope both producers by `financialAccountId: { in }`. An empty
  // set yields no import/sync events, which is correct for a space with no links.
  const links = await db.spaceAccountLink.findMany({
    where: { spaceId, status: ShareStatus.ACTIVE, financialAccount: { deletedAt: null } },
    select: { financialAccountId: true },
  });
  const accountIds = links.map((l) => l.financialAccountId);

  // ── ImportBatch source — COMPLETED batches on those accounts ───────────────
  const importBatches = accountIds.length === 0 ? [] : await db.importBatch.findMany({
    where: { status: "COMPLETED", financialAccountId: { in: accountIds } },
    orderBy: { completedAt: "desc" },
    take: 50,
    select: {
      id: true, kind: true, status: true,
      importedCount: true, skippedCount: true, matchedCount: true,
      completedAt: true,
    },
  });
  const importEvents = importBatches
    .map(normalizeImportBatchEvent)
    .filter((e): e is TimelineEvent => e !== null);

  // ── SyncIssue source — UNRESOLVED issues on those accounts ─────────────────
  // `detail` is deliberately NOT selected: it may carry provider-internal
  // identifiers and must never reach member-facing copy.
  const syncIssues = accountIds.length === 0 ? [] : await db.syncIssue.findMany({
    where: { resolved: false, financialAccountId: { in: accountIds } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, kind: true, resolved: true, createdAt: true },
  });
  const syncEvents = syncIssues
    .map(normalizeSyncIssueEvent)
    .filter((e): e is TimelineEvent => e !== null);

  // ── Merge all three normalized arrays, sort newest-first, single cap ───────
  // ISO 8601 strings sort lexicographically in timestamp order, so string
  // compare is a correct date sort here.
  const events: TimelineEvent[] = [...auditEvents, ...importEvents, ...syncEvents]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 60);

  return NextResponse.json({ events });
}, "GET /api/spaces/[id]/activity");

// Re-export the type so SpaceDashboard can import it if needed
export type { TimelineEvent, TimelineTone };
