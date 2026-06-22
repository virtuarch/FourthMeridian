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
 * Filtered out (noise):
 *   - SPACE_SWITCH — internal navigation, not meaningful to members
 *   - LOGIN / LOGOUT / LOGIN_FAILED — personal auth events, not space-scoped
 *   - PASSWORD_CHANGED / 2FA events / SESSION_REVOKED — security, not activity
 *   - GOAL_UPDATED — too granular; only creation/completion/archive shown
 *   - GOAL_TRASHED / GOAL_PURGE — admin-level, low value for members
 *   - PLAID_SYNC / WALLET_SYNC / ACCOUNT_ADD / ACCOUNT_REMOVE — platform noise
 *   - MANUAL_ASSET_UPDATE — balance edits are too frequent; shown in personal view
 *   - MANUAL_ASSET_PERMANENT_DELETE — rare, admin-level
 *
 * Supported event types (shown to members):
 *   SPACE_CREATED, SPACE_UPDATE
 *   MEMBER_INVITED, MEMBER_JOINED (inferred), MEMBER_REMOVED, MEMBER_ROLE_CHANGED, MEMBER_ROLE_CHANGE
 *   SPACE_LEAVE, SPACE_REMOVE_MEMBER
 *   ACCOUNT_SHARED, ACCOUNT_SHARE, ACCOUNT_REVOKED, ACCOUNT_SHARE_REVOKE
 *   GOAL_CREATED, GOAL_CREATE, GOAL_ARCHIVED, GOAL_RESTORED, GOAL_DELETE (completed)
 *   MANUAL_ASSET_ADD, MANUAL_ASSET_DELETE (archived), MANUAL_ASSET_RESTORE
 */

