/**
 * /dashboard/brief — the Daily Brief, inside the dashboard shell.
 *
 * ⚠️ IN THE SHELL, NOT BESIDE IT. The Brief used to live in its own `(brief)` route
 * group with its own logo header, so opening it dropped the global header and, on
 * mobile, the bottom navigation. It now inherits DashboardChrome like every other
 * destination on the bar — normal content column, normal bottom padding; it has no
 * need for the AI page's full-height layout.
 *
 * ⚠️ ONE SPACE, THE ACTIVE ONE. The same resolution My Space and AI use
 * (cookie → preferred Space → personal), cache()-shared with the layout. The id is
 * named on every request and re-resolved server-side; the client is keyed by it,
 * so switching Spaces is a new Brief, never the old Space's response.
 *
 * ⚠️ THE FIRST STATE IS RENDERED ON THE SERVER. The same cheap read GET performs
 * (row + watermark + metrics, never a model call), so a current Brief paints with
 * the page and only a Brief that needs work shows a skeleton. If that read fails,
 * the client simply asks for it.
 *
 * ⚠️ A VIEW IS RECORDED WHEN A BRIEF IS SHOWN, NOT WHEN IT IS ASKED FOR (BETA A2).
 * BRIEF_VIEWED is written once per (user, Space, Brief day) by two places and no
 * other: this page's first render, when the state it paints carries a Brief, and
 * GET /api/brief, when the response it returns carries one (app/api/brief/route.ts
 * states the rule). A router prefetch of this page is skipped. Generation (POST)
 * writes nothing — see the route header for what that leaves to the next read.
 *
 * ⚠️ THE NAME IS READ AS THE USER (RLS slice A). One row, their own: the tenant
 * policy on `User` is `id = current_fm_user_id()`, so the predicate below and the
 * database now agree about whose name this is. The Brief read beside it enters the
 * same boundary per phase — see lib/ai/brief/view.ts for why it cannot be one
 * transaction.
 *
 * ⚠️ FIRST RUN (Connections pass PR 2). The Brief is the post-login landing, so
 * it is where a brand-new user — no source ever, not a member of anyone else's
 * Space, welcome neither shown nor dismissed — is sent ONCE to the welcome view
 * on Connections. Security setup has already run (the layout's TOTP gate). The
 * read fails open and the welcome records itself as shown, so the Brief is
 * reachable again at once (back button, direct link) and established users are
 * never redirected. Only the landing redirects; every other page is untouched.
 */

import { getSpaceContext } from "@/lib/space";
import { withTenantDb } from "@/lib/db/tenant-context";
import { readBriefResponse } from "@/lib/ai/brief/view";
import { DailyBriefClient } from "@/components/brief/DailyBriefClient";
import type { BriefResponse } from "@/lib/brief-types";
import { recordBriefViewed } from "@/lib/analytics/product-events";
import { isRouterPrefetch } from "@/lib/analytics/request-intent";
import { redirect } from "next/navigation";
import { readFirstRun } from "@/lib/onboarding/first-run";
import { ONBOARDING_HREF } from "@/lib/onboarding/first-run.core";

export const preferredRegion = "sin1";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Daily Brief · Fourth Meridian",
};

export default async function DailyBriefPage() {
  const ctx = await getSpaceContext();

  if ((await readFirstRun(ctx.userId)).redirect && !(await isRouterPrefetch())) redirect(ONBOARDING_HREF);

  const [user, initial] = await Promise.all([
    withTenantDb(ctx.userId, (tx) =>
      tx.user.findUnique({ where: { id: ctx.userId }, select: { firstName: true, name: true } })),
    readBriefResponse(ctx.userId, ctx.spaceId)
      .then((r): BriefResponse | null => (r.ok ? r.body : null))
      .catch((err) => { console.error("[brief] initial read failed:", err); return null; }),
  ]);
  const firstName = user?.firstName ?? user?.name?.split(" ")[0] ?? null;

  if (initial?.brief && !(await isRouterPrefetch())) {
    await withTenantDb(ctx.userId, (tx) =>
      recordBriefViewed(tx, { userId: ctx.userId, spaceId: ctx.spaceId, briefDay: initial.brief!.briefDay, cached: true }));
  }

  return (
    <DailyBriefClient
      key={ctx.spaceId}
      spaceId={ctx.spaceId}
      spaceName={ctx.space.name}
      firstName={firstName}
      initial={initial}
    />
  );
}
