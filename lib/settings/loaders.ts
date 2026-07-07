/**
 * lib/settings/loaders.ts
 *
 * Per-page data loaders for the Settings section (UX-1 Phase 2).
 *
 * Each Settings route owns only the data it needs — there is deliberately no
 * single shared "getSettingsProfile" god-loader. Under nested App Router
 * routes each page is its own request, so pages never share a render pass and
 * there is no cross-page query to dedupe.
 *
 * The one intra-request overlap that CAN occur — a page's loader and a future
 * layout both resolving the session in the same request — is covered by
 * wrapping the session guard in React's cache() (same pattern as
 * getSpaceContext in lib/space.ts). Each loader then runs its own tailored
 * Prisma select.
 */

import { cache } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export interface SpaceOption {
  id:   string;
  name: string;
  type: string;
}

/**
 * Resolves the signed-in user id, redirecting to /login when absent.
 * cache()-wrapped so repeated calls within a single request (page + layout)
 * share one session lookup instead of re-running it.
 */
const requireUserId = cache(async (): Promise<string> => {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");
  return session.user.id;
});

// ── Account ───────────────────────────────────────────────────────────────────

export interface AccountData {
  email:            string;
  username:         string;
  firstName:        string;
  lastName:         string;
  hasDob:           boolean;
  employmentStatus: string;
  useCase:          string;
}

export async function getAccount(): Promise<AccountData> {
  const userId = await requireUserId();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = await (db as any).user.findUnique({
    where:  { id: userId },
    select: {
      email:                true,
      username:             true,
      firstName:            true,
      lastName:             true,
      employmentStatus:     true,
      useCase:              true,
      dateOfBirthEncrypted: true,
    },
  }) as {
    email: string; username: string | null; firstName: string | null;
    lastName: string | null; employmentStatus: string | null; useCase: string | null;
    dateOfBirthEncrypted: string | null;
  } | null;

  if (!user) redirect("/login");

  return {
    email:            user.email,
    username:         user.username         ?? "",
    firstName:        user.firstName        ?? "",
    lastName:         user.lastName         ?? "",
    hasDob:           !!user.dateOfBirthEncrypted,
    employmentStatus: user.employmentStatus ?? "",
    useCase:          user.useCase          ?? "",
  };
}

// ── Security ────────────────────────────────────────────────────────────────

export interface SecurityData {
  email: string;
}

export async function getSecurity(): Promise<SecurityData> {
  const userId = await requireUserId();
  const user = await db.user.findUnique({
    where:  { id: userId },
    select: { email: true },
  });
  if (!user) redirect("/login");
  return { email: user.email };
}

// ── Preferences ───────────────────────────────────────────────────────────────

export interface PreferencesData {
  reportingCurrency: string;
  preferredSpaceId:  string | null;
  spaces:            SpaceOption[];
}

export async function getPreferences(): Promise<PreferencesData> {
  const userId = await requireUserId();
  const [user, memberships] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).user.findUnique({
      where:  { id: userId },
      select: { reportingCurrency: true, preferredSpaceId: true },
    }) as Promise<{ reportingCurrency: string; preferredSpaceId: string | null } | null>,
    db.spaceMember.findMany({
      // Archived/trashed spaces can't be set as the default landing space —
      // exclude them from this picker (unchanged from the former page.tsx).
      where:   { userId, status: "ACTIVE", space: { archivedAt: null, deletedAt: null } },
      include: { space: { select: { id: true, name: true, type: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  ]);

  if (!user) redirect("/login");

  return {
    reportingCurrency: user.reportingCurrency ?? "USD",
    preferredSpaceId:  user.preferredSpaceId ?? null,
    spaces: memberships.map((m) => ({
      id:   m.space.id,
      name: m.space.name,
      type: m.space.type,
    })),
  };
}

// ── Data & Privacy ────────────────────────────────────────────────────────────

/**
 * Data & Privacy needs no server-side read today — Export is a client action
 * (POST /api/user/export) and Archive & Trash links to its own route. This
 * loader exists to enforce the auth guard consistently and to own any future
 * server data (privacy/consent state) the page acquires.
 */
export async function getDataPrivacy(): Promise<void> {
  await requireUserId();
}
