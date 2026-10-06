import { getServerSession } from "next-auth";
import { authOptions }      from "@/lib/auth";
import { redirectToLogin }  from "@/lib/auth/login-redirect";
import { db }               from "@/lib/db";
import { SpacesClient }     from "@/components/dashboard/SpacesClient";
import { getSpaceContext } from "@/lib/space";
import { getSpaceNetWorthSummaries } from "@/lib/data/snapshots";
import { withTenantDb } from "@/lib/db/tenant-context";
import { getSpaceCardFreshness } from "@/lib/freshness/space-card-freshness";

// Spaces landing page — the redesigned, premium successor to the old
// /dashboard/spaces page (see lib/space.ts and space-presets.ts
// for the backend "space" naming this intentionally leaves untouched;
// only the user-facing presentation layer is renamed to "Space").
//
// Same data shape as the old page, plus one additive read: a per-space
// net worth + sparkline trend (lib/data/snapshots.ts), so the new cards can
// show a real "primary financial metric" without inventing any new backend
// surface or touching the SpaceSnapshot schema.
//
// ── RLS-T3 — WHICH AUTHORITY EACH READ ON THIS PAGE RUNS UNDER ───────────────
// Every row this page reads about the VIEWER — their preferred Space, their
// memberships, their invitations, their platform grants, the platform Spaces
// those grants reach, and the public Spaces they have not joined — now executes
// as the viewer through `withTenantDb`. The identity is `session.user.id` from
// getServerSession and nothing else; the active-Space cookie below is read only
// to highlight a card and is never an authority.
//
// Each read is its OWN short transaction rather than one shared one. That is the
// RLS-B4 decision repeated: this page's reads are a fan-out, and handing them a
// single transaction would put them on one connection and silently serialise
// them. Nothing inside any of them calls out of the process.
//
// TWO READS STAY ON `db`, DELIBERATELY AND NARROWLY — the member roster and the
// display fields an invitation names. Both are §10 territory: fm_app's `User`
// policy is `id = current_fm_user_id()`, a user sees THEMSELVES, and co-member
// display identity is the APPLICATION's answer (lib/spaces/roster-visibility.ts
// cites THIS page's serializeMembers as the authority for the shape a non-member
// of a public Space receives). Each is annotated at its call site below.
export default async function SpacesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return redirectToLogin();

  const userId = session.user.id;

  // ── The Space the viewer is ACTUALLY in ──────────────────────────────
  // The SERVER's answer (getSpaceContext: active-Space cookie → preferred
  // Space → personal), not the raw cookie. With no cookie the client used to
  // assume "personal", while every page under this shell resolved the
  // PREFERRED Space — so once a non-personal default was set, opening the
  // personal Space here looked already-active, pushed to /dashboard without a
  // switch, and landed back in the default (owner's Preview, 2026-10-06).
  // cache()-deduped: the dashboard layout already resolved it this request.
  const activeSpaceId = await getSpaceContext().then((ctx) => ctx.spaceId, () => null);

  // ── Preferred space, my memberships, pending invites, platform Spaces ─
  const [preferredSpaceRow, myMemberships, pendingInvites, platformSpaces] = await Promise.all([
    // RLS-T3 — the viewer's own User row. fm_app's `User` SELECT policy is
    // `id = current_fm_user_id()`, so the predicate this call states is also the
    // one the database enforces: `findUnique` on anybody else's id answers null.
    //
    // ⚠️ THE CATCH IS WIDER THAN ITS COMMENT CLAIMS, AND IT IS VESTIGIAL.
    // `preferredSpaceId` has been in the schema since prisma/schema.prisma:358,
    // so the "migration not yet applied" case it was written for cannot occur;
    // what it now swallows is any failure of the tenant channel, which would
    // read as "no preferred Space" rather than as a broken authority. It is kept
    // byte-for-byte in behaviour because changing a failure mode is a separate
    // decision from changing an authority — reported, not quietly fixed.
    withTenantDb(userId, (tx) => tx.user.findUnique({
      where:  { id: userId },
      select: { preferredSpaceId: true },
    })).catch(() => null),

    // RLS-T3 — my memberships. `SpaceMember.fm_app_sel` carries a
    // `"userId" = current_fm_user_id()` arm (§12), so this needs no elevated
    // authority, and `SpaceMember.space` resolves because an ACTIVE membership
    // puts the Space in `fm_visible_space_ids()` — which filters on membership
    // and status ONLY, never on archivedAt/deletedAt, so an archived Space is
    // still visible to its member and the `where` below stays the thing that
    // excludes it.
    //
    // ⚠️ THE `members` INCLUDE HAD TO LEAVE, AND IT WOULD NOT HAVE FAILED
    // QUIETLY. `SpaceMember.user` is a REQUIRED relation and fm_app's `User`
    // policy is `id = current_fm_user_id()`, so in any SHARED Space the other
    // members' User rows are invisible and Prisma raises "Inconsistent query
    // result: Field user is required" instead of returning null. The dev corpus
    // has six shared Spaces, one of them with three ACTIVE members, so this
    // would have 500'd the Spaces landing page outright rather than degrading.
    // The roster is now one explicitly-named `db` read below.
    withTenantDb(userId, (tx) => tx.spaceMember.findMany({
      where: { userId, status: "ACTIVE", space: { archivedAt: null, deletedAt: null } },
      include: {
        space: {
          include: {
            _count: {
              // Canonical account count: ACTIVE SpaceAccountLink rows whose
              // FinancialAccount is not soft-deleted.
              // @@unique([spaceId, financialAccountId]) makes the ACTIVE-link
              // count equal the distinct-account count.
              //
              // Unchanged as the tenant: the links sit in a Space this viewer is
              // an ACTIVE member of, so `SpaceAccountLink.fm_app_sel`
              // (`spaceId IN fm_visible_space_ids()`) admits them, and each
              // account is ACTIVE-linked into that same Space, so
              // `fm_account_visible()` admits the FinancialAccount the filter
              // joins.
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
    })),

    // RLS-T3 — my invitations, served by the `"invitedUserId" =
    // current_fm_user_id()` arm of `SpaceInvite.fm_app_sel` (§13, which exists
    // precisely so an invitation is visible to the one person who must act on
    // it).
    //
    // ⚠️ BOTH RELATIONS HAD TO LEAVE FOR THE SAME REASON, AND THE `space` ONE IS
    // THE SHARPER OF THE TWO: an invitee is BY DEFINITION not a member of the
    // inviting Space, so `Space.fm_app_sel` admits that row only if it is public
    // — and `SpaceInvite.space` is a REQUIRED relation. Every invitation into a
    // private Space, which is every ordinary invitation, would have raised
    // "Inconsistent query result: Field space is required" and 500'd this page.
    // The dev corpus holds ZERO pending invites, so nothing local would have
    // caught it; the policy text is the only witness.
    withTenantDb(userId, (tx) => tx.spaceInvite.findMany({
      where: { invitedUserId: userId, status: "PENDING" },
      select: {
        id:            true,
        role:          true,
        status:        true,
        createdAt:     true,
        seenAt:        true,
        spaceId:       true,
        invitedById:   true,
      },
      orderBy: { createdAt: "desc" },
    })),

    // PO1.0 — platform Spaces the user holds an ACTIVE grant on (access-derived).
    loadPlatformSpaces(userId),
  ]);

  const preferredSpaceId: string | null = preferredSpaceRow?.preferredSpaceId ?? null;
  const mySpaceIds = myMemberships.map((m) => m.spaceId);

  // ── Public SHARED spaces the user hasn't joined ───────────────────────
  //
  // RLS-T3 — as the tenant, and the rows still come back: `Space.fm_app_sel`
  // carries an explicit `OR "isPublic" = true` arm (added by
  // 20261002000400_rls_membership_bootstrap, whose comment says a public Space's
  // 200 must not become a 404 for a non-member). That arm and the absence of any
  // such arm on `SpaceSnapshot` are the same decision seen twice: a public
  // Space's ROW is discoverable, its MONEY is not — see the block below.
  //
  // ⚠️ `_count.accountLinks` NOW READS 0 FOR AN UNJOINED SPACE, by the same
  // policy that gates the money: `SpaceAccountLink.fm_app_sel` is
  // `spaceId IN fm_visible_space_ids()`. Nothing renders it — `accountCount` is
  // declared on SpacesClient's Space type and read by zero of its render sites
  // (pinned in lib/rls-server-component-authority.test.ts) — so this changes a
  // field nobody reads rather than a figure somebody sees. It is left in place,
  // and named here, rather than deleted: removing it is a payload decision, not
  // an authority one.
  const publicSpaces = await withTenantDb(userId, (tx) => tx.space.findMany({
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
  }));

  // ── The member roster — §10, and DELIBERATELY NOT withTenantDb ────────────
  //
  // This is the read the two `members` includes above became. It is the
  // APPLICATION's disclosure, not the tenant's: lib/spaces/roster-visibility.ts
  // names THIS page's serializeMembers() as the authority for what a non-member
  // of a public Space may see — `{ id, role, joinedAt, user: { id, name,
  // username } }` — and the policies cannot express it, because a public Space
  // has no SpaceMember row this viewer may read (§12 closed the roster oracle at
  // the database) and a co-member's User row is hidden by §10 even where the
  // SpaceMember row is not.
  //
  // So it stays on `db`, as narrow as the disclosure it serves: ACTIVE rows
  // only, for Space ids this page has ALREADY established the viewer may see
  // (their own memberships, plus public Spaces the policy itself admitted), and
  // exactly the four scalars plus three display columns the old includes
  // selected — never email, never a SpaceMember scalar. Fields are PICKED, as
  // roster-visibility.ts insists, so a new column on either table cannot join
  // the payload by default.
  const rosterSpaceIds = [...mySpaceIds, ...publicSpaces.map((w) => w.id)];
  const rosterRows = rosterSpaceIds.length === 0 ? [] : await db.spaceMember.findMany({
    where:   { spaceId: { in: rosterSpaceIds }, status: "ACTIVE" },
    select:  {
      id:       true,
      spaceId:  true,
      role:     true,
      joinedAt: true,
      user:     { select: { id: true, name: true, username: true } },
    },
    // One global ordering reproduces the per-Space `joinedAt: "asc"` the nested
    // includes had, because grouping below preserves row order.
    orderBy: { joinedAt: "asc" },
  });
  const rosterBySpace = new Map<string, typeof rosterRows>();
  for (const row of rosterRows) {
    const list = rosterBySpace.get(row.spaceId);
    if (list) list.push(row);
    else rosterBySpace.set(row.spaceId, [row]);
  }

  // ── The two display fields an invitation names — §10, also NOT withTenantDb ─
  //
  // Same reasoning, and the Space half is the part the policies genuinely cannot
  // serve: an invitee must be told WHAT they have been invited to, and they are
  // not a member of it. Four Space fields and three User display columns — the
  // same ones the two includes selected, and no more.
  const inviteSpaceIds = [...new Set(pendingInvites.map((i) => i.spaceId))];
  const inviterIds     = [...new Set(pendingInvites.map((i) => i.invitedById))];
  const [inviteSpaces, inviters] = await Promise.all([
    inviteSpaceIds.length === 0 ? [] : db.space.findMany({
      where:  { id: { in: inviteSpaceIds } },
      select: { id: true, name: true, description: true, isPublic: true },
    }),
    inviterIds.length === 0 ? [] : db.user.findMany({
      where:  { id: { in: inviterIds } },
      select: { id: true, name: true, username: true },
    }),
  ]);
  const inviteSpaceById = new Map(inviteSpaces.map((s) => [s.id, s]));
  const inviterById     = new Map(inviters.map((u) => [u.id, u]));

  // ── Net worth + sparkline trend, one query for every card on the page ─────
  const allIds = [...mySpaceIds, ...publicSpaces.map((w) => w.id)];
  //
  // ── MEMBERSHIP GATES MONEY (owner decision, 2026-10-02) ───────────────────
  // `allIds` is `mySpaceIds` PLUS every PUBLIC Space the viewer has NOT joined
  // (`id: { notIn: mySpaceIds }`, above). `getSpaceNetWorthSummaries` has no
  // membership check of its own — it answers for whatever ids it is handed — so
  // on the migration principal this page published the net worth, the 1M change
  // and the sparkline of Spaces the viewer is not a member of. By application
  // code, not by accident, and not by any product decision anyone had made.
  //
  // RLS-C-S3 found it and declined to answer it unilaterally, because the fix
  // and the product question are the same edit. The owner has now answered:
  // `isPublic` means DISCOVERABLE AND JOINABLE, never "my balances are
  // published". So the figures are gated on membership.
  //
  // The gate is the tenant client, not a filter. `SpaceSnapshot.fm_app_sel` is
  // `"spaceId" IN (SELECT fm_visible_space_ids())`, so a non-member's Space
  // yields no summary and the Explore card renders the explicit no-figure state
  // (`netWorth: 0`/`trend: []`/`change: null` → "—"). Writing it as an
  // application `where` instead would put the rule somewhere a future edit could
  // drop it silently; here, dropping it means reaching for a wider client, which
  // scripts/audit-db-authority.ts refuses.
  //
  // ⚠️ The RLS design already said this. `Space.fm_app_sel` has an explicit
  // `OR "isPublic" = true` arm so a public Space's ROW is readable to anyone —
  // and `SpaceSnapshot` deliberately has no such arm. The policy drew the line
  // at membership for financial figures before the product did.
  const netWorthBySpace = await withTenantDb(userId, (tx) =>
    getSpaceNetWorthSummaries(tx, allIds),
  );
  // v2.6-L4F — per-Space ACCOUNT freshness, so the card's "updated" line is the
  // Slice 1 claim (anchored on the OLDEST observation, with its qualifier) and
  // not the snapshot date it used to show.
  //
  // MEMBER Spaces only (launch-readiness audit, 2026-10-06). getSpaceCardFreshness
  // reads the account subtree on the owner client and answers for whatever ids it
  // is handed; given `allIds` it published, for public Spaces the viewer has NOT
  // joined, when their accounts were last observed and how many are stale. That is
  // the same line "membership gates money" draws above, applied to the metadata
  // about the money. A Space absent from the result renders no "updated" line.
  const freshnessBySpace = await getSpaceCardFreshness(mySpaceIds);

  // ── Serialization helpers ─────────────────────────────────────────────────

  // The shape is unchanged; the parameter type no longer asks for `userId` /
  // `spaceId`, which it never read, so it describes what the roster read above
  // actually selects.
  function serializeMembers(
    members: {
      id: string; role: string; joinedAt: Date;
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
      members:      serializeMembers(rosterBySpace.get(m.space.id) ?? []),
      myRole:       m.role as string,
      accountCount: m.space._count.accountLinks,
      netWorth:     nw?.netWorth ?? 0,
      // MC1 QA Q5 — each card labels in its OWN Space's reporting currency
      // (REVIEW-3: the EFFECTIVE one — the currency of the amount actually
      // computed, which reverts to USD when the requested one is unsatisfiable,
      // exactly as inside the Space).
      currency:     nw?.currency ?? "USD",
      trend:        nw?.trend ?? [],
      // REVIEW-3 B-4 — reconstructed/estimated latest point carries its marker.
      estimated:    nw?.estimated ?? false,
      // v2.6-L4F — the latest ADMISSIBLE snapshot date. Kept for the "history
      // reaches" line; it is NOT a freshness claim and the card no longer
      // renders it as one.
      lastUpdated:  nw?.asOf ?? null,
      // v2.6-L4F — the canonical 1M change (same authority as the inside view).
      change:       nw?.change ?? null,
      // v2.6-L4F/L1 — account freshness through the Slice 1 authority. "Updated
      // today" previously came from the snapshot date, which says when we last
      // COMPUTED, never when the balances were last observed.
      freshness:    freshnessBySpace[m.space.id] ?? null,
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
      members:      serializeMembers(rosterBySpace.get(w.id) ?? []),
      accountCount: w._count.accountLinks,
      netWorth:     nw?.netWorth ?? 0,
      // MC1 QA Q5 / REVIEW-3 — the EFFECTIVE reporting currency (see above).
      currency:     nw?.currency ?? "USD",
      trend:        nw?.trend ?? [],
      estimated:    nw?.estimated ?? false,
      lastUpdated:  nw?.asOf ?? null,
      change:       nw?.change ?? null,
      freshness:    freshnessBySpace[w.id] ?? null,
    };
  });

  // The two relations are stitched back into the identical response shape. An
  // invitation whose Space or inviter cannot be resolved is DROPPED rather than
  // handed to a client whose `Invite` type declares both non-null: both FKs are
  // required with onDelete: Cascade, so a missing row cannot exist, and this
  // read runs on `db` where no policy can hide one — the branch is unreachable
  // and is written as a drop because the alternative is a render crash.
  const invitesSerialized = pendingInvites.flatMap((i) => {
    const space   = inviteSpaceById.get(i.spaceId);
    const invitedBy = inviterById.get(i.invitedById);
    if (!space || !invitedBy) return [];
    return [{
      id:        i.id,
      role:      i.role as string,
      status:    i.status as string,
      createdAt: i.createdAt.toISOString(),
      seenAt:    i.seenAt?.toISOString() ?? null,
      space,
      invitedBy,
    }];
  });

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

// ── PO1.0 platform Spaces, as the tenant — ONE transaction, on purpose ───────
//
// RLS-T3. These two reads are ONE coherent answer ("which platform Spaces does
// this operator's grants reach"), the second is a function of the first, and
// neither calls out of the process — so they share a transaction and the answer
// cannot straddle a grant being revoked mid-page.
//
// BOTH ARMS ALREADY EXIST IN THE POLICIES, which is why this needed no wider
// authority and no `systemDb`:
//   · `PlatformGrant.fm_app_sel` is `"userId" = current_fm_user_id()` (§9), and
//     the question asked is "my grants" — so the chips do NOT vanish under
//     fm_app. This was the open question on this page and the answer is that
//     the tenant role is the RIGHT one here: a grant is a fact about the
//     viewer.
//   · `Space.fm_app_sel` carries the platform arm (§11) — `platformArea IS NOT
//     NULL AND EXISTS (an ACTIVE PlatformGrant for me on that area)` — written
//     because the four platform Spaces hold ZERO SpaceMember rows and a
//     membership-only policy would hide them from the operators who own them.
//     So the Space rows come back too, and an area the viewer holds no grant on
//     is now refused by the database as well as by the `in` filter.
//
// ⚠️ THE ARM STOPS AT `Space`. It does NOT extend to the Space's SECTIONS —
// `SpaceDashboardSection` is a §7 `spaceId IN fm_visible_space_ids()` table with
// no platform arm at all — which is the finding that keeps
// app/(shell)/dashboard/platform/[area]/page.tsx on `db`. See the block at the
// top of that file.
async function loadPlatformSpaces(userId: string) {
  return withTenantDb(userId, async (tx) => {
    const grants = await tx.platformGrant.findMany({
      where:  { userId, status: "ACTIVE" },
      select: { area: true, level: true },
    });
    if (grants.length === 0) return [];

    const spaces = await tx.space.findMany({
      where:  { platformArea: { in: grants.map((g) => g.area) } },
      select: { id: true, name: true, platformArea: true },
    });

    return spaces.map((s) => ({
      id:     s.id,
      name:   s.name,
      area:   s.platformArea as string,
      // Non-null by construction: the `where` above only admits a Space whose
      // platformArea is one of these grants' areas.
      access: grants.find((g) => g.area === s.platformArea)!.level as string,
    }));
  });
}
