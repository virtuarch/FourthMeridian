import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { WorkplacesClient } from "@/components/dashboard/WorkplacesClient";

export default async function WorkplacesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;

  // My memberships (all workspace types)
  const myMemberships = await db.workspaceMember.findMany({
    where: { userId },
    include: {
      workspace: {
        include: {
          members: {
            include: {
              user: { select: { id: true, name: true, username: true } },
            },
            orderBy: { joinedAt: "asc" },
          },
        },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  const myWorkspaceIds = myMemberships.map((m) => m.workspaceId);

  // Public SHARED workspaces the user hasn't joined
  const publicWorkspaces = await db.workspace.findMany({
    where: {
      isPublic: true,
      type:     "SHARED",
      id:       { notIn: myWorkspaceIds },
    },
    include: {
      members: {
        include: {
          user: { select: { id: true, name: true, username: true } },
        },
        orderBy: { joinedAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Pending invites for this user
  const pendingInvites = await db.workspaceInvite.findMany({
    where: { invitedUserId: userId, status: "PENDING" },
    include: {
      workspace: { select: { id: true, name: true, description: true, isPublic: true } },
      invitedBy: { select: { id: true, name: true, username: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  function serializeMembers(members: { id: string; role: string; joinedAt: Date; userId: string; workspaceId: string; user: { id: string; name: string | null; username: string | null } }[]) {
    return members.map((mem) => ({
      id: mem.id,
      role: mem.role,
      joinedAt: mem.joinedAt.toISOString(),
      user: mem.user,
    }));
  }

  const mine = myMemberships.map((m) => ({
    id:          m.workspace.id,
    name:        m.workspace.name,
    description: m.workspace.description,
    type:        m.workspace.type,
    isPublic:    m.workspace.isPublic,
    createdAt:   m.workspace.createdAt.toISOString(),
    members:     serializeMembers(m.workspace.members),
    myRole:      m.role as string,
  }));

  const publicSerialized = publicWorkspaces.map((w) => ({
    id:          w.id,
    name:        w.name,
    description: w.description,
    type:        w.type,
    isPublic:    w.isPublic,
    createdAt:   w.createdAt.toISOString(),
    members:     serializeMembers(w.members),
  }));

  const invitesSerialized = pendingInvites.map((i) => ({
    ...i,
    createdAt: i.createdAt.toISOString(),
  }));

  return (
    <WorkplacesClient
      mine={mine}
      publicWorkspaces={publicSerialized}
      pendingInvites={invitesSerialized}
      currentUserId={userId}
    />
  );
}
