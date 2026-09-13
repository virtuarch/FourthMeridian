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
 */

import { getSpaceContext } from "@/lib/space";
import { db } from "@/lib/db";
import { readBriefResponse } from "@/lib/ai/brief/view";
import { DailyBriefClient } from "@/components/brief/DailyBriefClient";
import type { BriefResponse } from "@/lib/brief-types";

export const preferredRegion = "sin1";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Daily Brief · Fourth Meridian",
};

export default async function DailyBriefPage() {
  const ctx = await getSpaceContext();

  const [user, initial] = await Promise.all([
    db.user.findUnique({ where: { id: ctx.userId }, select: { firstName: true, name: true } }),
    readBriefResponse(ctx.userId, ctx.spaceId)
      .then((r): BriefResponse | null => (r.ok ? r.body : null))
      .catch((err) => { console.error("[brief] initial read failed:", err); return null; }),
  ]);
  const firstName = user?.firstName ?? user?.name?.split(" ")[0] ?? null;

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
