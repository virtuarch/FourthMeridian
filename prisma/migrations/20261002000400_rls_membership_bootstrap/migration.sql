-- RLS-15 — THE SELF-JOIN HOLE, AND THE TWO FLOWS IT WAS HIDING
--
-- 🔴 The SpaceMember INSERT policy shipped as:
--
--     WITH CHECK ("spaceId" IN (SELECT fm_visible_space_ids())
--                 OR "userId" = current_fm_user_id())
--
-- The second arm reads as "you may write your own membership row", which sounds
-- modest. It is not. It admits ANY row whose userId is yours — including one
-- naming a Space you have never been near. Measured, as fm_app, against the
-- acceptance fixtures:
--
--     insert into "SpaceMember" (spaceId, userId, role, status)
--       values ('space_b', 'alice', 'OWNER', 'ACTIVE');   -- SUCCEEDED
--
-- and Alice's visible transaction count went from 4 to 5. She joined Bob's
-- Space and read his data. The application never offered that route, so no
-- product test could have caught it — and RLS, which exists precisely to be the
-- backstop when the application is wrong, waved it through.
--
-- The arm existed because two legitimate flows cannot be authorised by EXISTING
-- membership, since establishing membership is the thing they do:
--   · creating a Space, where the creator's own OWNER row is the first member;
--   · accepting an invitation, where the invitee is not yet a member.
-- Both were served by making the policy permissive enough to cover them, which
-- is how a hole gets a reason.
--
-- The fix names the two flows instead of widening the rule to fit them.

-- ── The predicate, as a function, because it must see what the caller cannot ─
--
-- SECURITY DEFINER for the same reason fm_visible_space_ids() is: an invite you
-- have not yet accepted, and a Space you have just created, are both invisible
-- under your own policies. It is safe for the same reason too — it is
-- SELF-SCOPED. Every arm is keyed to current_fm_user_id(), so there is no way
-- to ask it about anybody else, whatever `space` is passed.
CREATE OR REPLACE FUNCTION fm_may_join_space(space text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT
      -- (1) A PENDING invitation addressed to me, for this Space.
      EXISTS (
        SELECT 1 FROM "SpaceInvite" i
         WHERE i."spaceId"       = space
           AND i."invitedUserId" = current_fm_user_id()
           AND i.status          = 'PENDING'
      )
      -- (2) A Space with no members at all: the one I just created, in the same
      --     transaction, before any membership exists to be visible.
      --
      --     ⚠️ `platformArea IS NULL` is load-bearing. The four platform Spaces
      --     have ZERO SpaceMember rows by design — they are reached through
      --     PlatformGrant — so without this clause "unclaimed" would describe
      --     them perfectly and any authenticated user could make themselves
      --     OWNER of Platform Ops.
      OR EXISTS (
        SELECT 1 FROM "Space" s
         WHERE s."id"           = space
           AND s."platformArea" IS NULL
           AND NOT EXISTS (SELECT 1 FROM "SpaceMember" m WHERE m."spaceId" = s."id")
      )
  $$;

GRANT EXECUTE ON FUNCTION fm_may_join_space(text) TO fm_app, fm_system;

DROP POLICY IF EXISTS fm_app_ins ON public."SpaceMember";
CREATE POLICY fm_app_ins ON public."SpaceMember" FOR INSERT TO fm_app
  WITH CHECK (
    "spaceId" IN (SELECT fm_visible_space_ids())
    OR ("userId" = current_fm_user_id() AND fm_may_join_space("spaceId"))
  );

-- The UPDATE arm fixes a second, quieter defect in the same place: re-joining a
-- Space you once LEFT went through Prisma as ON CONFLICT DO UPDATE, and the
-- UPDATE arm had no userId clause at all, so the accept simply failed. Adding
-- the SAME conditioned arm makes re-joining work and still refuses the thing a
-- naive `userId = current_fm_user_id()` would have allowed: a REMOVED member
-- flipping their own status back to ACTIVE without an invitation. Revocation
-- stays revocation.
DROP POLICY IF EXISTS fm_app_upd ON public."SpaceMember";
CREATE POLICY fm_app_upd ON public."SpaceMember" FOR UPDATE TO fm_app
  USING (
    "spaceId" IN (SELECT fm_visible_space_ids())
    OR ("userId" = current_fm_user_id() AND fm_may_join_space("spaceId"))
  )
  WITH CHECK (
    "spaceId" IN (SELECT fm_visible_space_ids())
    OR ("userId" = current_fm_user_id() AND fm_may_join_space("spaceId"))
  );

-- ── Two gaps Slice B hit, which are gaps and not holes ──────────────────────

-- Space had SELECT/INSERT/UPDATE and no DELETE, so permanent deletion matched
-- zero rows and surfaced as P2025. Whether a Space MAY be deleted is the
-- application's question (the route already requires OWNER); RLS only has to
-- stop it reaching somebody else's.
GRANT DELETE ON TABLE public."Space" TO fm_app;
CREATE POLICY fm_app_del ON public."Space" FOR DELETE TO fm_app
  USING ("id" IN (SELECT fm_visible_space_ids()));

-- A public Space is readable by design; the product says so with a column. The
-- SELECT policy had no arm for it, so a public Space's 200 became a 404 for
-- everyone who was not a member — RLS silently overruling a product decision it
-- was never meant to have an opinion about.
DROP POLICY IF EXISTS fm_app_sel ON public."Space";
CREATE POLICY fm_app_sel ON public."Space" FOR SELECT TO fm_app
  USING (
    "id" IN (SELECT fm_visible_space_ids())
    OR "isPublic" = true
    OR ("platformArea" IS NOT NULL AND EXISTS (
          SELECT 1 FROM "PlatformGrant" g
           WHERE g."userId" = current_fm_user_id()
             AND g.status   = 'ACTIVE'
             AND g.area     = "Space"."platformArea"))
  );
