import { getServerSession } from "next-auth";
import { cookies }          from "next/headers";
import { authOptions }      from "@/lib/auth";
import { redirect }         from "next/navigation";
import { db }               from "@/lib/db";
import { SpacesClient }     from "@/components/dashboard/SpacesClient";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspace";
import { getWorkspaceNetWorthSummaries } from "@/lib/data/snapshots";

// Spaces landing page — the redesigned, premium successor to the old
// /dashboard/workspaces page (see lib/workspace.ts and workspace-presets.ts
// for the backend "workspace" naming this intentionally leaves untouched;
// only the user-facing presentation layer is renamed to "Space").
//
// Same data shape as the old page, plus one additive read: a per-workspace
// net worth + sparkline trend (lib/data/snapshots.ts), so the new cards can
// show a real "primary financial metric" without inventing any new backend
// surface or touching the WorkspaceSnapshot schema.
export default async function SpacesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;

  // ── Active workspace from cookie ──────────────────────────────────────────
  const jar               = await cookies();
  const activeWorkspaceId = jar.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;

  // ── Preferred workspace, my memberships, pending invites ──────────────────
  const [preferredWorkspaceRow, myMemberships, pendingInvites] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).user
      .findUnique({ where: { id: userId }, select: { preferredWorkspaceId: true } })
      .catch(() => null), // migration not yet applied — ignore

    db.workspaceMember.findMany({
      where: { userId, status: "ACTIVE", workspace: { archivedAt: null, deletedAt: null } },
      include: {
        workspace: {
          include: {
            members: {
              where: { status: "ACTIVE" },
              include: {
                user: { select: { id: true, name: true, username: true } },
              },
              orderBy: { joinedAt: "asc" },
            },
            _count: {
              select: { accounts: { where: { deletedAt: null } } },
            },
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    }),

    db.workspaceInvite.findMany({
      where: { invitedUserId: userId, status: "PENDING" },
      select: {
        id:        true,
        role:      true,
        status:    true,
        createdAt: true,
        seenAt:    true,
        workspace: { select: { id: true, name: true, description: true, isPublic: true } },
        invitedBy: { select: { id: true, name: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const preferredWorkspaceId: string | null = preferredWorkspaceRow?.preferredWorkspaceId ?? null;
  const myWorkspaceIds = myMemberships.map((m) => m.workspaceId);

  // ── Public SHARED workspaces the user hasn't joined ───────────────────────
  const publicWorkspaces = await db.workspace.findMany({
    where: {
      isPublic:   true,
      type:       "SHARED",
      id:         { notIn: myWorkspaceIds },
      archivedAt: null,
      deletedAt:  null,
    },
    include: {
      members: {
        where: { status: "ACTIVE" },
        include: {
          user: { select: { id: true, name: true, username: true } },
        },
        orderBy: { joinedAt: "asc" },
      },
      _count: {
        select: { accounts: { where: { deletedAt: null } } },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // ── Net worth + sparkline trend, one query for every card on the page ─────
  const allIds = [...myWorkspaceIds, ...publicWorkspaces.map((w) => w.id)];
  const netWorthByWorkspace = await getWorkspaceNetWorthSummaries(allIds);

  // ── Serialization helpers ─────────────────────────────────────────────────

  function serializeMembers(
    members: {
      id: string; role: string; joinedAt: Date; userId: string; workspaceId: string;
      user: { id: string; name: string | null; username: string | null };
    }[]
  ) {
    return members.map((mem) => ({
      id:       mem.id,
      role:     mem.role,
      joinedAt: mem.joinedAt.toISOString(),
      user:     mem.user,
    }));
  }

  const mine = myMemberships.map((m) => {
    const nw = netWorthByWorkspace[m.workspace.id];
    return {
      id:           m.workspace.id,
      name:         m.workspace.name,
      description:  m.workspace.description,
      type:         m.workspace.type,
      category:     m.workspace.category ?? "OTHER",
      isPublic:     m.workspace.isPublic,
      createdAt:    m.workspace.createdAt.toISOString(),
      members:      serializeMembers(m.workspace.members),
      myRole:       m.role as string,
      accountCount: m.workspace._count.accounts,
      netWorth:     nw?.netWorth ?? 0,
      trend:        nw?.trend ?? [],
      lastUpdated:  nw?.asOf ?? null,
    };
  });

  const publicSerialized = publicWorkspaces.map((w) => {
    const nw = netWorthByWorkspace[w.id];
    return {
      id:           w.id,
      name:         w.name,
      description:  w.description,
      type:         w.type,
      category:     w.category ?? "OTHER",
      isPublic:     w.isPublic,
      createdAt:    w.createdAt.toISOString(),
      members:      serializeMembers(w.members),
      accountCount: w._count.accounts,
      netWorth:     nw?.netWorth ?? 0,
      trend:        nw?.trend ?? [],
      lastUpdated:  nw?.asOf ?? null,
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invitesSerialized = pendingInvites.map((i: any) => ({
    ...i,
    createdAt: i.createdAt.toISOString(),
    seenAt:    i.seenAt?.toISOString() ?? null,
  }));

  return (
    <SpacesClient
      mine={mine}
      publicSpaces={publicSerialized}
      pendingInvites={invitesSerialized}
      currentUserId={userId}
      activeSpaceId={activeWorkspaceId}
      preferredSpaceId={preferredWorkspaceId}
    />
  );
}
