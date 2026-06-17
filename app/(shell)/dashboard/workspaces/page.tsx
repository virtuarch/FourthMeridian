import { getServerSession } from "next-auth";
import { cookies }          from "next/headers";
import { authOptions }      from "@/lib/auth";
import { redirect }         from "next/navigation";
import { db }               from "@/lib/db";
import { WorkspacesClient } from "@/components/dashboard/WorkspacesClient";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspace";

export default async function WorkspacesPage() {
  // ── Timing instrumentation ──────────────────────────────────────────────
  // Chrome's Network panel can show a fast "Waiting for server" (TTFB) but a
  // slow "Content Download" for the same request. For a non-streamed RSC
  // response (no loading.tsx / <Suspense> boundary on this route — confirmed
  // absent), that split usually points away from "DB queries are slow" and
  // toward "the response body itself is large" or "the transfer is throttled."
  // We log both: per-query timings (rules DB in/out) AND final payload size +
  // object counts (rules the oversized-body theory in/out). Check Vercel
  // function logs for the "[workspaces page]" lines after a slow load.
  const t0 = Date.now();
  const lap = (label: string, from: number) => {
    console.log(`[workspaces page] ${label}: ${Date.now() - from}ms`);
    return Date.now();
  };

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");
  let t = lap("getServerSession", t0);

  const userId = session.user.id;

  // ── Active workspace from cookie ──────────────────────────────────────────
  const jar               = await cookies();
  const activeWorkspaceId = jar.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;
  t = lap("cookies()", t);

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
      // Archived/trashed workspaces are excluded from this default list —
      // they're only reachable from here on via the Archive & Trash page.
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
  t = lap("Promise.all [preferredWorkspace, myMemberships, pendingInvites]", t);

  const preferredWorkspaceId: string | null = preferredWorkspaceRow?.preferredWorkspaceId ?? null;
  const myWorkspaceIds = myMemberships.map((m) => m.workspaceId);

  // ── Public SHARED workspaces the user hasn't joined ───────────────────────
  // Depends on myWorkspaceIds above, so this one stays a separate await.
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
  t = lap("publicWorkspaces.findMany", t);

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
  t = lap("serialization", t);

  // ── Payload size / object count diagnostics ────────────────────────────
  // This is the number that actually settles the "is the RSC payload huge"
  // question. It measures the JSON the page hands to <WorkspacesClient>,
  // not the full RSC wire format (which adds React's flight-protocol framing
  // on top) — but if this number is already large, the wire payload only
  // gets bigger from here, never smaller.
  const props = {
    mine,
    publicWorkspaces: publicSerialized,
    pendingInvites: invitesSerialized,
    currentUserId: userId,
    activeWorkspaceId,
    preferredWorkspaceId,
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(props), "utf8");
  const totalMemberRows =
    mine.reduce((n, w) => n + w.members.length, 0) +
    publicSerialized.reduce((n, w) => n + w.members.length, 0);

  console.log("[workspaces page] payload diagnostics:", {
    totalMs:           Date.now() - t0,
    payloadKB:          (payloadBytes / 1024).toFixed(1),
    mineCount:          mine.length,
    publicCount:        publicSerialized.length,
    inviteCount:        invitesSerialized.length,
    totalMemberRows,
  });

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
