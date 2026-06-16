import { getServerSession } from "next-auth";
import { cookies }          from "next/headers";
import { authOptions }      from "@/lib/auth";
import { redirect }         from "next/navigation";
import { db }               from "@/lib/db";
import { WorkspacesClient } from "@/components/dashboard/WorkspacesClient";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspace";

export default async function WorkspacesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;

  // ── Active workspace from cookie ──────────────────────────────────────────
  const jar               = await cookies();
  const activeWorkspaceId = jar.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;

  // ── Preferred workspace, my memberships, pending invites ──────────────────
  // These three queries are independent of each other — run them concurrently
  // instead of as sequential round trips (each round trip to Supabase adds
  // real latency on serverless, and this page was previously firing 4+ awaits
  // back to back).
  const [preferredWorkspaceRow, myMemberships, pendingInvites] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).user
      .findUnique({ where: { id: userId }, select: { preferredWorkspaceId: true } })
      .catch(() => null), // migration not yet applied — ignore

    db.workspaceMember.findMany({
      where: { userId, status: "ACTIVE" },
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
      include: {
        workspace: { select: { id: true, name: true, description: true, isPublic: true } },
        invitedBy: { select: { id: true, name: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const preferredWorkspaceId: string | null = preferredWorkspaceRow?.preferredWorkspaceId ?? null;
  const myWorkspaceIds = myMemberships.map((m) => m.workspaceId);

  // ── Public SHARED workspaces the user hasn't joined ───────────────────────
  // Depends on myWorkspaceIds above, so this one stays a separate await.
  const publicWorkspaces = await db.workspace.findMany({
    where: {
      isPublic: true,
      type:     "SHARED",
      id:       { notIn: myWorkspaceIds },
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

  const mine = myMemberships.map((m) => ({
    id:           m.workspace.id,
    name:         m.workspace.name,
    description:  m.workspace.description,
    type:         m.workspace.type,
    isPublic:     m.workspace.isPublic,
    createdAt:    m.workspace.createdAt.toISOString(),
    members:      serializeMembers(m.workspace.members),
    myRole:       m.role as string,
    accountCount: m.workspace._count.accounts,
  }));

  const publicSerialized = publicWorkspaces.map((w) => ({
    id:           w.id,
    name:         w.name,
    description:  w.description,
    type:         w.type,
    isPublic:     w.isPublic,
    createdAt:    w.createdAt.toISOString(),
    members:      serializeMembers(w.members),
    accountCount: w._count.accounts,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invitesSerialized = pendingInvites.map((i: any) => ({
    ...i,
    createdAt: i.createdAt.toISOString(),
    seenAt:    i.seenAt?.toISOString() ?? null,
  }));

  return (
    <WorkspacesClient
      mine={mine}
      publicWorkspaces={publicSerialized}
      pendingInvites={invitesSerialized}
      currentUserId={userId}
      activeWorkspaceId={activeWorkspaceId}
      preferredWorkspaceId={preferredWorkspaceId}
    />
  );
}
