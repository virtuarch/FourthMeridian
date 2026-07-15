import { getServerSession } from "next-auth";
import { cookies }          from "next/headers";
import { authOptions }      from "@/lib/auth";
import { redirect }         from "next/navigation";
import { db }               from "@/lib/db";
import { SpacesClient }     from "@/components/dashboard/SpacesClient";
import { ACTIVE_SPACE_COOKIE } from "@/lib/space";
import { getSpaceNetWorthSummaries } from "@/lib/data/snapshots";

// Spaces landing page — the redesigned, premium successor to the old
// /dashboard/spaces page (see lib/space.ts and space-presets.ts
// for the backend "space" naming this intentionally leaves untouched;
// only the user-facing presentation layer is renamed to "Space").
//
// Same data shape as the old page, plus one additive read: a per-space
// net worth + sparkline trend (lib/data/snapshots.ts), so the new cards can
// show a real "primary financial metric" without inventing any new backend
// surface or touching the SpaceSnapshot schema.
export default async function SpacesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;

  // ── Active space from cookie ──────────────────────────────────────────
  const jar               = await cookies();
  const activeSpaceId = jar.get(ACTIVE_SPACE_COOKIE)?.value ?? null;

  // ── Preferred space, my memberships, pending invites, platform grants ─
  const [preferredSpaceRow, myMemberships, pendingInvites, platformGrants] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).user
      .findUnique({ where: { id: userId }, select: { preferredSpaceId: true } })
      .catch(() => null), // migration not yet applied — ignore

    db.spaceMember.findMany({
      where: { userId, status: "ACTIVE", space: { archivedAt: null, deletedAt: null } },
      include: {
        space: {
          include: {
            members: {
              where: { status: "ACTIVE" },
              include: {
                user: { select: { id: true, name: true, username: true } },
              },
              orderBy: { joinedAt: "asc" },
            },
            _count: {
              // Canonical account count (A1): ACTIVE SpaceAccountLink rows whose
              // FinancialAccount is not soft-deleted. Legacy `Space.accounts`
              // counted only legacy `Account` rows — always ~0 on current data,
              // a user-facing undercount. @@unique([spaceId, financialAccountId])
              // makes the ACTIVE-link count equal the distinct-account count.
              select: {
                accountLinks: {
                  where: { status: "ACTIVE", financialAccount: { deletedAt: null } },
                },
              },
            },
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    }),

    db.spaceInvite.findMany({
      where: { invitedUserId: userId, status: "PENDING" },
      select: {
        id:        true,
        role:      true,
        status:    true,
        createdAt: true,
        seenAt:    true,
        space: { select: { id: true, name: true, description: true, isPublic: true } },
        invitedBy: { select: { id: true, name: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
    }),

    // PO1.0 — platform Spaces the user holds an ACTIVE grant on (access-derived).
    db.platformGrant.findMany({
      where:  { userId, status: "ACTIVE" },
      select: { area: true, level: true },
    }),
  ]);

  const preferredSpaceId: string | null = preferredSpaceRow?.preferredSpaceId ?? null;
  const mySpaceIds = myMemberships.map((m) => m.spaceId);

  // ── Platform Spaces (access-derived; no SpaceMember rows) ─────────────
  const platformSpaces = platformGrants.length === 0 ? [] : (
    await db.space.findMany({
      where:  { platformArea: { in: platformGrants.map((g) => g.area) } },
      select: { id: true, name: true, platformArea: true },
    })
  ).map((s) => ({
    id:     s.id,
    name:   s.name,
    area:   s.platformArea as string,
    access: platformGrants.find((g) => g.area === s.platformArea)!.level as string,
  }));

  // ── Public SHARED spaces the user hasn't joined ───────────────────────
  const publicSpaces = await db.space.findMany({
    where: {
      isPublic:   true,
      type:       "SHARED",
      id:         { notIn: mySpaceIds },
      archivedAt: null,
      deletedAt:  null,
      // PO1.0 defense-in-depth — platform Spaces are never public (isPublic:false
      // already excludes them); this makes the exclusion explicit at the query.
      platformArea: null,
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
        // Canonical account count (A1) — see the myMemberships query above.
        select: {
          accountLinks: {
            where: { status: "ACTIVE", financialAccount: { deletedAt: null } },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // ── Net worth + sparkline trend, one query for every card on the page ─────
  const allIds = [...mySpaceIds, ...publicSpaces.map((w) => w.id)];
  const netWorthBySpace = await getSpaceNetWorthSummaries(allIds);

  // ── Serialization helpers ─────────────────────────────────────────────────

  function serializeMembers(
    members: {
      id: string; role: string; joinedAt: Date; userId: string; spaceId: string;
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
    const nw = netWorthBySpace[m.space.id];
    return {
      id:           m.space.id,
      name:         m.space.name,
      description:  m.space.description,
      type:         m.space.type,
      category:     m.space.category ?? "OTHER",
      isPublic:     m.space.isPublic,
      createdAt:    m.space.createdAt.toISOString(),
      members:      serializeMembers(m.space.members),
      myRole:       m.role as string,
      accountCount: m.space._count.accountLinks,
      netWorth:     nw?.netWorth ?? 0,
      // MC1 QA Q5 — each card labels in its OWN Space's reporting currency.
      currency:     nw?.currency ?? "USD",
      trend:        nw?.trend ?? [],
      lastUpdated:  nw?.asOf ?? null,
    };
  });

  const publicSerialized = publicSpaces.map((w) => {
    const nw = netWorthBySpace[w.id];
    return {
      id:           w.id,
      name:         w.name,
      description:  w.description,
      type:         w.type,
      category:     w.category ?? "OTHER",
      isPublic:     w.isPublic,
      createdAt:    w.createdAt.toISOString(),
      members:      serializeMembers(w.members),
      accountCount: w._count.accountLinks,
      netWorth:     nw?.netWorth ?? 0,
      // MC1 QA Q5 — each card labels in its OWN Space's reporting currency.
      currency:     nw?.currency ?? "USD",
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
      activeSpaceId={activeSpaceId}
      preferredSpaceId={preferredSpaceId}
      platformSpaces={platformSpaces}
    />
  );
}