import { NextRequest, NextResponse }    from "next/server";
import { db }                           from "@/lib/db";
import { requireUser }                  from "@/lib/session";
import { possessive }                   from "@/lib/format";
import { withApiHandler }               from "@/lib/api";
import { SpaceMemberStatus }        from "@prisma/client";
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
  // Manual assets
  "MANUAL_ASSET_ADD",
  "MANUAL_ASSET_DELETE",   // soft-delete = archive
  "MANUAL_ASSET_RESTORE",
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
        id, date, type: log.action, icon: "LayoutDashboard", tone: "info",
        actorName: actor,
        title:    "Space created",
        subtitle: str(meta.name) || "A new space was created",
      };

    case "SPACE_UPDATE":
      return {
        id, date, type: log.action, icon: "Settings", tone: "neutral",
        actorName: actor,
        title:    "Space updated",
        subtitle: "Space details were edited",
      };

    // ── Members ───────────────────────────────────────────────────────────────
    case "MEMBER_INVITED": {
      const email = str(meta.invitedEmail) || "Someone";
      const role  = str(meta.role);
      return {
        id, date, type: log.action, icon: "UserPlus", tone: "info",
        actorName: actor,
        title:    "Member invited",
        subtitle: role ? `${email} was invited as ${role}` : `${email} was invited`,
      };
    }

    case "MEMBER_JOINED":
      return {
        id, date, type: log.action, icon: "UserCheck", tone: "positive",
        actorName: actor,
        title:    "Member joined",
        subtitle: actor ? `${actor} joined the space` : "A new member joined",
      };

    case "MEMBER_REMOVED":
    case "SPACE_REMOVE_MEMBER": {
      const removedName = str(meta.removedName) || str(meta.targetName) || "A member";
      return {
        id, date, type: log.action, icon: "UserMinus", tone: "warning",
        actorName: actor,
        title:    "Member removed",
        subtitle: `${removedName} was removed from the space`,
      };
    }

    case "SPACE_LEAVE":
      return {
        id, date, type: log.action, icon: "LogOut", tone: "neutral",
        actorName: actor,
        title:    "Member left",
        subtitle: actor ? `${actor} left the space` : "A member left the space",
      };

    case "MEMBER_ROLE_CHANGED":
    case "MEMBER_ROLE_CHANGE": {
      const targetName = str(meta.targetName) || str(meta.name) || "A member";
      const newRole    = str(meta.newRole) || str(meta.role);
      return {
        id, date, type: log.action, icon: "Shield", tone: "neutral",
        actorName: actor,
        title:    "Role changed",
        subtitle: newRole ? `${possessive(targetName)} role changed to ${newRole}` : `${possessive(targetName)} role was updated`,
      };
    }

    // ── Account sharing ───────────────────────────────────────────────────────
    case "ACCOUNT_SHARED":
    case "ACCOUNT_SHARE": {
      const accountName  = str(meta.accountName) || str(meta.name) || "an account";
      const visibility   = str(meta.visibilityLevel) || str(meta.visibility);
      const visLabel     = visibility === "BALANCE_ONLY" ? "balance only" : visibility === "FULL" ? "full access" : "";
      return {
        id, date, type: log.action, icon: "Landmark", tone: "info",
        actorName: actor,
        title:    "Account shared",
        subtitle: visLabel
          ? `${actor ?? "Someone"} shared ${accountName} (${visLabel})`
          : `${actor ?? "Someone"} shared ${accountName}`,
      };
    }

    case "ACCOUNT_REVOKED":
    case "ACCOUNT_SHARE_REVOKE": {
      const accountName = str(meta.accountName) || str(meta.name) || "an account";
      return {
        id, date, type: log.action, icon: "Landmark", tone: "warning",
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
        id, date, type: log.action, icon: "Target", tone: "info",
        actorName: actor,
        title:    "Goal created",
        subtitle: `${goalName} was added`,
      };
    }

    case "GOAL_ARCHIVED": {
      const goalName = str(meta.goalName) || str(meta.name) || "A goal";
      return {
        id, date, type: log.action, icon: "Archive", tone: "neutral",
        actorName: actor,
        title:    "Goal archived",
        subtitle: `${goalName} was archived`,
      };
    }

    case "GOAL_RESTORED": {
      const goalName = str(meta.goalName) || str(meta.name) || "A goal";
      return {
        id, date, type: log.action, icon: "RotateCcw", tone: "positive",
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
        id, date, type: log.action, icon: isComplete ? "CheckCircle2" : "Archive", tone: isComplete ? "positive" : "neutral",
        actorName: actor,
        title:    isComplete ? "Goal completed" : "Goal removed",
        subtitle: isComplete ? `${goalName} reached its target` : `${goalName} was removed`,
      };
    }

    // ── Manual assets ─────────────────────────────────────────────────────────
    case "MANUAL_ASSET_ADD": {
      const name = str(meta.name) || "An asset";
      return {
        id, date, type: log.action, icon: "PackagePlus", tone: "positive",
        actorName: actor,
        title:    "Asset added",
        subtitle: `${name} was added as a manual asset`,
      };
    }

    case "MANUAL_ASSET_DELETE": {
      const assetName = str(meta.name) || "An asset";
      return {
        id, date, type: log.action, icon: "PackageMinus", tone: "warning",
        actorName: actor,
        title:    "Asset archived",
        subtitle: `${assetName} was archived`,
        href:     "/dashboard/settings/archived-assets",
      };
    }

    case "MANUAL_ASSET_RESTORE": {
      const assetName = str(meta.name) || "An asset";
      return {
        id, date, type: log.action, icon: "PackageCheck", tone: "positive",
        actorName: actor,
        title:    "Asset restored",
        subtitle: `${assetName} was restored from the archive`,
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
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  const { id: spaceId } = await params;
  if (!spaceId) return NextResponse.json({ error: "Missing space id" }, { status: 400 });

  // ── Membership guard ──────────────────────────────────────────────────────
  const membership = await db.spaceMember.findUnique({
    where:  { spaceId_userId: { spaceId, userId } },
    select: { status: true },
  });
  if (!membership || membership.status !== SpaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  // ── Normalize ─────────────────────────────────────────────────────────────
  // Logs are already ordered newest-first by the DB query (orderBy: createdAt desc).
  // SPACE_CREATED naturally falls to the bottom because it's the oldest event.
  const events: TimelineEvent[] = rawLogs
    .map((log) => normalizeLog(log as RawLog))
    .filter((e): e is TimelineEvent => e !== null)
    .slice(0, 100);

  return NextResponse.json({ events });
}, "GET /api/spaces/[id]/activity");

// Re-export the type so SpaceDashboard can import it if needed
export type { TimelineEvent, TimelineTone };
